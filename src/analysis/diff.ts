import type { FileClass } from './classification';
import { matchesAnyGlob } from './globs';
import { changedFilePaths, type VcsChangedFile } from '../vcs/types';

/* `complete` and `truncated` are retained content. `excluded` has none and never blocks completeness; `budget-truncated` was omitted and always blocks it. */
export type DiffFileState = 'complete' | 'truncated' | 'excluded' | 'budget-truncated';

export interface DiffFileCoverage {
    path: string;
    previousPath?: string;
    state: DiffFileState;
    reason?: string;
    /* Declarative policy axis, separate from DiffFileState: matched files stay
       Git-normal and classified, but leave automatic agent context. */
    contextExcluded?: boolean;
    /* Classification metadata from the single canonical owner; noise files stay
       visible here with their explicit coverage state. */
    classification: FileClass;
}

export interface DiffCoverage {
    unifiedDiff: string;
    files: DiffFileCoverage[];
    complete: boolean;
}

export interface CoverageDiffOptions {
    maxChars: number;
    priorityPatterns: string[];
    /* Declarative exclusion from automatic context; absent means no exclusion
       so existing callers stay byte-identical. */
    excludePatterns?: readonly string[];
}

/* One planned file: exact rendered size, budgeted characters, resulting state. */
export interface CoveragePlanEntry {
    path: string;
    previousPath?: string;
    state: DiffFileState;
    reason?: string;
    need: number;
    allocated: number;
    /* Declarative policy axis, separate from DiffFileState. */
    contextExcluded?: boolean;
}

export interface CoveragePlan {
    /* Sorted by coverage priority, then size and path. */
    entries: CoveragePlanEntry[];
    /* Patch characters to retain per path, in plan order; only reads appear. */
    allocations: ReadonlyMap<string, number>;
    complete: boolean;
}

/* Exact rendering numbers and reasons shared by the plan and its renderer. */
const MIN_TRUNCATED_CHARS = 500;

const EXCLUDED_REASON = 'no-reviewable-hunks';

export const CONTEXT_EXCLUDED_REASON = 'context-excluded';

export const UNAVAILABLE_REASON = 'patch-unavailable';

export const BUDGET_REASON = 'diff-budget-exceeded';

/* Reviewable means automatic agent context. Patch-excluded files carry no
   hunks; context-excluded files are declaratively kept out by review.exclude.
   Both never block completeness. */
export function isReviewableFile(file: DiffFileCoverage): boolean {
    if (file.contextExcluded === true) {
        return false;
    }

    return file.state !== 'excluded';
}

export function isCoveredFile(file: DiffFileCoverage): boolean {
    if (file.contextExcluded === true) {
        return true;
    }

    return isCoveredState(file.state);
}

/* Deterministic path-only match for review.exclude: a rename matches when
   either endpoint matches, like priority patterns. */
export function isContextExcluded(
    file: Pick<VcsChangedFile, 'path' | 'previousPath'>,
    patterns: readonly string[] | undefined
): boolean {
    if (patterns === undefined || patterns.length === 0) {
        return false;
    }

    return changedFilePaths(file).some((path) => matchesAnyGlob(path, patterns));
}

function isCoveredState(state: DiffFileState): boolean {
    return state === 'complete' || state === 'excluded';
}

/* Hunk size is known before content is retained, so the plan decides what to read. Every file ends with an explicit state. */
export function planCoverageDiff(files: readonly VcsChangedFile[], options: CoverageDiffOptions): CoveragePlan {
    const sorted = sortForCoverage(files, options.priorityPatterns);
    const contents = sorted.map((file) => plannedContent(file, options.excludePatterns));
    const allocations = allocateBudgets(measurableNeeds(contents), options.maxChars);
    const entries = buildPlanEntries(sorted, contents, allocations);

    return { entries, allocations: allocationsOf(entries), complete: entries.every((entry) => isCoveredEntry(entry)) };
}

/* What the budget plans for one file: no content, unavailable content, or a
   measurable rendering with an exact size. Context-excluded files never consume
   budget and never block completeness. */
type PlannedContent =
    | { kind: 'excluded' }
    | { kind: 'unavailable' }
    | { kind: 'context-excluded' }
    | { kind: 'measurable'; need: number };

function plannedContent(file: VcsChangedFile, excludePatterns: readonly string[] | undefined): PlannedContent {
    if (isContextExcluded(file, excludePatterns)) {
        return { kind: 'context-excluded' };
    }

    if (file.patch.state === 'unavailable') {
        return { kind: 'unavailable' };
    }

    if (file.patch.state === 'none') {
        return { kind: 'excluded' };
    }

    return { kind: 'measurable', need: renderedHeader(file).length + file.patch.chars };
}

function measurableNeeds(contents: readonly PlannedContent[]): number[] {
    const needs: number[] = [];

    for (const content of contents) {
        if (content.kind === 'measurable') {
            needs.push(content.need);
        }
    }

    return needs;
}

function buildPlanEntries(
    sorted: readonly VcsChangedFile[],
    contents: readonly PlannedContent[],
    allocations: number[]
): CoveragePlanEntry[] {
    const budgets = allocatedBudgets(contents, allocations);

    return sorted.map((file, index) => planEntry(file, contents[index], budgets[index] ?? 0));
}

/* One budget per file in plan order: only measurable content consumes an
   allocation, so the cursor stays aligned with `measurableNeeds`. */
function allocatedBudgets(contents: readonly PlannedContent[], allocations: number[]): number[] {
    const budgets: number[] = [];
    let cursor = 0;

    for (const content of contents) {
        let allocated = 0;

        if (content.kind === 'measurable') {
            allocated = allocations[cursor] ?? 0;
            cursor += 1;
        }

        budgets.push(allocated);
    }

    return budgets;
}

function planEntry(file: VcsChangedFile, content: PlannedContent | undefined, allocated: number): CoveragePlanEntry {
    if (content?.kind === 'context-excluded') {
        return contextExcludedEntry(file);
    }

    if (content?.kind === 'measurable') {
        return plannedEntry(file, content.need, allocated);
    }

    if (content?.kind === 'unavailable') {
        return unavailableEntry(file);
    }

    return excludedEntry(file);
}

function contextExcludedEntry(file: VcsChangedFile): CoveragePlanEntry {
    return {
        path: file.path,
        previousPath: file.previousPath,
        state: 'complete',
        reason: CONTEXT_EXCLUDED_REASON,
        need: 0,
        allocated: 0,
        contextExcluded: true
    };
}

function excludedEntry(file: VcsChangedFile): CoveragePlanEntry {
    return {
        path: file.path,
        previousPath: file.previousPath,
        state: 'excluded',
        reason: EXCLUDED_REASON,
        need: 0,
        allocated: 0
    };
}

/* Omitted reviewable content is never retained and always blocks completeness. */
function unavailableEntry(file: VcsChangedFile): CoveragePlanEntry {
    return {
        path: file.path,
        previousPath: file.previousPath,
        state: 'budget-truncated',
        reason: UNAVAILABLE_REASON,
        need: 0,
        allocated: 0
    };
}

function plannedEntry(file: VcsChangedFile, need: number, allocated: number): CoveragePlanEntry {
    const base = { path: file.path, previousPath: file.previousPath, need };

    if (allocated >= need) {
        return { ...base, state: 'complete', allocated };
    }

    if (publishablePatchChars(allocated, renderedHeader(file).length) > 0) {
        return { ...base, state: 'truncated', reason: BUDGET_REASON, allocated };
    }

    return { ...base, state: 'budget-truncated', reason: BUDGET_REASON, allocated: 0 };
}

/* Publishable patch chars once the header is covered; zero below the usability floor so plan and renderer agree. */
export function publishablePatchChars(allocated: number, headerChars: number): number {
    const usable = Math.max(0, allocated - headerChars);

    if (usable < MIN_TRUNCATED_CHARS) {
        return 0;
    }

    return usable;
}

function allocationsOf(entries: CoveragePlanEntry[]): Map<string, number> {
    const allocations = new Map<string, number>();

    for (const entry of entries) {
        if (entry.allocated > 0) {
            allocations.set(entry.path, entry.allocated);
        }
    }

    return allocations;
}

/* Plan measures the header and renderer prints it, so published size matches the plan. */
export function renderedHeader(file: VcsChangedFile): string {
    const header = `diff --git a/${file.previousPath ?? file.path} b/${file.path}\nstatus ${file.status}\nstats +${file.additions} -${file.deletions}\n`;

    return `${header}${renderRenameLine(file)}`;
}

function renderRenameLine(file: VcsChangedFile): string {
    if (file.previousPath === undefined) {
        return '';
    }

    return `rename from ${file.previousPath}\nrename to ${file.path}\n`;
}

function isCoveredEntry(entry: CoveragePlanEntry): boolean {
    if (entry.contextExcluded === true) {
        return true;
    }

    return isCoveredState(entry.state);
}

/* Each pass shares remaining budget across unsatisfied files; satisfied files release surplus to larger needs. */
function allocateBudgets(needs: number[], maxChars: number): number[] {
    const allocations = needs.map(() => 0);
    let remaining = maxChars;

    while (remaining > 0) {
        const progress = allocationPass(needs, allocations, remaining);

        if (progress === undefined) {
            break;
        }

        remaining = progress;
    }

    return allocations;
}

/* Returns leftover budget, or `undefined` when the pass makes no progress. */
function allocationPass(needs: number[], allocations: number[], remaining: number): number | undefined {
    const unsatisfiedCount = countUnsatisfied(needs, allocations);

    if (unsatisfiedCount === 0) {
        return undefined;
    }

    const share = Math.floor(remaining / unsatisfiedCount);
    const leftover = distributePass(needs, allocations, { remaining, share });

    if (leftover >= remaining) {
        return undefined;
    }

    return leftover;
}

function countUnsatisfied(needs: number[], allocations: number[]): number {
    return needs.filter((need, index) => need > (allocations[index] ?? 0)).length;
}

function distributePass(needs: number[], allocations: number[], budget: { remaining: number; share: number }): number {
    let leftover = budget.remaining;

    for (const [index, need] of needs.entries()) {
        const missing = need - (allocations[index] ?? 0);

        if (missing > 0 && leftover > 0) {
            const extra = Math.min(missing, budget.share, leftover);
            allocations[index] = (allocations[index] ?? 0) + extra;
            leftover -= extra;
        }
    }

    return leftover;
}

function sortForCoverage(files: readonly VcsChangedFile[], priorityPatterns: string[]): VcsChangedFile[] {
    const ranked = files.map((file) => ({ file, rank: priorityRank(file, priorityPatterns) }));

    return ranked
        .toSorted((left, right) => {
            const priorityDelta = left.rank - right.rank;

            if (priorityDelta !== 0) {
                return priorityDelta;
            }

            const sizeDelta = right.file.additions + right.file.deletions - (left.file.additions + left.file.deletions);

            if (sizeDelta !== 0) {
                return sizeDelta;
            }

            return left.file.path.localeCompare(right.file.path);
        })
        .map((entry) => entry.file);
}

/* Priority rank also considers the previous path of a rename. */
function priorityRank(file: VcsChangedFile, priorityPatterns: string[]): number {
    if (changedFilePaths(file).some((path) => matchesAnyGlob(path, priorityPatterns))) {
        return 0;
    }

    return 1;
}
