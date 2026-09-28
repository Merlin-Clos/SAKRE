import { describe, expect, test } from 'bun:test';
import { buildHotspots } from '../../src/intelligence/hotspots';
import { fileGrowthValue } from '../../src/intelligence/review-files';
import type {
    FileMetricBlock,
    HotspotName,
    LanguageMetrics,
    RepositoryMetrics,
    ReviewMapFile,
    ReviewMapFunction
} from '../../src/intelligence/schema';

const METRICS: RepositoryMetrics = {
    files: 1,
    lines: 10,
    code: 8,
    comments: 1,
    blanks: 1,
    bytes: 100,
    complexity: 1,
    cognitive: 1,
    uloc: 7,
    dryness: 0.7
};

function block(code: number, complexity: number): FileMetricBlock {
    return { code, comments: 1, blanks: 1, bytes: 100, complexity, cognitive: 1, ulocWithinFile: code };
}

function file(path: string, base: FileMetricBlock | null, head: FileMetricBlock | null): ReviewMapFile {
    let delta: ReviewMapFile['delta'] = null;

    if (base !== null && head !== null) {
        delta = {
            code: head.code - base.code,
            comments: 0,
            blanks: 0,
            bytes: 0,
            complexity: head.complexity - base.complexity,
            cognitive: 0,
            ulocWithinFile: 0
        };
    }

    return {
        path,
        status: 'modified',
        language: 'TypeScript',
        classification: 'source',
        risk: { noise: false },
        analysis: { scc: 'counted', cccc: 'attempted' },
        base,
        head,
        delta,
        changeMagnitude: 1,
        parse: { scc: 'ok', cccc: 'ok' }
    };
}

function fn(
    path: string,
    name: string,
    match: ReviewMapFunction['match'],
    headCognitive: number,
    headCyclomatic: number,
    delta = 0
): ReviewMapFunction {
    let base: ReviewMapFunction['base'] = { line: 1, cognitive: headCognitive - delta, cyclomatic: 1 };
    let head: ReviewMapFunction['head'] = { line: 1, cognitive: headCognitive, cyclomatic: headCyclomatic };

    if (match === 'added') {
        base = null;
    }

    if (match === 'deleted') {
        head = null;
    }

    let deltaEntry: ReviewMapFunction['delta'] = null;

    if (match === 'matched') {
        deltaEntry = { cognitive: delta, cyclomatic: 0 };
    }

    return {
        path,
        name,
        kind: 'function',
        parentChain: [],
        base,
        head,
        delta: deltaEntry,
        match
    };
}

function language(name: string, baseDryness: number | null, headDryness: number | null): LanguageMetrics {
    let base: RepositoryMetrics | null = { ...METRICS, dryness: baseDryness };
    let head: RepositoryMetrics | null = { ...METRICS, dryness: headDryness };

    if (baseDryness === null) {
        base = null;
    }

    if (headDryness === null) {
        head = null;
    }

    return { name, base, head, delta: null };
}

describe('hotspot ranking and caps', () => {
    test('ranks file growth descending and caps with explicit omissions', () => {
        const files = [
            file('src/a.ts', block(10, 1), block(30, 3)),
            file('src/b.ts', block(10, 1), block(50, 9)),
            file('src/c.ts', block(10, 1), block(20, 2))
        ];

        const result = buildHotspots({ files, functions: [], languages: [], limit: 2 });
        expect(result.hotspots.largestCodeGrowth.map((entry) => entry.path)).toEqual(['src/b.ts', 'src/a.ts']);
        expect(result.omissions.omitted.largestCodeGrowth).toBe(1);
        expect(result.hotspots.largestFileComplexityGrowth[0]?.path).toBe('src/b.ts');
    });

    test('ignores negative growth and deleted files', () => {
        const files = [file('src/shrunk.ts', block(50, 9), block(10, 1)), file('src/removed.ts', block(50, 9), null)];
        const result = buildHotspots({ files, functions: [], languages: [] });
        expect(result.hotspots.largestCodeGrowth).toEqual([]);
        expect(result.hotspots.largestFileComplexityGrowth).toEqual([]);
    });

    test('exposes one growth rule for matched, added and removed files', () => {
        const matched = file('src/matched.ts', block(10, 2), block(15, 5));
        const added = { ...file('src/added.ts', null, block(20, 4)), status: 'added' as const };
        const removed = { ...file('src/removed.ts', block(8, 2), null), status: 'removed' as const };

        expect(fileGrowthValue(matched, 'code')).toBe(5);
        expect(fileGrowthValue(matched, 'complexity')).toBe(3);
        expect(fileGrowthValue(added, 'code')).toBe(20);
        expect(fileGrowthValue(added, 'complexity')).toBe(4);
        expect(fileGrowthValue(removed, 'code')).toBe(0);
        expect(fileGrowthValue(removed, 'complexity')).toBe(0);
    });

    test('ranks new functions by cognitive then cyclomatic without a composite score', () => {
        const functions = [
            fn('src/a.ts', 'big-cognitive', 'added', 10, 1),
            fn('src/a.ts', 'big-cyclomatic', 'added', 10, 9),
            fn('src/a.ts', 'small', 'added', 2, 20)
        ];

        const result = buildHotspots({ files: [], functions, languages: [] });
        expect(result.hotspots.newFunctions.map((entry) => entry.name)).toEqual([
            'big-cyclomatic',
            'big-cognitive',
            'small'
        ]);
    });

    test('ranks function growth from matched deltas only', () => {
        const functions = [
            fn('src/a.ts', 'grew', 'matched', 12, 5, 5),
            fn('src/a.ts', 'unchanged', 'matched', 3, 2, 0),
            fn('src/b.ts', 'fresh', 'added', 99, 99)
        ];

        const result = buildHotspots({ files: [], functions, languages: [] });
        expect(result.hotspots.largestCognitiveGrowth.map((entry) => entry.name)).toEqual(['grew']);
    });

    test('reports dryness regressions per language and parse failures per file', () => {
        const parseErrorFile = {
            ...file('src/broken.ts', block(1, 1), block(2, 1)),
            parse: { scc: 'ok' as const, cccc: 'parse-error' as const }
        };

        const result = buildHotspots({
            files: [parseErrorFile],
            functions: [],
            languages: [language('TypeScript', 0.7, 0.6), language('Markdown', 0.5, 0.9)]
        });

        expect(result.hotspots.drynessRegression.map((entry) => entry.path)).toEqual(['TypeScript']);
        expect(result.hotspots.parseFailures.map((entry) => entry.path)).toEqual(['src/broken.ts']);
    });

    test('every named list exists even when empty', () => {
        const names: HotspotName[] = [
            'largestCodeGrowth',
            'largestFileComplexityGrowth',
            'largestCognitiveGrowth',
            'largestCyclomaticGrowth',
            'drynessRegression',
            'newFunctions',
            'parseFailures'
        ];

        const result = buildHotspots({ files: [], functions: [], languages: [] });

        for (const name of names) {
            expect(result.hotspots[name]).toEqual([]);
            expect(result.omissions.omitted[name]).toBe(0);
        }
    });

    test('hotspot output is deterministic for identical input', () => {
        const input = {
            files: [file('src/a.ts', block(1, 1), block(9, 9))],
            functions: [fn('src/a.ts', 'grew', 'matched', 12, 5, 4)],
            languages: [language('TypeScript', 0.8, 0.6)]
        };

        expect(JSON.stringify(buildHotspots(input))).toBe(JSON.stringify(buildHotspots(input)));
    });
});
