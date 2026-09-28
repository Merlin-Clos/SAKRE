import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
    cleanupRoots,
    parseResolverPhases,
    runResolver,
    sha256,
    tempRoot,
    writeActionPin,
    writeExecutable
} from '../helpers/action-resolver';

/* Regression for the digest computation: coreutils `sha256sum` escapes the
   filename and prefixes the whole line with a backslash when the path contains
   one, which Windows runner temp paths always do. Reading the file through
   stdin keeps the digest stable whatever shape the cache path has. */
setDefaultTimeout(30_000);

const LINUX_GZ = 'sakre-linux-x64.gz';

afterEach(cleanupRoots);

describe('composite Action resolver verification', () => {
    test('reuses a verified cache entry whose path contains a backslash', async () => {
        const root = await tempRoot('sakre-resolver-backslash-');

        const fixture = await writeExecutable(
            path.join(root, 'fixture-engine.sh'),
            '#!/usr/bin/env bash\nprintf "engine:%s\\n" "$*"\n'
        );

        const digest = sha256(await readFile(fixture));
        const actionPath = await writeActionPin(root, 'v1.0.0', { [LINUX_GZ]: digest });
        const runnerTemp = path.join(root, String.raw`runner\temp`);
        const installed = path.join(runnerTemp, 'sakre-engine', 'v1.0.0', 'sakre-linux-x64');
        await mkdir(path.dirname(installed), { recursive: true });
        await writeFile(installed, await readFile(fixture), { mode: 0o755 });

        const result = await runResolver({
            root,
            actionPath,
            args: ['--version'],
            env: { RUNNER_TEMP: runnerTemp }
        });

        expect(result.exitCode, result.stderr).toBe(0);
        expect(result.stdout).toContain('engine:--version');
        expect(parseResolverPhases(result.stderr).source).toBe('cache');
    });
});
