import { AiError } from '../ai/runtime';
import type { ReviewFailure, ReviewFailureKind } from '../contracts/review';
import { z } from 'zod';

export function reviewFailure(kind: ReviewFailureKind, stage: string, message: string): ReviewFailure {
    return { kind, stage, message };
}

// eslint-disable-next-line anti-slop/no-unknown-parameters -- thrown step values cross this boundary as unknown
export function describeStepError(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }

    return String(error);
}

// eslint-disable-next-line anti-slop/no-unknown-parameters -- thrown step values cross this boundary as unknown
export function toFailure(stage: string, error: unknown): ReviewFailure {
    if (error instanceof AiError) {
        return reviewFailure(error.kind, stage, error.message);
    }

    if (error instanceof z.ZodError) {
        return reviewFailure('invalid-output', stage, summarizeValidationFailure(error));
    }

    return reviewFailure('runtime-failure', stage, describeStepError(error));
}

function summarizeValidationFailure(error: z.ZodError): string {
    const unknownKeyIssues = error.issues.filter((issue) => issue.code === 'unrecognized_keys');

    const findingIssues = unknownKeyIssues.filter(
        (issue) =>
            // eslint-disable-next-line anti-slop/no-runtime-typeof -- narrows zod issue paths
            (issue.path[0] === 'findings' && typeof issue.path[1] === 'number') ||
            // eslint-disable-next-line anti-slop/no-runtime-typeof -- narrows zod issue paths
            (typeof issue.path[0] === 'number' && issue.path.length === 1)
    );

    const unsupportedKeys = [...new Set(unknownKeyIssues.flatMap((issue) => issue.keys))].toSorted();

    if (findingIssues.length > 0 && unsupportedKeys.length > 0) {
        const keyList = unsupportedKeys.map((key) => `"${key}"`).join(', ');

        return `${String(findingIssues.length)} returned finding(s) contained unsupported field(s): ${keyList}.`;
    }

    return summarizeFirstIssue(error);
}

function summarizeFirstIssue(error: z.ZodError): string {
    const [firstIssue] = error.issues;

    if (firstIssue === undefined) {
        return 'Output did not match the required schema.';
    }

    let issuePath = firstIssue.path.map(String).join('.');

    if (issuePath === '') {
        issuePath = 'root';
    }

    return `Output did not match the required schema at ${issuePath} (${firstIssue.code}).`;
}

export class AgentStepError extends Error {
    public readonly failure: ReviewFailure;

    public constructor(stage: string, failure: ReviewFailure) {
        super(`${stage} failed: ${failure.message}`);
        this.name = 'AgentStepError';
        this.failure = failure;
    }
}
