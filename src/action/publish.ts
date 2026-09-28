import type { getOctokit } from '@actions/github';
import { redactSensitive } from '../logger';

type OctokitLike = ReturnType<typeof getOctokit>;

export interface RepoContext {
    owner: string;
    repo: string;
}

interface CommentTarget {
    octokit: OctokitLike;
    repository: RepoContext;
    issueNumber: number;
}

export async function postComment(target: CommentTarget, body: string, signal?: AbortSignal): Promise<number> {
    const { octokit, repository, issueNumber } = target;

    const response = await octokit.rest.issues.createComment({
        owner: repository.owner,
        repo: repository.repo,
        issue_number: issueNumber,
        body: redactSensitive(body),
        ...requestOptions(signal)
    });

    return response.data.id;
}

export async function updateComment(input: {
    target: CommentTarget;
    commentId: number;
    body: string;
    signal?: AbortSignal;
}): Promise<void> {
    const { target, commentId, body, signal } = input;
    const { octokit, repository } = target;
    await octokit.rest.issues.updateComment({
        owner: repository.owner,
        repo: repository.repo,
        comment_id: commentId,
        body: redactSensitive(body),
        ...requestOptions(signal)
    });
}

function requestOptions(signal?: AbortSignal): { request?: { signal: AbortSignal } } {
    if (signal === undefined) {
        // eslint-disable-next-line anti-slop/no-known-value-widening -- absent signal means no request options
        return {};
    }

    // eslint-disable-next-line anti-slop/no-known-value-widening -- Octokit request-option bag owned by the Octokit contract
    return { request: { signal } };
}

export type { CommentTarget, OctokitLike };
