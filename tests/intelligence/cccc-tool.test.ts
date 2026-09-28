import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { measureCccc } from '../../src/intelligence/measure-cccc';
import { resolvePinnedBinary } from '../helpers/native-binary';

/* Real-binary proof of the CCCC 1.6.0 acquisition: deterministic normalization,
   explicit unsupported files, and parse errors kept as data. Skips when the
   pinned binary is unavailable (CI provides it or the content-addressed cache). */

const CCCC_VERSION = '1.6.0';

const ccccBinary = await resolvePinnedBinary('cccc', CCCC_VERSION, 'SAKRE_CCCC_BINARY');

describe('CCCC acquisition', () => {
    test.skipIf(ccccBinary === undefined)('normalizes a real run deterministically', async () => {
        if (ccccBinary === undefined) {
            throw new Error('The CCCC test started without a binary.');
        }

        const root = await mkdtemp(path.join(tmpdir(), 'sakre-cccc-tool-'));

        try {
            await Promise.all([
                writeFile(
                    path.join(root, 'nest.ts'),
                    'export function outer(){ function inner(){ if (a) return 1; } }\n'
                ),
                writeFile(path.join(root, 'broken.ts'), 'export function broken( { return ;\n'),
                writeFile(path.join(root, 'notes.zzz'), 'unsupported\n')
            ]);
            const files = ['nest.ts', 'broken.ts', 'notes.zzz'];
            const first = await measureCccc({ binaryPath: ccccBinary, directory: root, files });
            const second = await measureCccc({ binaryPath: ccccBinary, directory: root, files });

            expect(first.unsupported).toEqual(['notes.zzz']);
            expect(first.summary.parseErrorFileCount).toBe(1);
            expect(first.files.find((file) => file.path === 'broken.ts')?.parseErrors.length).toBeGreaterThan(0);
            const functions = first.files.find((file) => file.path === 'nest.ts')?.functions ?? [];
            expect(functions.map((fn) => fn.name)).toContain('inner');
            expect(functions.find((fn) => fn.name === 'inner')?.parentChain).toEqual(['outer']);
            expect(JSON.stringify(second)).toBe(JSON.stringify(first));
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
