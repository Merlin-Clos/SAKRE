import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import nativeAssets from '../../native-assets.json' with { type: 'json' };
import { measureCccc } from '../../src/intelligence/measure-cccc';
import { resolvePinnedBinary } from '../helpers/native-binary';

/* Real-binary proof of the pinned CCCC acquisition: deterministic normalization,
   explicit unsupported files, and parse errors kept as data. Skips when the
   pinned binary is unavailable (CI provides it or the content-addressed cache). */

const CCCC_VERSION = nativeAssets.tools.cccc.version;

const ccccBinary = await resolvePinnedBinary('cccc', CCCC_VERSION, 'SAKRE_CCCC_BINARY');

describe('CCCC acquisition', () => {
    test.skipIf(ccccBinary === undefined)(
        'measures C++, Scala, C# and VB.NET through the production parser',
        async () => {
            if (ccccBinary === undefined) {
                throw new Error('The CCCC test started without a binary.');
            }

            const fixtures = [
                {
                    file: 'example.cpp',
                    name: 'choose',
                    source: 'int choose(int value) { if (value > 0) return value; return 0; }\n'
                },
                {
                    file: 'example.scala',
                    name: 'choose',
                    source: 'object Example { def choose(value: Int): Int = { if (value > 0) return value; 0 } }\n'
                },
                {
                    file: 'example.cs',
                    name: 'Choose',
                    source: 'class Example { static int Choose(int value) { if (value > 0) return value; return 0; } }\n'
                },
                {
                    file: 'example.vb',
                    name: 'Choose',
                    source: [
                        'Module Example',
                        '    Function Choose(value As Integer) As Integer',
                        '        If value > 0 Then',
                        '            Return value',
                        '        End If',
                        '        Return 0',
                        '    End Function',
                        'End Module',
                        ''
                    ].join('\n')
                }
            ];

            const root = await mkdtemp(path.join(tmpdir(), 'sakre-cccc-languages-'));

            try {
                await Promise.all(fixtures.map((fixture) => writeFile(path.join(root, fixture.file), fixture.source)));

                const snapshot = await measureCccc({
                    binaryPath: ccccBinary,
                    directory: root,
                    files: fixtures.map((fixture) => fixture.file)
                });

                expect(snapshot.unsupported).toEqual([]);
                expect(snapshot.summary.fileCount).toBe(fixtures.length);
                expect(snapshot.summary.functionCount).toBe(fixtures.length);
                expect(snapshot.summary.parseErrorCount).toBe(0);

                for (const fixture of fixtures) {
                    const file = snapshot.files.find((entry) => entry.path === fixture.file);
                    expect(file?.functions).toHaveLength(1);
                    expect(file?.functions[0]).toMatchObject({ name: fixture.name, cognitive: 1, cyclomatic: 2 });
                }
            } finally {
                await rm(root, { recursive: true, force: true });
            }
        }
    );

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
