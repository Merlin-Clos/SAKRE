import * as core from '@actions/core';
import { context, getOctokit } from '@actions/github';
import { describeError } from '../errors';
import { configureLogRedaction, redactSensitive } from '../logger';
import { PRODUCT_NAME } from '../identity';
import { isAllowedAuthorAssociation, type ParsedCommand, parseReviewCommand } from './commands';
import { AlreadyReviewedError } from './errors';
import { type ActionInputs, ActionInputsError, readActionInputs } from './inputs';
import { postComment } from './publish';
import type { ReviewCommandInput, TriggerEvent } from './execute-review';

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

    await executeReviewCommand({ inputs, trigger, command, target });
}

async function executeReviewCommand(input: ReviewCommandInput): Promise<void> {
    const { executeReview } = await import('./execute-review');

    await executeReview(input);
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

export async function runActionEntrypoint(): Promise<void> {
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
