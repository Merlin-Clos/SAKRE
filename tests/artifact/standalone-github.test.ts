import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRepository, git } from '../helpers/artifact-repository';
import {
    reviewEnvironment,
    runStandalone,
    standaloneArtifactAvailable,
    standaloneFailure,
    startFakeGitHubApi
} from '../helpers/standalone-cli';

/* GitHub interaction of the compiled standalone CLI against a loopback REST
   fixture: PR auto-detection, explicit `--pr`, and publication resolution.
   No request can reach the real github.com. */
setDefaultTimeout(180_000);

let root = '';

beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'sakre-standalone-github-'));
});

afterAll(async () => {
    await rm(root, { recursive: true, force: true });
});

describe('standalone CLI GitHub artifact', () => {
    test.skipIf(!standaloneArtifactAvailable)(
        'auto-detects the pull request through a fixture GitHub API',
        async () => {
            const directory = await mkdtemp(path.join(root, 'github-context-'));
            const repository = await createRepository(directory);
            const api = startFixtureApi();

            try {
                git(repository.rootDir, ['remote', 'add', 'origin', `${api.baseUrl}/acme/demo.git`]);

                const result = await runStandalone(
                    [
                        'local',
                        '--mock',
                        '--context',
                        'github',
                        '--base',
                        repository.baseSha,
                        '--head',
                        repository.headSha,
                        '--repo',
                        repository.rootDir
                    ],
                    { cwd: repository.rootDir, env: githubEnvironment(api.baseUrl, await reviewEnvironment(root)) }
                );

                expect(result.exitCode, standaloneFailure(result)).toBe(0);
                expect(result.stdout).toContain('Reviewed commit:');
                const listRequest = api.requests.find((request) => request.path === '/repos/acme/demo/pulls');
                expect(listRequest).toBeDefined();
                expect(decodeURIComponent(listRequest?.search ?? '')).toContain('head=acme:main');
                expect(listRequest?.search).toContain('sort=created');
                expect(listRequest?.search).toContain('direction=desc');
                expect(api.requests.some((request) => request.path === '/repos/acme/demo/pulls/7')).toBe(true);
                expect(api.requests.some((request) => request.path === '/repos/acme/demo/issues/7/comments')).toBe(
                    true
                );
            } finally {
                await api.stop();
            }
        }
    );

    test.skipIf(!standaloneArtifactAvailable)(
        'resolves --pr publication against the fixture API without a real publication',
        async () => {
            const directory = await mkdtemp(path.join(root, 'github-pr-'));
            const repository = await createRepository(directory);
            const api = startFixtureApi();

            try {
                git(repository.rootDir, ['remote', 'add', 'origin', `${api.baseUrl}/acme/demo.git`]);

                const result = await runStandalone(
                    [
                        'local',
                        '--mock',
                        '--output',
                        'github-pr',
                        '--pr',
                        '7',
                        '--base',
                        repository.baseSha,
                        '--head',
                        repository.headSha,
                        '--repo',
                        repository.rootDir
                    ],
                    { cwd: repository.rootDir, env: githubEnvironment(api.baseUrl, await reviewEnvironment(root)) }
                );

                expect(result.exitCode, standaloneFailure(result)).toBe(0);
                /* `--pr` skips auto-detection but still fetches the context. */
                expect(api.requests.some((request) => request.path === '/repos/acme/demo/pulls')).toBe(false);
                expect(api.requests.some((request) => request.path === '/repos/acme/demo/pulls/7')).toBe(true);

                const created = api.requests.filter(
                    (request) => request.method === 'POST' && request.path === '/repos/acme/demo/issues/7/comments'
                );

                expect(created).toHaveLength(1);
                expect(api.requests.some((request) => request.method === 'PATCH')).toBe(true);
            } finally {
                await api.stop();
            }
        }
    );

    test.skipIf(!standaloneArtifactAvailable)(
        'fails github-pr output without a token before any publication',
        async () => {
            const directory = await mkdtemp(path.join(root, 'no-token-'));
            const repository = await createRepository(directory);
            const api = startFixtureApi();

            try {
                git(repository.rootDir, ['remote', 'add', 'origin', `${api.baseUrl}/acme/demo.git`]);

                const result = await runStandalone(
                    [
                        'local',
                        '--mock',
                        '--output',
                        'github-pr',
                        '--pr',
                        '7',
                        '--base',
                        repository.baseSha,
                        '--head',
                        repository.headSha,
                        '--repo',
                        repository.rootDir
                    ],
                    {
                        cwd: repository.rootDir,
                        env: { ...(await reviewEnvironment(root)), GITHUB_API_URL: api.baseUrl }
                    }
                );

                expect(result.exitCode).toBe(1);
                expect(result.stdout).toBe('');
                expect(result.stderr).toContain('Error:');
                expect(result.stderr).toContain('GITHUB_TOKEN');
                expect(result.stderr).not.toContain('::error::');
                expect(api.requests).toHaveLength(0);
            } finally {
                await api.stop();
            }
        }
    );
});

function startFixtureApi(): ReturnType<typeof startFakeGitHubApi> {
    return startFakeGitHubApi({ pullNumber: 7, branch: 'main' });
}

function githubEnvironment(baseUrl: string, environment: Record<string, string>): Record<string, string> {
    // eslint-disable-next-line anti-slop/no-known-value-widening -- environment-map fixture; Record documents the runner contract
    return { ...environment, GITHUB_TOKEN: 'fixture-token', GITHUB_API_URL: baseUrl };
}
