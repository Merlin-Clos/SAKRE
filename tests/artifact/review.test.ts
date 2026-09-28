import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startFakeProvider } from '../helpers/fake-artifact-provider';
import { nativeAssetFor } from '../../src/native/assets';
import { nativeTargetFor, releaseArtifactName } from '../../src/native/platform';
import { pinnedNativeAssetManifest } from '../../src/native/runtime';
import { createRepository, fileExists, git, rev, systemBinary } from '../helpers/artifact-repository';

setDefaultTimeout(180_000);

const target = nativeTargetFor(process.platform, process.arch);

let artifactPath = '';

if (target !== undefined) {
    artifactPath = path.resolve('dist-release', releaseArtifactName(target));
}

const artifactAvailable = artifactPath !== '' && (await fileExists(artifactPath));

describe('compiled engine artifact', () => {
    test.skipIf(!artifactAvailable)(
        'completes a review through the embedded engine with an isolated environment',
        async () => {
            const root = await mkdtemp(path.join(tmpdir(), 'sakre-artifact-'));
            const provider = startFakeProvider();

            try {
                const repository = await createRepository(root);
                const home = path.join(root, 'home');
                const cache = path.join(root, 'cache');
                const bin = path.join(root, 'bin');
                await Promise.all([mkdir(home), mkdir(cache), mkdir(bin)]);
                /* Unix runs with a PATH that contains only git and tar, so the
               embedded assets cannot silently fall back to host tools. */
                const isolatedPath = process.platform !== 'win32';

                if (isolatedPath) {
                    await symlink(systemBinary('git'), path.join(bin, 'git'));
                    await symlink(systemBinary('tar'), path.join(bin, 'tar'));
                }

                /* A hostile user-level configuration must not reach the engine. */
                await writeFile(path.join(home, 'AGENTS.md'), 'USER LEVEL AGENTS INSTRUCTIONS MUST NOT LEAK\n', 'utf8');
                await mkdir(path.join(home, 'config', 'opencode'), { recursive: true });
                await writeFile(
                    path.join(home, 'config', 'opencode', 'opencode.json'),
                    JSON.stringify({ instructions: ['AGENTS.md'], plugin: ['./evil.js'] }),
                    'utf8'
                );

                const result = await runArtifact(
                    [
                        'local',
                        '--base',
                        repository.baseSha,
                        '--head',
                        repository.headSha,
                        '--repo',
                        repository.rootDir,
                        '--provider',
                        'anthropic',
                        '--model',
                        'claude-sonnet-4-5'
                    ],
                    artifactEnvironment({ home, cache, bin, isolatedPath, providerBaseURL: provider.baseURL }),
                    { cwd: repository.rootDir }
                );

                expect(result.stderr).not.toContain('::error::');
                expect(result.exitCode).toBe(0);
                expect(result.stdout).toContain('Reviewed commit:');
                expect(result.stdout).toContain('<summary>Review intelligence · deterministic SCC + CCCC</summary>');
                expect(result.stdout).toContain('### Analysis signals');
                /* The embedded CCCC binary must actually execute: a degraded
                   measurement renders the explicit unavailable message instead
                   of the distribution table. */
                expect(result.stdout).toContain('<summary>Functions / CCCC</summary>');
                expect(result.stdout).toContain('| Function count |');
                expect(result.stdout).not.toContain('CCCC distributions unavailable');
                expect(provider.requests.filter((request) => request.tools.length > 0).length).toBeGreaterThanOrEqual(
                    5
                );

                for (const request of provider.requests) {
                    expect(request.system).not.toContain('USER LEVEL AGENTS INSTRUCTIONS MUST NOT LEAK');
                    expect(request.userText).not.toContain('USER LEVEL AGENTS INSTRUCTIONS MUST NOT LEAK');
                }

                /* The embedded SCC, CCCC and rg assets were materialized from
               the executable, not resolved from PATH. */
                const scc = nativeAssetFor(pinnedNativeAssetManifest, 'scc', target ?? 'linux-x64');
                const cccc = nativeAssetFor(pinnedNativeAssetManifest, 'cccc', target ?? 'linux-x64');
                const rg = nativeAssetFor(pinnedNativeAssetManifest, 'rg', target ?? 'linux-x64');
                let cacheRoot = cache;

                if (process.platform === 'darwin') {
                    cacheRoot = path.join(home, 'Library', 'Caches');
                }

                const sccPath = path.join(
                    cacheRoot,
                    'sakre',
                    'bin',
                    'scc',
                    `${scc.version}-${scc.binarySha256}`,
                    scc.binaryPath
                );

                const ccccPath = path.join(
                    cacheRoot,
                    'sakre',
                    'bin',
                    'cccc',
                    `${cccc.version}-${cccc.binarySha256}`,
                    cccc.binaryPath
                );

                const rgPath = path.join(
                    cacheRoot,
                    'sakre',
                    'bin',
                    'rg',
                    `${rg.version}-${rg.binarySha256}`,
                    rg.binaryPath
                );

                expect(hashOf(await readFile(sccPath))).toBe(scc.binarySha256);
                expect(hashOf(await readFile(ccccPath))).toBe(cccc.binarySha256);
                expect(hashOf(await readFile(rgPath))).toBe(rg.binarySha256);
            } finally {
                await provider.stop();
                await rm(root, { recursive: true, force: true });
            }
        }
    );

    test.skipIf(!artifactAvailable)(
        'pins trusted BASE instructions and the prompt assembly order in the provider payload',
        async () => {
            const root = await mkdtemp(path.join(tmpdir(), 'sakre-artifact-order-'));
            const provider = startFakeProvider();

            try {
                const repository = await createAgentsRepository(root);
                const environment = await createArtifactEnvironment(root, provider.baseURL);
                /* The guidance fixture lives outside the Git repository. */
                const guidanceText = 'GUIDANCE MARKER: focus on the database migration path.';
                const guidancePath = path.join(root, 'artifact-guidance.md');
                await writeFile(guidancePath, `${guidanceText}\n`, 'utf8');

                const result = await runArtifact(
                    [
                        'local',
                        '--base',
                        repository.baseSha,
                        '--head',
                        repository.headSha,
                        '--repo',
                        repository.rootDir,
                        '--provider',
                        'anthropic',
                        '--model',
                        'claude-sonnet-4-5',
                        '--instructions',
                        guidancePath
                    ],
                    environment,
                    { cwd: repository.rootDir }
                );

                expect(result.stderr).not.toContain('::error::');
                expect(result.exitCode).toBe(0);
                const requests = provider.requests.filter((request) => request.tools.length > 0);
                expect(requests.length).toBeGreaterThan(0);

                for (const request of requests) {
                    expect(request.system).toContain('Instructions from:');
                    expect(request.system).toContain('BASE TRUSTED INSTRUCTIONS MARKER');
                    expect(request.system).not.toContain('HEAD HOSTILE INSTRUCTIONS MUST NOT REACH');
                    /* The hostile HEAD text may appear as reviewable diff data,
                       never as instructions before the untrusted diff block. */
                    const hostileIndex = request.userText.indexOf('HEAD HOSTILE INSTRUCTIONS MUST NOT REACH');
                    const diffIndex = request.userText.indexOf('name="unified-diff"');

                    if (hostileIndex !== -1) {
                        expect(diffIndex).toBeGreaterThanOrEqual(0);
                        expect(hostileIndex).toBeGreaterThan(diffIndex);
                    }
                }

                const maintainability = requests.find((request) =>
                    request.system.includes('## Deterministic Maintainability Signals')
                );

                expect(maintainability).toBeDefined();
                const system = maintainability?.system ?? '';
                const user = maintainability?.userText ?? '';
                const indexShared = system.indexOf('# Shared review rules');
                const indexContract = system.indexOf('Non-negotiable rules:');
                expect(indexShared).toBeGreaterThanOrEqual(0);
                expect(indexContract).toBeGreaterThan(indexShared);
                /* Policy stays on the instruction surface; the review evidence
                   travels on the message surface, in order. */
                expect(system).not.toContain('name="review-map"');
                expect(system).not.toContain('name="unified-diff"');
                const indexMap = user.indexOf('name="review-map"');
                const indexDiff = user.indexOf('name="unified-diff"');
                expect(indexMap).toBeGreaterThanOrEqual(0);
                expect(indexDiff).toBeGreaterThan(indexMap);
                expect(user).toContain('changedFiles=');
                expect(user).toContain('How to use this evidence');

                /* Guidance is serialized after the contract and before the
                   ReviewMap; the coordinator receives provenance only. */
                const guided = requests.find((request) => request.userText.includes('name="user-guidance:local-file"'));
                expect(guided).toBeDefined();
                const guidedSystem = guided?.system ?? '';
                const guidedUser = guided?.userText ?? '';
                expect(guidedUser).toContain(guidanceText);
                expect(guidedSystem).not.toContain(guidanceText);
                const indexRule = guidedSystem.indexOf('Untrusted does not mean ignored');
                const indexGuidance = guidedUser.indexOf('name="user-guidance:local-file"');
                expect(indexRule).toBeGreaterThanOrEqual(0);
                expect(indexGuidance).toBeLessThan(guidedUser.indexOf('name="review-map"'));
                expect(guidedUser.indexOf('name="review-map"')).toBeLessThan(guidedUser.indexOf('name="unified-diff"'));

                const coordinatorRequest = requests.find((request) =>
                    request.system.includes('You are the review coordinator')
                );

                expect(coordinatorRequest).toBeDefined();
                expect(coordinatorRequest?.system).not.toContain(guidanceText);
                expect(coordinatorRequest?.userText).not.toContain(guidanceText);
                expect(coordinatorRequest?.userText).not.toContain('user-guidance:');
                expect(coordinatorRequest?.system).toContain('User guidance provenance: present (source: local-file).');

                const commonAgent = requests.find((request) =>
                    request.system.includes('Adjudicate specialist findings against the full diff')
                );

                expect(commonAgent).toBeDefined();
                const commonUser = commonAgent?.userText ?? '';
                expect(commonUser).toContain('name="review-map"');
                expect(commonUser).not.toContain('### Function deltas');
            } finally {
                await provider.stop();
                await rm(root, { recursive: true, force: true });
            }
        }
    );

    test.skipIf(!artifactAvailable)('reports its version without starting a review', async () => {
        const result = await runArtifact(['--version'], {});
        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).not.toBe('');
    });
});

interface ArtifactEnvironmentInput {
    home: string;
    cache: string;
    bin: string;
    isolatedPath: boolean;
    providerBaseURL: string;
}

/* Isolated HOME/cache/PATH used by the artifact scenarios. */
async function createArtifactEnvironment(root: string, providerBaseURL: string): Promise<Record<string, string>> {
    const home = path.join(root, 'home');
    const cache = path.join(root, 'cache');
    const bin = path.join(root, 'bin');
    await Promise.all([mkdir(home), mkdir(cache), mkdir(bin)]);
    const isolatedPath = process.platform !== 'win32';

    if (isolatedPath) {
        await symlink(systemBinary('git'), path.join(bin, 'git'));
        await symlink(systemBinary('tar'), path.join(bin, 'tar'));
    }

    return artifactEnvironment({ home, cache, bin, isolatedPath, providerBaseURL });
}

/* A repository whose AGENTS.md is replaced at HEAD: the trusted workspace must
   serve the BASE content to the engine, and the provider payload must show it. */
async function createAgentsRepository(root: string): Promise<{ rootDir: string; baseSha: string; headSha: string }> {
    const rootDir = path.join(root, 'repository');
    await mkdir(path.join(rootDir, 'src'), { recursive: true });
    git(rootDir, ['init', '-q', '-b', 'main']);
    git(rootDir, ['config', 'user.email', 'artifact@example.com']);
    git(rootDir, ['config', 'user.name', 'Artifact Fixture']);
    await writeFile(path.join(rootDir, 'AGENTS.md'), 'BASE TRUSTED INSTRUCTIONS MARKER\n', 'utf8');
    await writeFile(path.join(rootDir, 'src', 'app.js'), 'export const value = 1;\n', 'utf8');
    git(rootDir, ['add', '-A']);
    git(rootDir, ['commit', '-qm', 'base']);
    const baseSha = rev(rootDir, 'HEAD');
    await writeFile(path.join(rootDir, 'AGENTS.md'), 'HEAD HOSTILE INSTRUCTIONS MUST NOT REACH THE PROVIDER\n', 'utf8');
    await writeFile(path.join(rootDir, 'src', 'app.js'), 'export const value = 2;\n', 'utf8');
    git(rootDir, ['add', '-A']);
    git(rootDir, ['commit', '-qm', 'head']);

    return { rootDir, baseSha, headSha: rev(rootDir, 'HEAD') };
}

function artifactEnvironment(input: ArtifactEnvironmentInput): Record<string, string> {
    // eslint-disable-next-line anti-slop/no-known-value-widening -- environment-map fixture; Record documents the runner contract
    const environment: Record<string, string> = {
        HOME: input.home,
        XDG_CACHE_HOME: input.cache,
        LOCALAPPDATA: input.cache,
        XDG_DATA_HOME: path.join(input.home, 'data'),
        XDG_CONFIG_HOME: path.join(input.home, 'config'),
        XDG_STATE_HOME: path.join(input.home, 'state'),
        SAKRE_PROVIDER_API_KEY: 'sk-ant-artifact',
        SAKRE_PROVIDER_BASE_URL: input.providerBaseURL,
        GITHUB_TOKEN: ''
    };

    if (input.isolatedPath) {
        environment.PATH = input.bin;
    }

    // eslint-disable-next-line anti-slop/no-known-value-widening -- environment-map fixture; Record documents the runner contract
    return environment;
}

function runArtifact(
    args: string[],
    env: Record<string, string>,
    options: { cwd?: string } = {}
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        const child = spawn(artifactPath, args, {
            cwd: options.cwd,
            env,
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

function hashOf(content: Uint8Array): string {
    return createHash('sha256').update(content).digest('hex');
}
