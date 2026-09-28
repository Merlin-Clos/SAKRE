import { getOctokit } from '@actions/github';
import { selectReviewComments } from '../vcs/github';
import type { LocalGitContext } from '../vcs/local';
import { runCommand } from './process';

export type OctokitLike = ReturnType<typeof getOctokit>;

export interface GitHubRemote {
    host: string;
    owner: string;
    repo: string;
}

export interface GitHubClient {
    octokit: OctokitLike;
    repository: { owner: string; repo: string };
}

export interface GitHubClientDependencies {
    createOctokit: (token: string, apiBaseUrl: string) => OctokitLike;
}

const HTTPS_SEPARATOR = '://';

const SCP_LIKE_PATTERN = /^(?:[^@/]+@)?(?<host>[^:/]+):(?<path>.+)$/u;

const GITHUB_HOST = 'github.com';

const GITHUB_API_BASE_URL = 'https://api.github.com';

const GIT_SUFFIX = '.git';

const REVIEW_HISTORY_LIMIT = 10;

const defaultDependencies: GitHubClientDependencies = {
    createOctokit: (token, apiBaseUrl) => getOctokit(token, { baseUrl: apiBaseUrl })
};

/* Parses HTTPS, SSH, and scp-like remotes with no client; non-GitHub hosts are
   still returned for the caller to decide. */
export function parseRemote(remoteUrl: string): GitHubRemote | undefined {
    const trimmed = remoteUrl.trim();

    if (trimmed === '') {
        return undefined;
    }

    if (!trimmed.includes(HTTPS_SEPARATOR)) {
        return parseScpLikeRemote(trimmed);
    }

    const parsed = parseUrl(trimmed);

    if (parsed === undefined) {
        return undefined;
    }

    return buildRemote(parsed.hostname, parsed.pathname);
}

function parseScpLikeRemote(value: string): GitHubRemote | undefined {
    const match = SCP_LIKE_PATTERN.exec(value);

    if (match?.groups === undefined) {
        return undefined;
    }

    const { host, path: remotePath } = match.groups;

    if (host === undefined || remotePath === undefined) {
        return undefined;
    }

    return buildRemote(host, remotePath);
}

function parseUrl(value: string): URL | undefined {
    try {
        return new URL(value);
    } catch {
        return undefined;
    }
}

function buildRemote(host: string, remotePath: string): GitHubRemote | undefined {
    const segments = remotePath.replace(/^\/+/u, '').replace(/\/+$/u, '').split('/');
    const owner = segments[0] ?? '';
    let repo = segments[1] ?? '';

    if (repo.endsWith(GIT_SUFFIX)) {
        repo = repo.slice(0, -GIT_SUFFIX.length);
    }

    if (host === '' || owner === '' || repo === '') {
        return undefined;
    }

    return { host, owner, repo };
}

/* The `github.com` remote always uses the public API, even with GITHUB_API_URL set. Other
   hosts must match the configured API host; the base URL is where the token
   goes, so eligibility and client host agree. */
export function resolveGitHubApiBaseUrl(remote: GitHubRemote, environment: NodeJS.ProcessEnv): string | undefined {
    if (remote.host === GITHUB_HOST) {
        return GITHUB_API_BASE_URL;
    }

    const apiUrl = optional(environment.GITHUB_API_URL);

    if (apiUrl === undefined) {
        return undefined;
    }

    try {
        if (new URL(apiUrl).hostname === remote.host) {
            return apiUrl;
        }

        return undefined;
    } catch {
        return undefined;
    }
}

export function isGitHubRemote(remote: GitHubRemote, environment: NodeJS.ProcessEnv): boolean {
    return resolveGitHubApiBaseUrl(remote, environment) !== undefined;
}

/* Token order: GITHUB_TOKEN, GH_TOKEN, then the `gh` store. `gh` stays
   optional and never acts as data client. */
export async function resolveGitHubToken(environment: NodeJS.ProcessEnv): Promise<string | undefined> {
    const direct = optional(environment.GITHUB_TOKEN) ?? optional(environment.GH_TOKEN);

    if (direct !== undefined) {
        return direct;
    }

    try {
        const result = await runCommand({ command: 'gh', args: ['auth', 'token'], env: environment });

        if (result.exitCode !== 0) {
            return undefined;
        }

        return optional(result.stdout);
    } catch {
        return undefined;
    }
}

export interface CreateGitHubClientInput {
    remote: GitHubRemote;
    token: string;
    environment: NodeJS.ProcessEnv;
    dependencies?: GitHubClientDependencies;
}

export function createGitHubClient(input: CreateGitHubClientInput): GitHubClient {
    const apiBaseUrl = resolveGitHubApiBaseUrl(input.remote, input.environment);

    if (apiBaseUrl === undefined) {
        throw new Error(`The origin remote "${input.remote.host}" is not a GitHub API host.`);
    }

    const dependencies = input.dependencies ?? defaultDependencies;

    return {
        octokit: dependencies.createOctokit(input.token, apiBaseUrl),
        repository: { owner: input.remote.owner, repo: input.remote.repo }
    };
}

/* Server-side head filter returns the open PR for the head owner (origin owner
   for forks), so no full pagination is needed. Newest wins on shared branches. */
export interface OpenPullRequestQuery {
    headOwner: string;
    branch?: string;
}

export async function findOpenPullRequest(
    client: GitHubClient,
    query: OpenPullRequestQuery,
    signal?: AbortSignal
): Promise<number | undefined> {
    if (query.branch === undefined || query.branch === '') {
        return undefined;
    }

    const response = await client.octokit.rest.pulls.list({
        owner: client.repository.owner,
        repo: client.repository.repo,
        state: 'open',
        head: `${query.headOwner}:${query.branch}`,
        sort: 'created',
        direction: 'desc',
        per_page: 1,
        ...requestOptions(signal)
    });

    const [match] = response.data;

    if (match === undefined || match.head.ref !== query.branch) {
        return undefined;
    }

    return match.number;
}

export async function fetchGitHubContext(
    client: GitHubClient,
    number: number,
    signal?: AbortSignal
): Promise<LocalGitContext> {
    const pull = await client.octokit.rest.pulls.get({
        owner: client.repository.owner,
        repo: client.repository.repo,
        pull_number: number,
        ...requestOptions(signal)
    });

    const comments = await client.octokit.paginate(client.octokit.rest.issues.listComments, {
        owner: client.repository.owner,
        repo: client.repository.repo,
        issue_number: number,
        per_page: 100,
        ...requestOptions(signal)
    });

    return {
        owner: client.repository.owner,
        repo: client.repository.repo,
        number: pull.data.number,
        title: pull.data.title,
        body: pull.data.body ?? '',
        authorLogin: pull.data.user.login,
        comments: selectReviewComments(comments).slice(0, REVIEW_HISTORY_LIMIT)
    };
}

function requestOptions(signal?: AbortSignal): { request?: { signal: AbortSignal } } {
    if (signal === undefined) {
        // eslint-disable-next-line anti-slop/no-known-value-widening -- empty options literal matches the declared request contract
        return {};
    }

    // eslint-disable-next-line anti-slop/no-known-value-widening -- literal matches the declared request contract
    return { request: { signal } };
}

function optional(value: string | undefined): string | undefined {
    if (value === undefined || value.trim() === '') {
        return undefined;
    }

    return value.trim();
}
