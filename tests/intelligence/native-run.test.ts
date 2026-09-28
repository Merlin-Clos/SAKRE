import { describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultClassificationRules } from '../../src/analysis/classification';
import { nativeToolVersion } from '../../src/native/assets';
import { createNativeIntelligenceRun } from '../../src/intelligence/native-run';
import { type NativeRuntime, pinnedNativeAssetManifest } from '../../src/native/runtime';
import type { VcsChangedFile } from '../../src/vcs/types';
import { scriptedTool } from '../helpers/scripted-tool';

/* The Action and CLI pre-pass factory forwards exactly the binaries the native
   runtime materialized and the versions of the pinned manifest. */

const LINE_COUNTING_SCC = `import { readFileSync } from 'node:fs';

const lines = readFileSync('src/a.ts', 'utf8').split('\\n').length - 1;
console.log(JSON.stringify([{ Name: 'TypeScript', Count: 1, Lines: lines + 900, Code: lines, Comment: 0, Blank: 0, Bytes: 10, Complexity: 1, Cognitive: 1, ULOC: lines, Files: [] }]));
`;

const EMPTY_CCCC = `console.log(JSON.stringify({ files: [], summary: { file_count: 0, function_count: 0, parse_error_count: 0, parse_error_file_count: 0, cognitive: { sum: 0, max: 0, median: 0, p90: 0, p95: 0 }, cyclomatic: { sum: 0, max: 0, median: 0, p90: 0, p95: 0 } } }));
`;

describe('native intelligence run', () => {
    test('runs the pre-pass with the materialized binaries and pinned versions', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'sakre-native-run-'));
        const repository = path.join(root, 'repository');
        const tools = path.join(root, 'tools');

        try {
            await mkdir(path.join(repository, 'src'), { recursive: true });
            await mkdir(tools);
            git(repository, ['init', '--initial-branch', 'main']);
            git(repository, ['config', 'user.email', 'fixture@sakre.local']);
            git(repository, ['config', 'user.name', 'SAKRE Fixture']);
            await writeFile(path.join(repository, 'src', 'a.ts'), 'export const a = 1;\n');
            git(repository, ['add', '-A']);
            git(repository, ['commit', '-m', 'base']);
            const baseSha = rev(repository);
            await writeFile(path.join(repository, 'src', 'a.ts'), 'export const a = 2;\nexport const b = 3;\n');
            git(repository, ['add', '-A']);
            git(repository, ['commit', '-m', 'head']);
            const headSha = rev(repository);

            const scc = await scriptedTool(tools, 'materialized-scc', LINE_COUNTING_SCC);
            const cccc = await scriptedTool(tools, 'materialized-cccc', EMPTY_CCCC);
            const run = createNativeIntelligenceRun(fakeRuntime(root, scc, cccc));

            const output = await run({
                worktreeDir: repository,
                baseSha,
                headSha,
                changedFiles: changedFiles(),
                classification: defaultClassificationRules()
            });

            /* The scripted SCC adds 900 to the real line count: a forwarded
               host `scc` would not produce this number. */
            expect(output.map.repository.base.lines).toBe(901);
            expect(output.baseMetrics).toEqual({ recognizedFilesCount: 1, physicalLines: 901 });
            expect(output.map.tools).toEqual({
                scc: { version: nativeToolVersion(pinnedNativeAssetManifest, 'scc'), status: 'ok' },
                cccc: { version: nativeToolVersion(pinnedNativeAssetManifest, 'cccc'), status: 'ok' }
            });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});

function changedFiles(): VcsChangedFile[] {
    return [{ path: 'src/a.ts', status: 'modified', additions: 1, deletions: 0, patch: { state: 'none' } }];
}

function fakeRuntime(cacheRoot: string, scc: string, cccc: string): NativeRuntime {
    return {
        target: 'linux-x64',
        cacheRoot,
        materializeRipgrep: () => Promise.resolve(path.join(cacheRoot, 'rg')),
        materializeScc: () => Promise.resolve(scc),
        materializeCccc: () => Promise.resolve(cccc),
        materializeEnginePlugin: () => Promise.resolve(path.join(cacheRoot, 'plugin')),
        engineCredentialPath: path.join(cacheRoot, 'engine', 'credentials.json'),
        engineOAuthCredentialPath: path.join(cacheRoot, 'data', 'engine', 'credentials.db'),
        engineDatabasePath: path.join(cacheRoot, 'engine', 'runs', 'fixture', 'engine.db'),
        engineDatabaseDirectory: path.join(cacheRoot, 'engine', 'runs', 'fixture')
    };
}

function git(cwd: string, args: readonly string[]): void {
    execSync(['git', ...args].join(' '), { cwd, encoding: 'utf8', stdio: 'ignore' });
}

function rev(cwd: string): string {
    return execSync('git rev-parse HEAD', { cwd, encoding: 'utf8' }).trim();
}
