import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultClassificationRules } from '../../src/analysis/classification';
import { runIntelligencePrePass } from '../../src/intelligence/pre-pass';
import type { VcsChangedFile } from '../../src/vcs/types';
import { resolvePinnedBinary } from '../helpers/native-binary';

/* F-001 regression: the canonical file list of an ordinary large tracked tree
   exceeds the Windows CreateProcessW 32,767-character command line and overflows
   argv on Linux far later. The pre-pass must measure the tree through its
   filtered analysis directory, so this fixture succeeds wherever a pinned tool
   runs, including native Windows CI. */

const FILE_COUNT = 1800;

const WINDOWS_COMMAND_LINE_LIMIT = 32_767;

const sccBinary = await resolvePinnedBinary('scc', '4.1.0', 'SAKRE_SCC_BINARY');

const ccccBinary = await resolvePinnedBinary('cccc', '1.6.0', 'SAKRE_CCCC_BINARY');

function git(cwd: string, args: readonly string[]): void {
    execFileSync('git', [...args], { cwd, encoding: 'utf8', stdio: 'ignore' });
}

function rev(cwd: string): string {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
}

async function createLargeRepository(rootDir: string): Promise<{ baseSha: string; paths: string[] }> {
    git(rootDir, ['init', '--initial-branch', 'main']);
    git(rootDir, ['config', 'user.email', 'fixture@sakre.local']);
    git(rootDir, ['config', 'user.name', 'SAKRE Fixture']);
    const paths: string[] = [];

    for (let index = 0; index < FILE_COUNT; index += 1) {
        const directory = path.join(
            rootDir,
            'src',
            'generated',
            `module-${String(Math.floor(index / 100)).padStart(3, '0')}`
        );

        const relative = `src/generated/module-${String(Math.floor(index / 100)).padStart(3, '0')}/component-${String(index).padStart(4, '0')}-implementation.ts`;
        await mkdir(directory, { recursive: true });
        await writeFile(path.join(rootDir, relative), `export const value${String(index)} = ${String(index)};\n`);
        paths.push(relative);
    }

    git(rootDir, ['add', '-A']);
    git(rootDir, ['commit', '-m', 'large base']);

    return { baseSha: rev(rootDir), paths };
}

describe('large tracked tree', () => {
    test.skipIf(sccBinary === undefined || ccccBinary === undefined)(
        'measures a tree whose canonical file list would overflow the Windows command line',
        async () => {
            if (sccBinary === undefined || ccccBinary === undefined) {
                throw new Error('The large-tree test started without the pinned tools.');
            }

            const rootDir = await mkdtemp(path.join(tmpdir(), 'sakre-large-tree-'));

            try {
                const { baseSha, paths } = await createLargeRepository(rootDir);
                const canonicalArgvChars = paths.reduce((total, file) => total + file.length + 1, 0);
                expect(canonicalArgvChars).toBeGreaterThan(WINDOWS_COMMAND_LINE_LIMIT);

                await writeFile(
                    path.join(rootDir, paths[0] ?? 'src/generated/module-000/component-0000-implementation.ts'),
                    'export const changed = 1;\n'
                );
                git(rootDir, ['add', '-A']);
                git(rootDir, ['commit', '-m', 'large head']);
                const headSha = rev(rootDir);

                const changedFiles: VcsChangedFile[] = [
                    {
                        path: paths[0] ?? 'src/generated/module-000/component-0000-implementation.ts',
                        status: 'modified',
                        additions: 1,
                        deletions: 1,
                        patch: { state: 'none' }
                    }
                ];

                const output = await runIntelligencePrePass({
                    worktreeDir: rootDir,
                    baseSha,
                    headSha,
                    changedFiles,
                    classification: defaultClassificationRules(),
                    sccBinaryPath: sccBinary,
                    ccccBinaryPath: ccccBinary,
                    sccVersion: '4.1.0',
                    ccccVersion: '1.6.0'
                });

                expect(output.map.tools).toEqual({
                    scc: { version: '4.1.0', status: 'ok' },
                    cccc: { version: '1.6.0', status: 'ok' }
                });
                expect(output.baseMetrics.recognizedFilesCount).toBeGreaterThan(FILE_COUNT / 2);
                expect(output.map.repository.head.files).toBeGreaterThan(FILE_COUNT / 2);
                /* The measured HEAD is the committed revision, not the checkout. */
                expect(output.map.files).toHaveLength(1);
            } finally {
                await rm(rootDir, { recursive: true, force: true });
            }
        },
        240_000
    );
});
