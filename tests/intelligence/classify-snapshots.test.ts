import { describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { GitTreeSnapshot } from '../../src/analysis/snapshot';
import { classificationWarnings, classifySnapshots } from '../../src/intelligence/classify-snapshots';
import { defaultClassificationRules } from '../../src/analysis/classification';
import type { VcsChangedFile } from '../../src/vcs/types';

/* Classification reads are real file reads: an unchanged blob reuses the BASE
   classification without a second read, and a read that actually fails is
   reported. Fabricating the counters cannot prove either contract. */

const SHA_A = 'a'.repeat(40);

const SHA_B = 'b'.repeat(40);

/* A permission-denied read is only reachable for a non-root POSIX user. */
const canDenyRead = process.platform !== 'win32' && (process.getuid?.() ?? 0) !== 0;

function snapshot(directory: string, files: { path: string; blobSha: string }[]): GitTreeSnapshot {
    return { sha: SHA_A, directory, listing: { files }, close: () => Promise.resolve() };
}

function changedFile(filePath: string): VcsChangedFile {
    return { path: filePath, status: 'modified', additions: 1, deletions: 0, patch: { state: 'none' } };
}

async function makeRoots(): Promise<{ baseRoot: string; headRoot: string }> {
    const baseRoot = await mkdtemp(path.join(tmpdir(), 'sakre-classify-base-'));
    const headRoot = await mkdtemp(path.join(tmpdir(), 'sakre-classify-head-'));
    await Promise.all([mkdir(path.join(baseRoot, 'src')), mkdir(path.join(headRoot, 'src'))]);

    return { baseRoot, headRoot };
}

describe('snapshot classification', () => {
    test('reuses the BASE classification for a stable path with an unchanged blob', async () => {
        const { baseRoot, headRoot } = await makeRoots();

        try {
            await writeFile(path.join(baseRoot, 'src', 'app.ts'), '// @generated\nbase content\n');
            /* The on-disk HEAD content is marker-free: only the equal blob SHA
               can explain a reused `generated` classification. */
            await writeFile(path.join(headRoot, 'src', 'app.ts'), 'export const value = 1;\n');

            const unchanged = await classifySnapshots({
                changedFiles: [changedFile('src/app.ts')],
                rules: defaultClassificationRules(),
                baseTree: snapshot(baseRoot, [{ path: 'src/app.ts', blobSha: SHA_A }]),
                headTree: snapshot(headRoot, [{ path: 'src/app.ts', blobSha: SHA_A }])
            });

            expect(unchanged.base.get('src/app.ts')?.classification).toBe('generated');
            expect(unchanged.head.get('src/app.ts')?.classification).toBe('generated');
            expect(unchanged.readFailures).toEqual({ base: 0, head: 0 });

            /* A different blob SHA means the content changed: the marker-free
               HEAD file must be classified from its own prefix. */
            const changed = await classifySnapshots({
                changedFiles: [changedFile('src/app.ts')],
                rules: defaultClassificationRules(),
                baseTree: snapshot(baseRoot, [{ path: 'src/app.ts', blobSha: SHA_A }]),
                headTree: snapshot(headRoot, [{ path: 'src/app.ts', blobSha: SHA_B }])
            });

            expect(changed.head.get('src/app.ts')?.classification).toBe('source');
        } finally {
            await Promise.all([
                rm(baseRoot, { recursive: true, force: true }),
                rm(headRoot, { recursive: true, force: true })
            ]);
        }
    });

    test.skipIf(!canDenyRead)('reports a real failed BASE read and never reuses it for HEAD', async () => {
        const { baseRoot, headRoot } = await makeRoots();
        const lockedPath = path.join(baseRoot, 'src', 'locked.ts');

        try {
            await writeFile(lockedPath, '// @generated\nlocked content\n');
            await chmod(lockedPath, 0o000);
            await writeFile(path.join(headRoot, 'src', 'locked.ts'), '// @generated\nreadable content\n');

            const result = await classifySnapshots({
                changedFiles: [changedFile('src/locked.ts')],
                rules: defaultClassificationRules(),
                baseTree: snapshot(baseRoot, [{ path: 'src/locked.ts', blobSha: SHA_A }]),
                headTree: snapshot(headRoot, [{ path: 'src/locked.ts', blobSha: SHA_A }])
            });

            expect(result.readFailures).toEqual({ base: 1, head: 0 });
            expect(classificationWarnings(result)).toEqual([
                '1 BASE file prefix(es) could not be read for generated-marker detection; classified by path only.'
            ]);
            /* The failed BASE read degrades to path-only classification and is
               not reused: HEAD is read and detects the marker. */
            expect(result.base.get('src/locked.ts')?.classification).toBe('source');
            expect(result.head.get('src/locked.ts')?.classification).toBe('generated');
        } finally {
            await chmod(lockedPath, 0o600);
            await Promise.all([
                rm(baseRoot, { recursive: true, force: true }),
                rm(headRoot, { recursive: true, force: true })
            ]);
        }
    });
});
