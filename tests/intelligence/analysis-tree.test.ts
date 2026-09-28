import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AnalysisTreeError, createAnalysisTree } from '../../src/intelligence/analysis-tree';
import { rejectionOf } from '../helpers/rejection';

/* A failed materialization must not leave a populated tree behind: the worker
   pool settles before cleanup, so the temporary directory is removed after the
   last in-flight link attempt. The unsafe path sits after 1,000 files: with the
   previous immediate-rejection pool, workers kept materializing the remaining
   ~4,000 files while cleanup ran and the directory survived. */

const FILE_COUNT = 5000;

const UNSAFE_INDEX = 1000;

describe('filtered analysis tree', () => {
    test('removes the temporary tree when a path cannot be materialized', async () => {
        const scratchRoot = await mkdtemp(path.join(tmpdir(), 'sakre-analysis-parent-'));
        const source = path.join(scratchRoot, 'source');
        const files = Array.from({ length: FILE_COUNT }, (_unused, index) => `src/file-${String(index)}.ts`);

        try {
            await mkdir(path.join(source, 'src'), { recursive: true });
            await Promise.all(files.map((file) => writeFile(path.join(source, file), 'export const value = 1;\n')));

            /* The unsafe path is planned after enough files that the previous
               un-settled pool would still be materializing when cleanup ran. */
            const failure = await rejectionOf(
                createAnalysisTree({
                    sourceDirectory: source,
                    files: [
                        ...files.slice(0, UNSAFE_INDEX),
                        String.raw`src/unsafe\path.ts`,
                        ...files.slice(UNSAFE_INDEX)
                    ],
                    scratchRoot
                })
            );

            expect(failure).toBeInstanceOf(AnalysisTreeError);
            expect(await readdir(scratchRoot)).toEqual(['source']);
        } finally {
            await rm(scratchRoot, { recursive: true, force: true });
        }
    });
});
