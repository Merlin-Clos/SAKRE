import { type DiffCoverage, isCoveredFile, isReviewableFile } from '../analysis/diff';
import type { RiskAssessment } from '../analysis/risk';
import { inlineCode } from '../intelligence/format';
import { projectionKindFor, projectReviewMap } from '../intelligence/project';
import type { ReviewMap } from '../intelligence/schema';
import type { AiRuntime } from '../ai/runtime';
import type { EffectiveRun } from '../config/effective-run';
import type { ResolvedReviewConfig } from '../config/load';
import type { ReviewContext } from './context';
import type {
    CandidateFinding,
    MaterializedFinding,
    ReviewFailure,
    ReviewResult,
    Severity,
    VerifiedFinding
} from '../contracts/review';
import { createLogger } from '../logger';
import {
    AgentRosterError,
    type AgentSpec,
    buildAgentRoster,
    canResolveModelRoute,
    resolveModelRoute,
    selectAgentPlan
} from './agents';
import {
    createDeadline,
    type DeadlineHandle,
    type PipelineDeps,
    runCoordinatorStep,
    runSpecialistStep
} from './pipeline-steps';
import { loadPrompts } from './prompts';
import { type ReviewGuidance, reviewGuidanceProvenance } from './guidance';
import { AgentStepError, toFailure } from './step-failure';
import { verifyFindings } from './verifier';

const log = createLogger('pipeline');

export interface PipelineInput {
    context: ReviewContext;
    config: ResolvedReviewConfig;
    credentials: EffectiveRun;
    risk: RiskAssessment;
    coverage: DiffCoverage;
    /* Deterministic pre-pass output; absent in focused unit tests only. */
    intelligence?: ReviewMap;
    runtime: AiRuntime;
    vcs: { getFileContent: (path: string, ref: string, signal?: AbortSignal) => Promise<string | null> };
    /* Untrusted user intent; it reaches specialist prompts only. */
    guidance?: ReviewGuidance;
    signal?: AbortSignal;
    deadline?: DeadlineHandle;
}

export interface PipelineOutput {
    result: ReviewResult;
}

interface MaterializedCandidate extends CandidateFinding {
    id: string;
    fingerprint: string;
    sourceAgents: string[];
}

/* Pipeline v1: specialists in parallel, coordinator, then parallel verification.
   All steps share one deadline; fail-fast or continue-partial per config. */
export async function runReviewPipeline(input: PipelineInput): Promise<PipelineOutput> {
    const ownsDeadline = input.deadline === undefined;
    const deadline = input.deadline ?? createDeadline(input.config.review.deadlineMinutes, input.signal);

    try {
        const prompts = await loadPrompts(input.vcs, input.context.baseSha, {
            ...input.config.prompts,
            signal: deadline.signal
        });

        const deps: PipelineDeps = {
            runtime: input.runtime,
            prompts,
            modelFor: (agentId) => modelFor(input, agentId),
            projectionFor: (agentId) => projectionFor(input, agentId),
            guidance: input.guidance,
            guidanceProvenance: reviewGuidanceProvenance(input.guidance)
        };

        const plan = selectAgentPlan({
            roster: buildAgentRoster(input.config),
            tier: input.risk.tier,
            requiredSpecialists: input.risk.requiredSpecialists,
            plan: input.config.agents.plan
        });

        const specialists = plan.filter((spec) => spec.id !== 'coordinator' && spec.id !== 'verifier');
        const coordinatorSpec = plan.find((spec) => spec.id === 'coordinator');
        const verifierSpec = plan.find((spec) => spec.id === 'verifier');
        log.info('Selected agent plan', { tier: input.risk.tier, agents: plan.map((spec) => spec.id) });
        const failures: ReviewFailure[] = [];

        /* Fail closed before the first provider call: each active pair must
           resolve via matrix or global fallback. */
        const unresolvedAgents = plan
            .filter((spec) => !canResolveModelRoute(input.config, spec.id, input.risk.tier))
            .map((spec) => spec.id);

        if (unresolvedAgents.length > 0) {
            failures.push({
                kind: 'runtime-failure',
                stage: 'plan',
                message: `No model route resolved for ${unresolvedAgents.join(', ')} at tier ${input.risk.tier}.`
            });

            return incompleteResult(input, failures, []);
        }

        if (coordinatorSpec === undefined || verifierSpec === undefined) {
            failures.push({
                kind: 'runtime-failure',
                stage: 'plan',
                message: 'Coordinator or verifier missing from the plan.'
            });

            return incompleteResult(input, failures, []);
        }

        const failFastController =
            input.config.review.failurePolicy === 'fail-fast' ? new AbortController() : undefined;

        const specialistDeadline =
            failFastController === undefined ? deadline : deadlineWithCancellation(deadline, failFastController);

        const settled = await Promise.allSettled(
            specialists.map(async (spec) => {
                try {
                    return await runSpecialistStep(spec, deps, input.context, specialistDeadline);
                } catch (error) {
                    failFastController?.abort();
                    throw error;
                }
            })
        );

        if (failFastController !== undefined) {
            specialistDeadline.cancel();
        }

        const succeeded = settled.filter((outcome) => outcome.status === 'fulfilled').length;
        log.info('Specialist stages settled', {
            specialists: specialists.length,
            succeeded,
            failed: settled.length - succeeded
        });
        const candidates = collectCandidates(settled, failures, input.config.review.failurePolicy);

        if (candidates === null) {
            return incompleteResult(input, failures, []);
        }

        const coordinatorOutcome = await guardedCoordinator(
            coordinatorSpec,
            deps,
            input.context,
            candidates,
            deadline,
            failures
        );

        if (coordinatorOutcome === null) {
            return incompleteResult(input, failures, []);
        }

        const adjudicated = adjudicate(candidates, coordinatorOutcome.findings, failures);
        log.info('Coordinator adjudicated candidates', {
            candidates: candidates.length,
            retained: coordinatorOutcome.findings.length
        });

        const verification = await verifyFindings({
            findings: adjudicated,
            tier: input.risk.tier,
            runtime: input.runtime,
            prompts,
            modelFor: deps.modelFor,
            diff: input.context.diff,
            projection: deps.projectionFor('verifier'),
            guidance: deps.guidanceProvenance,
            deadline
        });

        failures.push(...verification.failures);
        log.info('Verification completed', {
            attempted: adjudicated.length,
            verified: verification.verified.size,
            unverified: adjudicated.length - verification.verified.size,
            failures: verification.failures.length
        });

        return { result: assembleResult(input, adjudicated, verification, failures) };
    } finally {
        if (ownsDeadline) {
            deadline.cancel();
        }
    }
}

/* Per-agent projection: enriched for maintainability/correctness/performance,
   compact for every other agent including security. */
function projectionFor(input: PipelineInput, agentId: string): string {
    if (input.intelligence === undefined) {
        return '';
    }

    return projectReviewMap({
        map: input.intelligence,
        coverage: input.coverage,
        kind: projectionKindFor(agentId)
    });
}

function deadlineWithCancellation(parent: DeadlineHandle, controller: AbortController): DeadlineHandle {
    function cancelFromParent(): void {
        controller.abort();
    }

    if (parent.signal.aborted) {
        controller.abort();
    } else {
        parent.signal.addEventListener('abort', cancelFromParent, { once: true });
    }

    return {
        signal: controller.signal,
        isExpired: () => controller.signal.aborted,
        configure: parent.configure,
        cancel: () => {
            parent.signal.removeEventListener('abort', cancelFromParent);
        }
    };
}

/* Shares the model resolution used for the provider catalogue: one source, so
   a routed model cannot miss from OpenCode. A miss here is a bug: the plan is
   checked before any specialist runs. */
function modelFor(input: PipelineInput, agentId: string): { providerID: string; modelID: string; variant?: string } {
    const route = resolveModelRoute(input.config, agentId, input.risk.tier);

    if (route.model === undefined) {
        throw new AgentRosterError(`No model route resolved for agent "${agentId}" at tier "${input.risk.tier}".`);
    }

    // eslint-disable-next-line anti-slop/no-known-value-widening -- literal matches the declared model contract
    return { providerID: input.credentials.provider, modelID: route.model, variant: route.variant };
}

/* Fail-fast stops at the first required failure. Continue-partial keeps
   successes; the final status stays incomplete. */
function collectCandidates(
    settled: PromiseSettledResult<{ candidates: MaterializedFinding[] }>[],
    failures: ReviewFailure[],
    policy: 'fail-fast' | 'continue-partial'
): MaterializedCandidate[] | null {
    for (const outcome of settled) {
        if (outcome.status === 'rejected') {
            failures.push(
                outcome.reason instanceof AgentStepError
                    ? outcome.reason.failure
                    : toFailure('agent:unknown', outcome.reason)
            );
        }
    }

    if (failures.length > 0 && policy === 'fail-fast') {
        return null;
    }

    const fulfilled = settled.filter(
        (outcome): outcome is PromiseFulfilledResult<{ candidates: MaterializedFinding[] }> =>
            outcome.status === 'fulfilled'
    );

    return fulfilled.flatMap((outcome) => outcome.value.candidates);
}

interface CoordinatorFindingSummary {
    sourceIds: string[];
    severity: Severity;
    title: string;
    impact: string;
    evidence: string;
    location?: { file: string; line?: number; lineEnd?: number };
    suggestedFix?: string;
}

async function guardedCoordinator(
    spec: AgentSpec,
    deps: PipelineDeps,
    context: ReviewContext,
    candidates: MaterializedCandidate[],
    deadline: DeadlineHandle,
    failures: ReviewFailure[]
): Promise<{ summary: string; findings: CoordinatorFindingSummary[] } | null> {
    try {
        return await runCoordinatorStep(spec, deps, context, candidates, deadline);
    } catch (error) {
        // SAFETY: failure is probed as an optional property; AgentStepError carries it, other errors use the runtime-failure fallback.
        const { failure } = error as { failure?: ReviewFailure };
        failures.push(failure ?? { kind: 'runtime-failure', stage: 'agent:coordinator', message: String(error) });

        return null;
    }
}

/* Adjudication: each coordinator finding must reference known candidate ids;
   source agents are rebuilt from the originals and survive dedup. */
function adjudicate(
    candidates: MaterializedCandidate[],
    coordinatorFindings: CoordinatorFindingSummary[],
    failures: ReviewFailure[]
): MaterializedFinding[] {
    const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    const adjudicated: MaterializedFinding[] = [];

    for (const finding of coordinatorFindings) {
        const unknownIds = finding.sourceIds.filter((id) => !byId.has(id));

        if (unknownIds.length > 0) {
            failures.push({
                kind: 'invalid-output',
                stage: 'agent:coordinator',
                message: `Coordinator referenced unknown candidate ids: ${unknownIds.join(', ')}`
            });
            continue;
        }

        const sources = finding.sourceIds.map((id) => byId.get(id)!);
        const [primary] = sources;

        if (primary === undefined) {
            continue;
        }

        const sourceAgents = [...new Set(sources.flatMap((source) => source.sourceAgents))];
        adjudicated.push({
            ...primary,
            severity: finding.severity,
            title: finding.title,
            impact: finding.impact,
            evidence: finding.evidence,
            location: finding.location ?? primary.location,
            suggestedFix: finding.suggestedFix ?? primary.suggestedFix,
            sourceAgents
        });
    }

    return adjudicated;
}

function assembleResult(
    input: PipelineInput,
    adjudicated: MaterializedFinding[],
    verification: {
        verified: Map<string, { state: 'confirmed' | 'rejected'; reason: string }>;
        failures: ReviewFailure[];
    },
    failures: ReviewFailure[]
): ReviewResult {
    const verified: VerifiedFinding[] = [];
    const unverified: VerifiedFinding[] = [];

    for (const candidate of adjudicated) {
        const outcome = verification.verified.get(candidate.id);

        const entry: VerifiedFinding = {
            severity: candidate.severity,
            category: candidate.category,
            title: candidate.title,
            impact: candidate.impact,
            evidence: candidate.evidence,
            location: candidate.location,
            suggestedFix: candidate.suggestedFix,
            id: candidate.id,
            fingerprint: candidate.fingerprint,
            sourceAgents: candidate.sourceAgents,
            verification:
                outcome === undefined
                    ? { state: 'unverified' }
                    : { state: outcome.state, reason: outcome.reason, verifiedBy: 'verifier' }
        };

        if (outcome === undefined) {
            unverified.push(entry);
        } else {
            verified.push(entry);
        }
    }

    return finalize(input, verified, unverified, failures);
}

/* Final status: only a confirmed Blocker gives changes_required; other confirmed
   findings give comments, else clean. Any loss leaves the review incomplete. */
function finalize(
    input: PipelineInput,
    verified: VerifiedFinding[],
    unverified: VerifiedFinding[],
    failures: ReviewFailure[]
): ReviewResult {
    const base = {
        riskSummary: input.context.riskSummary,
        riskTier: input.risk.tier,
        reviewedHeadSha: input.context.headSha,
        findings: verified,
        intelligence: input.intelligence
    };

    const coverageFailures = coverageFailure(input.coverage);

    if (failures.length > 0 || coverageFailures.length > 0) {
        return {
            ...base,
            status: 'incomplete',
            verdict: null,
            unverifiedFindings: unverified,
            failures: failuresOrPlaceholder([...failures, ...coverageFailures])
        };
    }

    const findings = [...verified, ...unverified];
    const confirmed = findings.filter((finding) => finding.verification.state === 'confirmed');
    const confirmedBlocker = confirmed.some((finding) => finding.severity === 'Blocker');
    let verdict: 'clean' | 'comments' | 'changes_required' = 'clean';

    if (confirmedBlocker) {
        verdict = 'changes_required';
    } else if (confirmed.length > 0) {
        verdict = 'comments';
    }

    return { ...base, findings, status: 'complete', verdict };
}

function failuresOrPlaceholder(failures: ReviewFailure[]): ReviewFailure[] {
    if (failures.length > 0) {
        return failures;
    }

    return [{ kind: 'unknown', stage: 'pipeline', message: 'Review ended incomplete.' }];
}

/* Forced partial reviews must name what was skipped, so findings never read as
   exhaustive. Paths are untrusted and rendered as code spans. */
function coverageFailure(coverage: DiffCoverage): ReviewFailure[] {
    if (coverage.complete) {
        return [];
    }

    const reviewable = coverage.files.filter((file) => isReviewableFile(file));
    const unReviewed = reviewable.filter((file) => !isCoveredFile(file)).map((file) => file.path);

    return [{ kind: 'runtime-failure', stage: 'coverage', message: describeUnreviewed(unReviewed, reviewable.length) }];
}

function describeUnreviewed(unReviewed: string[], reviewableCount: number): string {
    if (unReviewed.length === 0) {
        return 'Diff coverage is incomplete.';
    }

    return `Diff coverage is incomplete: ${unReviewed.length} of ${reviewableCount} reviewable files were not fully reviewed: ${unReviewed.map((path) => inlineCode(path)).join(', ')}.`;
}

function incompleteResult(
    input: PipelineInput,
    failures: ReviewFailure[],
    unverified: VerifiedFinding[]
): PipelineOutput {
    return {
        result: {
            riskSummary: input.context.riskSummary,
            riskTier: input.risk.tier,
            reviewedHeadSha: input.context.headSha,
            findings: [],
            status: 'incomplete',
            verdict: null,
            unverifiedFindings: unverified,
            intelligence: input.intelligence,
            failures: failuresOrPlaceholder([...failures, ...coverageFailure(input.coverage)])
        }
    };
}
