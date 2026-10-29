import * as core from '@actions/core';
import { homedir } from 'node:os';
import type { ReviewMap } from '../intelligence/schema';
import { reviewMapLogPayload } from '../intelligence/log';
import { createNativeIntelligenceRun } from '../intelligence/native-run';
import { describeError } from '../errors';
import { redactSensitive } from '../logger';
import { PRODUCT_NAME } from '../identity';
import { type NativeRuntime, resolveNativeRuntime } from '../native/runtime';
import type { ReviewGuidance, TriggerGuidanceChoice } from '../review/guidance';
import { GitHubVcs } from '../vcs/github';
import { createTrustedWorkspace } from '../workspace/trusted';
import { type ParsedCommand, resolveTriggerGuidance } from './commands';
import { DiffBudgetExceededError } from './errors';
import type { ActionInputs } from './inputs';
import { postComment, updateComment } from './publish';
import { type ReviewCycleDeps, runReviewCycle } from './run';
import { buildBudgetAbortComment, type PublishedResult } from './state';

export interface TriggerEvent {
    pullRequestNumber: number;
    commentId: number;
    commentBody: string;
    authorAssociation?: string;
}

export interface ReviewCommandInput {
    inputs: ActionInputs;
    trigger: TriggerEvent;
    command: ParsedCommand;
    target: Parameters<typeof postComment>[0];
}

export async function executeReview(input: ReviewCommandInput): Promise<void> {
    const published = await runCycle(input);

    if (published?.result.status === 'incomplete') {
        core.setFailed(`${PRODUCT_NAME} completed with an incomplete review. See the published diagnostics.`);
    }
}

/* Undefined when a budget abort was already answered, so the caller does not
   treat it as a result. */
async function runCycle(input: ReviewCommandInput): Promise<PublishedResult | undefined> {
    try {
        return await runReviewCycle(await cycleDeps(input));
    } catch (error) {
        if (error instanceof DiffBudgetExceededError) {
            await reportBudgetAbort(input.target, error, input.inputs.triggerCommand);
            core.setFailed(redactSensitive(error.message));

            return undefined;
        }

        throw error;
    }
}

async function cycleDeps(input: ReviewCommandInput): Promise<ReviewCycleDeps> {
    const { inputs, trigger, command, target } = input;
    const { octokit, repository } = target;
    const native = await resolveNativeEnvironment();
    /* `--force` re-reviews; `--force-over-budget` also covers budget refusal. */
    const commandForces = command.mode === 'review-force-over-budget';
    const triggerGuidance = resolveTriggerGuidance(command);

    if (triggerGuidance.kind === 'ignored') {
        core.warning(triggerGuidance.warning);
    }

    return {
        vcs: new GitHubVcs({ octokit, repository }),
        inputs,
        prNumber: trigger.pullRequestNumber,
        runId: process.env.GITHUB_RUN_ID,
        execution: 'github-action',
        guidance: acceptedGuidance(triggerGuidance),
        force: commandForces || command.mode === 'review-force',
        forceOverBudget: commandForces || inputs.forceOverBudget,
        /* SCC runs only when a step needs it: an over-budget abort skips it. */
        runIntelligence: createNativeIntelligenceRun(native),
        logIntelligence,
        /* The Action reviews an ephemeral workspace with BASE AGENTS.md; the
           workflow checkout is never trusted. */
        createWorkspace: (request) => createTrustedWorkspace({ repositoryDir: process.cwd(), ...request }),
        createRuntime: async ({ effective, config, signal, worktreeDir }) => {
            const { createActionRuntime } = await import('./runtime-factory');

            return createActionRuntime({
                effective,
                config,
                isMockMode: inputs.isMockMode,
                native,
                signal,
                checkoutDir: worktreeDir
            });
        },
        publication: {
            triggerCommentId: trigger.commentId,
            create: (body, signal) => postComment(target, body, signal),
            update: (commentId, body, signal) => updateComment({ target, commentId, body, signal })
        }
    };
}

/* Only accepted guidance reaches the pipeline; `none` and `ignored` stay empty. */
function acceptedGuidance(choice: TriggerGuidanceChoice): ReviewGuidance | undefined {
    if (choice.kind === 'accepted') {
        return choice.guidance;
    }

    return undefined;
}

function resolveNativeEnvironment(): Promise<NativeRuntime> {
    return resolveNativeRuntime({
        platform: process.platform,
        architecture: process.arch,
        environment: process.env,
        home: homedir()
    });
}

/* CI observability: full ReviewMap JSON in a collapsible group. */
function logIntelligence(map: ReviewMap): void {
    core.startGroup(`${PRODUCT_NAME} ReviewMap`);
    core.info(reviewMapLogPayload(map));
    core.endGroup();
}

/* The abort must reach the PR even with no review comment yet; a publish failure
   is reported but never hides the budget failure. */
async function reportBudgetAbort(
    target: Parameters<typeof postComment>[0],
    error: DiffBudgetExceededError,
    triggerCommand: string
): Promise<void> {
    try {
        await postComment(target, buildBudgetAbortComment(error.report, triggerCommand));
    } catch (publishError) {
        core.warning(`Failed to publish the over-budget explanation: ${describeError(publishError)}`);
    }
}
