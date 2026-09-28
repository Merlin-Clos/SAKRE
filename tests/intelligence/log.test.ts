import { expect, test } from 'bun:test';
import { REVIEW_MAP_LOG_CAP_CHARS, reviewMapLogPayload } from '../../src/intelligence/log';
import type { ReviewMap } from '../../src/intelligence/schema';

function mapWithWarnings(warnings: string[]): ReviewMap {
    return {
        schemaVersion: 1,
        revisions: { baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) },
        tools: { scc: { version: '4.1.0', status: 'ok' }, cccc: { version: '1.6.0', status: 'ok' } },
        coverage: {
            scc: { languages: [], notCounted: [], unmeasurable: [], unsupported: [] },
            cccc: { languages: [], unsupported: [], parseErrorFiles: [] }
        },
        repository: {
            base: {
                files: 0,
                lines: 0,
                code: 0,
                comments: 0,
                blanks: 0,
                bytes: 0,
                complexity: 0,
                cognitive: 0,
                uloc: 0,
                dryness: null
            },
            head: {
                files: 0,
                lines: 0,
                code: 0,
                comments: 0,
                blanks: 0,
                bytes: 0,
                complexity: 0,
                cognitive: 0,
                uloc: 0,
                dryness: null
            },
            delta: {
                files: 0,
                lines: 0,
                code: 0,
                comments: 0,
                blanks: 0,
                bytes: 0,
                complexity: 0,
                cognitive: 0,
                uloc: 0,
                dryness: null
            },
            changed: { added: 0, modified: 0, removed: 0, renamed: 0 }
        },
        languages: [],
        files: [],
        functions: [],
        distributions: { cccc: { base: null, head: null, delta: null } },
        hotspots: {
            largestCodeGrowth: [],
            largestFileComplexityGrowth: [],
            largestCognitiveGrowth: [],
            largestCyclomaticGrowth: [],
            drynessRegression: [],
            newFunctions: [],
            parseFailures: []
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
        warnings
    };
}

test('logs the full map JSON when it fits the cap', () => {
    const payload = reviewMapLogPayload(mapWithWarnings(['SCC BASE measurement unavailable.']));
    expect(payload).toContain('"schemaVersion": 1');
    expect(payload).toContain('SCC BASE measurement unavailable.');
    expect(payload).not.toContain('truncated');
});

test('caps the log payload with an explicit truncation notice', () => {
    const payload = reviewMapLogPayload(mapWithWarnings(['x'.repeat(1000)]), 200);
    expect(payload.length).toBeLessThan(400);
    expect(payload).toContain('[ReviewMap log truncated:');
    expect(payload).toContain('the internal map stays complete.');
});

test('a payload exactly at the cap stays intact with the exact omission count', () => {
    const full = reviewMapLogPayload(mapWithWarnings(['exact-boundary']), 10_000_000);
    expect(reviewMapLogPayload(mapWithWarnings(['exact-boundary']), full.length)).toBe(full);
    const over = reviewMapLogPayload(mapWithWarnings(['exact-boundary']), full.length - 1);
    expect(over.startsWith(full.slice(0, -1))).toBe(true);
    expect(over).toContain('1 characters omitted');
});

test('the default cap is a measured, documented value', () => {
    expect(REVIEW_MAP_LOG_CAP_CHARS).toBe(256_000);
});
