import type { getOctokit } from '@actions/github';
import {
    changedFileStatuses,
    type VcsChangedFile,
    type VcsClient,
    type VcsFilePatch,
    type VcsPullRequest,
    type VcsPullRequestSnapshot,
    type VcsReviewComment
} from './types';
import { wrapVcsError } from './errors';
import { METADATA_COMMENT_MARKER, REVIEW_COMMENT_MARKER } from '../identity';

const HTTP_NOT_FOUND = 404;

const REVIEW_HISTORY_LIMIT = 10;

const BOT_COMMENT_MARKERS = [REVIEW_COMMENT_MARKER, METADATA_COMMENT_MARKER] as const;

const DEFAULT_BOT_LOGIN = 'github-actions[bot]';

interface VcsRepositoryContext {
    owner: string;
    repo: string;
}

type OctokitLike = ReturnType<typeof getOctokit>;

interface GitHubVcsOptions {
    octokit: OctokitLike;
    repository: VcsRepositoryContext;
    expectedBotLogin?: string;
}

/* GitHub adapter: maps Octokit responses to internal contracts before leaving
   the module. Pagination goes through octokit.paginate. */
export class GitHubVcs implements VcsClient {
    private readonly octokit: OctokitLike;
    private readonly repository: VcsRepositoryContext;
    private readonly expectedBotLogin: string;

    public constructor(options: GitHubVcsOptions) {
        this.octokit = options.octokit;
        this.repository = options.repository;
        this.expectedBotLogin = options.expectedBotLogin ?? DEFAULT_BOT_LOGIN;
    }

    private async getPull(
        number: number,
        operation: string,
        signal?: AbortSignal
    ): Promise<{
        data: {
            number: number;
            title: string;
            body: string | null;
            user?: { login?: string | null } | null;
            base: { ref: string; sha: string };
            head: { ref: string; sha: string };
        };
    }> {
        try {
            return await this.octokit.rest.pulls.get({
                owner: this.repository.owner,
                repo: this.repository.repo,
                pull_number: number,
                ...requestOptions(signal)
            });
        } catch (error) {
            throw wrapVcsError(operation, error);
        }
    }

    public async getPullRequestSnapshot(number: number, signal?: AbortSignal): Promise<VcsPullRequestSnapshot> {
        const pullResponse = await this.getPull(number, 'pulls.get', signal);

        const [changedFiles, comments] = await Promise.all([
            this.listChangedFiles(number, signal),
            this.listReviewComments(number, signal)
        ]);

        return { pullRequest: this.mapPullRequest(pullResponse.data), changedFiles, comments };
    }

    /* GitHub returns patch content with the file list, so every allocation is
       already retained and there is nothing left to read. */
    public readonly materializeCoveragePatches = (
        files: readonly VcsChangedFile[],
        _allocations: ReadonlyMap<string, number>
    ): Promise<VcsChangedFile[]> => Promise.resolve([...files]);

    private async getContent(path: string, ref: string, signal?: AbortSignal): Promise<ContentResponse | null> {
        try {
            return await this.octokit.rest.repos.getContent({
                owner: this.repository.owner,
                repo: this.repository.repo,
                path,
                ref,
                ...requestOptions(signal)
            });
        } catch (error) {
            if (isNotFoundStatus(error)) {
                return null;
            }

            throw wrapVcsError('repos.getContent', error);
        }
    }

    public async getFileContent(path: string, ref: string, signal?: AbortSignal): Promise<string | null> {
        const response = await this.getContent(path, ref, signal);

        if (response === null) {
            return null;
        }

        return decodeFileContent(response.data);
    }

    public async getCurrentHeadSha(number: number, signal?: AbortSignal): Promise<string> {
        const pullResponse = await this.getPull(number, 'pulls.getHead', signal);

        return pullResponse.data.head.sha;
    }

    private mapPullRequest(data: {
        number: number;
        title: string;
        body: string | null;
        user?: { login?: string | null } | null;
        base: { ref: string; sha: string };
        head: { ref: string; sha: string };
    }): VcsPullRequest {
        return {
            owner: this.repository.owner,
            repo: this.repository.repo,
            number: data.number,
            title: data.title,
            body: data.body ?? '',
            authorLogin: data.user?.login ?? 'unknown',
            baseRef: data.base.ref,
            baseSha: data.base.sha,
            headRef: data.head.ref,
            headSha: data.head.sha
        };
    }

    private async listChangedFiles(number: number, signal?: AbortSignal): Promise<VcsChangedFile[]> {
        const files = await paginated('pulls.listFiles', () =>
            this.octokit.paginate(this.octokit.rest.pulls.listFiles, {
                owner: this.repository.owner,
                repo: this.repository.repo,
                pull_number: number,
                per_page: 100,
                ...requestOptions(signal)
            })
        );

        return files.map((file) => ({
            path: file.filename,
            previousPath: file.previous_filename,
            status: mapFileStatus(file.status),
            additions: file.additions,
            deletions: file.deletions,
            patch: mapVcsPatch(file)
        }));
    }

    private async listReviewComments(number: number, signal?: AbortSignal): Promise<VcsReviewComment[]> {
        const comments = await paginated('issues.listComments', () =>
            this.octokit.paginate(this.octokit.rest.issues.listComments, {
                owner: this.repository.owner,
                repo: this.repository.repo,
                issue_number: number,
                per_page: 100,
                ...requestOptions(signal)
            })
        );

        return selectReviewComments(comments, this.expectedBotLogin);
    }
}

interface GitHubIssueCommentLike {
    id: number;
    body?: string | null;
    created_at: string;
    user?: { type?: string | null; login?: string | null } | null;
}

/* Shared by the Action adapter and the local GitHub context: only the bot's
   own marked review comments become review history. */
export function selectReviewComments(
    comments: GitHubIssueCommentLike[],
    expectedBotLogin: string = DEFAULT_BOT_LOGIN
): VcsReviewComment[] {
    return comments
        .filter((comment) => isTrustedReviewComment(comment, expectedBotLogin))
        .toSorted((left, right) => right.created_at.localeCompare(left.created_at))
        .slice(0, REVIEW_HISTORY_LIMIT)
        .map((comment) => ({
            id: comment.id,
            body: comment.body ?? '',
            createdAt: comment.created_at,
            authorType: mapAuthorType(comment.user?.type)
        }));
}

async function paginated<TResult>(operation: string, run: () => Promise<TResult[]>): Promise<TResult[]> {
    try {
        return await run();
    } catch (error) {
        throw wrapVcsError(operation, error);
    }
}

function mapFileStatus(status: string): VcsChangedFile['status'] {
    const mapped = changedFileStatuses.find((candidate) => candidate === status);

    return mapped ?? 'modified';
}

/* API omits `patch` both for binary files and for text diffs too large to
   inline. `additions + deletions` separates the two: a text change with line
   counts is reviewable content that must never be reported as covered. */
function mapVcsPatch(file: { patch?: string; additions: number; deletions: number }): VcsFilePatch {
    if (file.patch !== undefined) {
        return { state: 'retained', chars: file.patch.length, content: file.patch };
    }

    if (file.additions + file.deletions > 0) {
        return { state: 'unavailable' };
    }

    return { state: 'none' };
}

function mapAuthorType(userType: string | null | undefined): VcsReviewComment['authorType'] {
    if (userType === 'Bot') {
        return 'Bot';
    }

    if (userType === 'User') {
        return 'User';
    }

    return 'Unknown';
}

function isTrustedReviewComment(
    comment: { body?: string | null; user?: { type?: string | null; login?: string | null } | null },
    expectedBotLogin: string
): boolean {
    return (
        comment.user?.type === 'Bot' &&
        comment.user.login === expectedBotLogin &&
        BOT_COMMENT_MARKERS.every((marker) => comment.body?.includes(marker) === true)
    );
}

// eslint-disable-next-line anti-slop/no-unknown-parameters -- Octokit failures cross this boundary as unknown
function isNotFoundStatus(error: unknown): boolean {
    // eslint-disable-next-line anti-slop/no-runtime-typeof -- object guard before probing the status field
    if (typeof error !== 'object' || error === null || !('status' in error)) {
        return false;
    }

    const { status } = error;

    return status === HTTP_NOT_FOUND;
}

function requestOptions(signal?: AbortSignal): { request?: { signal: AbortSignal } } {
    if (signal === undefined) {
        // eslint-disable-next-line anti-slop/no-known-value-widening -- empty options literal matches the declared request contract
        return {};
    }

    // eslint-disable-next-line anti-slop/no-known-value-widening -- literal matches the declared request contract
    return { request: { signal } };
}

function decodeBase64Utf8(content: string): string {
    return Buffer.from(content, 'base64').toString('utf8');
}

type ContentResponse = Awaited<ReturnType<OctokitLike['rest']['repos']['getContent']>>;

function decodeFileContent(response: ContentResponse['data']): string | null {
    // eslint-disable-next-line anti-slop/no-runtime-typeof -- narrows the Octokit content union before decoding
    if (Array.isArray(response) || response.type !== 'file' || typeof response.content !== 'string') {
        return null;
    }

    return decodeBase64Utf8(response.content);
}
