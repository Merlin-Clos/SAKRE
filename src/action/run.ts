import type { ReviewResult } from '../contracts/review';
import { resolveEffectiveRun } from '../config/effective-run';
import { DEFAULT_DEADLINE_MINUTES, loadReviewConfig, type ResolvedReviewConfig } from '../config/load';
import { type CoveragePlan, isReviewableFile, planCoverageDiff } from '../analysis/diff';
import { renderCoverageDiff } from '../analysis/render';
import { type CoverageBudgetSummary, summarizeCoverage } from '../analysis/budget';
import { assessRisk } from '../analysis/risk';
import { escalationPriorityPatterns } from '../analysis/risk-rules';
import { buildSharedReviewContext } from '../review/context';
import { runReviewPipeline, type PipelineOutput } from '../review/pipeline';
import {
    classificationsOfReviewMap,
    type IntelligenceOutput,
    type IntelligenceRunOptions
} from '../intelligence/pre-pass';
import type { ReviewMap } from '../intelligence/schema';
import type { AiRuntime } from '../ai/runtime';
import { recordModelInvocations } from '../ai/provenance';
import type { RuntimeRequest } from './runtime-factory';
import type { TrustedWorkspace, WorkspaceFactory } from '../workspace/trusted';
import type { VcsClient } from '../vcs/types';
import type { ProviderCredentials } from './inputs';
import { createLogger } from '../logger';
import { asError, describeError } from '../errors';
import { createDeadline, type DeadlineHandle } from '../review/pipeline-steps';
import { closeOwnedResources } from './resources';
import { AlreadyReviewedError, DiffBudgetExceededError } from './errors';
import {
    buildFinalComment,
    buildInProgressComment,
    isAlreadyReviewed,
    summarizeResultForLog,
    type PublishedResult,
    type ReviewExecution
} from './state';
import { publishFinal, replaceProgressWithFailure, type ReviewPublication } from './publication';
import type { ReviewGuidance } from '../review/guidance';

/* The cycle takes only the run inputs it uses, so local runs reuse it without
   posing as Action events. */
export interface ReviewRunInputs {
    provider?: string;
    defaultModel?: string;
    configPath: string;
    /* CLI-only: explicit --config path read as trusted-local input. */
    localConfigPath?: string;
    isMockMode: boolean;
    credentials: ProviderCredentials;
    /* Local-only: accept native OpenCode providers and OpenCode store credentials. */
    allowNativeProvider?: boolean;
    allowMissingCredential?: boolean;
}

export interface ReviewCycleDeps {
    vcs: VcsClient;
    inputs: ReviewRunInputs;
    prNumber: number;
    /* Run identity for publication metadata; carried on every entrypoint. */
    runId?: string;
    /* Where the run started; the renderer states it and the channel never
       changes it. */
    execution: ReviewExecution;
    /* Untrusted user intent from `--instructions` or the trigger comment. */
    guidance?: ReviewGuidance;
    force: boolean;
    /* Explicit opt-in to review a diff above budget. */
    forceOverBudget?: boolean;
    /* Asked when the diff exceeds budget without force; absent means abort. */
    confirmOverBudget?: (report: CoverageBudgetSummary) => Promise<boolean>;
    worktreeDir?: string;
    /* Deterministic pre-pass: runs before context build and provider calls. */
    runIntelligence: (options: IntelligenceRunOptions) => Promise<IntelligenceOutput>;
    /* Full-map observability; the CI group and the CLI stderr shape differ. */
    logIntelligence?: (map: ReviewMap) => void;
    createWorkspace?: WorkspaceFactory;
    createRuntime: (request: RuntimeRequest) => Promise<AiRuntime>;
    publication?: ReviewPublication;
}

/* Mock runs skip provider calls but still resolve the route: one placeholder
   keeps `local --mock` and `mock_mode` runnable without config. */
const MOCK_MODEL_ID = 'mock-model';

const log = createLogger('review');

export async function runReviewCycle(
    deps: ReviewCycleDeps,
    deadline: DeadlineHandle = createDeadline(DEFAULT_DEADLINE_MINUTES)
): Promise<PublishedResult> {
    const { inputs, vcs, prNumber, runId } = deps;
    let runtime: AiRuntime | undefined = undefined;
    let workspace: TrustedWorkspace | undefined = undefined;
    let commentId: number | undefined = undefined;
    let headSha: string | undefined = undefined;
    // eslint-disable-next-line init-declarations -- assigned before it is read after the finally block
    let reviewResult: PublishedResult | undefined;
    let reviewError: Error | undefined = undefined;
    // eslint-disable-next-line init-declarations -- assigned in the finally block before it is read
    let cleanupError: Error | undefined;

    try {
        const snapshot = await vcs.getPullRequestSnapshot(prNumber, deadline.signal);
        const baseSha = snapshot.pullRequest.baseSha;
        headSha = snapshot.pullRequest.headSha;
        log.info('Loaded pull request snapshot', {
            prNumber,
            baseSha,
            headSha,
            changedFiles: snapshot.changedFiles.length
        });

        if (!deps.force && isAlreadyReviewed(snapshot.comments, headSha)) {
            throw new AlreadyReviewedError(headSha);
        }

        const config = await loadReviewConfig(vcs, baseSha, {
            operational: {
                provider: inputs.provider,
                defaultModel: inputs.defaultModel ?? (inputs.isMockMode ? MOCK_MODEL_ID : undefined)
            },
            configPath: inputs.configPath,
            localConfigPath: inputs.localConfigPath,
            allowNativeProvider: inputs.allowNativeProvider,
            signal: deadline.signal
        });

        deadline.configure(config.review.deadlineMinutes);
        log.info('Resolved review configuration', {
            provider: config.provider,
            model: config.model ?? null,
            failurePolicy: config.review.failurePolicy,
            deadlineMinutes: config.review.deadlineMinutes
        });

        const effective = resolveEffectiveRun({
            config,
            apiKey: inputs.credentials.apiKey,
            baseURL: inputs.credentials.baseURL,
            isMockMode: inputs.isMockMode,
            allowUnsupportedProvider: inputs.allowNativeProvider,
            allowMissingCredential: inputs.allowMissingCredential
        });

        /* Pre-flight: measured diff and budget decide completeness before any
           provider process starts. */
        const budget = config.review.diffBudgetChars;
        const riskRules = config.risk;

        const plan = planCoverageDiff(snapshot.changedFiles, {
            maxChars: budget,
            priorityPatterns: escalationPriorityPatterns(riskRules),
            excludePatterns: config.review.exclude
        });

        if (!(await isPartialRunAllowed(deps, plan, budget))) {
            throw new DiffBudgetExceededError(summarizeCoverage(plan, budget));
        }

        const files = await vcs.materializeCoveragePatches(snapshot.changedFiles, plan.allocations, deadline.signal);
        workspace = await deps.createWorkspace?.({ baseSha, headSha, signal: deadline.signal });
        const worktreeDir = workspace?.directory ?? deps.worktreeDir ?? process.cwd();
        runtime = await deps.createRuntime({ effective, config, signal: deadline.signal, worktreeDir });

        /* Records the exact resolved model of each call crossing the boundary,
           never the routing plan. */
        const modelInvocations = recordModelInvocations(
            runtime,
            (modelId) => config.models?.catalog?.[modelId]?.artificialAnalysisUrl
        );

        runtime = modelInvocations.runtime;
        const { publication } = deps;

        if (publication !== undefined) {
            const inProgressBody = buildInProgressComment({
                headSha,
                baseSha,
                triggerCommentId: publication.triggerCommentId,
                runId
            });

            commentId = await publication.create(inProgressBody, deadline.signal);
        }

        const intelligence = await deps.runIntelligence({
            worktreeDir,
            baseSha,
            headSha,
            changedFiles: snapshot.changedFiles,
            classification: config.classification,
            signal: deadline.signal
        });

        log.info('Built deterministic review intelligence', {
            files: intelligence.map.files.length,
            functions: intelligence.map.functions.length,
            warnings: intelligence.map.warnings.length,
            sccVersion: intelligence.map.tools.scc.version,
            ccccVersion: intelligence.map.tools.cccc.version
        });
        deps.logIntelligence?.(intelligence.map);

        /* Coverage uses the pre-pass classification directly; no renderer
           reinterprets the rules. */
        const coverage = renderCoverageDiff(plan, files, {
            classification: config.classification,
            fileClassifications: classificationsOfReviewMap(intelligence.map)
        });

        log.info('Built budgeted diff coverage', {
            complete: coverage.complete,
            includedFiles: coverage.files.filter((file) => isReviewableFile(file)).length,
            totalFiles: coverage.files.length,
            forcedPartial: !coverage.complete
        });

        const risk = assessRisk({
            changedFiles: snapshot.changedFiles,
            recognizedFilesCount: intelligence.baseMetrics.recognizedFilesCount,
            physicalLines: intelligence.baseMetrics.physicalLines,
            rules: riskRules,
            classification: config.classification,
            fileClassifications: classificationsOfReviewMap(intelligence.map)
        });

        log.info('Assessed review risk', {
            tier: risk.tier,
            volumeTier: risk.volumeTier,
            changedFiles: risk.changedFilesCount,
            changedLines: risk.changedLines,
            specialists: risk.requiredSpecialists,
            escalations: risk.escalations.map((escalation) => escalation.id)
        });
        const context = buildSharedReviewContext({ snapshot, coverage, risk });

        const pipelineResult = await runReviewPipeline({
            context,
            config,
            credentials: effective,
            risk,
            coverage,
            intelligence: intelligence.map,
            runtime,
            vcs,
            guidance: deps.guidance,
            deadline
        });

        const currentHeadSha = await vcs.getCurrentHeadSha(prNumber, deadline.signal);
        const finalResult = toFinalResult(pipelineResult, headSha, currentHeadSha);
        await publishFinal({
            commentId,
            body: buildFinalComment(finalResult, {
                execution: deps.execution,
                baseSha,
                guidance: deps.guidance?.source,
                guidanceText: deps.guidance?.text,
                runId,
                models: modelInvocations.modelsUsed()
            }),
            signal: deadline.signal,
            publication: deps.publication
        });
        log.info('Published review result', {
            commentId: commentId ?? null,
            stale: finalResult.status === 'stale',
            ...summarizeResultForLog(finalResult)
        });
        reviewResult = {
            result: finalResult,
            stale: finalResult.status === 'stale',
            models: modelInvocations.modelsUsed()
        };
    } catch (error) {
        const failure = asError(error);
        reviewError = failure;
        log.error('Review cycle failed', { error: describeError(failure) });

        if (commentId !== undefined && headSha !== undefined) {
            await replaceProgressWithFailure({ publication: deps.publication, commentId, headSha, runId });
        }
    } finally {
        deadline.cancel();
        cleanupError = await closeOwnedResources(runtime, workspace);
    }

    return resolveCycleOutcome({ reviewError, cleanupError, reviewResult });
}

/* A head that moved turns a complete verdict into `stale`: no verdict is tied
   to the new head. */
function toFinalResult(pipeline: PipelineOutput, headSha: string, currentHeadSha: string): ReviewResult {
    const result = pipeline.result;

    if (currentHeadSha === headSha) {
        return result;
    }

    if (result.status === 'incomplete') {
        return {
            riskSummary: result.riskSummary,
            riskTier: result.riskTier,
            reviewedHeadSha: result.reviewedHeadSha,
            findings: result.findings,
            intelligence: result.intelligence,
            status: 'stale',
            verdict: null,
            currentHeadSha,
            unverifiedFindings: result.unverifiedFindings,
            failures: result.failures
        };
    }

    return {
        riskSummary: result.riskSummary,
        riskTier: result.riskTier,
        reviewedHeadSha: result.reviewedHeadSha,
        findings: result.findings,
        intelligence: result.intelligence,
        status: 'stale',
        verdict: null,
        currentHeadSha,
        unverifiedFindings: [],
        failures: []
    };
}

/* Primary error wins; cleanup surfaces only when the review itself succeeded. */
function resolveCycleOutcome(input: {
    reviewError: Error | undefined;
    cleanupError: Error | undefined;
    reviewResult: PublishedResult | undefined;
}): PublishedResult {
    if (input.reviewError !== undefined) {
        throw input.reviewError;
    }

    if (input.cleanupError !== undefined) {
        throw input.cleanupError;
    }

    if (input.reviewResult === undefined) {
        throw new Error('Review cycle ended without a result or an error.');
    }

    return input.reviewResult;
}

/* Partial coverage continues only with explicit force or operator confirm. */
async function isPartialRunAllowed(deps: ReviewCycleDeps, plan: CoveragePlan, limitChars: number): Promise<boolean> {
    if (plan.complete) {
        return true;
    }

    const report = summarizeCoverage(plan, limitChars);

    if (deps.forceOverBudget === true) {
        log.info('Proceeding with a partial review: the over-budget review was forced', { report });

        return true;
    }

    if ((await deps.confirmOverBudget?.(report)) === true) {
        log.info('Proceeding with a partial review: the over-budget diff was confirmed', { report });

        return true;
    }

    log.info('Aborting before the provider call: the diff exceeds the review budget', { report });

    return false;
}

export type { ReviewResult, ResolvedReviewConfig };
