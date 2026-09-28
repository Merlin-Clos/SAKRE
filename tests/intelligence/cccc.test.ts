import { describe, expect, test } from 'bun:test';
import { buildCcccArguments, flattenFunctions, parseCcccSnapshot } from '../../src/intelligence/measure-cccc';

/* Shape captured from CCCC 1.6.0 with `--no-config --no-ignore --no-cache`:
   nested functions, a parse error file, and a requested file skipped as
   unsupported. */
const OUTPUT = JSON.stringify({
    files: [
        {
            path: 'src/nest.ts',
            cognitive: 1,
            cyclomatic: 3,
            functions: [
                {
                    name: 'outer',
                    kind: 'function',
                    line: 1,
                    cognitive: 0,
                    cyclomatic: 1,
                    children: [
                        {
                            name: 'inner',
                            kind: 'function',
                            line: 1,
                            cognitive: 1,
                            cyclomatic: 2
                        }
                    ]
                }
            ]
        },
        {
            path: 'src/broken.ts',
            cognitive: 0,
            cyclomatic: 0,
            functions: [],
            parse_errors: ['Expected `:` but found `;`']
        }
    ],
    summary: {
        file_count: 2,
        function_count: 2,
        parse_error_count: 1,
        parse_error_file_count: 1,
        parse_error_files: ['src/broken.ts'],
        cognitive: { sum: 1, max: 1, median: 0, p90: 1, p95: 1 },
        cyclomatic: { sum: 3, max: 2, median: 1, p90: 2, p95: 2 }
    }
});

describe('CCCC normalization', () => {
    test('flattens nested functions with a root-first parent chain', () => {
        const snapshot = parseCcccSnapshot(OUTPUT);
        expect(snapshot.files.map((file) => file.path)).toEqual(['src/broken.ts', 'src/nest.ts']);
        const [, nest] = snapshot.files;
        expect(nest?.functions).toEqual([
            { name: 'inner', kind: 'function', line: 1, cognitive: 1, cyclomatic: 2, parentChain: ['outer'] },
            { name: 'outer', kind: 'function', line: 1, cognitive: 0, cyclomatic: 1, parentChain: [] }
        ]);
    });

    test('keeps parse errors as data and preserves the summary counters', () => {
        const snapshot = parseCcccSnapshot(OUTPUT);
        expect(snapshot.files[0]?.parseErrors).toEqual(['Expected `:` but found `;`']);
        expect(snapshot.summary).toEqual({
            fileCount: 2,
            functionCount: 2,
            parseErrorCount: 1,
            parseErrorFileCount: 1,
            parseErrorFiles: ['src/broken.ts'],
            cognitive: { sum: 1, max: 1, median: 0, p90: 1, p95: 1 },
            cyclomatic: { sum: 3, max: 2, median: 1, p90: 2, p95: 2 }
        });
    });

    test('reports requested files the tool skipped as unsupported', () => {
        const snapshot = parseCcccSnapshot(OUTPUT, ['src/nest.ts', 'src/broken.ts', 'notes.zzz']);
        expect(snapshot.unsupported).toEqual(['notes.zzz']);
    });

    test('normalizes Windows-style tool paths before matching requested files', () => {
        const windowsOutput = JSON.stringify({
            files: [
                { path: String.raw`.\src\nest.ts`, cognitive: 1, cyclomatic: 3, functions: [] },
                {
                    path: String.raw`.\src\broken.ts`,
                    cognitive: 0,
                    cyclomatic: 0,
                    functions: [],
                    parse_errors: ['Expected `:` but found `;`']
                }
            ],
            summary: {
                file_count: 2,
                function_count: 0,
                parse_error_count: 1,
                parse_error_file_count: 1,
                parse_error_files: [String.raw`.\src\broken.ts`],
                cognitive: { sum: 1, max: 1, median: 0, p90: 1, p95: 1 },
                cyclomatic: { sum: 3, max: 2, median: 1, p90: 2, p95: 2 }
            }
        });

        const snapshot = parseCcccSnapshot(windowsOutput, ['src/nest.ts', 'src/broken.ts']);
        expect(snapshot.files.map((file) => file.path)).toEqual(['src/broken.ts', 'src/nest.ts']);
        expect(snapshot.summary.parseErrorFiles).toEqual(['src/broken.ts']);
        expect(snapshot.unsupported).toEqual([]);
    });

    test('builds the untrusted-workspace-safe argument list for one directory run', () => {
        expect(buildCcccArguments()).toEqual(['--no-config', '--no-ignore', '--no-cache', '--', '.']);
    });

    test('orders functions by line, then name, then kind', () => {
        const flattened = flattenFunctions([
            { name: 'zeta', kind: 'method', line: 4, cognitive: 0, cyclomatic: 1 },
            { name: 'alpha', kind: 'function', line: 1, cognitive: 0, cyclomatic: 1 },
            { name: 'alpha', kind: 'method', line: 1, cognitive: 0, cyclomatic: 1 }
        ]);

        expect(flattened.map((fn) => `${fn.name}:${fn.kind}`)).toEqual([
            'alpha:function',
            'alpha:method',
            'zeta:method'
        ]);
    });

    test('is deterministic for the same input', () => {
        expect(JSON.stringify(parseCcccSnapshot(OUTPUT))).toBe(JSON.stringify(parseCcccSnapshot(OUTPUT)));
    });
});
