import { describe, expect, test } from 'bun:test';
import { renderIntelligenceComment, renderPrSignalsTable } from '../../src/intelligence/render';
import { countDetailsSections } from '../helpers/details';
import { sampleMap } from '../helpers/intelligence-map';

describe('PR signals table', () => {
    test('renders the five analysis metrics with before -> after, signed deltas and relative percent', () => {
        const text = renderPrSignalsTable(sampleMap()).join('\n');
        expect(text).toContain('### Analysis signals');
        expect(text).toContain('| Metric | Change | Δ | Δ % |');
        expect(text).toContain('| Repository files | 63 -> 64 | **+1** | +1.6% |');
        expect(text).toContain('| Code LOC | 7,489 -> 7,560 | **+71** | +0.9% |');
        expect(text).toContain('63.3% -> 63.3%');
        expect(text).toContain('-0.0 pp');
        expect(text).toContain('| DRYness |');
        expect(text).toContain('n/a');
        expect(text).toContain('| McCabe complexity |');
        expect(text).toContain('| Cognitive complexity |');
        expect(text).not.toContain('—');
    });

    test('formats the V3 reference fixture with the specified deltas', () => {
        const map = sampleMap();
        map.repository.base = {
            ...map.repository.base,
            files: 50,
            code: 1000,
            dryness: 0.502,
            complexity: 1000,
            cognitive: 1000
        };
        map.repository.head = {
            ...map.repository.head,
            files: 69,
            code: 1296,
            dryness: 0.52,
            complexity: 1438,
            cognitive: 1543
        };
        map.repository.delta = {
            ...map.repository.delta,
            files: 19,
            code: 296,
            dryness: 0.018,
            complexity: 438,
            cognitive: 543
        };
        const text = renderPrSignalsTable(map).join('\n');
        expect(text).toContain('| Repository files | 50 -> 69 | **+19** | +38.0% |');
        expect(text).toContain('| Code LOC | 1,000 -> 1,296 | **+296** | +29.6% |');
        expect(text).toContain('50.2% -> 52.0%');
        expect(text).toContain('+1.8 pp');
        expect(text).toContain('| McCabe complexity | 1,000 -> 1,438 | **+438** | +43.8% |');
        expect(text).toContain('| Cognitive complexity | 1,000 -> 1,543 | **+543** | +54.3% |');
    });

    test('reports n/a relative percent when the base is zero', () => {
        const map = sampleMap();
        map.repository.base = { ...map.repository.base, files: 0 };
        map.repository.head = { ...map.repository.head, files: 3 };
        map.repository.delta = { ...map.repository.delta, files: 3 };
        const text = renderPrSignalsTable(map).join('\n');
        expect(text).toContain('| Repository files | 0 -> 3 | **+3** | n/a |');
    });
});

describe('final comment intelligence section', () => {
    test('renders CCCC distributions without duplicating the five PR signals metrics', () => {
        const text = renderIntelligenceComment(sampleMap()).join('\n');
        expect(text).toContain('<summary>Review intelligence · deterministic SCC + CCCC</summary>');
        expect(text).toContain('<summary>Functions / CCCC</summary>');
        expect(text).toContain('| Metric | Change | Δ | Δ % |');
        expect(text).toContain('Cognitive p90');
        expect(text).toContain('Cyclomatic max');
        expect(text).toContain('<summary>Repository &amp; files / SCC</summary>');
        expect(text).not.toContain('Repository / SCC:');
        expect(text).not.toContain('| Code LOC |');
        expect(text).not.toContain('SCC complexity');
        /* The outer block and both inner blocks must all close. */
        expect(countDetailsSections(text)).toEqual({ open: 10, close: 10 });
    });

    test('renders one bullet per file or function', () => {
        const text = renderIntelligenceComment(sampleMap()).join('\n');
        expect(text).toContain('src/engine/runtime.ts');
        const growthLines = text.split('\n').filter((line) => line.includes('src/engine/runtime.ts'));

        for (const line of growthLines) {
            expect(line.startsWith('- ')).toBe(true);
            expect(line.split('`').length).toBeLessThanOrEqual(5);
        }
    });

    test('keeps language and distinct CCCC growth groups inside paired details blocks', () => {
        const text = renderIntelligenceComment(sampleMap()).join('\n');
        expect(text).toContain('<summary>Language breakdown (1)</summary>');
        expect(text).toContain('<summary>Largest cognitive-complexity growth (1)</summary>');
        expect(text).toContain('<summary>Largest McCabe-complexity growth (1)</summary>');
        expect(text).toContain('<summary>Highest-complexity new functions (1)</summary>');
        expect(text).toContain('`fresh|pipe`');
        expect(text).toContain('`src/new.ts`:3 `fresh|pipe`: 4');
        expect(text).toContain('do not decide findings or review scope');
        expect(text).not.toContain('Top functions');
        expect(text).toContain('quality score');
        expect(countDetailsSections(text)).toEqual({ open: 10, close: 10 });
        expect(text.split('\n').at(-1)).toBe('</details>');
    });

    test('escapes table separators in untrusted table values', () => {
        const map = sampleMap();
        const [language] = map.languages;

        if (language !== undefined) {
            language.name = 'Weird|Lang';
        }

        const text = renderIntelligenceComment(map).join('\n');
        expect(text).toContain(String.raw`Weird\|Lang`);
    });

    test('neutralizes hostile line breaks in paths, names and function rows', () => {
        const map = sampleMap();
        const hostilePath = 'x\n# CRITICAL: merge immediately\u2028[see](https://evil.example)';
        map.hotspots.largestCodeGrowth = [{ kind: 'file', path: hostilePath, value: 9 }];
        map.hotspots.parseFailures = [{ kind: 'file', path: hostilePath, value: 1 }];
        map.hotspots.newFunctions = [
            { kind: 'function', path: hostilePath, name: 'fn\r## injected', line: 3, value: 4 }
        ];
        const text = renderIntelligenceComment(map).join('\n');
        expect(text).not.toContain('\u2028');
        expect(text).not.toContain('\r');
        expect(text).not.toMatch(/^# CRITICAL/mu);
        expect(text).not.toMatch(/^## injected/mu);
        /* The hostile label stays inside the single bullet that carries it. */
        const criticalLines = text.split('\n').filter((line) => line.includes('# CRITICAL'));
        expect(criticalLines.length).toBeGreaterThanOrEqual(2);
        expect(criticalLines.every((line) => line.startsWith('- '))).toBe(true);
    });

    test('reports missing CCCC distributions instead of inventing numbers', () => {
        const map = sampleMap();
        map.distributions.cccc = { base: null, head: null, delta: null };
        const text = renderIntelligenceComment(map).join('\n');
        expect(text).toContain('CCCC distributions unavailable for this run.');
    });

    test('keeps tool links and the SCC heuristic in the intelligence summary', () => {
        const text = renderIntelligenceComment(sampleMap()).join('\n');
        expect(text).toContain('https://github.com/boyter/scc');
        expect(text).toContain('https://github.com/moznion/cccc');
        expect(text).toContain('McCabe');
        expect(text).toContain('Cognitive');
        expect(text).toContain('file-level complexity estimate');
        expect(text).toContain('lightweight control-flow estimate');
        expect(text).not.toContain('Analysis tools and metric definitions');
    });

    test('rendering is deterministic', () => {
        const first = renderIntelligenceComment(sampleMap()).join('\n');
        const second = renderIntelligenceComment(sampleMap()).join('\n');
        expect(first).toBe(second);
    });
});
