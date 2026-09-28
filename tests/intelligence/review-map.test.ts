import { describe, expect, test } from 'bun:test';
import type { FileClassification } from '../../src/analysis/classification';
import type { CcccFileMetrics, CcccSnapshot } from '../../src/intelligence/measure-cccc';
import type { SccFileMetrics, SccLanguageMetrics, SccSnapshot } from '../../src/intelligence/measure-scc';
import { buildReviewMap } from '../../src/intelligence/normalize';
import type { SnapshotReviewData } from '../../src/intelligence/schema';
import type { VcsChangedFile } from '../../src/vcs/types';

function sccLanguage(name: string, code: number, cognitive: number, uloc: number, files = 1): SccLanguageMetrics {
    return {
        name,
        files,
        lines: code + 2,
        code,
        comments: 1,
        blanks: 1,
        bytes: code * 10,
        complexity: code / 10,
        cognitive,
        uloc,
        dryness: uloc / (code + 2)
    };
}

function sccFile(
    path: string,
    language: string,
    code: number,
    options: { complexity: number; cognitive: number }
): SccFileMetrics {
    return {
        path,
        language,
        possibleLanguages: [language],
        lines: code + 2,
        code,
        comments: 1,
        blanks: 1,
        bytes: code * 10,
        complexity: options.complexity,
        cognitive: options.cognitive,
        uloc: code - 1,
        binary: false,
        minified: false,
        generated: false
    };
}

function sccSnapshot(languages: SccLanguageMetrics[], files: SccFileMetrics[]): SccSnapshot {
    const totals = {
        files: 0,
        lines: 0,
        code: 0,
        comments: 0,
        blanks: 0,
        bytes: 0,
        complexity: 0,
        cognitive: 0,
        uloc: 0,
        dryness: 0
    };

    for (const language of languages) {
        totals.files += language.files;
        totals.lines += language.lines;
        totals.code += language.code;
        totals.comments += language.comments;
        totals.blanks += language.blanks;
        totals.bytes += language.bytes;
        totals.complexity += language.complexity;
        totals.cognitive += language.cognitive;
        totals.uloc += language.uloc;
    }

    totals.dryness = totals.uloc / totals.lines;

    return { languages, files, totals };
}

function ccccFile(path: string, functions: CcccFileMetrics['functions']): CcccFileMetrics {
    return { path, cognitive: 0, cyclomatic: 0, functions, parseErrors: [] };
}

function ccccSnapshot(files: CcccFileMetrics[], functionCount: number): CcccSnapshot {
    return {
        files,
        unsupported: [],
        summary: {
            fileCount: files.length,
            functionCount,
            parseErrorCount: 0,
            parseErrorFileCount: 0,
            parseErrorFiles: [],
            cognitive: { sum: 1, max: 1, median: 0, p90: 1, p95: 1 },
            cyclomatic: { sum: 2, max: 2, median: 1, p90: 2, p95: 2 }
        }
    };
}

function classifier(
    path: string,
    classification: FileClassification['classification'],
    noise = false
): FileClassification {
    if (noise) {
        return {
            classification,
            risk: { noise: true },
            analysis: { scc: 'not-counted', cccc: 'unsupported' }
        };
    }

    return {
        classification,
        risk: { noise: false },
        analysis: { scc: 'counted', cccc: 'attempted' }
    };
}

function changedFile(
    path: string,
    status: VcsChangedFile['status'],
    options: { additions: number; deletions: number; previousPath?: string }
): VcsChangedFile {
    return {
        path,
        status,
        additions: options.additions,
        deletions: options.deletions,
        previousPath: options.previousPath,
        patch: { state: 'none' }
    };
}

const BASE_LANGUAGES = [sccLanguage('TypeScript', 150, 21, 120, 2), sccLanguage('Markdown', 12, 0, 10)];

const HEAD_LANGUAGES = [sccLanguage('TypeScript', 200, 26, 160, 3), sccLanguage('Markdown', 12, 0, 10)];

const BASE_SCC = sccSnapshot(BASE_LANGUAGES, [
    sccFile('src/app.ts', 'TypeScript', 100, { complexity: 10, cognitive: 20 }),
    sccFile('src/old.ts', 'TypeScript', 50, { complexity: 11, cognitive: 1 }),
    sccFile('README.md', 'Markdown', 12, { complexity: 0, cognitive: 0 })
]);

const HEAD_SCC = sccSnapshot(HEAD_LANGUAGES, [
    sccFile('src/app.ts', 'TypeScript', 130, { complexity: 13, cognitive: 25 }),
    sccFile('src/renamed.ts', 'TypeScript', 50, { complexity: 12, cognitive: 1 }),
    sccFile('src/new.ts', 'TypeScript', 20, { complexity: 2, cognitive: 0 }),
    sccFile('README.md', 'Markdown', 12, { complexity: 0, cognitive: 0 })
]);

const BASE_CCCC = ccccSnapshot(
    [
        ccccFile('src/app.ts', [
            { name: 'handler', kind: 'function', line: 10, cognitive: 2, cyclomatic: 3, parentChain: [] },
            { name: 'gone', kind: 'function', line: 40, cognitive: 1, cyclomatic: 1, parentChain: [] }
        ]),
        ccccFile('src/old.ts', [
            { name: 'moved', kind: 'function', line: 5, cognitive: 1, cyclomatic: 1, parentChain: [] }
        ])
    ],
    3
);

const HEAD_CCCC = ccccSnapshot(
    [
        ccccFile('src/app.ts', [
            { name: 'handler', kind: 'function', line: 12, cognitive: 5, cyclomatic: 4, parentChain: [] }
        ]),
        ccccFile('src/renamed.ts', [
            { name: 'moved', kind: 'function', line: 7, cognitive: 1, cyclomatic: 2, parentChain: [] }
        ]),
        ccccFile('src/new.ts', [
            { name: 'fresh', kind: 'function', line: 3, cognitive: 2, cyclomatic: 2, parentChain: [] }
        ])
    ],
    3
);

function baseSnapshot(): SnapshotReviewData {
    return {
        scc: BASE_SCC,
        cccc: BASE_CCCC,
        requested: ['src/app.ts', 'src/old.ts', 'README.md'],
        notCounted: ['bun.lock'],
        unmeasurable: []
    };
}

function headSnapshot(): SnapshotReviewData {
    return {
        scc: HEAD_SCC,
        cccc: HEAD_CCCC,
        requested: ['src/app.ts', 'src/renamed.ts', 'src/new.ts', 'README.md'],
        notCounted: ['bun.lock'],
        unmeasurable: []
    };
}

function buildInput(): Parameters<typeof buildReviewMap>[0] {
    return {
        revisions: { baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) },
        tools: { scc: { version: '4.1.0', status: 'ok' as const }, cccc: { version: '1.6.0', status: 'ok' as const } },
        base: baseSnapshot(),
        head: headSnapshot(),
        changedFiles: [
            changedFile('src/app.ts', 'modified', { additions: 30, deletions: 5 }),
            changedFile('src/new.ts', 'added', { additions: 20, deletions: 0 }),
            changedFile('src/renamed.ts', 'renamed', { additions: 2, deletions: 2, previousPath: 'src/old.ts' }),
            changedFile('bun.lock', 'modified', { additions: 100, deletions: 100 })
        ],
        classifications: new Map([
            ['src/app.ts', classifier('src/app.ts', 'source')],
            ['src/new.ts', classifier('src/new.ts', 'source')],
            ['src/renamed.ts', classifier('src/renamed.ts', 'source')],
            ['bun.lock', classifier('bun.lock', 'lockfile', true)]
        ])
    };
}

describe('ReviewMap assembly', () => {
    test('carries the schema version, revisions, tools and changed counts', () => {
        const map = buildReviewMap(buildInput());
        expect(map.schemaVersion).toBe(1);
        expect(map.revisions).toEqual({ baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) });
        expect(map.tools).toEqual({
            scc: { version: '4.1.0', status: 'ok' },
            cccc: { version: '1.6.0', status: 'ok' }
        });
        expect(map.repository.changed).toEqual({ added: 1, modified: 2, removed: 0, renamed: 1 });
    });

    test('computes repository and language deltas from the SCC aggregates', () => {
        const map = buildReviewMap(buildInput());
        expect(map.repository.base.code).toBe(162);
        expect(map.repository.head.code).toBe(212);
        expect(map.repository.delta.code).toBe(50);
        expect(map.repository.delta.files).toBe(1);
        const typescript = map.languages.find((language) => language.name === 'TypeScript');
        expect(typescript?.base?.code).toBe(150);
        expect(typescript?.head?.code).toBe(200);
        expect(typescript?.delta?.code).toBe(50);
        const added = map.languages.find((language) => language.name === 'Markdown');
        expect(added?.delta?.code).toBe(0);
    });

    test('records per-file metrics, classification and parse status', () => {
        const map = buildReviewMap(buildInput());
        const app = map.files.find((file) => file.path === 'src/app.ts');
        expect(app?.base).toEqual({
            code: 100,
            comments: 1,
            blanks: 1,
            bytes: 1000,
            complexity: 10,
            cognitive: 20,
            ulocWithinFile: 99
        });
        expect(app?.delta?.code).toBe(30);
        expect(app?.changeMagnitude).toBe(35);
        expect(app?.parse).toEqual({ scc: 'ok', cccc: 'ok' });

        const lock = map.files.find((file) => file.path === 'bun.lock');
        expect(lock?.classification).toBe('lockfile');
        expect(lock?.risk.noise).toBe(true);
        expect(lock?.analysis).toEqual({ scc: 'not-counted', cccc: 'unsupported' });
        expect(lock?.parse).toEqual({ scc: 'not-counted', cccc: 'unsupported' });
        expect(lock?.base).toBeNull();
    });

    test('matches functions across a rename and keeps additions/deletions explicit', () => {
        const map = buildReviewMap(buildInput());
        const handler = map.functions.find((fn) => fn.name === 'handler');
        expect(handler?.match).toBe('matched');
        expect(handler?.delta).toEqual({ cognitive: 3, cyclomatic: 1 });
        const moved = map.functions.find((fn) => fn.name === 'moved');
        expect(moved?.path).toBe('src/renamed.ts');
        expect(moved?.match).toBe('matched');
        expect(moved?.delta).toEqual({ cognitive: 0, cyclomatic: 1 });
        const fresh = map.functions.find((fn) => fn.name === 'fresh');
        expect(fresh?.match).toBe('added');
        expect(fresh?.base).toBeNull();
        expect(map.functions.find((fn) => fn.name === 'gone')?.match).toBe('deleted');
    });

    test('reports coverage including unsupported files and classified omissions', () => {
        const map = buildReviewMap(buildInput());
        expect(map.coverage.scc.notCounted).toEqual(['bun.lock']);
        expect(map.coverage.scc.unsupported).toEqual([]);
        expect(map.coverage.scc.languages).toEqual(['Markdown', 'TypeScript']);
        expect(map.coverage.cccc.unsupported).toEqual(['bun.lock']);
    });

    test('ranks hotspots and exposes omission counters', () => {
        const map = buildReviewMap(buildInput());
        expect(map.hotspots.largestCodeGrowth[0]?.path).toBe('src/app.ts');
        expect(map.hotspotOmissions.omitted.largestCodeGrowth).toBeGreaterThanOrEqual(0);
        expect(map.hotspots.largestCognitiveGrowth[0]?.name).toBe('handler');
    });

    test('degrades explicitly when CCCC is unavailable on one side', () => {
        const input = buildInput();
        const map = buildReviewMap({ ...input, head: { ...input.head, cccc: null } });
        expect(map.tools.cccc.status).toBe('unavailable');
        expect(map.distributions.cccc.base).not.toBeNull();
        expect(map.distributions.cccc.head).toBeNull();
        expect(map.distributions.cccc.delta).toBeNull();
        expect(map.warnings).toContain('CCCC HEAD measurement unavailable.');
        /* A one-sided failure is not evidence: no function is fabricated as
           added or deleted, and no function hotspot is derived from it. */
        expect(map.functions).toEqual([]);
        expect(map.hotspots.largestCognitiveGrowth).toEqual([]);
        expect(map.hotspots.largestCyclomaticGrowth).toEqual([]);
        expect(map.hotspots.newFunctions).toEqual([]);
    });

    test('degrades explicitly when CCCC is unavailable on the BASE side', () => {
        const input = buildInput();
        const map = buildReviewMap({ ...input, base: { ...input.base, cccc: null } });
        expect(map.tools.cccc.status).toBe('unavailable');
        expect(map.distributions.cccc.base).toBeNull();
        expect(map.distributions.cccc.head).not.toBeNull();
        expect(map.distributions.cccc.delta).toBeNull();
        expect(map.warnings).toContain('CCCC BASE measurement unavailable.');
        /* Without a BASE side every HEAD function would be fabricated as added;
           the guard must suppress the function evidence on either side. */
        expect(map.functions).toEqual([]);
        expect(map.hotspots.largestCognitiveGrowth).toEqual([]);
        expect(map.hotspots.largestCyclomaticGrowth).toEqual([]);
        expect(map.hotspots.newFunctions).toEqual([]);
    });

    test('ranks an added file as HEAD minus zero in the file-growth hotspots', () => {
        const input = buildInput();

        const addedOnly: SnapshotReviewData = {
            ...input.head,
            requested: ['src/new.ts'],
            notCounted: []
        };

        const map = buildReviewMap({
            ...input,
            base: { ...input.base, requested: [] },
            head: addedOnly,
            changedFiles: [changedFile('src/new.ts', 'added', { additions: 20, deletions: 0 })],
            classifications: new Map([['src/new.ts', classifier('src/new.ts', 'source')]])
        });

        expect(map.hotspots.largestCodeGrowth.map((entry) => entry.path)).toContain('src/new.ts');
        expect(map.hotspots.largestCodeGrowth[0]?.value).toBeGreaterThan(0);
    });

    test('the functional map is deterministic for identical input', () => {
        const first = JSON.stringify(buildReviewMap(buildInput()));
        const second = JSON.stringify(buildReviewMap(buildInput()));
        expect(first).toBe(second);
    });
});
