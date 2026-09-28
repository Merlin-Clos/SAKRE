import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import packageJson from '../../package.json' with { type: 'json' };
import { PRODUCT_NAME } from '../../src/identity';
import { createRepository } from '../helpers/artifact-repository';
import {
    credentialFreeEnvironment,
    reviewEnvironment,
    runStandalone,
    standaloneArtifactAvailable,
    standaloneFailure
} from '../helpers/standalone-cli';

/* Standalone CLI contract of the compiled binary: help answers without any
   initialization, Git-context reviews need no GitHub credential, a trusted
   `--config` file reaches the run, and `--output-file` never replaces the
   selected output. GitHub context and publication are covered separately. */
setDefaultTimeout(180_000);

let root = '';

beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'sakre-standalone-'));
});

afterAll(async () => {
    await rm(root, { recursive: true, force: true });
});

describe('standalone CLI artifact', () => {
    test.skipIf(!standaloneArtifactAvailable)(
        'answers help and version without credentials or a Git repository',
        async () => {
            const cwd = await mkdtemp(path.join(root, 'outside-'));
            const environment = await credentialFreeEnvironment(root);

            const help = await runStandalone(['--help'], { cwd, env: environment });
            expect(help.exitCode).toBe(0);
            expect(help.stdout).toContain('Usage: sakre');
            expect(help.stdout).toContain('local');
            expect(help.stdout).toContain('auth');
            expect(help.stderr).toBe('');

            const version = await runStandalone(['--version'], { cwd, env: environment });
            expect(version.exitCode).toBe(0);
            expect(version.stdout.trim()).toBe(`${PRODUCT_NAME} ${packageJson.version}`);

            const localHelp = await runStandalone(['local', '--help'], { cwd, env: environment });
            expect(localHelp.exitCode).toBe(0);
            expect(localHelp.stdout).toContain('Usage: sakre local');
            expect(localHelp.stdout).toContain('--context');
            expect(localHelp.stdout).toContain('--output-file');
            expect(localHelp.stderr).toBe('');

            /* `help local` must route to the local help, not the root help. */
            const helpLocal = await runStandalone(['help', 'local'], { cwd, env: environment });
            expect(helpLocal.exitCode).toBe(0);
            expect(helpLocal.stdout).toContain('Usage: sakre local');
            expect(helpLocal.stdout).toContain('--output-file');
            expect(helpLocal.stderr).toBe('');

            const authHelp = await runStandalone(['auth', '--help'], { cwd, env: environment });
            expect(authHelp.exitCode).toBe(0);
            expect(authHelp.stdout).toContain('Usage: sakre auth');
            expect(authHelp.stdout).toContain('login');
            expect(authHelp.stderr).toBe('');

            const loginHelp = await runStandalone(['auth', 'login', '--help'], { cwd, env: environment });
            expect(loginHelp.exitCode).toBe(0);
            expect(loginHelp.stdout).toContain('Usage: sakre auth login');
            expect(loginHelp.stdout).toContain('provider');
            expect(loginHelp.stdout).toContain('--key');
            expect(loginHelp.stderr).toBe('');

            for (const output of [help, version, localHelp, helpLocal, authHelp, loginHelp]) {
                expect(output.stderr).not.toContain('::error::');
            }
        }
    );

    test.skipIf(!standaloneArtifactAvailable)('fails an unknown root command as an interactive error', async () => {
        const cwd = await mkdtemp(path.join(root, 'unknown-command-'));
        const environment = await credentialFreeEnvironment(root);

        const result = await runStandalone(['--frobnicate'], { cwd, env: environment });
        expect(result.exitCode).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain('unknown option');
        expect(result.stderr).not.toContain('::error::');
    });

    test.skipIf(!standaloneArtifactAvailable)(
        'reviews with Git context and terminal output without any GitHub credential',
        async () => {
            const directory = await mkdtemp(path.join(root, 'git-context-'));
            const repository = await createRepository(directory);
            const environment = await reviewEnvironment(root);

            const result = await runStandalone(
                [
                    'local',
                    '--mock',
                    '--context',
                    'git',
                    '--output',
                    'terminal',
                    '--base',
                    repository.baseSha,
                    '--head',
                    repository.headSha,
                    '--repo',
                    repository.rootDir
                ],
                { cwd: repository.rootDir, env: environment }
            );

            expect(result.exitCode, standaloneFailure(result)).toBe(0);
            expect(result.stdout).toContain('Reviewed commit:');
            expect(result.stdout).toContain('Execution: Local CLI');
            expect(result.stdout).toContain('User guidance: none');
            expect(result.stdout).toContain('<summary>Review intelligence · deterministic SCC + CCCC</summary>');
            /* The compiled CLI runs the embedded CCCC binary, not a host tool. */
            expect(result.stdout).toContain('<summary>Functions / CCCC</summary>');
            expect(result.stdout).toContain('| Function count |');
            expect(result.stdout).not.toContain('CCCC distributions unavailable');
            expect(result.stderr).not.toContain('::error::');
            /* The isolated PATH contains no `gh`; Git context must not need it. */
            expect(result.stderr).not.toContain('GitHub');
        }
    );

    test.skipIf(!standaloneArtifactAvailable)(
        'reads absolute and cwd-relative --instructions guidance outside a Git repository',
        async () => {
            const directory = await mkdtemp(path.join(root, 'instructions-'));
            const repository = await createRepository(directory);
            const environment = await reviewEnvironment(root);
            /* The guidance fixture and the process working directory both sit
               outside any Git repository: the file is read only because the
               option was passed. */
            const cwd = await mkdtemp(path.join(root, 'outside-git-'));
            const guidanceText = 'Focus on <script>& details</pre>\n</details>\n## Injected';
            const guidance = path.join(cwd, 'review-guidance.md');
            await writeFile(guidance, guidanceText, 'utf8');

            const result = await runStandalone(
                [
                    'local',
                    '--mock',
                    '--instructions',
                    guidance,
                    '--base',
                    repository.baseSha,
                    '--head',
                    repository.headSha,
                    '--repo',
                    repository.rootDir
                ],
                { cwd, env: environment }
            );

            expect(result.exitCode, standaloneFailure(result)).toBe(0);
            expect(result.stdout).toContain('Execution: Local CLI');
            expect(result.stdout).toContain('User guidance: provided (local file)');
            expect(result.stdout).toContain(
                `<pre>\n${guidanceText.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}\n</pre>`
            );
            expect(result.stderr).toContain('Do not put secrets in review guidance.');
            expect(result.stderr).not.toContain(guidanceText);

            /* The same file resolves relative to the process cwd: the compiled
               binary and the in-process CLI share the contract. */
            const relative = await runStandalone(
                [
                    'local',
                    '--mock',
                    '--instructions',
                    'review-guidance.md',
                    '--base',
                    repository.baseSha,
                    '--head',
                    repository.headSha,
                    '--repo',
                    repository.rootDir
                ],
                { cwd, env: environment }
            );

            expect(relative.exitCode, standaloneFailure(relative)).toBe(0);
            expect(relative.stdout).toContain('User guidance: provided (local file)');
            expect(relative.stdout).toContain(
                `<pre>\n${guidanceText.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}\n</pre>`
            );
            expect(relative.stdout).not.toContain('</pre>\n</details>\n## Injected');
            expect(relative.stderr).toContain('Do not put secrets in review guidance.');
            expect(relative.stderr).not.toContain(guidanceText);

            const oversized = path.join(cwd, 'oversized-guidance.md');
            await writeFile(oversized, 'x'.repeat(8001), 'utf8');

            const failed = await runStandalone(
                [
                    'local',
                    '--mock',
                    '--instructions',
                    oversized,
                    '--base',
                    repository.baseSha,
                    '--head',
                    repository.headSha,
                    '--repo',
                    repository.rootDir
                ],
                { cwd, env: environment }
            );

            expect(failed.exitCode).toBe(1);
            expect(failed.stdout).toBe('');
            expect(failed.stderr).toContain('Error:');
            expect(failed.stderr).toContain('8000');
        }
    );

    test.skipIf(!standaloneArtifactAvailable)('honors a trusted --config file outside the repository', async () => {
        const directory = await mkdtemp(path.join(root, 'trusted-config-'));
        const repository = await createRepository(directory);
        const environment = await reviewEnvironment(root);
        const trustedConfig = path.join(directory, 'trusted-local.yml');
        await writeFile(trustedConfig, 'provider: openai-compatible\n', 'utf8');

        const baseline = await runStandalone(
            [
                'local',
                '--mock',
                '--base',
                repository.baseSha,
                '--head',
                repository.headSha,
                '--repo',
                repository.rootDir
            ],
            { cwd: repository.rootDir, env: environment }
        );

        expect(baseline.exitCode, standaloneFailure(baseline)).toBe(0);
        expect(baseline.stderr).toContain('"provider":"anthropic"');

        const trusted = await runStandalone(
            [
                'local',
                '--mock',
                '--config',
                trustedConfig,
                '--base',
                repository.baseSha,
                '--head',
                repository.headSha,
                '--repo',
                repository.rootDir
            ],
            { cwd: repository.rootDir, env: environment }
        );

        expect(trusted.exitCode, standaloneFailure(trusted)).toBe(0);
        expect(trusted.stderr).toContain('"provider":"openai-compatible"');
    });

    test.skipIf(!standaloneArtifactAvailable)(
        'writes the report with --output-file while terminal output still reaches stdout',
        async () => {
            const directory = await mkdtemp(path.join(root, 'output-file-'));
            const repository = await createRepository(directory);
            const environment = await reviewEnvironment(root);
            const target = path.join(directory, 'review.md');

            const result = await runStandalone(
                [
                    'local',
                    '--mock',
                    '--base',
                    repository.baseSha,
                    '--head',
                    repository.headSha,
                    '--repo',
                    repository.rootDir,
                    '--output-file',
                    target
                ],
                { cwd: repository.rootDir, env: environment }
            );

            expect(result.exitCode, standaloneFailure(result)).toBe(0);
            expect(result.stdout).toContain('Reviewed commit:');
            expect(await readFile(target, 'utf8')).toBe(result.stdout);
        }
    );
});
