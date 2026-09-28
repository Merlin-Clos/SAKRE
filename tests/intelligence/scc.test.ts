import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CancelledError } from '../../src/analysis/cancellation';
import {
    deriveDryness,
    measureScc,
    parseSccSnapshot,
    roundTo,
    SccMetricsError
} from '../../src/intelligence/measure-scc';
import { rejectionOf } from '../helpers/rejection';
import { scriptedTool } from '../helpers/scripted-tool';

/* Shape captured from SCC 4.1.0 with `--by-file --format json -a --cognitive`;
   `PossibleLanguages` and `Files` order are intentionally unsorted to prove the
   canonicalization. */
const OUTPUT = JSON.stringify([
    {
        Name: 'TypeScript',
        Bytes: 120,
        CodeBytes: 0,
        Lines: 20,
        Code: 16,
        Comment: 2,
        Blank: 2,
        Complexity: 5,
        Cognitive: 7,
        Count: 2,
        WeightedComplexity: 0,
        LineLength: null,
        ULOC: 14,
        Files: [
            {
                Language: 'TypeScript',
                PossibleLanguages: ['TypeScript', 'Qt Translation Source'],
                Filename: 'b.ts',
                Extension: 'ts',
                Location: 'src/b.ts',
                Symlocation: '',
                Bytes: 60,
                Lines: 10,
                Code: 8,
                Comment: 1,
                Blank: 1,
                Complexity: 3,
                Cognitive: 4,
                WeightedComplexity: 0,
                Hash: null,
                Binary: false,
                Minified: false,
                Generated: false,
                EndPoint: 0,
                Uloc: 7
            },
            {
                Language: 'TypeScript',
                PossibleLanguages: ['TypeScript'],
                Filename: 'a.ts',
                Extension: 'ts',
                Location: 'src/a.ts',
                Symlocation: '',
                Bytes: 60,
                Lines: 10,
                Code: 8,
                Comment: 1,
                Blank: 1,
                Complexity: 2,
                Cognitive: 3,
                WeightedComplexity: 0,
                Hash: null,
                Binary: false,
                Minified: false,
                Generated: true,
                EndPoint: 0,
                Uloc: 7
            }
        ]
    },
    {
        Name: 'Markdown',
        Bytes: 10,
        CodeBytes: 0,
        Lines: 0,
        Code: 0,
        Comment: 0,
        Blank: 0,
        Complexity: 0,
        Cognitive: 0,
        Count: 1,
        WeightedComplexity: 0,
        LineLength: null,
        ULOC: 0,
        Files: []
    }
]);

describe('SCC normalization', () => {
    test('canonicalizes languages and files and keeps the flags', () => {
        const snapshot = parseSccSnapshot(OUTPUT);
        expect(snapshot.languages.map((language) => language.name)).toEqual(['Markdown', 'TypeScript']);
        expect(snapshot.files.map((file) => file.path)).toEqual(['src/a.ts', 'src/b.ts']);
        expect(snapshot.files[0]?.possibleLanguages).toEqual(['TypeScript']);
        expect(snapshot.files[1]?.possibleLanguages).toEqual(['Qt Translation Source', 'TypeScript']);
        expect(snapshot.files[0]?.generated).toBe(true);
        expect(snapshot.files[0]?.binary).toBe(false);
    });

    test('totals sum the official language aggregates and derive dryness', () => {
        const snapshot = parseSccSnapshot(OUTPUT);
        expect(snapshot.totals).toEqual({
            files: 3,
            lines: 20,
            code: 16,
            comments: 2,
            blanks: 2,
            bytes: 130,
            complexity: 5,
            cognitive: 7,
            uloc: 14,
            dryness: 0.7
        });
        expect(snapshot.languages[0]?.dryness).toBeNull();
    });

    test('dryness is ULOC/Lines rounded to four decimals', () => {
        expect(deriveDryness(5636, 8908)).toBe(0.6327);
        expect(deriveDryness(0, 10)).toBe(0);
        expect(deriveDryness(1, 3)).toBe(0.3333);
        expect(deriveDryness(10, 0)).toBeNull();
        expect(deriveDryness(10, -1)).toBeNull();
        expect(roundTo(0.63269, 4)).toBe(0.6327);
    });

    test('is deterministic for the same input', () => {
        expect(JSON.stringify(parseSccSnapshot(OUTPUT))).toBe(JSON.stringify(parseSccSnapshot(OUTPUT)));
    });
});

/* Scripted-binary mechanics: the production invocation must carry the
   hardening flags, clear SCC_CONFIG_PATH, target the analysis-tree directory
   with one positional entry instead of a per-file argv list, and translate
   process failures and cancellation into typed errors. */
describe('SCC invocation mechanics', () => {
    test('targets the analysis tree once and neutralizes config and ignore files', async () => {
        const runner = await mkdtemp(path.join(tmpdir(), 'sakre-scc-invocation-'));
        const tree = await mkdtemp(path.join(tmpdir(), 'sakre-scc-tree-'));
        const argsFile = path.join(runner, 'args.txt');
        const envFile = path.join(runner, 'env.txt');

        try {
            await writeFile(path.join(tree, 'a.ts'), 'export const a = 1;\n');

            const binary = await scriptedTool(
                runner,
                'scc',
                `import { writeFileSync } from 'node:fs';

writeFileSync(${JSON.stringify(argsFile)}, process.argv.slice(2).join('\\n') + '\\n');
writeFileSync(${JSON.stringify(envFile)}, process.env.SCC_CONFIG_PATH ?? '');
console.log(JSON.stringify([{ Name: 'TypeScript', Count: 1, Lines: 1, Code: 1, Comment: 0, Blank: 0, Bytes: 20, Complexity: 0, Cognitive: 0, ULOC: 1, Files: [] }]));
`
            );

            const snapshot = await measureScc({ binaryPath: binary, directory: tree, files: ['a.ts'] });

            expect(snapshot.totals.files).toBe(1);
            const recorded = await readFile(argsFile, 'utf8');
            const forwarded = recorded.trim().split('\n');

            for (const flag of ['--no-config', '--no-gitignore', '--no-ignore', '--no-scc-ignore', '--no-gitmodule']) {
                expect(forwarded).toContain(flag);
            }

            expect(forwarded.at(-1)).toBe('.');
            expect(forwarded).not.toContain('a.ts');
            expect(await readFile(envFile, 'utf8')).toBe('');
        } finally {
            await Promise.all([
                rm(runner, { recursive: true, force: true }),
                rm(tree, { recursive: true, force: true })
            ]);
        }
    });

    test('reports a non-zero process result as a typed failure without spawning for an empty plan', async () => {
        const runner = await mkdtemp(path.join(tmpdir(), 'sakre-scc-failure-'));

        try {
            const binary = await scriptedTool(runner, 'scc-fail', 'process.exit(9);\n');
            const failure = await rejectionOf(measureScc({ binaryPath: binary, directory: runner, files: ['a.ts'] }));
            expect(failure).toBeInstanceOf(SccMetricsError);
            expect(failure.message).toContain('exit code 9');

            /* An empty plan never spawns the tool; an invalid binary path is safe. */
            const empty = await measureScc({ binaryPath: path.join(runner, 'missing'), directory: runner, files: [] });
            expect(empty.files).toEqual([]);
        } finally {
            await rm(runner, { recursive: true, force: true });
        }
    });

    test('surfaces cancellation as CancelledError', async () => {
        const controller = new AbortController();
        controller.abort();

        const failure = await rejectionOf(
            measureScc({ binaryPath: 'scc', directory: tmpdir(), files: ['a.ts'], signal: controller.signal })
        );

        expect(failure).toBeInstanceOf(CancelledError);
    });
});
