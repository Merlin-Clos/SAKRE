import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    createGitHubClient,
    fetchGitHubContext,
    findOpenPullRequest,
    type GitHubClient,
    isGitHubRemote,
    type OctokitLike,
    parseRemote,
    resolveGitHubApiBaseUrl,
    resolveGitHubToken
} from '../../src/cli/forge';
import { METADATA_COMMENT_MARKER, REVIEW_COMMENT_MARKER } from '../../src/identity';

describe('Git remote parsing', () => {
    test('parses https, ssh and scp-like remotes', () => {
        expect(parseRemote('https://github.com/acme/demo.git')).toEqual({
            host: 'github.com',
            owner: 'acme',
            repo: 'demo'
        });
        expect(parseRemote('https://github.com/acme/my-repo.git')).toEqual({
            host: 'github.com',
            owner: 'acme',
            repo: 'my-repo'
        });
        expect(parseRemote('git@github.com:acme/demo.git')).toEqual({
            host: 'github.com',
            owner: 'acme',
            repo: 'demo'
        });
        expect(parseRemote('github.com:acme/demo.git')).toEqual({
            host: 'github.com',
            owner: 'acme',
            repo: 'demo'
        });
        expect(parseRemote('ssh://git@github.com/acme/demo')).toEqual({
            host: 'github.com',
            owner: 'acme',
            repo: 'demo'
        });
        expect(parseRemote('https://gitlab.com/acme/demo.git')).toEqual({
            host: 'gitlab.com',
            owner: 'acme',
            repo: 'demo'
        });
    });

    test('rejects empty, malformed and incomplete remotes', () => {
        expect(parseRemote('')).toBeUndefined();
        expect(parseRemote('not a remote')).toBeUndefined();
        expect(parseRemote('https://')).toBeUndefined();
        expect(parseRemote('https://github.com/acme')).toBeUndefined();
    });
});

describe('GitHub API host resolution', () => {
    test('eligibility requires github.com or the configured API host', () => {
        const github = { host: 'github.com', owner: 'acme', repo: 'demo' };
        const enterprise = { host: 'github.corp.example', owner: 'acme', repo: 'demo' };
        expect(isGitHubRemote(github, {})).toBe(true);
        expect(isGitHubRemote(enterprise, { GITHUB_API_URL: 'https://github.corp.example/api/v3' })).toBe(true);
        expect(isGitHubRemote(enterprise, {})).toBe(false);
        expect(isGitHubRemote(enterprise, { GITHUB_API_URL: 'https://other.example/api/v3' })).toBe(false);
    });

    test('github.com always targets the public API, never a configured enterprise host', () => {
        const github = { host: 'github.com', owner: 'acme', repo: 'demo' };
        const enterprise = { host: 'github.corp.example', owner: 'acme', repo: 'demo' };
        const ghesEnvironment = { GITHUB_API_URL: 'https://github.corp.example/api/v3' };
        expect(resolveGitHubApiBaseUrl(github, ghesEnvironment)).toBe('https://api.github.com');
        expect(resolveGitHubApiBaseUrl(enterprise, ghesEnvironment)).toBe('https://github.corp.example/api/v3');
        expect(resolveGitHubApiBaseUrl(enterprise, { GITHUB_API_URL: 'not-a-url' })).toBeUndefined();
    });
});

describe('GitHub token resolution', () => {
    let root = '';
    let failingRoot = '';

    beforeAll(async () => {
        root = await mkdtemp(path.join(tmpdir(), 'sakre-token-'));
        const bin = path.join(root, 'bin');
        await mkdir(bin);
        await writeFile(
            path.join(bin, 'gh'),
            '#!/bin/sh\nif [ "$1" = "auth" ] && [ "$2" = "token" ]; then printf "gh-token\\n"; else exit 2; fi\n'
        );
        await chmod(path.join(bin, 'gh'), 0o755);
        failingRoot = await mkdtemp(path.join(tmpdir(), 'sakre-token-failing-'));
        const failingBin = path.join(failingRoot, 'bin');
        await mkdir(failingBin);
        await writeFile(path.join(failingBin, 'gh'), '#!/bin/sh\nprintf "junk\\n"\nexit 1\n');
        await chmod(path.join(failingBin, 'gh'), 0o755);
    });

    afterAll(async () => {
        await rm(root, { recursive: true, force: true });
        await rm(failingRoot, { recursive: true, force: true });
    });

    test('environment tokens win over the optional gh store', async () => {
        expect(await resolveGitHubToken({ GITHUB_TOKEN: 'direct', GH_TOKEN: 'fallback' })).toBe('direct');
        expect(await resolveGitHubToken({ GH_TOKEN: 'fallback' })).toBe('fallback');
    });

    test('falls back to gh when present and stays undefined otherwise', async () => {
        expect(await resolveGitHubToken({ PATH: path.join(root, 'bin') })).toBe('gh-token');
        expect(await resolveGitHubToken({ PATH: path.join(root, 'absent') })).toBeUndefined();
    });

    test('a failing gh with stdout yields no token and a blank env token is not a token', async () => {
        expect(await resolveGitHubToken({ PATH: path.join(failingRoot, 'bin') })).toBeUndefined();
        expect(await resolveGitHubToken({ GITHUB_TOKEN: '   ', PATH: path.join(root, 'absent') })).toBeUndefined();
    });
});

describe('GitHub pull request context', () => {
    test('queries the server-side head filter and returns the matching pull request', async () => {
        const { client, listCalls } = fakeClient({ pulls: [{ number: 7, head: { ref: 'feature' } }] });
        expect(await findOpenPullRequest(client, { headOwner: 'acme', branch: 'feature' })).toBe(7);
        expect(listCalls).toHaveLength(1);
        expect(listCalls[0]).toMatchObject({
            owner: 'acme',
            repo: 'demo',
            state: 'open',
            head: 'acme:feature',
            sort: 'created',
            direction: 'desc',
            per_page: 1
        });
    });

    test('selects the first of several matching pull requests for deterministic auto-detection', async () => {
        const { client, listCalls } = fakeClient({
            pulls: [
                { number: 12, head: { ref: 'feature' } },
                { number: 9, head: { ref: 'feature' } }
            ]
        });

        expect(await findOpenPullRequest(client, { headOwner: 'acme', branch: 'feature' })).toBe(12);
        expect(listCalls).toHaveLength(1);
        /* The newest open pull request is requested first, so the documented
           rule does not depend on API ordering. */
        expect(listCalls[0]).toMatchObject({ sort: 'created', direction: 'desc', per_page: 1 });
    });

    test('filters by the fork head owner while querying the base repository', async () => {
        const { client, listCalls } = fakeClient({ pulls: [{ number: 8, head: { ref: 'feature' } }] });
        expect(await findOpenPullRequest(client, { headOwner: 'contributor', branch: 'feature' })).toBe(8);
        expect(listCalls).toHaveLength(1);
        expect(listCalls[0]).toMatchObject({
            owner: 'acme',
            repo: 'demo',
            state: 'open',
            head: 'contributor:feature',
            per_page: 1
        });
    });

    test('queries nothing for an empty branch', async () => {
        const { client, listCalls } = fakeClient({ pulls: [{ number: 7, head: { ref: 'feature' } }] });
        expect(await findOpenPullRequest(client, { headOwner: 'acme', branch: '' })).toBeUndefined();
        expect(listCalls).toHaveLength(0);
    });

    test('returns undefined when no open pull request matches the branch', async () => {
        const { client } = fakeClient({ pulls: [] });
        expect(await findOpenPullRequest(client, { headOwner: 'acme', branch: 'feature' })).toBeUndefined();
    });

    test('ignores a pull request whose head ref does not match the query', async () => {
        const { client } = fakeClient({ pulls: [{ number: 9, head: { ref: 'other' } }] });
        expect(await findOpenPullRequest(client, { headOwner: 'acme', branch: 'feature' })).toBeUndefined();
    });

    test('maps the pull request and keeps only marked bot review comments', async () => {
        const { client } = fakeClient({
            comments: [
                {
                    id: 2,
                    body:
                        `<!-- ${REVIEW_COMMENT_MARKER} -->\n` +
                        `<!-- ${METADATA_COMMENT_MARKER} {"headSha":"a","status":"complete"} -->\n` +
                        'earlier review',
                    created_at: '2026-09-01T00:00:00Z',
                    user: { type: 'Bot', login: 'github-actions[bot]' }
                },
                {
                    id: 1,
                    body: 'thanks!',
                    created_at: '2026-09-02T00:00:00Z',
                    user: { type: 'User', login: 'alice' }
                },
                {
                    id: 3,
                    body: 'unrelated bot message',
                    created_at: '2026-09-03T00:00:00Z',
                    user: { type: 'Bot', login: 'github-actions[bot]' }
                }
            ]
        });

        const context = await fetchGitHubContext(client, 7);
        expect(context).toMatchObject({
            owner: 'acme',
            repo: 'demo',
            number: 7,
            title: 'Real title',
            body: 'Real body',
            authorLogin: 'alice'
        });
        expect(context.comments).toHaveLength(1);
        expect(context.comments?.[0]?.id).toBe(2);
    });
});

describe('GitHub client construction', () => {
    test('sends the token to the API host that matches the remote', () => {
        const requests: { token: string; apiBaseUrl: string }[] = [];

        const dependencies = {
            createOctokit: (token: string, apiBaseUrl: string): OctokitLike => {
                requests.push({ token, apiBaseUrl });

                // SAFETY: the factory only records token and host; the empty object stands in for the unused Octokit surface.
                return {} as OctokitLike;
            }
        };

        const environment = { GITHUB_API_URL: 'https://github.corp.example/api/v3' };

        const github = createGitHubClient({
            remote: { host: 'github.com', owner: 'acme', repo: 'demo' },
            token: 'secret-token',
            environment,
            dependencies
        });

        createGitHubClient({
            remote: { host: 'github.corp.example', owner: 'acme', repo: 'demo' },
            token: 'enterprise-token',
            environment,
            dependencies
        });

        expect(github.repository).toEqual({ owner: 'acme', repo: 'demo' });
        expect(requests).toEqual([
            { token: 'secret-token', apiBaseUrl: 'https://api.github.com' },
            { token: 'enterprise-token', apiBaseUrl: 'https://github.corp.example/api/v3' }
        ]);
    });

    test('refuses a remote that is not a GitHub API host', () => {
        expect(() =>
            createGitHubClient({
                remote: { host: 'gitlab.com', owner: 'acme', repo: 'demo' },
                token: 'secret-token',
                environment: {}
            })
        ).toThrow('not a GitHub API host');
    });
});

interface FakePull {
    number: number;
    head: { ref: string };
}

interface FakeComment {
    id: number;
    body: string;
    created_at: string;
    user: { type?: string; login?: string };
}

function fakeClient(input: { pulls?: FakePull[]; comments?: FakeComment[] }): {
    client: GitHubClient;
    listCalls: Record<string, unknown>[];
} {
    const listCalls: Record<string, unknown>[] = [];
    const pulls = input.pulls ?? [];
    const comments = input.comments ?? [];

    const octokit = {
        paginate: (): Promise<unknown[]> => Promise.resolve(comments),
        rest: {
            pulls: {
                list: (parameters: Record<string, unknown>): Promise<{ data: unknown[] }> => {
                    listCalls.push(parameters);

                    return Promise.resolve({ data: pulls });
                },
                get: (): Promise<{ data: Record<string, unknown> }> =>
                    Promise.resolve({
                        data: {
                            number: 7,
                            title: 'Real title',
                            body: 'Real body',
                            user: { login: 'alice' },
                            base: { ref: 'main', sha: 'a'.repeat(40) },
                            head: { ref: 'feature', sha: 'b'.repeat(40) }
                        }
                    })
            },
            issues: {
                listComments: (): Promise<{ data: unknown[] }> => Promise.resolve({ data: [] })
            }
        }
    };

    // eslint-disable-next-line anti-slop/no-known-value-widening -- fake-client fixture; annotation documents the exercised surface
    return {
        // SAFETY: the fake implements the pulls/issues calls this mapping case exercises; list parameters are asserted through listCalls.
        // eslint-disable-next-line anti-slop/no-chained-type-assertions -- fake implements only the exercised methods; the chain bridges the partial fake to the SDK type
        client: { octokit: octokit as unknown as OctokitLike, repository: { owner: 'acme', repo: 'demo' } },
        listCalls
    };
}
