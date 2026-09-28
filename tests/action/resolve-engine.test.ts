import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
    cleanupRoots,
    fileExists,
    parseResolverPhases,
    PINNED_DIGEST,
    pwshAvailable,
    pwshEngineTarget,
    runPwshResolver,
    runResolver,
    sha256,
    tempRoot,
    writeActionPin,
    writeExecutable,
    writePwshEngineFixture
} from '../helpers/action-resolver';
import { stubCurl } from '../helpers/curl-stub';

/* The composite Action runs action/resolve-engine.sh through `shell: bash`, so
   the Linux and macOS delivery path is executed for real. The PowerShell cache
   branches run when `pwsh` is installed; its download path needs network and is
   exercised by the Windows CI artifact job and the benchmark workflow. */
setDefaultTimeout(30_000);

const LINUX_GZ = 'sakre-linux-x64.gz';

const INSTALLED = ['runner-temp', 'sakre-engine', 'v1.0.0', 'sakre-linux-x64'];

afterEach(cleanupRoots);

describe('composite Action resolver', () => {
    test('executes a preinstalled override and reports the override phases', async () => {
        const root = await tempRoot('sakre-resolver-override-');

        const fakeEngine = await writeExecutable(
            path.join(root, 'fake-engine.sh'),
            '#!/usr/bin/env bash\nsleep 0.05\nprintf "engine:%s\\n" "$*"\nexit 7\n'
        );

        const result = await runResolver({
            root,
            args: ['--version'],
            env: { SAKRE_ENGINE_BINARY: fakeEngine }
        });

        expect(result.exitCode).toBe(7);
        expect(result.stdout).toContain('engine:--version');
        const phases = parseResolverPhases(result.stderr);
        expect(phases.source).toBe('override');
        /* The override path has zero pre-execute phases by construction, but a
           real engine run must be timed or the instrumentation is broken. */
        expect(phases.execute_ms).toBeGreaterThan(0);
        expect(phases.total_ms).toBeGreaterThanOrEqual(phases.execute_ms);
        const summary = await readFile(path.join(root, 'summary.md'), 'utf8');
        expect(summary).toContain('| bootstrap before spawn, excluding download |');
        expect(summary).toContain('source: `override`');
    });

    test('rejects a runner without a published engine target', async () => {
        const root = await tempRoot('sakre-resolver-target-');
        await writeActionPin(root, 'v1.0.0', { [LINUX_GZ]: PINNED_DIGEST });

        const result = await runResolver({ root, env: { RUNNER_ARCH: 'ARM' } });

        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain('does not publish an engine for Linux/ARM');
    });

    test('fails closed when the Action tree has no release pin yet', async () => {
        const root = await tempRoot('sakre-resolver-unpinned-');
        await writeActionPin(root, null, {});

        const result = await runResolver({ root });

        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain('does not pin an engine release yet');
    });

    test('rejects a full version ref that does not match the committed pin', async () => {
        const root = await tempRoot('sakre-resolver-mismatch-');
        await writeActionPin(root, 'v1.0.0', { [LINUX_GZ]: PINNED_DIGEST });

        const result = await runResolver({ root, env: { GITHUB_ACTION_REF: 'v1.2.3' } });

        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain('pins v1.0.0, but this Action ref is v1.2.3');
    });

    test('downloads, decompresses, verifies and installs the pinned engine', async () => {
        const root = await tempRoot('sakre-resolver-download-');

        const fixture = await writeExecutable(
            path.join(root, 'fixture-engine.sh'),
            '#!/usr/bin/env bash\nprintf "engine:%s\\n" "$*"\n'
        );

        const digest = sha256(await readFile(fixture));
        const actionPath = await writeActionPin(root, 'v1.0.0', { [LINUX_GZ]: digest });
        const stubBin = await stubCurl(root, fixture);

        const result = await runResolver({
            root,
            actionPath,
            args: ['--version'],
            env: { PATH: `${stubBin}:${process.env.PATH ?? ''}` }
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('engine:--version');
        const phases = parseResolverPhases(result.stderr);
        expect(phases.source).toBe('download');
        /* A download path that reports a zero download time would hide a real
           network transfer from the benchmark. */
        expect(phases.download_ms).toBeGreaterThan(0);
        expect(phases.total_ms).toBeGreaterThanOrEqual(phases.download_ms);
        const installed = path.join(root, ...INSTALLED);
        expect(sha256(await readFile(installed))).toBe(digest);
    });

    test('reuses the verified cache entry without downloading again', async () => {
        const root = await tempRoot('sakre-resolver-cache-');

        const fixture = await writeExecutable(
            path.join(root, 'fixture-engine.sh'),
            '#!/usr/bin/env bash\nprintf "engine:%s\\n" "$*"\n'
        );

        const digest = sha256(await readFile(fixture));
        const actionPath = await writeActionPin(root, 'v1.0.0', { [LINUX_GZ]: digest });
        const stubBin = await stubCurl(root, fixture);
        const env = { PATH: `${stubBin}:${process.env.PATH ?? ''}` };

        const first = await runResolver({ root, actionPath, args: ['--version'], env });
        const second = await runResolver({ root, actionPath, args: ['--version'], env });

        expect(parseResolverPhases(first.stderr).source).toBe('download');
        const phases = parseResolverPhases(second.stderr);
        expect(phases.source).toBe('cache');
        expect(phases.download_ms).toBe(0);
        expect(phases.verify_ms).toBeGreaterThanOrEqual(0);
        expect(second.stdout).toContain('engine:--version');
    });

    test('rebuilds a corrupted cache entry from the pinned remote asset', async () => {
        const root = await tempRoot('sakre-resolver-cache-tamper-');

        const fixture = await writeExecutable(
            path.join(root, 'fixture-engine.sh'),
            '#!/usr/bin/env bash\nprintf "engine:%s\\n" "$*"\n'
        );

        const digest = sha256(await readFile(fixture));
        const actionPath = await writeActionPin(root, 'v1.0.0', { [LINUX_GZ]: digest });
        const stubBin = await stubCurl(root, fixture);
        const env = { PATH: `${stubBin}:${process.env.PATH ?? ''}` };

        await runResolver({ root, actionPath, args: ['--version'], env });
        const installed = path.join(root, ...INSTALLED);
        await writeFile(installed, 'tampered');

        const repaired = await runResolver({ root, actionPath, args: ['--version'], env });

        expect(parseResolverPhases(repaired.stderr).source).toBe('download');
        expect(sha256(await readFile(installed))).toBe(digest);
    });

    test('rejects a downloaded engine whose SHA-256 does not match the pin', async () => {
        const root = await tempRoot('sakre-resolver-corrupt-');

        const fixture = await writeExecutable(
            path.join(root, 'fixture-engine.sh'),
            '#!/usr/bin/env bash\nprintf "engine:%s\\n" "$*"\n'
        );

        const actionPath = await writeActionPin(root, 'v1.0.0', { [LINUX_GZ]: PINNED_DIGEST });
        const stubBin = await stubCurl(root, fixture);

        const result = await runResolver({
            root,
            actionPath,
            args: ['--version'],
            env: { PATH: `${stubBin}:${process.env.PATH ?? ''}` }
        });

        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain('does not match the pinned SHA-256');
        expect(await fileExists(path.join(root, ...INSTALLED))).toBe(false);
    });

    test('falls back to the authenticated asset API with the engine_token input', async () => {
        const root = await tempRoot('sakre-resolver-auth-');

        const fixture = await writeExecutable(
            path.join(root, 'fixture-engine.sh'),
            '#!/usr/bin/env bash\nprintf "engine:%s\\n" "$*"\n'
        );

        const digest = sha256(await readFile(fixture));
        const actionPath = await writeActionPin(root, 'v1.0.0', { [LINUX_GZ]: digest });
        const stubBin = await stubCurl(root, fixture, { authenticated: true });
        const curlLog = path.join(root, 'curl.log');

        const result = await runResolver({
            root,
            actionPath,
            args: ['--version'],
            env: {
                PATH: `${stubBin}:${process.env.PATH ?? ''}`,
                INPUT_ENGINE_TOKEN: 'test-token',
                RESOLVER_CURL_LOG: curlLog
            }
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('engine:--version');
        expect(result.stderr).toContain('source=download');
        /* The credential is passed through stdin config, never argv. */
        const applied = await readFile(curlLog, 'utf8');
        expect(applied).not.toContain('test-token');
    });

    test('fails with an actionable engine credential message when a private repository has no token', async () => {
        const root = await tempRoot('sakre-resolver-noauth-');

        const fixture = await writeExecutable(
            path.join(root, 'fixture-engine.sh'),
            '#!/usr/bin/env bash\nprintf "engine:%s\\n" "$*"\n'
        );

        const digest = sha256(await readFile(fixture));
        const actionPath = await writeActionPin(root, 'v1.0.0', { [LINUX_GZ]: digest });
        const stubBin = await stubCurl(root, fixture, { authenticated: true });

        const result = await runResolver({
            root,
            actionPath,
            args: ['--version'],
            env: { PATH: `${stubBin}:${process.env.PATH ?? ''}` }
        });

        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain('Failed to download https://github.com/');
        expect(result.stderr).toContain('engine_token');
        expect(result.stderr).toContain('SAKRE_ENGINE_TOKEN');
        expect(result.stderr).toContain('SAKRE_ENGINE_BINARY');
    });
});

const PWSH_AVAILABLE = pwshAvailable();

/* The cache assertions are identical on both platforms; only the fixture and
   its marker differ, because PowerShell only executes real executables. */
const PWSH_TARGET = pwshEngineTarget(LINUX_GZ);

const PWSH_INSTALLED = ['runner-temp', 'sakre-engine', 'v1.0.0', PWSH_TARGET.binary];

describe('composite Action resolver (PowerShell)', () => {
    test.skipIf(!PWSH_AVAILABLE)('reuses a preinstalled cache entry and executes it', async () => {
        const root = await tempRoot('sakre-resolver-pwsh-cache-');
        const fixture = await writePwshEngineFixture(root);
        const digest = sha256(await readFile(fixture.path));
        const actionPath = await writeActionPin(root, 'v1.0.0', { [PWSH_TARGET.asset]: digest });
        const installed = path.join(root, ...PWSH_INSTALLED);
        await mkdir(path.dirname(installed), { recursive: true });
        await copyFile(fixture.path, installed);

        const result = await runPwshResolver({
            root,
            actionPath,
            args: ['--version'],
            env: { RUNNER_OS: PWSH_TARGET.runnerOs }
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain(fixture.marker);
        const phases = parseResolverPhases(result.stderr);
        expect(phases.source).toBe('cache');
        expect(phases.download_ms).toBe(0);
    });

    test.skipIf(!PWSH_AVAILABLE)('detects a mismatched cache entry and refuses to execute it', async () => {
        const root = await tempRoot('sakre-resolver-pwsh-tamper-');
        const fixture = await writePwshEngineFixture(root);
        const digest = sha256(await readFile(fixture.path));
        const actionPath = await writeActionPin(root, 'v1.0.0', { [PWSH_TARGET.asset]: digest });
        const installed = path.join(root, ...PWSH_INSTALLED);
        await mkdir(path.dirname(installed), { recursive: true });
        await writeFile(installed, 'tampered');

        const result = await runPwshResolver({
            root,
            actionPath,
            args: ['--version'],
            env: { RUNNER_OS: PWSH_TARGET.runnerOs }
        });

        /* The cache entry is discarded; the subsequent download cannot succeed
           without network, so the failure names the download. */
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain('Failed to download');
        expect(result.stdout).not.toContain(fixture.marker);
    });
});
