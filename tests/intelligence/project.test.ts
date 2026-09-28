import { describe, expect, test } from 'bun:test';
import type { DiffCoverage } from '../../src/analysis/diff';
import { projectionKindFor, projectReviewMap } from '../../src/intelligence/project';
import type { ReviewMap, ReviewMapFile, ReviewMapFunction } from '../../src/intelligence/schema';

const COVERAGE: DiffCoverage = {
    unifiedDiff: 'diff --git a/src/app.ts b/src/app.ts',
    files: [
        { path: 'src/app.ts', state: 'complete', classification: 'source' },
        { path: 'src/new.ts', state: 'truncated', classification: 'source' },
        { path: 'bun.lock', state: 'budget-truncated', classification: 'lockfile' }
    ],
    complete: false
};

function file(path: string, code: number, complexity: number): ReviewMapFile {
    return {
        path,
        status: 'modified',
        language: 'TypeScript',
        classification: 'source',
        risk: { noise: false },
        analysis: { scc: 'counted', cccc: 'attempted' },
        base: {
            code,
            comments: 1,
            blanks: 1,
            bytes: code * 10,
            complexity,
            cognitive: complexity,
            ulocWithinFile: code - 1
        },
        head: {
            code: code + 10,
            comments: 1,
            blanks: 1,
            bytes: code * 10,
            complexity: complexity + 2,
            cognitive: complexity + 3,
            ulocWithinFile: code + 9
        },
        delta: { code: 10, comments: 0, blanks: 0, bytes: 0, complexity: 2, cognitive: 3, ulocWithinFile: 10 },
        changeMagnitude: 12,
        parse: { scc: 'ok', cccc: 'ok' }
    };
}

function noiseFile(path: string): ReviewMapFile {
    return {
        path,
        status: 'modified',
        language: null,
        classification: 'lockfile',
        risk: { noise: true },
        analysis: { scc: 'not-counted', cccc: 'unsupported' },
        base: null,
        head: null,
        delta: null,
        changeMagnitude: 200,
        parse: { scc: 'not-counted', cccc: 'unsupported' }
    };
}

function excludedFile(path: string, changeMagnitude: number): ReviewMapFile {
    return {
        path,
        status: 'modified',
        language: 'TypeScript',
        classification: 'source',
        risk: { noise: false },
        analysis: { scc: 'counted', cccc: 'attempted' },
        base: null,
        head: null,
        delta: null,
        changeMagnitude,
        parse: { scc: 'ok', cccc: 'ok' }
    };
}

function fn(name: string, match: ReviewMapFunction['match'], cognitive: number, cyclomatic: number): ReviewMapFunction {
    const head = { line: 10, cognitive, cyclomatic };
    let base: ReviewMapFunction['base'] = { line: 8, cognitive: cognitive - 1, cyclomatic };
    let headBlock: ReviewMapFunction['head'] = head;
    let delta: ReviewMapFunction['delta'] = null;

    if (match === 'added') {
        base = null;
    }

    if (match === 'deleted') {
        headBlock = null;
    }

    if (match === 'matched') {
        delta = { cognitive: 1, cyclomatic: 0 };
    }

    return {
        path: 'src/app.ts',
        name,
        kind: 'function',
        parentChain: [],
        base,
        head: headBlock,
        delta,
        match
    };
}

function map(): ReviewMap {
    const functions = [
        fn('grew', 'matched', 5, 4),
        fn('fresh', 'added', 3, 9),
        fn('gone', 'deleted', 1, 1),
        fn('unstable', 'ambiguous', 2, 2)
    ];

    return {
        schemaVersion: 1,
        revisions: { baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) },
        tools: { scc: { version: '4.1.0', status: 'ok' }, cccc: { version: '1.6.0', status: 'ok' } },
        coverage: {
            scc: { languages: ['TypeScript'], notCounted: ['bun.lock'], unmeasurable: [], unsupported: [] },
            cccc: { languages: [], unsupported: ['bun.lock'], parseErrorFiles: [] }
        },
        repository: {
            base: {
                files: 3,
                lines: 100,
                code: 80,
                comments: 5,
                blanks: 15,
                bytes: 800,
                complexity: 10,
                cognitive: 20,
                uloc: 60,
                dryness: 0.6
            },
            head: {
                files: 4,
                lines: 120,
                code: 95,
                comments: 5,
                blanks: 20,
                bytes: 950,
                complexity: 14,
                cognitive: 26,
                uloc: 72,
                dryness: 0.6
            },
            delta: {
                files: 1,
                lines: 20,
                code: 15,
                comments: 0,
                blanks: 5,
                bytes: 150,
                complexity: 4,
                cognitive: 6,
                uloc: 12,
                dryness: 0
            },
            changed: { added: 1, modified: 2, removed: 0, renamed: 0 }
        },
        languages: [
            {
                name: 'TypeScript',
                base: {
                    files: 2,
                    lines: 90,
                    code: 70,
                    comments: 5,
                    blanks: 15,
                    bytes: 700,
                    complexity: 10,
                    cognitive: 20,
                    uloc: 50,
                    dryness: 0.55
                },
                head: {
                    files: 3,
                    lines: 110,
                    code: 85,
                    comments: 5,
                    blanks: 20,
                    bytes: 850,
                    complexity: 14,
                    cognitive: 26,
                    uloc: 62,
                    dryness: 0.56
                },
                delta: {
                    files: 1,
                    lines: 20,
                    code: 15,
                    comments: 0,
                    blanks: 5,
                    bytes: 150,
                    complexity: 4,
                    cognitive: 6,
                    uloc: 12,
                    dryness: 0.01
                }
            }
        ],
        files: [file('src/app.ts', 100, 10), file('src/new.ts', 0, 0), noiseFile('bun.lock')],
        functions,
        distributions: {
            cccc: {
                base: {
                    functionCount: 4,
                    parseErrorCount: 0,
                    cognitive: { sum: 10, max: 5, median: 2, p90: 4, p95: 5 },
                    cyclomatic: { sum: 12, max: 6, median: 2, p90: 5, p95: 6 }
                },
                head: {
                    functionCount: 5,
                    parseErrorCount: 1,
                    cognitive: { sum: 14, max: 6, median: 2, p90: 5, p95: 6 },
                    cyclomatic: { sum: 16, max: 9, median: 3, p90: 6, p95: 9 }
                },
                delta: {
                    functionCount: 1,
                    parseErrorCount: 1,
                    cognitive: { sum: 4, max: 1, median: 0, p90: 1, p95: 1 },
                    cyclomatic: { sum: 4, max: 3, median: 1, p90: 1, p95: 3 }
                }
            }
        },
        hotspots: {
            largestCodeGrowth: [{ kind: 'file', path: 'src/app.ts', value: 10 }],
            largestFileComplexityGrowth: [{ kind: 'file', path: 'src/app.ts', value: 2 }],
            largestCognitiveGrowth: [{ kind: 'function', path: 'src/app.ts', name: 'grew', line: 10, value: 1 }],
            largestCyclomaticGrowth: [],
            drynessRegression: [],
            newFunctions: [{ kind: 'function', path: 'src/app.ts', name: 'fresh', line: 10, value: 3 }],
            parseFailures: []
        },
        hotspotOmissions: {
            omitted: {
                largestCodeGrowth: 2,
                largestFileComplexityGrowth: 0,
                largestCognitiveGrowth: 0,
                largestCyclomaticGrowth: 0,
                drynessRegression: 0,
                newFunctions: 0,
                parseFailures: 0
            }
        },
        warnings: []
    };
}

/* The closing block renders only non-zero counters; an absent counter is zero. */
function counterOf(text: string, name: string): number {
    const match = new RegExp(`${name}=(\\d+)`, 'u').exec(text);

    if (match?.[1] === undefined) {
        return 0;
    }

    return Number(match[1]);
}

describe('ReviewMap projections', () => {
    test('the common projection carries every changed file, the diff metadata and the usage contract', () => {
        const result = projectReviewMap({ map: map(), coverage: COVERAGE, kind: 'common' });
        expect(result).toContain('## Deterministic review intelligence (ReviewMap)');
        expect(result).toContain('src/app.ts');
        expect(result).toContain('src/new.ts');
        expect(result).toContain('bun.lock');
        expect(result).toContain('never define scope');
        expect(result).toContain('Verify every finding against the real diff and code');
        expect(result).toContain('changedFiles=3, representedFiles=2, truncated=true');
        expect(counterOf(result, 'omittedHotspots')).toBe(2);
    });

    test('every projection states the usage contract with the current severity vocabulary only', () => {
        const kinds = ['common', 'maintainability', 'correctness', 'performance'] as const;

        for (const kind of kinds) {
            const result = projectReviewMap({ map: map(), coverage: COVERAGE, kind });
            expect(result, kind).toContain('`Blocker`');

            for (const retired of ['`Critical`', '`Warning`', '`Suggestion`']) {
                expect(result, `${kind}: ${retired}`).not.toContain(retired);
            }
        }
    });

    test('the maintainability projection adds full function deltas and parse status', () => {
        const result = projectReviewMap({ map: map(), coverage: COVERAGE, kind: 'maintainability' });
        expect(result).toContain('### Function deltas');
        expect(result).toContain('grew (function) matched');
        expect(result).toContain('fresh (function) added');
        expect(result).toContain('gone (function) deleted');
        expect(result).toContain('ambiguous');
        expect(result).toContain('parse scc=ok cccc=ok');
    });

    test('the correctness projection keeps added, ambiguous and worsened functions', () => {
        const result = projectReviewMap({ map: map(), coverage: COVERAGE, kind: 'correctness' });
        expect(result).toContain('fresh');
        expect(result).toContain('unstable');
        expect(result).toContain('grew');
        expect(result).not.toContain('gone');
    });

    test('the performance projection ranks large HEAD functions', () => {
        const result = projectReviewMap({ map: map(), coverage: COVERAGE, kind: 'performance' });
        const fresh = result.indexOf('fresh');
        const gone = result.indexOf('gone');
        expect(fresh).toBeGreaterThanOrEqual(0);
        expect(gone).toBe(-1);
    });

    test('a small budget truncates sections with explicit omission counters', () => {
        const result = projectReviewMap({ map: map(), coverage: COVERAGE, kind: 'maintainability', maxChars: 700 });
        expect(counterOf(result, 'omittedFiles') + counterOf(result, 'omittedFunctions')).toBeGreaterThan(0);
        expect(result).toContain('omitted');
        expect(result).toContain('changedFiles=3');
        expect(result).toContain('truncated=true');
        /* The cap is a real ceiling: the reserved closing block counts. */
        expect(result.length).toBeLessThanOrEqual(700);
    });

    test('the internal structural display cap contributes to omittedHotspots exactly', () => {
        const sample = map();
        sample.hotspots.largestCodeGrowth = Array.from({ length: 8 }, (_unused, index) => ({
            kind: 'file' as const,
            path: `src/growth-${String(index)}.ts`,
            value: 8 - index
        }));
        const result = projectReviewMap({ map: sample, coverage: COVERAGE, kind: 'common' });
        const structuralLines = result.split('\n').filter((line) => line.startsWith('- code growth: '));
        expect(structuralLines).toHaveLength(5);
        /* Three entries from the display cap plus the two map-level omissions
           the fixture declares. */
        expect(counterOf(result, 'omittedHotspots')).toBe(5);
        expect(result).toContain('omittedHotspots=5');
        expect(result.length).toBeLessThanOrEqual(8000);
    });

    test('dropped fixed lines never count as omitted functions', () => {
        const result = projectReviewMap({ map: map(), coverage: COVERAGE, kind: 'common', maxChars: 400 });
        expect(counterOf(result, 'omittedFunctions')).toBe(0);
        expect(counterOf(result, 'omittedFixed')).toBeGreaterThan(0);
        expect(result).toContain('omittedFixed=');
        expect(result.length).toBeLessThanOrEqual(400);
    });

    test('every projection kind respects its default cap including the closing block', () => {
        const kinds = ['common', 'maintainability', 'correctness', 'performance'] as const;
        const limits = { common: 8000, maintainability: 25_000, correctness: 10_000, performance: 10_000 };
        const sample = map();
        sample.files = Array.from({ length: 300 }, (_unused, index) => file(`src/file-${index}.ts`, index, index));

        for (const kind of kinds) {
            const result = projectReviewMap({ map: sample, coverage: COVERAGE, kind });
            expect(result.length).toBeLessThanOrEqual(limits[kind]);
        }
    });

    test('a budget overrun keeps the first files and counts the omitted ones', () => {
        const sample = map();
        sample.files = Array.from({ length: 100 }, (_unused, index) => file(`src/file-${index}.ts`, index, index));
        const result = projectReviewMap({ map: sample, coverage: COVERAGE, kind: 'common', maxChars: 2000 });
        expect(result).toContain('src/file-0.ts');
        expect(result).toContain('omittedFiles=');
        expect(counterOf(result, 'omittedFiles')).toBeGreaterThan(0);
        expect(counterOf(result, 'omittedFiles')).toBeLessThanOrEqual(100);
    });

    test('security and unknown roles receive the common projection only', () => {
        expect(projectionKindFor('security')).toBe('common');
        expect(projectionKindFor('conventions')).toBe('common');
        expect(projectionKindFor('coordinator')).toBe('common');
        expect(projectionKindFor('verifier')).toBe('common');
        expect(projectionKindFor('maintainability')).toBe('maintainability');
        expect(projectionKindFor('correctness')).toBe('correctness');
        expect(projectionKindFor('performance')).toBe('performance');
        const security = projectReviewMap({ map: map(), coverage: COVERAGE, kind: 'common' });
        expect(security).not.toContain('### Function deltas');
    });

    test('projection output is deterministic', () => {
        const first = JSON.stringify(projectReviewMap({ map: map(), coverage: COVERAGE, kind: 'maintainability' }));
        const second = JSON.stringify(projectReviewMap({ map: map(), coverage: COVERAGE, kind: 'maintainability' }));
        expect(first).toBe(second);
    });

    test('neutralizes hostile line breaks in projected paths and function names', () => {
        const sample = map();
        const hostile = fn('fn\n## injected', 'added', 3, 9);
        hostile.path = 'src/a\u2028## injected.ts';
        sample.functions = [hostile];
        const result = projectReviewMap({ map: sample, coverage: COVERAGE, kind: 'maintainability' });
        expect(result).not.toContain('\u2028');
        expect(result).not.toMatch(/^## injected/mu);
    });
});

describe('review.exclude projection', () => {
    test('excluded files disappear individually with one exact global summary', () => {
        const sample = map();
        sample.files = [...sample.files, excludedFile('tools/oxlint/anti-slop/rules/foo.ts', 50)];

        const coverage: DiffCoverage = {
            unifiedDiff: 'diff --git a/src/app.ts b/src/app.ts',
            files: [
                { path: 'src/app.ts', state: 'complete', classification: 'source' },
                {
                    path: 'tools/oxlint/anti-slop/rules/foo.ts',
                    state: 'complete',
                    reason: 'context-excluded',
                    classification: 'source',
                    contextExcluded: true
                }
            ],
            complete: true
        };

        const result = projectReviewMap({ map: sample, coverage, kind: 'common' });

        expect(result).toContain('src/app.ts');
        expect(result).not.toContain('tools/oxlint/anti-slop/rules/foo.ts');
        expect(result).toContain('Excluded from automatic context: 1 files (50 changed lines).');
        expect(result).toContain('changedFiles=2, representedFiles=1');
    });

    test('the summary sums magnitudes and stays absent when nothing is excluded', () => {
        const sample = map();
        sample.files = [
            file('src/app.ts', 100, 10),
            excludedFile('tools/oxlint/anti-slop/rules/foo.ts', 12),
            excludedFile('tools/oxlint/anti-slop/shared/bar.ts', 200)
        ];

        const coverage: DiffCoverage = {
            unifiedDiff: '',
            files: [
                { path: 'src/app.ts', state: 'complete', classification: 'source' },
                {
                    path: 'tools/oxlint/anti-slop/rules/foo.ts',
                    state: 'complete',
                    reason: 'context-excluded',
                    classification: 'source',
                    contextExcluded: true
                },
                {
                    path: 'tools/oxlint/anti-slop/shared/bar.ts',
                    state: 'complete',
                    reason: 'context-excluded',
                    classification: 'source',
                    contextExcluded: true
                }
            ],
            complete: true
        };

        const excluded = projectReviewMap({ map: sample, coverage, kind: 'common' });

        expect(excluded).not.toContain('tools/oxlint/anti-slop/rules/foo.ts');
        expect(excluded).not.toContain('tools/oxlint/anti-slop/shared/bar.ts');
        expect(excluded).toContain('Excluded from automatic context: 2 files (212 changed lines).');

        const clean = projectReviewMap({ map: map(), coverage: COVERAGE, kind: 'common' });

        expect(clean).not.toContain('Excluded from automatic context:');
    });
});
