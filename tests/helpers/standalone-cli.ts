import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, symlink } from 'node:fs/promises';
import path from 'node:path';
import { nativeTargetFor, releaseArtifactName } from '../../src/native/platform';
import { fileExists, systemBinary } from './artifact-repository';

/* Shared host for the standalone-CLI artifact tests: resolve the compiled
   binary once, run it with an explicit environment, and provide the isolated
   credential-free environments and the loopback GitHub REST fixture. */

export interface StandaloneResult {
    exitCode: number | null;
    stdout: string;
    stderr: string;
}

const target = nativeTargetFor(process.platform, process.arch);

let artifactPath = '';

if (target !== undefined) {
    artifactPath = path.resolve('dist-release', releaseArtifactName(target));
}

export const standaloneArtifactAvailable = artifactPath !== '' && (await fileExists(artifactPath));

export function runStandalone(
    args: string[],
    options: { cwd: string; env: Record<string, string> }
): Promise<StandaloneResult> {
    return new Promise((resolve, reject) => {
        const child = spawn(artifactPath, args, {
            cwd: options.cwd,
            env: options.env,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => {
            stdout += chunk.toString('utf8');
        });
        child.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString('utf8');
        });
        child.on('error', reject);
        child.on('close', (exitCode) => {
            resolve({ exitCode, stdout, stderr });
        });
    });
}

export function standaloneFailure(result: StandaloneResult): string {
    return `The standalone CLI exited with ${String(result.exitCode)}.\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`;
}

let sequence = 0;

/* An empty PATH (with no `gh`) plus empty credential variables: help and the
   Git-only review must not need any of them. */
export async function credentialFreeEnvironment(root: string): Promise<Record<string, string>> {
    const home = await isolatedHome(root);
    sequence += 1;
    const bin = path.join(root, `bin-${String(sequence)}`);
    await mkdir(bin, { recursive: true });

    return {
        ...home,
        PATH: bin,
        GITHUB_TOKEN: '',
        GH_TOKEN: '',
        SAKRE_PROVIDER_API_KEY: '',
        SAKRE_PROVIDER_BASE_URL: ''
    };
}

/* Git and tar are symlinked into an isolated bin directory on Unix, so the review has no `gh` fallback. Windows keeps
   its PATH because the isolated layout would hide git as well. */
export async function reviewEnvironment(root: string): Promise<Record<string, string>> {
    const home = await isolatedHome(root);
    sequence += 1;
    const bin = path.join(root, `bin-${String(sequence)}`);
    await mkdir(bin, { recursive: true });

    // eslint-disable-next-line anti-slop/no-known-value-widening -- CLI fixture environment map; Record documents the contract
    const environment: Record<string, string> = {
        ...home,
        GITHUB_TOKEN: '',
        GH_TOKEN: '',
        SAKRE_PROVIDER_API_KEY: '',
        SAKRE_PROVIDER_BASE_URL: ''
    };

    if (process.platform === 'win32') {
        environment.PATH = process.env.PATH ?? '';
    } else {
        await symlink(systemBinary('git'), path.join(bin, 'git'));
        await symlink(systemBinary('tar'), path.join(bin, 'tar'));
        environment.PATH = bin;
    }

    return environment;
}

async function isolatedHome(root: string): Promise<Record<string, string>> {
    const home = await mkdtemp(path.join(root, 'home-'));

    return {
        HOME: home,
        LOCALAPPDATA: home,
        APPDATA: home,
        XDG_CACHE_HOME: path.join(home, 'cache'),
        XDG_CONFIG_HOME: path.join(home, 'config'),
        XDG_DATA_HOME: path.join(home, 'data'),
        XDG_STATE_HOME: path.join(home, 'state'),
        GH_CONFIG_DIR: path.join(home, 'gh')
    };
}

export interface FakeRequest {
    method: string;
    path: string;
    search: string;
}

export interface FakeGitHubApi {
    baseUrl: string;
    requests: FakeRequest[];
    stop: () => Promise<void>;
}

/* Loopback GitHub REST fixture: the CLI talks to it through GITHUB_API_URL, so
   no request can reach github.com. Only the endpoints the CLI uses are
   implemented; anything else answers 404 and fails the calling test. */
export function startFakeGitHubApi(input: { pullNumber: number; branch: string }): FakeGitHubApi {
    const requests: FakeRequest[] = [];

    const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch(request) {
            const url = new URL(request.url);
            requests.push({ method: request.method, path: url.pathname, search: url.search });
            const repository = '/repos/acme/demo';

            if (request.method === 'GET' && url.pathname === `${repository}/pulls`) {
                return Response.json([
                    { number: input.pullNumber, head: { ref: input.branch }, base: { ref: 'main' } }
                ]);
            }

            if (request.method === 'GET' && url.pathname === `${repository}/pulls/${String(input.pullNumber)}`) {
                return Response.json({
                    number: input.pullNumber,
                    title: 'Fixture pull request',
                    body: 'Fixture body',
                    user: { login: 'alice' },
                    base: { ref: 'main', sha: 'a'.repeat(40) },
                    head: { ref: input.branch, sha: 'b'.repeat(40) }
                });
            }

            if (
                request.method === 'GET' &&
                url.pathname === `${repository}/issues/${String(input.pullNumber)}/comments`
            ) {
                return Response.json([]);
            }

            if (
                request.method === 'POST' &&
                url.pathname === `${repository}/issues/${String(input.pullNumber)}/comments`
            ) {
                return Response.json({ id: 101 });
            }

            if (request.method === 'PATCH' && url.pathname === `${repository}/issues/comments/101`) {
                return Response.json({ id: 101 });
            }

            return new Response('unexpected fixture request', { status: 404 });
        }
    });

    return {
        baseUrl: `http://127.0.0.1:${String(server.port)}`,
        requests,
        stop: () => server.stop(true)
    };
}
