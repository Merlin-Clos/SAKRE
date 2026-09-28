import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { Credential } from '@opencode/core/credential';
import { Integration } from '@opencode/schema/integration';
import { Effect, Schema } from 'effect';
import { createMockRuntime } from '../../src/ai/mock-runtime';
import { runAuthCli } from '../../src/cli/auth';
import type { OctokitLike } from '../../src/cli/forge';
import { runLocalCli } from '../../src/cli/local';
import { stripCommentMarkers } from '../../src/cli/output';
import type { EffectiveRun } from '../../src/config/effective-run';
import { persistentCredentialLayer, prepareOAuthCredentialStore } from '../../src/engine/oauth-credentials';
import { materializeEnginePlugin } from '../../src/engine/plugin-source';
import { PRODUCT_NAME, PROVIDER_API_KEY_ENV } from '../../src/identity';
import type { NativeRuntime } from '../../src/native/runtime';
import { startFakeProvider } from '../helpers/fake-artifact-provider';

interface CliRepository {
    rootDir: string;
    baseSha: string;
    headSha: string;
}

interface CapturedStream {
    stream: NodeJS.WritableStream;
    read: () => string;
}

interface GitHubFixture {
    octokit: OctokitLike;
    progressBodies: string[];
    finalBodies: string[];
    listCalls: Record<string, unknown>[];
    commentTargets: { owner: string; repo: string }[];
    pullsGetCalls: number;
}

let workspace = '';

const nativeHolder: { runtime?: NativeRuntime } = {};

let homeRoot = '';

const createdRepositories: string[] = [];

beforeAll(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), 'sakre-cli-tests-'));
    homeRoot = path.join(workspace, 'home');
    await mkdir(homeRoot);
    nativeHolder.runtime = await createFakeNativeRuntime();
});

/* Native layer stub: the SCC script answers the base-tree measurement with the
   same JSON shape the real binary returns, so mock reviews stay fully offline
   without a preinstalled engine. */
async function createFakeNativeRuntime(): Promise<NativeRuntime> {
    const sccPath = path.join(workspace, 'fake-scc');
    await writeFile(
        sccPath,
        `#!/bin/sh\nprintf '[{"Name":"JavaScript","Count":3,"Lines":42,"Complexity":0,"Bytes":0,"Code":0,"Comment":0,"Blank":0}]\\n'\n`,
        { mode: 0o755 }
    );

    return {
        target: 'linux-x64',
        cacheRoot: workspace,
        materializeRipgrep: () => Promise.resolve(path.join(workspace, 'fake-rg')),
        materializeScc: () => Promise.resolve(sccPath),
        materializeCccc: () => Promise.resolve(path.join(workspace, 'fake-cccc')),
        materializeEnginePlugin: () => materializeEnginePlugin(path.join(workspace, 'plugin-cache')),
        engineCredentialPath: path.join(workspace, 'engine', 'credentials.json'),
        engineOAuthCredentialPath: path.join(workspace, 'data', 'engine', 'credentials.db'),
        engineDatabasePath: path.join(workspace, 'engine', 'runs', 'fixture', 'engine.db'),
        engineDatabaseDirectory: path.join(workspace, 'engine', 'runs', 'fixture')
    };
}

afterEach(async () => {
    await Promise.all(createdRepositories.splice(0).map((rootDir) => rm(rootDir, { recursive: true, force: true })));
});

afterAll(async () => {
    await rm(workspace, { recursive: true, force: true });
});

describe('local CLI review cycle', () => {
    test('prints help on stdout and exits zero without running a review', async () => {
        const stdout = captureStream();
        const stderr = captureStream();

        const exitCode = await runLocalCli(['--help'], {
            cwd: workspace,
            env: minimalEnvironment(),
            stdout: stdout.stream,
            stderr: stderr.stream,
            native: nativeHolder.runtime
        });

        expect(exitCode).toBe(0);
        expect(stdout.read()).toContain('Usage: sakre local');
        expect(stderr.read()).toBe('');
    });

    test('rejects malformed arguments on stderr and exits one without running a review', async () => {
        for (const args of [['--unknown'], ['--'], ['positional']]) {
            const stdout = captureStream();
            const stderr = captureStream();

            const exitCode = await runLocalCli(args, {
                cwd: workspace,
                env: minimalEnvironment(),
                stdout: stdout.stream,
                stderr: stderr.stream,
                native: nativeHolder.runtime
            });

            expect(exitCode).toBe(1);
            expect(stdout.read()).toBe('');
            expect(stderr.read()).not.toBe('');
        }
    });

    test('reviews a local repository in mock mode without any GitHub activity', async () => {
        const repository = await createCliRepository();
        const stdout = captureStream();
        const stderr = captureStream();
        let octokitCalls = 0;

        const exitCode = await runLocalCli(
            ['--mock', '--base', repository.baseSha, '--head', repository.headSha, '--repo', repository.rootDir],
            {
                cwd: workspace,
                env: minimalEnvironment(),
                stdout: stdout.stream,
                stderr: stderr.stream,
                native: nativeHolder.runtime,
                githubClientDependencies: {
                    createOctokit: () => {
                        octokitCalls += 1;
                        throw new Error('GitHub must not be called.');
                    }
                }
            }
        );

        expect(exitCode).toBe(0);
        expect(stdout.read()).toContain(`## ✅ ${PRODUCT_NAME}: Clean`);
        expect(stdout.read()).toContain('Reviewed commit:');
        expect(stderr.read()).toContain('[cli]');
        /* The full ReviewMap reaches stderr through the raw sink: the generic
           per-string cap must not cut it, and the map keeps its own cap. */
        const cliStderr = stderr.read();
        expect(cliStderr).toContain('"hotspotOmissions"');
        expect(cliStderr).not.toContain('[truncated');
        expect(octokitCalls).toBe(0);
    });

    test('aborts without prompting on a non-TTY stdin when the diff exceeds the budget', async () => {
        const repository = await createOverBudgetRepository();
        const stdout = captureStream();
        const stderr = captureStream();

        const exitCode = await runLocalCli(
            ['--mock', '--base', repository.baseSha, '--head', repository.headSha, '--repo', repository.rootDir],
            {
                cwd: workspace,
                env: minimalEnvironment(),
                stdout: stdout.stream,
                stderr: stderr.stream,
                native: nativeHolder.runtime
            }
        );

        expect(exitCode).toBe(1);
        expect(stderr.read()).toContain('Error: Diff exceeds the review budget');
        expect(stderr.read()).toContain('diff = ');
        expect(stderr.read()).toContain('limit = 20000');
        expect(stderr.read()).toContain('--force-over-budget');
        expect(stderr.read()).not.toContain('Proceed with a partial review?');
        expect(stdout.read()).toBe('');
    });

    test('reads an explicit --config file from the local filesystem', async () => {
        /* The base commit sets a 20,000 budget; the explicit local file raises it,
           so the review proceeds only when the local file is honored. */
        const repository = await createOverBudgetRepository();
        const localConfig = path.join(workspace, 'trusted-local.yml');
        await writeFile(localConfig, 'review:\n  diffBudgetChars: 1000000\n');
        const stdout = captureStream();
        const stderr = captureStream();

        const exitCode = await runLocalCli(
            [
                '--mock',
                '--config',
                localConfig,
                '--base',
                repository.baseSha,
                '--head',
                repository.headSha,
                '--repo',
                repository.rootDir
            ],
            {
                cwd: workspace,
                env: minimalEnvironment(),
                stdout: stdout.stream,
                stderr: stderr.stream,
                native: nativeHolder.runtime
            }
        );

        expect(stderr.read()).not.toContain('limit = 20000');
        expect(stdout.read()).toContain('Reviewed commit:');
        expect(exitCode).toBe(0);
    });

    test('fails clearly when the explicit --config file is unreadable', async () => {
        const repository = await createCliRepository();
        const stdout = captureStream();
        const stderr = captureStream();

        const exitCode = await runLocalCli(
            [
                '--mock',
                '--config',
                path.join(workspace, 'missing-local.yml'),
                '--base',
                repository.baseSha,
                '--head',
                repository.headSha,
                '--repo',
                repository.rootDir
            ],
            {
                cwd: workspace,
                env: minimalEnvironment(),
                stdout: stdout.stream,
                stderr: stderr.stream,
                native: nativeHolder.runtime
            }
        );

        expect(exitCode).toBe(1);
        expect(stderr.read()).toContain('Failed to read the explicit config');
    });

    test('reads an explicit --instructions file as untrusted local guidance', async () => {
        const repository = await createCliRepository();
        const instructions = path.join(workspace, 'review-guidance.md');
        const guidanceText = 'Focus on the migration path; the queue nit is not interesting.';
        await writeFile(instructions, guidanceText);
        const stdout = captureStream();
        const stderr = captureStream();

        const exitCode = await runLocalCli(
            [
                '--mock',
                '--instructions',
                instructions,
                '--base',
                repository.baseSha,
                '--head',
                repository.headSha,
                '--repo',
                repository.rootDir
            ],
            {
                cwd: workspace,
                env: minimalEnvironment(),
                stdout: stdout.stream,
                stderr: stderr.stream,
                native: nativeHolder.runtime
            }
        );

        expect(exitCode).toBe(0);
        expect(stdout.read()).toContain('Execution: Local CLI');
        expect(stdout.read()).toContain('User guidance: provided (local file)');
        expect(stdout.read()).toContain('<summary>User guidance used</summary>');
        expect(stdout.read()).toContain(guidanceText);
        expect(stderr.read()).not.toContain(guidanceText);
        expect(stderr.read()).toContain('Do not put secrets in review guidance.');
    });

    test('fails an --instructions file above the guidance cap with an explicit error', async () => {
        const repository = await createCliRepository();
        const instructions = path.join(workspace, 'oversized-guidance.md');
        await writeFile(instructions, 'x'.repeat(8001));
        const stdout = captureStream();
        const stderr = captureStream();

        const exitCode = await runLocalCli(
            [
                '--mock',
                '--instructions',
                instructions,
                '--base',
                repository.baseSha,
                '--head',
                repository.headSha,
                '--repo',
                repository.rootDir
            ],
            {
                cwd: workspace,
                env: minimalEnvironment(),
                stdout: stdout.stream,
                stderr: stderr.stream,
                native: nativeHolder.runtime
            }
        );

        expect(exitCode).toBe(1);
        expect(stdout.read()).toBe('');
        expect(stderr.read()).toContain('Error:');
        expect(stderr.read()).toContain('--instructions');
        expect(stderr.read()).toContain('8000');
    });

    test('fails clearly when the explicit --instructions file is unreadable', async () => {
        const repository = await createCliRepository();
        const stdout = captureStream();
        const stderr = captureStream();

        const exitCode = await runLocalCli(
            [
                '--mock',
                '--instructions',
                path.join(workspace, 'missing-guidance.md'),
                '--base',
                repository.baseSha,
                '--head',
                repository.headSha,
                '--repo',
                repository.rootDir
            ],
            {
                cwd: workspace,
                env: minimalEnvironment(),
                stdout: stdout.stream,
                stderr: stderr.stream,
                native: nativeHolder.runtime
            }
        );

        expect(exitCode).toBe(1);
        expect(stdout.read()).toBe('');
        expect(stderr.read()).toContain('Cannot read the --instructions file');
    });

    test('accepts an --instructions file at the character cap', async () => {
        const repository = await createCliRepository();
        const instructions = path.join(workspace, 'cap-guidance.md');
        await writeFile(instructions, 'x'.repeat(8000));
        const stdout = captureStream();
        const stderr = captureStream();

        const exitCode = await runLocalCli(
            [
                '--mock',
                '--instructions',
                instructions,
                '--base',
                repository.baseSha,
                '--head',
                repository.headSha,
                '--repo',
                repository.rootDir
            ],
            {
                cwd: workspace,
                env: minimalEnvironment(),
                stdout: stdout.stream,
                stderr: stderr.stream,
                native: nativeHolder.runtime
            }
        );

        expect(exitCode).toBe(0);
        expect(stdout.read()).toContain('User guidance: provided (local file)');
        expect(stderr.read()).not.toContain('Error:');
    });

    test('applies the guidance cap to multi-byte UTF-8 characters', async () => {
        const repository = await createCliRepository();
        const accepted = path.join(workspace, 'two-byte-guidance.md');
        /* 8,000 two-byte characters are 16,000 UTF-8 bytes: accepted. */
        await writeFile(accepted, 'é'.repeat(8000));
        const acceptedStdout = captureStream();

        const acceptedExit = await runLocalCli(
            [
                '--mock',
                '--instructions',
                accepted,
                '--base',
                repository.baseSha,
                '--head',
                repository.headSha,
                '--repo',
                repository.rootDir
            ],
            {
                cwd: workspace,
                env: minimalEnvironment(),
                stdout: acceptedStdout.stream,
                stderr: captureStream().stream,
                native: nativeHolder.runtime
            }
        );

        expect(acceptedExit).toBe(0);
        expect(acceptedStdout.read()).toContain('User guidance: provided (local file)');

        const rejected = path.join(workspace, 'two-byte-over-cap.md');
        await writeFile(rejected, 'é'.repeat(8001));
        const rejectedStderr = captureStream();

        const rejectedExit = await runLocalCli(
            [
                '--mock',
                '--instructions',
                rejected,
                '--base',
                repository.baseSha,
                '--head',
                repository.headSha,
                '--repo',
                repository.rootDir
            ],
            {
                cwd: workspace,
                env: minimalEnvironment(),
                stdout: captureStream().stream,
                stderr: rejectedStderr.stream,
                native: nativeHolder.runtime
            }
        );

        expect(rejectedExit).toBe(1);
        expect(rejectedStderr.read()).toContain('8001');
        expect(rejectedStderr.read()).toContain('8000');
    });

    test('rejects an --instructions file above the byte bound without materializing it', async () => {
        const repository = await createCliRepository();
        const instructions = path.join(workspace, 'large-guidance.md');
        /* Far above 8,000 characters * 4 bytes: the bounded read must never
           decode or retain the whole file. */
        await writeFile(instructions, 'x'.repeat(100_000));
        const stdout = captureStream();
        const stderr = captureStream();

        const exitCode = await runLocalCli(
            [
                '--mock',
                '--instructions',
                instructions,
                '--base',
                repository.baseSha,
                '--head',
                repository.headSha,
                '--repo',
                repository.rootDir
            ],
            {
                cwd: workspace,
                env: minimalEnvironment(),
                stdout: stdout.stream,
                stderr: stderr.stream,
                native: nativeHolder.runtime
            }
        );

        expect(exitCode).toBe(1);
        expect(stdout.read()).toBe('');
        expect(stderr.read()).toContain('Error:');
        expect(stderr.read()).toContain('--instructions');
        expect(stderr.read()).toContain('8000');
    });

    test.skipIf(process.platform !== 'linux')(
        'rejects an unbounded --instructions source without reading it to the end',
        async () => {
            /* /dev/zero never reaches EOF: the run ends only because the read is
               bounded, which proves the file is not materialized. */
            const stdout = captureStream();
            const stderr = captureStream();

            const exitCode = await runLocalCli(['--mock', '--instructions', '/dev/zero'], {
                cwd: workspace,
                env: minimalEnvironment(),
                stdout: stdout.stream,
                stderr: stderr.stream,
                native: nativeHolder.runtime
            });

            expect(exitCode).toBe(1);
            expect(stdout.read()).toBe('');
            expect(stderr.read()).toContain('--instructions');
            expect(stderr.read()).toContain('8000');
        }
    );

    test('resolves a relative --instructions path against the invocation cwd', async () => {
        const repository = await createCliRepository();
        const invocationDirectory = await mkdtemp(path.join(tmpdir(), 'sakre-cli-cwd-'));

        try {
            /* The file exists only under the invocation cwd and never under the
               repository directory: resolving against `--repo` cannot pass. */
            await writeFile(path.join(invocationDirectory, 'relative-guidance.md'), 'Focus on the relative path.');
            const stdout = captureStream();
            const stderr = captureStream();

            const exitCode = await runLocalCli(
                [
                    '--mock',
                    '--instructions',
                    'relative-guidance.md',
                    '--base',
                    repository.baseSha,
                    '--head',
                    repository.headSha,
                    '--repo',
                    repository.rootDir
                ],
                {
                    cwd: invocationDirectory,
                    env: minimalEnvironment(),
                    stdout: stdout.stream,
                    stderr: stderr.stream,
                    native: nativeHolder.runtime
                }
            );

            expect(exitCode).toBe(0);
            expect(stdout.read()).toContain('User guidance: provided (local file)');
            expect(stderr.read()).not.toContain('Error:');
        } finally {
            await rm(invocationDirectory, { recursive: true, force: true });
        }
    });

    test('never discovers guidance from a repository file at HEAD', async () => {
        const repository = await createCliRepository();
        const marker = 'REPOSITORY GUIDANCE MUST NOT BE DISCOVERED';
        await writeFile(path.join(repository.rootDir, 'review-guidance.md'), `${marker}\n`);
        run('git', ['add', 'review-guidance.md'], repository.rootDir);
        run('git', ['commit', '-qm', 'guidance'], repository.rootDir);
        const headSha = run('git', ['rev-parse', 'HEAD'], repository.rootDir);
        const stdout = captureStream();
        const stderr = captureStream();

        const exitCode = await runLocalCli(
            ['--mock', '--base', repository.baseSha, '--head', headSha, '--repo', repository.rootDir],
            {
                cwd: workspace,
                env: minimalEnvironment(),
                stdout: stdout.stream,
                stderr: stderr.stream,
                native: nativeHolder.runtime
            }
        );

        expect(exitCode).toBe(0);
        expect(stdout.read()).toContain('User guidance: none');
        expect(`${stdout.read()}${stderr.read()}`).not.toContain(marker);
    });

    test('reviews the portion that fits with --force-over-budget and ends incomplete', async () => {
        const repository = await createOverBudgetRepository();
        const stdout = captureStream();
        const stderr = captureStream();

        const exitCode = await runLocalCli(
            [
                '--mock',
                '--force-over-budget',
                '--base',
                repository.baseSha,
                '--head',
                repository.headSha,
                '--repo',
                repository.rootDir
            ],
            {
                cwd: workspace,
                env: minimalEnvironment(),
                stdout: stdout.stream,
                stderr: stderr.stream,
                native: nativeHolder.runtime
            }
        );

        expect(exitCode).toBe(1);
        expect(stdout.read()).toContain(`## ⚠️ ${PRODUCT_NAME}: review incomplete`);
        expect(stdout.read()).toContain('Diff coverage is incomplete');
        expect(stdout.read()).toContain('src/app.js');
        expect(stderr.read()).not.toContain('Proceed with a partial review?');
    });

    test('prompts on a TTY and proceeds on y', async () => {
        const repository = await createOverBudgetRepository();
        const stdout = captureStream();
        const stderr = captureStream();

        const exitCode = await runLocalCli(
            ['--mock', '--base', repository.baseSha, '--head', repository.headSha, '--repo', repository.rootDir],
            {
                cwd: workspace,
                env: minimalEnvironment(),
                stdout: stdout.stream,
                stderr: stderr.stream,
                stdin: Readable.from(['y\n']),
                isTty: true,
                native: nativeHolder.runtime
            }
        );

        expect(exitCode).toBe(1);
        expect(stderr.read()).toContain('Proceed with a partial review? [y/N]');
        expect(stderr.read()).toContain('reviewable');
        expect(stdout.read()).toContain('review incomplete');
    });

    test('prompts on a TTY and aborts on n without reviewing', async () => {
        const repository = await createOverBudgetRepository();
        const stdout = captureStream();
        const stderr = captureStream();

        const exitCode = await runLocalCli(
            ['--mock', '--base', repository.baseSha, '--head', repository.headSha, '--repo', repository.rootDir],
            {
                cwd: workspace,
                env: minimalEnvironment(),
                stdout: stdout.stream,
                stderr: stderr.stream,
                stdin: Readable.from(['n\n']),
                isTty: true,
                native: nativeHolder.runtime
            }
        );

        expect(exitCode).toBe(1);
        expect(stderr.read()).toContain('Proceed with a partial review? [y/N]');
        expect(stderr.read()).toContain('--force-over-budget');
        expect(stdout.read()).toBe('');
    });

    test('also writes the Markdown to a file with --output-file', async () => {
        const repository = await createCliRepository();
        const stdout = captureStream();

        const firstExit = await runLocalCli(['--mock', '--base', repository.baseSha, '--head', repository.headSha], {
            cwd: repository.rootDir,
            env: minimalEnvironment(),
            stdout: stdout.stream,
            stderr: captureStream().stream,
            native: nativeHolder.runtime
        });

        const target = path.join(repository.rootDir, 'review.md');
        const secondStdout = captureStream();

        const secondExit = await runLocalCli(
            ['--mock', '--base', repository.baseSha, '--head', repository.headSha, '--output-file', target],
            {
                cwd: repository.rootDir,
                env: minimalEnvironment(),
                stdout: secondStdout.stream,
                stderr: captureStream().stream,
                native: nativeHolder.runtime
            }
        );

        expect(firstExit).toBe(0);
        expect(secondExit).toBe(0);
        /* `--output-file` is an additional sink: terminal output still reaches
           stdout, and both sinks carry the identical Markdown. */
        expect(secondStdout.read()).toBe(stdout.read());
        expect(await readFile(target, 'utf8')).toBe(stdout.read());
    });

    test('writes the file in github-pr output without publishing twice', async () => {
        const repository = await createCliRepository({ remote: 'https://github.com/acme/demo.git' });
        const fixture = createGitHubFixture();
        const target = path.join(repository.rootDir, 'published.md');
        const stdout = captureStream();

        const exitCode = await runLocalCli(
            [
                '--mock',
                '--base',
                repository.baseSha,
                '--head',
                repository.headSha,
                '--context',
                'github',
                '--output',
                'github-pr',
                '--output-file',
                target
            ],
            {
                cwd: repository.rootDir,
                env: { PATH: process.env.PATH ?? '', GITHUB_TOKEN: 'fake-token' },
                stdout: stdout.stream,
                stderr: captureStream().stream,
                native: nativeHolder.runtime,
                githubClientDependencies: { createOctokit: () => fixture.octokit }
            }
        );

        expect(exitCode).toBe(0);
        expect(fixture.progressBodies).toHaveLength(1);
        expect(fixture.finalBodies).toHaveLength(1);
        expect(fixture.finalBodies[0]).toContain('"status":"complete"');
        /* Publication to a pull request never changes the run provenance, and
           the actual model invocations stay visible in the same body. */
        expect(fixture.finalBodies[0]).toContain('Execution: Local CLI');
        expect(fixture.finalBodies[0]).toContain('"execution":"local-cli"');
        expect(fixture.finalBodies[0]).toContain('<summary>Models used');
        expect(fixture.finalBodies[0]).toContain('| correctness | mock-model |');
        expect(fixture.finalBodies[0]).toContain('"agentId":"coordinator","model":"mock-model"');
        expect(fixture.finalBodies[0]).not.toContain('| verifier |');
        /* The published comment and the local file are one report: the CLI
           renders both from the same provenance value. */
        const [publishedBody] = fixture.finalBodies;

        if (publishedBody === undefined) {
            throw new Error('Expected a published final comment.');
        }

        expect(await readFile(target, 'utf8')).toBe(`${stripCommentMarkers(publishedBody)}\n`);
        /* GitHub PR output never duplicates the report on stdout. */
        expect(stdout.read()).toBe('');
    });

    test('reports a missing environment key before any provider work', async () => {
        const repository = await createCliRepository();
        const stderr = captureStream();

        const exitCode = await runLocalCli(
            ['--base', repository.baseSha, '--head', repository.headSha, '--auth', 'env'],
            {
                cwd: repository.rootDir,
                env: minimalEnvironment(),
                stdout: captureStream().stream,
                stderr: stderr.stream,
                native: nativeHolder.runtime
            }
        );

        expect(exitCode).toBe(1);
        expect(stderr.read()).toContain(PROVIDER_API_KEY_ENV);
    });

    test('passes a keyless Zen Free route to the host even without an OpenCode store', async () => {
        const repository = await createCliRepository();
        const absentStore = path.join(workspace, 'no-opencode-store.json');

        for (const mode of ['auto', 'opencode']) {
            const captured: { effective?: EffectiveRun } = {};

            const exitCode = await runLocalCli(
                [
                    '--repo',
                    repository.rootDir,
                    '--base',
                    repository.baseSha,
                    '--head',
                    repository.headSha,
                    '--auth',
                    mode,
                    '--provider',
                    'opencode',
                    '--model',
                    'mimo-v2.6-flash-free'
                ],
                {
                    env: minimalEnvironment(),
                    authStorePath: absentStore,
                    native: nativeHolder.runtime,
                    stdout: captureStream().stream,
                    stderr: captureStream().stream,
                    createRuntime: (input) => {
                        captured.effective = input.effective;

                        return Promise.resolve(createMockRuntime());
                    }
                }
            );

            expect(exitCode).toBe(0);
            expect(captured.effective).toMatchObject({ provider: 'opencode', model: 'mimo-v2.6-flash-free' });
            expect(captured.effective?.apiKey).toBeUndefined();
        }
    });

    test('does not inject a stored OpenCode Go key into the independent Zen integration', async () => {
        const repository = await createCliRepository();
        const storePath = path.join(workspace, 'go-only-store.json');
        await writeFile(storePath, JSON.stringify({ 'opencode-go': { type: 'api', key: 'go-only-secret' } }));
        const captured: { effective?: EffectiveRun } = {};

        const exitCode = await runLocalCli(
            [
                '--repo',
                repository.rootDir,
                '--base',
                repository.baseSha,
                '--head',
                repository.headSha,
                '--auth',
                'opencode',
                '--provider',
                'opencode',
                '--model',
                'muse-spark-1.3-contributor-free'
            ],
            {
                env: minimalEnvironment(),
                authStorePath: storePath,
                native: nativeHolder.runtime,
                stdout: captureStream().stream,
                stderr: captureStream().stream,
                createRuntime: (input) => {
                    captured.effective = input.effective;

                    return Promise.resolve(createMockRuntime());
                }
            }
        );

        expect(exitCode).toBe(0);
        expect(captured.effective?.provider).toBe('opencode');
        expect(captured.effective?.apiKey).toBeUndefined();
    });

    test('names both credential options when the provider is absent from the store', async () => {
        const repository = await createCliRepository();
        const storePath = path.join(workspace, 'auth-store.json');
        await writeFile(storePath, JSON.stringify({ anthropic: { type: 'api', key: 'anthropic-key' } }));
        const stderr = captureStream();

        const exitCode = await runLocalCli(
            [
                '--base',
                repository.baseSha,
                '--head',
                repository.headSha,
                '--auth',
                'opencode',
                '--provider',
                'openai',
                '--model',
                'gpt-5'
            ],
            {
                cwd: repository.rootDir,
                env: minimalEnvironment(),
                authStorePath: storePath,
                stdout: captureStream().stream,
                stderr: stderr.stream,
                native: nativeHolder.runtime
            }
        );

        expect(exitCode).toBe(1);
        expect(stderr.read()).toContain('sakre auth login');
        expect(stderr.read()).toContain(PROVIDER_API_KEY_ENV);
    });

    test('logs in with auth login and then reviews with the stored credential', async () => {
        const repository = await createCliRepository();
        const provider = startFakeProvider();
        const baseNative = nativeHolder.runtime;

        if (baseNative === undefined) {
            throw new Error('The fake native runtime was not initialised.');
        }

        const credentialNative: NativeRuntime = {
            ...baseNative,
            engineCredentialPath: path.join(repository.rootDir, 'credentials.json'),
            engineOAuthCredentialPath: path.join(repository.rootDir, 'credentials.db')
        };

        try {
            const loginExit = await runAuthCli(['login', 'anthropic', '--key', 'sk-ant-stored'], {
                native: () => Promise.resolve(credentialNative),
                env: {},
                stderr: captureStream().stream
            });

            expect(loginExit).toBe(0);

            const stdout = captureStream();
            const stderr = captureStream();

            const exitCode = await runLocalCli(
                [
                    '--base',
                    repository.baseSha,
                    '--head',
                    repository.headSha,
                    '--repo',
                    repository.rootDir,
                    '--provider',
                    'anthropic',
                    '--model',
                    'claude-opus-5'
                ],
                {
                    cwd: repository.rootDir,
                    env: { ...minimalEnvironment(), SAKRE_PROVIDER_BASE_URL: provider.baseURL },
                    stdout: stdout.stream,
                    stderr: stderr.stream,
                    native: credentialNative
                }
            );

            expect(exitCode).toBe(0);
            expect(stdout.read()).toContain('Reviewed commit:');
            const toolRequests = provider.requests.filter((request) => request.tools.length > 0);
            expect(toolRequests.length).toBeGreaterThanOrEqual(1);
            expect(toolRequests.every((request) => request.authHeaders['x-api-key'] === 'sk-ant-stored')).toBe(true);
        } finally {
            await provider.stop();
        }
    });

    test('prefers selected OAuth in auto mode while explicit env mode keeps the API key', async () => {
        const repository = await createCliRepository();
        const baseNative = nativeHolder.runtime;

        if (baseNative === undefined) {
            throw new Error('The fake native runtime was not initialised.');
        }

        const credentialNative: NativeRuntime = {
            ...baseNative,
            engineOAuthCredentialPath: path.join(repository.rootDir, 'oauth', 'credentials.db')
        };

        const credentialID = await seedOAuthCredential(credentialNative.engineOAuthCredentialPath, 'openai');

        const captured: {
            auto?: { apiKey?: string; oauthCredential?: { path: string; credentialID: string } };
            env?: { apiKey?: string; oauthCredential?: { path: string; credentialID: string } };
        } = {};

        for (const mode of ['auto', 'env'] as const) {
            const exitCode = await runLocalCli(
                [
                    '--repo',
                    repository.rootDir,
                    '--base',
                    repository.baseSha,
                    '--head',
                    repository.headSha,
                    '--auth',
                    mode,
                    '--provider',
                    'openai',
                    '--model',
                    'gpt-5'
                ],
                {
                    env: { ...minimalEnvironment(), [PROVIDER_API_KEY_ENV]: 'environment-key' },
                    native: credentialNative,
                    stdout: captureStream().stream,
                    stderr: captureStream().stream,
                    createRuntime: (input) => {
                        captured[mode] = {
                            apiKey: input.effective.apiKey,
                            oauthCredential: input.oauthCredential
                        };

                        return Promise.resolve(createMockRuntime());
                    }
                }
            );

            expect(exitCode).toBe(0);
        }

        expect(captured.auto).toEqual({
            apiKey: undefined,
            oauthCredential: { path: credentialNative.engineOAuthCredentialPath, credentialID }
        });
        expect(captured.env).toEqual({
            apiKey: 'environment-key',
            oauthCredential: undefined
        });
    });

    test('requires explicit selection for multiple OAuth accounts and rejects cross-provider IDs', async () => {
        const repository = await createCliRepository();
        const baseNative = nativeHolder.runtime;

        if (baseNative === undefined) {
            throw new Error('Native runtime was not initialised.');
        }

        const native = {
            ...baseNative,
            engineOAuthCredentialPath: path.join(repository.rootDir, 'multi', 'credentials.db')
        };

        const first = await seedOAuthCredential(native.engineOAuthCredentialPath, 'openai', false);
        await seedOAuthCredential(native.engineOAuthCredentialPath, 'openai', false);
        const wrongProvider = await seedOAuthCredential(native.engineOAuthCredentialPath, 'github-copilot', false);

        const args = [
            '--repo',
            repository.rootDir,
            '--base',
            repository.baseSha,
            '--head',
            repository.headSha,
            '--auth',
            'auto',
            '--provider',
            'openai',
            '--model',
            'gpt-5'
        ];

        async function attempt(
            credential?: string
        ): Promise<{ code: number; stderr: string; selected?: string; apiKey?: string }> {
            const stderr = captureStream();
            const captured: { selected?: string; apiKey?: string } = {};
            const commandArgs = [...args];

            if (credential !== undefined) {
                commandArgs.push('--credential', credential);
            }

            const code = await runLocalCli(commandArgs, {
                env: { ...minimalEnvironment(), [PROVIDER_API_KEY_ENV]: 'environment-key' },
                native,
                stdout: captureStream().stream,
                stderr: stderr.stream,
                createRuntime: (input) => {
                    captured.selected = input.oauthCredential?.credentialID;
                    captured.apiKey = input.effective.apiKey;

                    return Promise.resolve(createMockRuntime());
                }
            });

            return { code, stderr: stderr.read(), ...captured };
        }

        const ambiguous = await attempt();
        expect(ambiguous.code).toBe(1);
        expect(ambiguous.stderr).toContain('--credential');
        expect(await attempt(first)).toMatchObject({ code: 0, selected: first, apiKey: undefined });
        const crossProvider = await attempt(wrongProvider);
        expect(crossProvider.code).toBe(1);
        expect(crossProvider.stderr).toContain('does not belong');
        const missing = await attempt('missing-id');
        expect(missing.code).toBe(1);
        expect(missing.stderr).toContain('does not belong');
    });

    test('mock reviews do not require an OAuth account choice', async () => {
        const repository = await createCliRepository();
        const baseNative = nativeHolder.runtime;

        if (baseNative === undefined) {
            throw new Error('Native runtime was not initialised.');
        }

        const native = {
            ...baseNative,
            engineOAuthCredentialPath: path.join(repository.rootDir, 'mock-accounts', 'credentials.db')
        };

        await seedOAuthCredential(native.engineOAuthCredentialPath, 'openai', false);
        await seedOAuthCredential(native.engineOAuthCredentialPath, 'openai', false);
        const stderr = captureStream();

        const code = await runLocalCli(
            [
                '--repo',
                repository.rootDir,
                '--base',
                repository.baseSha,
                '--head',
                repository.headSha,
                '--context',
                'git',
                '--auth',
                'auto',
                '--provider',
                'openai',
                '--model',
                'gpt-5',
                '--mock'
            ],
            { env: minimalEnvironment(), native, stdout: captureStream().stream, stderr: stderr.stream }
        );

        expect(code).toBe(0);
        expect(stderr.read()).not.toContain('--credential');
    });

    test('explicit credential rejects non-auto auth modes', async () => {
        const repository = await createCliRepository();

        for (const [mode, mockFlag] of [
            ['env', []],
            ['opencode', []],
            ['env', ['--mock']]
        ] as const) {
            const stderr = captureStream();

            const code = await runLocalCli(
                [
                    '--repo',
                    repository.rootDir,
                    '--base',
                    repository.baseSha,
                    '--head',
                    repository.headSha,
                    '--context',
                    'git',
                    '--auth',
                    mode,
                    '--credential',
                    'account-id',
                    '--provider',
                    'openai',
                    '--model',
                    'gpt-5',
                    ...mockFlag
                ],
                {
                    env: { ...minimalEnvironment(), [PROVIDER_API_KEY_ENV]: 'environment-key' },
                    native: nativeHolder.runtime,
                    stdout: captureStream().stream,
                    stderr: stderr.stream,
                    createRuntime: () => {
                        throw new Error('Invalid auth combination must not start runtime.');
                    }
                }
            );

            expect(code).toBe(1);
            expect(stderr.read()).toContain('--credential requires --auth auto');
        }
    });

    test('an explicit API-key source does not read an unrelated damaged OAuth store', async () => {
        const repository = await createCliRepository();
        const baseNative = nativeHolder.runtime;

        if (baseNative === undefined) {
            throw new Error('The fake native runtime was not initialised.');
        }

        const brokenPath = path.join(repository.rootDir, 'unreadable-oauth.db');
        await writeFile(brokenPath, 'not a SQLite database');
        const stderr = captureStream();

        const exitCode = await runLocalCli(
            [
                '--repo',
                repository.rootDir,
                '--base',
                repository.baseSha,
                '--head',
                repository.headSha,
                '--auth',
                'env',
                '--provider',
                'openai',
                '--model',
                'gpt-5'
            ],
            {
                env: { ...minimalEnvironment(), [PROVIDER_API_KEY_ENV]: 'environment-key' },
                native: { ...baseNative, engineOAuthCredentialPath: brokenPath },
                stdout: captureStream().stream,
                stderr: stderr.stream,
                createRuntime: () => Promise.resolve(createMockRuntime())
            }
        );

        expect(exitCode).toBe(0);
        expect(stderr.read()).not.toContain('database disk image');
    });

    test('a selected OAuth credential does not read a damaged lower-priority API-key store', async () => {
        const repository = await createCliRepository();
        const baseNative = nativeHolder.runtime;

        if (baseNative === undefined) {
            throw new Error('The fake native runtime was not initialised.');
        }

        const native: NativeRuntime = {
            ...baseNative,
            engineCredentialPath: path.join(repository.rootDir, 'damaged-api-keys.json'),
            engineOAuthCredentialPath: path.join(repository.rootDir, 'data', 'credentials.db')
        };

        await writeFile(native.engineCredentialPath, 'not JSON');
        const credentialID = await seedOAuthCredential(native.engineOAuthCredentialPath, 'openai');
        const captured: { credentialID?: string } = {};

        const exitCode = await runLocalCli(
            [
                '--repo',
                repository.rootDir,
                '--base',
                repository.baseSha,
                '--head',
                repository.headSha,
                '--auth',
                'auto',
                '--provider',
                'openai',
                '--model',
                'gpt-5'
            ],
            {
                env: minimalEnvironment(),
                native,
                stdout: captureStream().stream,
                stderr: captureStream().stream,
                createRuntime: (input) => {
                    captured.credentialID = input.oauthCredential?.credentialID;

                    return Promise.resolve(createMockRuntime());
                }
            }
        );

        expect(exitCode).toBe(0);
        expect(captured.credentialID).toBe(credentialID);
    });

    test('falls back to the Git context when a GitHub remote has no token', async () => {
        const repository = await createCliRepository({ remote: 'https://github.com/acme/demo.git' });
        const stderr = captureStream();

        const exitCode = await runLocalCli(['--mock', '--base', repository.baseSha, '--head', repository.headSha], {
            cwd: repository.rootDir,
            env: minimalEnvironment(),
            stdout: captureStream().stream,
            stderr: stderr.stream,
            native: nativeHolder.runtime,
            githubClientDependencies: {
                createOctokit: () => {
                    throw new Error('GitHub must not be called without a token.');
                }
            }
        });

        expect(exitCode).toBe(0);
        expect(stderr.read()).toContain('GitHub context');
    });

    test('never calls GitHub or gh for a non-GitHub remote', async () => {
        const repository = await createCliRepository({ remote: 'https://gitlab.com/acme/demo.git' });
        const marker = path.join(workspace, 'gh-called.txt');
        const binDirectory = path.join(workspace, 'bin');
        await mkdir(binDirectory, { recursive: true });
        await writeFile(path.join(binDirectory, 'gh'), `#!/bin/sh\ntouch "${marker}"\nprintf 'token\\n'\n`);
        await chmod(path.join(binDirectory, 'gh'), 0o755);
        let octokitCalls = 0;
        const stderr = captureStream();

        const exitCode = await runLocalCli(['--mock', '--base', repository.baseSha, '--head', repository.headSha], {
            cwd: repository.rootDir,
            env: { PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ''}` },
            stdout: captureStream().stream,
            stderr: stderr.stream,
            native: nativeHolder.runtime,
            githubClientDependencies: {
                createOctokit: () => {
                    octokitCalls += 1;
                    throw new Error('GitHub must not be called.');
                }
            }
        });

        expect(exitCode).toBe(0);
        expect(octokitCalls).toBe(0);
        expect(stderr.read()).toContain('not GitHub');
        expect(await fileExists(marker)).toBe(false);
    });

    test('publishes through Octokit when --output github-pr is requested', async () => {
        const repository = await createCliRepository({ remote: 'https://github.com/acme/demo.git' });
        const fixture = createGitHubFixture();

        const exitCode = await runLocalCli(
            [
                '--mock',
                '--base',
                repository.baseSha,
                '--head',
                repository.headSha,
                '--context',
                'github',
                '--output',
                'github-pr',
                '--pr',
                '7'
            ],
            {
                cwd: repository.rootDir,
                env: { PATH: process.env.PATH ?? '', GITHUB_TOKEN: 'fake-token' },
                stdout: captureStream().stream,
                stderr: captureStream().stream,
                native: nativeHolder.runtime,
                githubClientDependencies: { createOctokit: () => fixture.octokit }
            }
        );

        expect(exitCode).toBe(0);
        expect(fixture.progressBodies).toHaveLength(1);
        expect(fixture.progressBodies[0]).toContain('review in progress');
        expect(fixture.finalBodies).toHaveLength(1);
        expect(fixture.finalBodies[0]).toContain('"status":"complete"');
        expect(fixture.finalBodies[0]).toContain('Execution: Local CLI');
        expect(fixture.pullsGetCalls).toBe(1);
    });

    test('discovers the pull request automatically through the server-side head filter', async () => {
        const repository = await createCliRepository({ remote: 'https://github.com/acme/demo.git' });
        const fixture = createGitHubFixture({ pullNumber: 12, branch: 'feature' });
        const stderr = captureStream();

        const exitCode = await runLocalCli(
            ['--mock', '--base', repository.baseSha, '--head', repository.headSha, '--repo', repository.rootDir],
            {
                cwd: workspace,
                env: { PATH: process.env.PATH ?? '', HOME: homeRoot, GITHUB_TOKEN: 'fake-token' },
                stdout: captureStream().stream,
                stderr: stderr.stream,
                native: nativeHolder.runtime,
                githubClientDependencies: { createOctokit: () => fixture.octokit }
            }
        );

        expect(exitCode).toBe(0);
        expect(fixture.listCalls).toHaveLength(1);
        expect(fixture.listCalls[0]).toMatchObject({ head: 'acme:feature', per_page: 1, state: 'open' });
        expect(fixture.pullsGetCalls).toBe(1);
    });

    test('reaches a fork pull request and publishes through the upstream repository', async () => {
        const repository = await createCliRepository({ remote: 'https://github.com/contributor/demo.git' });
        run('git', ['remote', 'add', 'upstream', 'https://github.com/acme/demo.git'], repository.rootDir);
        const fixture = createGitHubFixture({ pullNumber: 12, branch: 'feature' });
        const stderr = captureStream();

        const exitCode = await runLocalCli(
            [
                '--mock',
                '--base',
                repository.baseSha,
                '--head',
                repository.headSha,
                '--repo',
                repository.rootDir,
                '--output',
                'github-pr'
            ],
            {
                cwd: workspace,
                env: { PATH: process.env.PATH ?? '', HOME: homeRoot, GITHUB_TOKEN: 'fake-token' },
                stdout: captureStream().stream,
                stderr: stderr.stream,
                native: nativeHolder.runtime,
                githubClientDependencies: { createOctokit: () => fixture.octokit }
            }
        );

        expect(exitCode).toBe(0);
        expect(fixture.listCalls).toHaveLength(1);
        expect(fixture.listCalls[0]).toMatchObject({
            owner: 'acme',
            repo: 'demo',
            head: 'contributor:feature',
            per_page: 1,
            state: 'open'
        });
        expect(fixture.pullsGetCalls).toBe(1);
        expect(fixture.commentTargets).toEqual([
            { owner: 'acme', repo: 'demo' },
            { owner: 'acme', repo: 'demo' }
        ]);
    });

    test('uses an explicit --pr without querying for an open pull request', async () => {
        const repository = await createCliRepository({ remote: 'https://github.com/acme/demo.git' });
        const fixture = createGitHubFixture({ pullNumber: 12, branch: 'feature' });
        const stderr = captureStream();

        const exitCode = await runLocalCli(
            [
                '--mock',
                '--base',
                repository.baseSha,
                '--head',
                repository.headSha,
                '--repo',
                repository.rootDir,
                '--context',
                'github',
                '--pr',
                '12'
            ],
            {
                cwd: workspace,
                env: { PATH: process.env.PATH ?? '', HOME: homeRoot, GITHUB_TOKEN: 'fake-token' },
                stdout: captureStream().stream,
                stderr: stderr.stream,
                native: nativeHolder.runtime,
                githubClientDependencies: { createOctokit: () => fixture.octokit }
            }
        );

        expect(exitCode).toBe(0);
        expect(fixture.listCalls).toHaveLength(0);
        expect(fixture.pullsGetCalls).toBe(1);
    });

    test('requires --pr when the checkout is a detached HEAD', async () => {
        const repository = await createCliRepository({ remote: 'https://github.com/acme/demo.git' });
        run('git', ['checkout', '-q', '--detach'], repository.rootDir);
        const fixture = createGitHubFixture();
        const stderr = captureStream();

        const exitCode = await runLocalCli(
            [
                '--mock',
                '--base',
                repository.baseSha,
                '--head',
                repository.headSha,
                '--repo',
                repository.rootDir,
                '--context',
                'github'
            ],
            {
                cwd: workspace,
                env: { PATH: process.env.PATH ?? '', HOME: homeRoot, GITHUB_TOKEN: 'fake-token' },
                stdout: captureStream().stream,
                stderr: stderr.stream,
                native: nativeHolder.runtime,
                githubClientDependencies: { createOctokit: () => fixture.octokit }
            }
        );

        expect(exitCode).toBe(1);
        expect(fixture.listCalls).toHaveLength(0);
        expect(stderr.read()).toContain('detached HEAD');
        expect(stderr.read()).toContain('--pr');
    });

    test('falls back to the Git context when the branch has no open pull request', async () => {
        const repository = await createCliRepository({ remote: 'https://github.com/acme/demo.git' });
        const fixture = createGitHubFixture({ hasPullRequest: false });
        const stderr = captureStream();

        const exitCode = await runLocalCli(
            ['--mock', '--base', repository.baseSha, '--head', repository.headSha, '--repo', repository.rootDir],
            {
                cwd: workspace,
                env: { PATH: process.env.PATH ?? '', HOME: homeRoot, GITHUB_TOKEN: 'fake-token' },
                stdout: captureStream().stream,
                stderr: stderr.stream,
                native: nativeHolder.runtime,
                githubClientDependencies: { createOctokit: () => fixture.octokit }
            }
        );

        expect(exitCode).toBe(0);
        expect(fixture.listCalls).toHaveLength(1);
        expect(fixture.pullsGetCalls).toBe(0);
        expect(stderr.read()).toContain('no open pull request');
        expect(stderr.read()).toContain('--pr');
    });

    test('fails actionably for --context github when the branch has no open pull request', async () => {
        const repository = await createCliRepository({ remote: 'https://github.com/acme/demo.git' });
        const fixture = createGitHubFixture({ hasPullRequest: false });
        const stderr = captureStream();

        const exitCode = await runLocalCli(
            [
                '--mock',
                '--base',
                repository.baseSha,
                '--head',
                repository.headSha,
                '--repo',
                repository.rootDir,
                '--context',
                'github'
            ],
            {
                cwd: workspace,
                env: { PATH: process.env.PATH ?? '', HOME: homeRoot, GITHUB_TOKEN: 'fake-token' },
                stdout: captureStream().stream,
                stderr: stderr.stream,
                native: nativeHolder.runtime,
                githubClientDependencies: { createOctokit: () => fixture.octokit }
            }
        );

        expect(exitCode).toBe(1);
        expect(stderr.read()).toContain('branch "feature"');
        expect(stderr.read()).toContain('acme/demo');
        expect(stderr.read()).toContain('--pr');
        expect(stderr.read()).toContain('fork');
    });

    test('injects the requested store key into the runtime without an environment key', async () => {
        const repository = await createCliRepository();
        const storePath = path.join(workspace, 'native-auth-store.json');
        await writeFile(storePath, JSON.stringify({ anthropic: { type: 'api', key: 'store-key' } }));
        const captured: { effective?: EffectiveRun } = {};

        const exitCode = await runLocalCli(
            [
                '--repo',
                repository.rootDir,
                '--base',
                repository.baseSha,
                '--head',
                repository.headSha,
                '--auth',
                'opencode',
                '--provider',
                'anthropic',
                '--model',
                'claude-sonnet-4-5'
            ],
            {
                cwd: workspace,
                env: minimalEnvironment(),
                authStorePath: storePath,
                stdout: captureStream().stream,
                stderr: captureStream().stream,
                native: nativeHolder.runtime,
                createRuntime: (input) => {
                    captured.effective = input.effective;

                    return Promise.resolve(createMockRuntime());
                }
            }
        );

        expect(exitCode).toBe(0);
        expect(captured.effective?.apiKey).toBe('store-key');
    });

    test('fails explicitly when the selected OpenCode store entry is an OAuth credential', async () => {
        const repository = await createCliRepository();
        const storePath = path.join(workspace, 'oauth-auth-store.json');
        await writeFile(storePath, JSON.stringify({ anthropic: { type: 'oauth', access: 'store-token' } }));
        const stderr = captureStream();
        const stdout = captureStream();

        const exitCode = await runLocalCli(
            [
                '--repo',
                repository.rootDir,
                '--base',
                repository.baseSha,
                '--head',
                repository.headSha,
                '--auth',
                'opencode',
                '--provider',
                'anthropic',
                '--model',
                'claude-sonnet-4-5'
            ],
            {
                cwd: workspace,
                env: minimalEnvironment(),
                authStorePath: storePath,
                stdout: stdout.stream,
                stderr: stderr.stream,
                native: nativeHolder.runtime
            }
        );

        expect(exitCode).toBe(1);
        expect(stderr.read()).toContain('OAuth credential');
        expect(stderr.read()).toContain('separate store');
        expect(stderr.read()).toContain('auth login');
        expect(stderr.read()).not.toContain('store-token');
    });

    test('reads AGENTS.md from the BASE overlay workspace when --base is given', async () => {
        const repository = await createCliRepository({
            baseAgents: 'base instructions\n',
            headAgents: 'head instructions\n'
        });

        const captured: { checkoutDir?: string; agents?: string } = {};

        const exitCode = await runLocalCli(
            ['--mock', '--base', repository.baseSha, '--head', repository.headSha, '--repo', repository.rootDir],
            {
                cwd: workspace,
                env: minimalEnvironment(),
                stdout: captureStream().stream,
                stderr: captureStream().stream,
                native: nativeHolder.runtime,
                createRuntime: async (input) => {
                    captured.checkoutDir = input.checkoutDir;
                    captured.agents = await readFile(path.join(input.checkoutDir ?? '', 'AGENTS.md'), 'utf8');

                    return createMockRuntime();
                }
            }
        );

        expect(exitCode).toBe(0);
        expect(captured.checkoutDir).not.toBe(repository.rootDir);
        expect(captured.agents).toBe('base instructions\n');
        expect(await readFile(path.join(repository.rootDir, 'AGENTS.md'), 'utf8')).toBe('head instructions\n');
    });

    test('keeps the checkout as the trusted directory without --base', async () => {
        const repository = await createCliRepository({
            baseAgents: 'base instructions\n',
            headAgents: 'head instructions\n'
        });

        const captured: { checkoutDir?: string } = {};

        const exitCode = await runLocalCli(['--mock', '--head', repository.headSha, '--repo', repository.rootDir], {
            cwd: workspace,
            env: minimalEnvironment(),
            stdout: captureStream().stream,
            stderr: captureStream().stream,
            native: nativeHolder.runtime,
            createRuntime: (input) => {
                captured.checkoutDir = input.checkoutDir;

                return Promise.resolve(createMockRuntime());
            }
        });

        expect(exitCode).toBe(0);
        expect(captured.checkoutDir).toBe(repository.rootDir);
    });

    test('applies the repository configuration from the base commit, never from head', async () => {
        const repository = await createCliRepository({
            baseConfig: 'provider: openai-compatible\nmodel: base-model\n',
            headConfig: 'provider: anthropic\n'
        });

        const stderr = captureStream();

        const exitCode = await runLocalCli(
            ['--mock', '--base', repository.baseSha, '--head', repository.headSha, '--repo', repository.rootDir],
            {
                cwd: workspace,
                env: minimalEnvironment(),
                stdout: captureStream().stream,
                stderr: stderr.stream,
                native: nativeHolder.runtime
            }
        );

        expect(exitCode).toBe(0);
        expect(stderr.read()).toContain('"provider":"openai-compatible"');
    });

    test('fails when the target directory is not a Git repository', async () => {
        const directory = await mkdtemp(path.join(tmpdir(), 'sakre-not-a-repo-'));

        try {
            const stderr = captureStream();

            const exitCode = await runLocalCli(['--mock'], {
                cwd: directory,
                env: minimalEnvironment(),
                stdout: captureStream().stream,
                stderr: stderr.stream,
                native: nativeHolder.runtime
            });

            expect(exitCode).toBe(1);
            expect(stderr.read()).toContain('Error: The review target is not inside a Git repository.');
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    test('fails clearly when --output github-pr has no token', async () => {
        const repository = await createCliRepository({ remote: 'https://github.com/acme/demo.git' });
        const stderr = captureStream();

        const exitCode = await runLocalCli(
            [
                '--mock',
                '--base',
                repository.baseSha,
                '--head',
                repository.headSha,
                '--output',
                'github-pr',
                '--pr',
                '7'
            ],
            {
                cwd: repository.rootDir,
                env: minimalEnvironment(),
                native: nativeHolder.runtime,
                stdout: captureStream().stream,
                stderr: stderr.stream
            }
        );

        expect(exitCode).toBe(1);
        expect(stderr.read()).toContain('GITHUB_TOKEN');
    });

    test('fails actionably for --output github-pr when no open pull request is found', async () => {
        const repository = await createCliRepository({ remote: 'https://github.com/acme/demo.git' });
        const fixture = createGitHubFixture({ hasPullRequest: false });
        const stderr = captureStream();

        const exitCode = await runLocalCli(
            [
                '--mock',
                '--base',
                repository.baseSha,
                '--head',
                repository.headSha,
                '--repo',
                repository.rootDir,
                '--output',
                'github-pr'
            ],
            {
                cwd: workspace,
                env: { PATH: process.env.PATH ?? '', HOME: homeRoot, GITHUB_TOKEN: 'fake-token' },
                stdout: captureStream().stream,
                stderr: stderr.stream,
                native: nativeHolder.runtime,
                githubClientDependencies: { createOctokit: () => fixture.octokit }
            }
        );

        expect(exitCode).toBe(1);
        expect(stderr.read()).toContain('--pr');
    });
});

function minimalEnvironment(): NodeJS.ProcessEnv {
    return { PATH: process.env.PATH ?? '', HOME: homeRoot };
}

function captureStream(): CapturedStream {
    let text = '';

    const stream = new Writable({
        write(chunk: Buffer, _encoding, callback): void {
            text += chunk.toString('utf8');
            callback();
        }
    });

    return { stream, read: () => text };
}

async function seedOAuthCredential(databasePath: string, integrationID: string, select = true): Promise<string> {
    await prepareOAuthCredentialStore(databasePath);
    const layer = persistentCredentialLayer({ path: databasePath, integrationID, persistCreatedSelection: select });

    const credential = await Effect.runPromise(
        Effect.gen(function* createTestCredential() {
            const service = yield* Credential.Service;

            return yield* service.create({
                integrationID: Schema.decodeUnknownSync(Integration.ID)(integrationID),
                label: 'selected account',
                value: Credential.OAuth.make({
                    type: 'oauth',
                    methodID: Schema.decodeUnknownSync(Integration.MethodID)('test'),
                    access: 'oauth-access',
                    refresh: 'oauth-refresh',
                    expires: 0
                })
            });
        }).pipe(Effect.provide(layer))
    );

    return credential.id;
}

function createGitHubFixture(
    input: { pullNumber?: number; branch?: string; hasPullRequest?: boolean } = {}
): GitHubFixture {
    const pullNumber = input.pullNumber ?? 7;
    const branch = input.branch ?? 'feature';
    const hasPullRequest = input.hasPullRequest ?? true;
    const progressBodies: string[] = [];
    const finalBodies: string[] = [];
    const listCalls: Record<string, unknown>[] = [];
    const commentTargets: { owner: string; repo: string }[] = [];
    let pullsGetCalls = 0;

    const octokit = {
        paginate: (): Promise<unknown[]> => Promise.resolve([]),
        rest: {
            pulls: {
                list: (parameters: Record<string, unknown>): Promise<{ data: unknown[] }> => {
                    listCalls.push(parameters);

                    if (!hasPullRequest) {
                        return Promise.resolve({ data: [] });
                    }

                    return Promise.resolve({ data: [{ number: pullNumber, head: { ref: branch } }] });
                },
                get: (): Promise<{ data: Record<string, unknown> }> => {
                    pullsGetCalls += 1;

                    return Promise.resolve({
                        data: {
                            number: pullNumber,
                            title: 'Local fixture PR',
                            body: 'PR body',
                            user: { login: 'alice' },
                            base: { ref: 'main', sha: 'a'.repeat(40) },
                            head: { ref: branch, sha: 'b'.repeat(40) }
                        }
                    });
                }
            },
            issues: {
                listComments: (): Promise<{ data: unknown[] }> => Promise.resolve({ data: [] }),
                createComment: (entry: {
                    owner: string;
                    repo: string;
                    body: string;
                }): Promise<{ data: { id: number } }> => {
                    commentTargets.push({ owner: entry.owner, repo: entry.repo });
                    progressBodies.push(entry.body);

                    return Promise.resolve({ data: { id: 101 } });
                },
                updateComment: (entry: {
                    owner: string;
                    repo: string;
                    body: string;
                }): Promise<{ data: { id: number } }> => {
                    commentTargets.push({ owner: entry.owner, repo: entry.repo });
                    finalBodies.push(entry.body);

                    return Promise.resolve({ data: { id: 101 } });
                }
            }
        }
    };

    // SAFETY: the fake implements the pulls/issues calls this CLI case exercises; request bodies are asserted below.
    return {
        // eslint-disable-next-line anti-slop/no-chained-type-assertions -- fake implements only the exercised methods; the chain bridges the partial fake to the SDK type
        octokit: octokit as unknown as OctokitLike,
        progressBodies,
        finalBodies,
        listCalls,
        commentTargets,
        get pullsGetCalls(): number {
            return pullsGetCalls;
        }
    };
}

interface CliRepositoryOptions {
    remote?: string;
    baseConfig?: string;
    headConfig?: string;
    headContent?: string;
    baseAgents?: string;
    headAgents?: string;
}

const DEFAULT_HEAD_CONTENT = 'export const value = 2;\nexport const extra = true;\n';

async function createCliRepository(options: CliRepositoryOptions = {}): Promise<CliRepository> {
    const { remote, baseConfig, headConfig, headContent = DEFAULT_HEAD_CONTENT, baseAgents, headAgents } = options;
    const rootDir = await mkdtemp(path.join(tmpdir(), 'sakre-cli-repo-'));
    createdRepositories.push(rootDir);
    run('git', ['init', '-q', '-b', 'main'], rootDir);
    run('git', ['config', 'user.email', 'cli@example.com'], rootDir);
    run('git', ['config', 'user.name', 'CLI Fixture'], rootDir);
    await mkdir(path.join(rootDir, 'src'), { recursive: true });
    await writeFile(path.join(rootDir, 'src', 'app.js'), 'export const value = 1;\n');

    if (baseConfig !== undefined) {
        await mkdir(path.join(rootDir, '.github'), { recursive: true });
        await writeFile(path.join(rootDir, '.github', 'sakre.yml'), baseConfig);
    }

    if (baseAgents !== undefined) {
        await writeFile(path.join(rootDir, 'AGENTS.md'), baseAgents);
    }

    run('git', ['add', '-A'], rootDir);
    run('git', ['commit', '-qm', 'base'], rootDir);
    const baseSha = run('git', ['rev-parse', 'HEAD'], rootDir);
    run('git', ['checkout', '-q', '-b', 'feature'], rootDir);
    await writeFile(path.join(rootDir, 'src', 'app.js'), headContent);

    if (headConfig !== undefined) {
        await mkdir(path.join(rootDir, '.github'), { recursive: true });
        await writeFile(path.join(rootDir, '.github', 'sakre.yml'), headConfig);
    }

    if (headAgents !== undefined) {
        await writeFile(path.join(rootDir, 'AGENTS.md'), headAgents);
    }

    run('git', ['add', '-A'], rootDir);
    run('git', ['commit', '-qm', 'head'], rootDir);
    const headSha = run('git', ['rev-parse', 'HEAD'], rootDir);

    if (remote !== undefined) {
        run('git', ['remote', 'add', 'origin', remote], rootDir);
    }

    return { rootDir, baseSha, headSha };
}

/* Base config with a 20,000-character budget and a head change above it: the
   review aborts before any provider work unless forcing was requested. */
function createOverBudgetRepository(): Promise<CliRepository> {
    const lines = Array.from({ length: 1700 }, (_unused, index) => `export const value${index} = ${index};`);

    return createCliRepository({
        baseConfig: 'review:\n  diffBudgetChars: 20000\n',
        headContent: `${lines.join('\n')}\n`
    });
}

async function fileExists(filePath: string): Promise<boolean> {
    try {
        await stat(filePath);

        return true;
    } catch {
        return false;
    }
}

function run(command: string, arguments_: string[], cwd: string): string {
    const result = spawnSync(command, arguments_, { cwd, encoding: 'utf8' });

    if (result.status !== 0) {
        throw new Error(`${command} failed: ${result.stderr}`);
    }

    return result.stdout.trim();
}
