import { describe, expect, test } from 'bun:test';
import { formatBudgetReport, summarizeCoverage } from '../../src/analysis/budget';
import {
    CONTEXT_EXCLUDED_REASON,
    isContextExcluded,
    isCoveredFile,
    isReviewableFile,
    planCoverageDiff
} from '../../src/analysis/diff';
import { buildCoverageDiff, renderCoverageDiff } from '../../src/analysis/render';
import { classifyFile, defaultClassificationRules } from '../../src/analysis/classification';
import { matchesAnyGlob } from '../../src/analysis/globs';
import { escalationPriorityPatterns } from '../../src/analysis/risk-rules';
import type { VcsChangedFile, VcsFilePatch } from '../../src/vcs/types';

interface ChangedFileOptions {
    additions?: number;
    deletions?: number;
    previousPath?: string;
}

const NO_PATCH: VcsFilePatch = { state: 'none' };

const UNAVAILABLE_PATCH: VcsFilePatch = { state: 'unavailable' };

function retained(patch: string): VcsFilePatch {
    return { state: 'retained', chars: patch.length, content: patch };
}

function measured(chars: number): VcsFilePatch {
    return { state: 'measured', chars };
}

function changedFile(path: string, patch: VcsFilePatch, options: ChangedFileOptions = {}): VcsChangedFile {
    return {
        path,
        status: 'modified',
        additions: options.additions ?? 1,
        deletions: options.deletions ?? 0,
        patch,
        previousPath: options.previousPath
    };
}

function patchOf(lines: number): string {
    return Array.from({ length: lines }, (_unused, index) => `+line-${index}`).join('\n');
}

function smallMeasuredFile(index: number): VcsChangedFile {
    const patch = patchOf(10);

    return changedFile(`src/small-${index}.ts`, retained(patch));
}

describe('coverage-budgeted diff', () => {
    test('priority files come first even when provided last', () => {
        const readme = changedFile('docs/readme.md', retained(patchOf(10)));
        const critical = changedFile('auth/login.ts', retained(patchOf(10)));
        const coverage = buildCoverageDiff([readme, critical], { maxChars: 100_000, priorityPatterns: ['auth/**'] });
        expect(coverage.files[0]).toMatchObject({ path: 'auth/login.ts', state: 'complete' });
        expect(coverage.complete).toBe(true);
    });

    test('a budgeted diff keeps sensitive middleware paths ahead of unrelated files', () => {
        const files = [
            changedFile('src/unrelated-a.ts', retained(patchOf(2000))),
            changedFile('src/unrelated-b.ts', retained(patchOf(2000))),
            changedFile('src/unrelated-c.ts', retained(patchOf(2000))),
            changedFile('src/middleware/auth.ts', retained(patchOf(2000)))
        ];

        const coverage = buildCoverageDiff(files, {
            maxChars: 3000,
            priorityPatterns: [...defaultClassificationRules().criticalPathPatterns]
        });

        expect(coverage.files[0]?.path).toBe('src/middleware/auth.ts');
        expect(coverage.files[0]?.state).toBe('truncated');
        expect(coverage.unifiedDiff).toContain('src/middleware/auth.ts');
        expect(coverage.complete).toBe(false);
    });

    test('every escalation-matched path is retained before neutral paths', () => {
        const files = [
            /* The neutral path sorts before every escalation match and carries
               more changed lines, so only the priority branch can keep it last. */
            changedFile('aaa/neutral.ts', measured(5000), { additions: 5000 }),
            changedFile('.github/workflows/ci.yml', measured(5000)),
            changedFile('package.json', measured(5000)),
            changedFile('db/migrations/001.sql', measured(5000))
        ];

        const plan = planCoverageDiff(files, {
            maxChars: 30_000,
            priorityPatterns: escalationPriorityPatterns()
        });

        expect(plan.entries.map((entry) => entry.path).slice(0, 3)).toEqual([
            '.github/workflows/ci.yml',
            'db/migrations/001.sql',
            'package.json'
        ]);
        expect(plan.complete).toBe(true);
    });

    test('escalation priority patterns cover workflows, dependencies, migrations and security', () => {
        const patterns = escalationPriorityPatterns();

        function matches(path: string): boolean {
            return matchesAnyGlob(path, patterns);
        }

        expect(matches('.github/workflows/ci.yml')).toBe(true);
        expect(matches('package.json')).toBe(true);
        expect(matches('db/migrations/001.sql')).toBe(true);
        expect(matches('src/auth/session.ts')).toBe(true);
        expect(matches('src/components/button.ts')).toBe(false);
    });

    test('redistributes a satisfied share so an uneven diff that fits the budget is complete', () => {
        const files = [changedFile('src/small.ts', measured(30)), changedFile('src/large.ts', measured(1020))];
        const unbounded = planCoverageDiff(files, { maxChars: 1_000_000, priorityPatterns: [] });
        const exactBudget = unbounded.entries.reduce((total, entry) => total + entry.need, 0);

        /* One file needs more than half the budget but the total still fits:
           the surplus of the small file must reach the large one. */
        const plan = planCoverageDiff(files, { maxChars: exactBudget, priorityPatterns: [] });
        expect(plan.complete).toBe(true);
        expect(plan.entries.map((entry) => entry.state)).toEqual(['complete', 'complete']);
    });

    test('budget overflows are explicit and drop the lowest priority files', () => {
        const files = [
            changedFile('src/small-a.ts', retained(patchOf(10))),
            changedFile('src/small-b.ts', retained(patchOf(10))),
            changedFile('src/big.ts', retained(patchOf(4000)))
        ];

        const coverage = buildCoverageDiff(files, { maxChars: 600, priorityPatterns: [] });
        expect(coverage.complete).toBe(false);
        const smallA = coverage.files.find((entry) => entry.path === 'src/small-a.ts');
        expect(smallA?.state).toBe('complete');
        const big = coverage.files.find((entry) => entry.path === 'src/big.ts');
        expect(big?.state).toBe('budget-truncated');
        expect(big?.reason).toBe('diff-budget-exceeded');
    });

    test('a truncated file is published as truncated and breaks completeness', () => {
        const hugeFile = changedFile('src/huge.ts', retained(patchOf(2000)));

        const coverage = buildCoverageDiff([hugeFile], {
            maxChars: 800,
            priorityPatterns: []
        });

        const huge = coverage.files.find((entry) => entry.path === 'src/huge.ts');
        expect(huge?.state).toBe('truncated');
        expect(coverage.unifiedDiff).toContain('[omitted: truncated at');
        expect(coverage.complete).toBe(false);
    });

    test('a budget too small for any meaningful content omits everything explicitly', () => {
        const files = Array.from({ length: 100 }, (_unused, index) => smallMeasuredFile(index));
        const coverage = buildCoverageDiff(files, { maxChars: 1000, priorityPatterns: [] });
        expect(coverage.complete).toBe(false);
        expect(coverage.files.every((entry) => entry.state === 'budget-truncated')).toBe(true);
    });

    test('patch-less files are excluded and never make coverage incomplete', () => {
        const coverage = buildCoverageDiff(
            [changedFile('assets/logo.png', NO_PATCH), changedFile('src/app.ts', retained('+ok'))],
            { maxChars: 5000, priorityPatterns: [] }
        );

        expect(coverage.complete).toBe(true);
        expect(coverage.files.find((entry) => entry.path === 'assets/logo.png')).toMatchObject({
            state: 'excluded',
            reason: 'no-reviewable-hunks'
        });
    });

    test('a provider-omitted patch always blocks completeness and is never rendered', () => {
        const files = [
            changedFile('src/large.ts', UNAVAILABLE_PATCH, { additions: 1200, deletions: 3 }),
            changedFile('assets/logo.png', NO_PATCH),
            changedFile('src/app.ts', retained('+ok'))
        ];

        const coverage = buildCoverageDiff(files, { maxChars: 5000, priorityPatterns: [] });

        expect(coverage.complete).toBe(false);
        expect(coverage.files.find((entry) => entry.path === 'src/large.ts')).toMatchObject({
            state: 'budget-truncated',
            reason: 'patch-unavailable'
        });
        expect(coverage.files.find((entry) => entry.path === 'assets/logo.png')).toMatchObject({ state: 'excluded' });
        expect(coverage.unifiedDiff).not.toContain('src/large.ts');
    });

    test('coverage classification keeps excluded content out and unavailable content uncovered', () => {
        const coverage = buildCoverageDiff(
            [
                changedFile('assets/logo.png', NO_PATCH),
                changedFile('src/large.ts', UNAVAILABLE_PATCH, { additions: 900 }),
                changedFile('src/app.ts', retained('+ok'))
            ],
            { maxChars: 5000, priorityPatterns: [] }
        );

        const byPath = new Map(coverage.files.map((entry) => [entry.path, entry]));
        const logo = byPath.get('assets/logo.png');
        const large = byPath.get('src/large.ts');
        const app = byPath.get('src/app.ts');

        if (logo === undefined || large === undefined || app === undefined) {
            throw new Error('expected every file in the coverage');
        }

        expect(isReviewableFile(logo)).toBe(false);
        expect(isCoveredFile(logo)).toBe(true);
        expect(isCoveredFile(app)).toBe(true);
        expect(isReviewableFile(large)).toBe(true);
        expect(isCoveredFile(large)).toBe(false);
        expect(isReviewableFile(app)).toBe(true);
    });

    test('coverage classification consumes the resolved rules and the pre-pass classifications', () => {
        const files = [changedFile('assets/logo.png', NO_PATCH), changedFile('src/app.ts', retained('+ok'))];
        const plan = planCoverageDiff(files, { maxChars: 5000, priorityPatterns: [] });
        const rules = defaultClassificationRules();

        const resolved = new Map([
            ['assets/logo.png', classifyFile({ path: 'assets/logo.png', content: '// @generated\n', rules })],
            ['src/app.ts', classifyFile({ path: 'src/app.ts', rules })]
        ]);

        const coverage = renderCoverageDiff(plan, files, {
            /* The resolved rules would mark src/** as an asset; the pre-pass
               classification must win because it is the single resolution. */
            classification: { ...rules, assetPatterns: [...rules.assetPatterns, 'src/**'] },
            fileClassifications: resolved
        });

        const byPath = new Map(coverage.files.map((entry) => [entry.path, entry]));
        expect(byPath.get('assets/logo.png')?.classification).toBe('generated');
        expect(byPath.get('src/app.ts')?.classification).toBe('source');
    });

    test('the budget summary counts an unavailable patch as reviewable but not covered', () => {
        const plan = planCoverageDiff([changedFile('src/large.ts', UNAVAILABLE_PATCH, { additions: 900 })], {
            maxChars: 5000,
            priorityPatterns: []
        });

        const summary = summarizeCoverage(plan, 5000);
        expect(summary.reviewableFiles).toBe(1);
        expect(summary.completeFiles).toBe(0);
    });

    test('a measured file without retained content can never render as complete', () => {
        const files = [changedFile('src/read.ts', measured(100))];
        const plan = planCoverageDiff(files, { maxChars: 5000, priorityPatterns: [] });
        expect(plan.complete).toBe(true);

        /* The size is known but no content was read: the renderer must downgrade
           the file instead of reporting a complete review over unread content. */
        const coverage = renderCoverageDiff(plan, files);
        expect(coverage.complete).toBe(false);
        expect(coverage.files[0]).toMatchObject({ path: 'src/read.ts', state: 'budget-truncated' });
    });

    test('the plan only allocates reads for files that will be reviewed', () => {
        const files = [
            changedFile('src/kept.ts', measured(10)),
            changedFile('src/dropped.ts', measured(4000)),
            changedFile('assets/logo.png', NO_PATCH)
        ];

        const plan = planCoverageDiff(files, { maxChars: 600, priorityPatterns: [] });
        expect([...plan.allocations.keys()]).toEqual(['src/kept.ts']);
    });

    test('renames keep their previous path in the header', () => {
        const coverage = buildCoverageDiff(
            [changedFile('src/new-name.ts', retained('+ok'), { previousPath: 'src/old-name.ts' })],
            {
                maxChars: 5000,
                priorityPatterns: []
            }
        );

        expect(coverage.unifiedDiff).toContain('rename from src/old-name.ts');
        expect(coverage.unifiedDiff).toContain('rename to src/new-name.ts');
    });

    test('coverage output is deterministic', () => {
        const files = [
            changedFile('src/a.ts', retained(patchOf(30))),
            changedFile('src/b.ts', retained(patchOf(30))),
            changedFile('auth/c.ts', retained(patchOf(30)))
        ];

        const options = { maxChars: 1200, priorityPatterns: ['auth/**'] };
        const first = buildCoverageDiff(files, options);
        const second = buildCoverageDiff(files, options);
        expect(first.unifiedDiff).toBe(second.unifiedDiff);
        expect(first.files).toEqual(second.files);
    });
});

describe('budget report', () => {
    test('states the exact diff size, the limit, the allocation share and file counts', () => {
        const report = formatBudgetReport({
            totalChars: 1000,
            limitChars: 400,
            coveredChars: 250,
            reviewableFiles: 4,
            completeFiles: 1
        });

        expect(report).toBe('diff = 1000 characters, limit = 400; reviewable 25.0 % (1/4 files complete)');
    });

    test('summarizes the covered characters from the plan allocation', () => {
        const files = [changedFile('src/kept.ts', measured(10)), changedFile('src/dropped.ts', measured(4000))];
        const plan = planCoverageDiff(files, { maxChars: 600, priorityPatterns: [] });
        const summary = summarizeCoverage(plan, 600);
        expect(summary.reviewableFiles).toBe(2);
        expect(summary.completeFiles).toBe(1);
        expect(summary.totalChars).toBeGreaterThan(summary.coveredChars);
        expect(summary.coveredChars).toBeGreaterThan(0);
    });
});

describe('review.exclude context', () => {
    const EXCLUDE = ['tools/oxlint/anti-slop/**'];

    test('an excluded measurable file leaves the diff, the budget and completeness', () => {
        const excluded = changedFile('tools/oxlint/anti-slop/rules/foo.ts', retained(patchOf(2000)), {
            additions: 2000,
            deletions: 10
        });

        const kept = changedFile('src/app.ts', retained('+ok'));

        const plan = planCoverageDiff([excluded, kept], {
            maxChars: 5000,
            priorityPatterns: [],
            excludePatterns: EXCLUDE
        });

        const byPath = new Map(plan.entries.map((entry) => [entry.path, entry]));
        const excludedEntry = byPath.get('tools/oxlint/anti-slop/rules/foo.ts');

        expect(excludedEntry).toMatchObject({
            state: 'complete',
            reason: CONTEXT_EXCLUDED_REASON,
            need: 0,
            allocated: 0,
            contextExcluded: true
        });
        expect([...plan.allocations.keys()]).toEqual(['src/app.ts']);
        expect(plan.complete).toBe(true);

        const coverage = renderCoverageDiff(plan, [excluded, kept], {});
        const excludedCoverage = coverage.files.find((entry) => entry.path === 'tools/oxlint/anti-slop/rules/foo.ts');

        expect(excludedCoverage).toMatchObject({
            state: 'complete',
            reason: CONTEXT_EXCLUDED_REASON,
            classification: 'source',
            contextExcluded: true
        });
        expect(coverage.unifiedDiff).not.toContain('tools/oxlint/anti-slop/rules/foo.ts');
        expect(coverage.unifiedDiff).toContain('src/app.ts');
        expect(coverage.complete).toBe(true);

        if (excludedCoverage === undefined) {
            throw new Error('expected the excluded file in the coverage');
        }

        expect(isReviewableFile(excludedCoverage)).toBe(false);
        expect(isCoveredFile(excludedCoverage)).toBe(true);
        expect(isContextExcluded({ path: excluded.path }, EXCLUDE)).toBe(true);
        expect(isContextExcluded({ path: kept.path }, EXCLUDE)).toBe(false);
    });

    test('exclusion wins over a tight budget and an unavailable patch', () => {
        const excluded = changedFile('tools/oxlint/anti-slop/shared/bar.ts', retained(patchOf(2000)), {
            additions: 2000
        });

        const unavailable = changedFile('tools/oxlint/anti-slop/vendor/baz.ts', UNAVAILABLE_PATCH, {
            additions: 900
        });

        const normal = changedFile('src/big.ts', retained(patchOf(4000)));

        const plan = planCoverageDiff([excluded, unavailable, normal], {
            maxChars: 600,
            priorityPatterns: [],
            excludePatterns: EXCLUDE
        });

        const byPath = new Map(plan.entries.map((entry) => [entry.path, entry]));

        expect(byPath.get('tools/oxlint/anti-slop/shared/bar.ts')).toMatchObject({
            state: 'complete',
            contextExcluded: true
        });
        expect(byPath.get('tools/oxlint/anti-slop/vendor/baz.ts')).toMatchObject({
            state: 'complete',
            contextExcluded: true
        });
        expect([...plan.allocations.keys()].some((path) => path.startsWith('tools/'))).toBe(false);
        /* Only the normal file can still block completeness. */
        expect(plan.complete).toBe(false);

        const summary = summarizeCoverage(plan, 600);
        expect(summary.reviewableFiles).toBe(1);
    });

    test('exclusion matches either endpoint of a rename', () => {
        const renamedFrom = changedFile('src/new-name.ts', retained('+ok'), {
            previousPath: 'tools/oxlint/anti-slop/old-name.ts'
        });

        const renamedTo = changedFile('tools/oxlint/anti-slop/new-name.ts', retained('+ok'), {
            previousPath: 'src/old-name.ts'
        });

        for (const file of [renamedFrom, renamedTo]) {
            const plan = planCoverageDiff([file], {
                maxChars: 5000,
                priorityPatterns: [],
                excludePatterns: EXCLUDE
            });

            expect(plan.entries[0]).toMatchObject({ contextExcluded: true, state: 'complete' });
        }

        const kept = changedFile('src/kept.ts', retained('+ok'), { previousPath: 'src/old-kept.ts' });

        const keptPlan = planCoverageDiff([kept], {
            maxChars: 5000,
            priorityPatterns: [],
            excludePatterns: EXCLUDE
        });

        expect(keptPlan.entries[0]?.contextExcluded).toBeUndefined();
        expect(keptPlan.entries[0]?.state).toBe('complete');
    });

    test('binary and empty files keep their excluded semantics without the context flag', () => {
        const binary = changedFile('assets/logo.png', NO_PATCH);
        const empty = changedFile('src/empty.ts', NO_PATCH);
        const normal = changedFile('src/app.ts', retained('+ok'));

        const coverage = buildCoverageDiff([binary, empty, normal], {
            maxChars: 5000,
            priorityPatterns: []
        });

        const byPath = new Map(coverage.files.map((entry) => [entry.path, entry]));

        expect(byPath.get('assets/logo.png')).toMatchObject({
            state: 'excluded',
            reason: 'no-reviewable-hunks'
        });
        expect(byPath.get('assets/logo.png')?.contextExcluded).toBeUndefined();
        expect(byPath.get('src/empty.ts')).toMatchObject({ state: 'excluded' });
        expect(byPath.get('src/empty.ts')?.contextExcluded).toBeUndefined();
        expect(byPath.get('src/app.ts')?.contextExcluded).toBeUndefined();
        expect(coverage.complete).toBe(true);
    });
});
