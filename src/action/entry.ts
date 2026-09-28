import * as core from '@actions/core';
import { context, getOctokit } from '@actions/github';
import { homedir } from 'node:os';
import type { ReviewMap } from '../intelligence/schema';
import { reviewMapLogPayload } from '../intelligence/log';
import { createNativeIntelligenceRun } from '../intelligence/native-run';
import { runAuthCli } from '../cli/auth';
import { runLocalCli } from '../cli/local';
import { routeRootCli, writeCliError } from '../cli/root';
import { describeError } from '../errors';
import { configureLogRedaction, redactSensitive } from '../logger';
import { CLI_AUTH_COMMAND, CLI_LOCAL_COMMAND, PRODUCT_NAME } from '../identity';
import { type NativeRuntime, resolveNativeRuntime } from '../native/runtime';
import type { ReviewGuidance, TriggerGuidanceChoice } from '../review/guidance';
import { GitHubVcs } from '../vcs/github';
import { createTrustedWorkspace } from '../workspace/trusted';
import { isAllowedAuthorAssociation, type ParsedCommand, parseReviewCommand, resolveTriggerGuidance } from './commands';
import { AlreadyReviewedError, DiffBudgetExceededError } from './errors';
import { type ActionInputs, ActionInputsError, readActionInputs } from './inputs';
import { postComment, updateComment } from './publish';
import { type ReviewCycleDeps, runReviewCycle } from './run';
import { buildBudgetAbortComment, type PublishedResult } from './state';
import { createActionRuntime } from './runtime-factory';

interface TriggerEvent {
    pullRequestNumber: number;
    commentId: number;
    commentBody: string;
    authorAssociation?: string;
}

async function main(): Promise<void> {
    configureLogRedaction([core.getInput('github_token'), core.getInput('provider_api_key')]);
    const inputs = readActionInputs({ getInput: (name) => core.getInput(name) });
    configureLogRedaction([inputs.githubToken, inputs.credentials.apiKey ?? '']);
    const trigger = readTriggerEvent(context.eventName, context.payload);

    if (trigger === undefined) {
        core.info('Skipping because the event is not an issue_comment on a pull request.');

        return;
    }

    await handleTrigger(inputs, trigger);
}

async function handleTrigger(inputs: ActionInputs, trigger: TriggerEvent): Promise<void> {
    if (!isAllowedAuthorAssociation(trigger.authorAssociation, inputs.allowedAuthorAssociations)) {
        core.info('Skipping because the comment author association is not allowed.');

        return;
    }

    const command = parseReviewCommand(trigger.commentBody, inputs.triggerCommand);

    if (command.mode === 'none') {
        core.info('Skipping because the comment does not contain the review command.');

        return;
    }

    await dispatchCommand(inputs, trigger, command);
}

async function dispatchCommand(inputs: ActionInputs, trigger: TriggerEvent, command: ParsedCommand): Promise<void> {
    const octokit = getOctokit(inputs.githubToken);
    const target = { octokit, repository: context.repo, issueNumber: trigger.pullRequestNumber };

    if (command.mode === 'invalid') {
        await postComment(target, invalidCommandHelp(inputs.triggerCommand));

        return;
    }

    if (command.mode === 'diagnostic') {
        await postComment(target, diagnosticComment(inputs.provider, inputs.configPath));

        return;
    }

    await executeReview({ inputs, trigger, command, target });
}

async function executeReview(input: {
    inputs: ActionInputs;
    trigger: TriggerEvent;
    command: ParsedCommand;
    target: Parameters<typeof postComment>[0];
}): Promise<void> {
    const published = await runCycle(input);

    if (published?.result.status === 'incomplete') {
        core.setFailed(`${PRODUCT_NAME} completed with an incomplete review. See the published diagnostics.`);
    }
}

/* Undefined when a budget abort was already answered, so the caller does not
   treat it as a result. */
async function runCycle(input: {
    inputs: ActionInputs;
    trigger: TriggerEvent;
    command: ParsedCommand;
    target: Parameters<typeof postComment>[0];
}): Promise<PublishedResult | undefined> {
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

async function cycleDeps(input: {
    inputs: ActionInputs;
    trigger: TriggerEvent;
    command: ParsedCommand;
    target: Parameters<typeof postComment>[0];
}): Promise<ReviewCycleDeps> {
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
        createRuntime: ({ effective, config, signal, worktreeDir }) =>
            createActionRuntime({
                effective,
                config,
                isMockMode: inputs.isMockMode,
                native,
                signal,
                checkoutDir: worktreeDir
            }),
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

// eslint-disable-next-line anti-slop/no-unknown-parameters -- untrusted GitHub webhook payload parsed via narrowing below
function readTriggerEvent(eventName: string, payload: unknown): TriggerEvent | undefined {
    if (eventName !== 'issue_comment' || !isRecord(payload)) {
        return undefined;
    }

    const { issue, comment } = payload;

    if (!isRecord(issue) || !isRecord(issue.pull_request) || !isRecord(comment)) {
        return undefined;
    }

    // eslint-disable-next-line anti-slop/no-runtime-typeof -- intentional narrowing of webhook fields after isRecord checks
    if (typeof issue.number !== 'number' || typeof comment.id !== 'number' || typeof comment.body !== 'string') {
        return undefined;
    }

    return {
        pullRequestNumber: issue.number,
        commentId: comment.id,
        commentBody: comment.body,
        authorAssociation: optionalString(comment.author_association)
    };
}

// eslint-disable-next-line anti-slop/no-unknown-parameters -- untrusted webhook field narrowed to string below
function optionalString(value: unknown): string | undefined {
    // eslint-disable-next-line anti-slop/no-runtime-typeof -- intentional narrowing after explicit check
    if (typeof value === 'string') {
        return value;
    }

    return undefined;
}

// eslint-disable-next-line anti-slop/no-unsafe-dictionary-type -- untrusted boundary guard; fields narrowed per-site below
function isRecord(value: unknown): value is Record<string, unknown> {
    // eslint-disable-next-line anti-slop/no-runtime-typeof -- intentional narrowing in type predicate
    return typeof value === 'object' && value !== null;
}

function invalidCommandHelp(triggerCommand: string): string {
    return `Invalid command. Use \`${triggerCommand}\`, \`${triggerCommand} --force\`, \`${triggerCommand} --force-over-budget\`, or \`${triggerCommand} --diagnostic\`.`;
}

function diagnosticComment(provider: string | undefined, configPath: string): string {
    let providerLabel = '(from protected config)';

    if (provider !== undefined) {
        providerLabel = provider;
    }

    return [
        `## ${PRODUCT_NAME} diagnostic`,
        '',
        `Provider input: \`${providerLabel}\``,
        `Protected config path: \`${configPath}\``,
        'No provider call was made.'
    ].join('\n');
}

async function runActionEntrypoint(): Promise<void> {
    try {
        await main();
    } catch (error) {
        if (error instanceof AlreadyReviewedError) {
            core.info(redactSensitive(error.message));
        } else if (error instanceof ActionInputsError) {
            core.setFailed(redactSensitive(error.message));
        } else {
            core.setFailed(redactSensitive(describeError(error)));
        }
    }
}

/* Assets resolve only when `auth login` stored a credential, so `auth --help`
   answers on unsupported platforms or unwritable caches. Failures here are
   CLI errors, not Action annotations. */
async function runAuthEntrypoint(args: string[]): Promise<number> {
    try {
        return await runAuthCli(args, { native: resolveNativeEnvironment });
    } catch (error) {
        writeCliError(process.stderr, error);

        return 1;
    }
}

/* Dispatch precedes init: `--help`/`--version` answer at once, `local`/`auth`
   run the standalone CLI, and no args means the Action entrypoint. */
const route = routeRootCli(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr });

switch (route.command) {
    case 'exit': {
        process.exitCode = route.exitCode;
        break;
    }

    case CLI_LOCAL_COMMAND: {
        process.exitCode = await runLocalCli(route.args);
        break;
    }

    case CLI_AUTH_COMMAND: {
        process.exitCode = await runAuthEntrypoint(route.args);
        break;
    }

    case 'action': {
        await runActionEntrypoint();
        break;
    }

    default: {
        assertNever(route);
    }
}

/* New routes fail compile until they own a handler; never fall through to Action
   validation. */
function assertNever(unhandled: never): never {
    throw new Error(`Unhandled root CLI route: ${JSON.stringify(unhandled)}.`);
}
