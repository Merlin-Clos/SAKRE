import type { RepositoryMetrics, ReviewMap } from '../../src/intelligence/schema';

/* Compact ReviewMap fixture for comment-rendering and CLI parity tests. */
export const REPOSITORY: RepositoryMetrics = {
    files: 63,
    lines: 8908,
    code: 7489,
    comments: 634,
    blanks: 785,
    bytes: 327_616,
    complexity: 1267,
    cognitive: 3120,
    uloc: 5636,
    dryness: 0.6327
};

export function sampleMap(): ReviewMap {
    return {
        schemaVersion: 1,
        revisions: { baseSha: 'a1b2c3d'.repeat(6), headSha: 'd4e5f6a'.repeat(6) },
        tools: { scc: { version: '4.1.0', status: 'ok' }, cccc: { version: '1.6.0', status: 'ok' } },
        coverage: {
            scc: { languages: ['TypeScript'], notCounted: [], unmeasurable: [], unsupported: [] },
            cccc: { languages: [], unsupported: [], parseErrorFiles: [] }
        },
        repository: {
            base: REPOSITORY,
            head: { ...REPOSITORY, files: 64, code: 7560, uloc: 5700, dryness: 0.6326 },
            delta: {
                files: 1,
                lines: 102,
                code: 71,
                comments: 6,
                blanks: 25,
                bytes: 3384,
                complexity: 23,
                cognitive: 75,
                uloc: 64,
                dryness: -0.0001
            },
            changed: { added: 2, modified: 5, removed: 1, renamed: 1 }
        },
        languages: [
            {
                name: 'TypeScript',
                base: { ...REPOSITORY, code: 7000, uloc: 5200, dryness: 0.63 },
                head: { ...REPOSITORY, code: 7071, uloc: 5264, dryness: 0.625 },
                delta: { ...REPOSITORY, code: 71, uloc: 64, dryness: -0.005 }
            }
        ],
        files: [],
        functions: [],
        distributions: {
            cccc: {
                base: {
                    functionCount: 1778,
                    parseErrorCount: 0,
                    cognitive: { sum: 1350, max: 19, median: 0, p90: 2, p95: 4 },
                    cyclomatic: { sum: 3194, max: 20, median: 1, p90: 3, p95: 5 }
                },
                head: {
                    functionCount: 1780,
                    parseErrorCount: 1,
                    cognitive: { sum: 1425, max: 21, median: 0, p90: 3, p95: 5 },
                    cyclomatic: { sum: 3260, max: 22, median: 1, p90: 4, p95: 6 }
                },
                delta: {
                    functionCount: 2,
                    parseErrorCount: 1,
                    cognitive: { sum: 75, max: 2, median: 0, p90: 1, p95: 1 },
                    cyclomatic: { sum: 66, max: 2, median: 0, p90: 1, p95: 1 }
                }
            }
        },
        hotspots: {
            largestCodeGrowth: [{ kind: 'file', path: 'src/engine/runtime.ts', value: 20 }],
            largestFileComplexityGrowth: [{ kind: 'file', path: 'src/engine/runtime.ts', value: 9 }],
            largestCognitiveGrowth: [
                { kind: 'function', path: 'src/engine/runtime.ts', name: 'attemptTurns', line: 121, value: 15 }
            ],
            largestCyclomaticGrowth: [
                { kind: 'function', path: 'src/engine/runtime.ts', name: 'attemptTurns', line: 121, value: 8 }
            ],
            drynessRegression: [{ kind: 'language', path: 'TypeScript', value: 0.005 }],
            newFunctions: [{ kind: 'function', path: 'src/new.ts', name: 'fresh|pipe', line: 3, value: 4 }],
            parseFailures: [{ kind: 'file', path: 'src/broken.ts', value: 1 }]
        },
        hotspotOmissions: {
            omitted: {
                largestCodeGrowth: 0,
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
