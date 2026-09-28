import type { DiffCoverage } from '../analysis/diff';
import { formatDryness, plainText, signed } from './format';
import { fileSection, functionSection, type StructuralContent, structuralSection } from './project-sections';
import type { ReviewMap } from './schema';

/* Per-role projections; tops never define scope and critical issues can sit outside hotspots. Findings need diff verification; truncation stays explicit with reserved closing counters. */

export type ProjectionKind = 'common' | 'maintainability' | 'correctness' | 'performance';

const DEFAULT_LIMITS: Record<ProjectionKind, number> = {
    common: 8000,
    maintainability: 25_000,
    correctness: 10_000,
    performance: 10_000
};

const SHORT_SHA_LENGTH = 7;

export interface ProjectionInput {
    map: ReviewMap;
    coverage: DiffCoverage;
    kind: ProjectionKind;
    maxChars?: number;
}

/* All counters render in the closing block, so callers read projection text instead of a second representation. */
interface ProjectionCounters {
    diff: {
        changedFiles: number;
        representedFiles: number;
        truncated: boolean;
        excludedFiles: number;
        excludedLines: number;
    };
    omittedHotspots: number;
    omittedFiles: number;
    omittedFunctions: number;
    /* Header/repository/title lines dropped by budget fitting. */
    omittedFixed: number;
}

export function projectReviewMap(input: ProjectionInput): string {
    const maxChars = input.maxChars ?? DEFAULT_LIMITS[input.kind];
    const { map } = input;
    const excludedPaths = excludedContextPaths(input.coverage);
    const files = fileSection(map, input.kind, excludedPaths);
    const functions = functionSection(map, input.kind);
    const structural = structuralSection(map);
    const diff = diffMetadata(map, input.coverage);

    const candidates: Section[] = [
        { title: '', kind: 'fixed', lines: headerLines(map, diff) },
        { title: '', kind: 'fixed', lines: repositoryLines(map) },
        { title: 'Changed files', kind: 'files', lines: files.lines, omitted: files.omitted },
        structuralCandidate(structural, map),
        { title: 'Function deltas', kind: 'functions', lines: functions.lines, omitted: functions.omitted }
    ];

    const sections = candidates.filter((section) => section.lines.length > 0);
    /* The closing block size is reserved first, so fitted sections never push past maxChars. */
    const reserved = closingBlockLength(sections, diff);
    const fitted = fitSections(sections, Math.max(0, maxChars - reserved));
    const metadata = countersOf(diff, fitted.omitted);

    return [...fitted.lines, ...closingLines(metadata)].join('\n');
}

function structuralCandidate(structural: StructuralContent, map: ReviewMap): Section {
    if (structural.entries === 0) {
        return { title: 'Structural changes', kind: 'fixed', lines: structural.lines };
    }

    return {
        title: 'Structural changes',
        kind: 'hotspots',
        lines: structural.lines,
        omitted: structural.omitted + totalOmittedHotspots(map)
    };
}

interface Section {
    title: string;
    kind: 'fixed' | 'files' | 'functions' | 'hotspots';
    lines: string[];
    /* Entries this section already knows it cannot render. */
    omitted?: number;
}

interface Omissions {
    files: number;
    functions: number;
    hotspots: number;
    fixed: number;
}

interface FittedSections {
    lines: string[];
    omitted: Omissions;
}

interface FitState {
    lines: string[];
    omitted: Omissions;
    used: number;
    stopped: boolean;
}

/* Section order is priority order; overflowing sections fill line by line and dropped lines join their own omission counter. Later sections stop once the budget is exhausted. */
function fitSections(sections: Section[], maxChars: number): FittedSections {
    const state: FitState = { lines: [], omitted: emptyOmissions(), used: 0, stopped: false };

    for (const section of sections) {
        if (state.stopped) {
            accumulateDropped(state.omitted, section, 0);
        } else {
            placeSection(state, section, maxChars);
        }
    }

    return { lines: state.lines, omitted: state.omitted };
}

function placeSection(state: FitState, section: Section, maxChars: number): void {
    const block = sectionLines(section);
    const size = blockLength(block);

    if (state.used + size <= maxChars) {
        state.lines.push(...block);
        state.used += size;
        /* Already-known omissions still count even when every rendered line fits. */
        addKnownOmissions(state.omitted, section);

        return;
    }

    state.stopped = true;
    const kept = keepWithin(block, Math.max(0, maxChars - state.used));
    state.lines.push(...kept.lines);
    let titleCount = 0;

    if (section.title !== '') {
        titleCount = 1;
    }

    const keptTitle = Math.min(titleCount, kept.lines.length);
    const keptData = kept.lines.length - keptTitle;
    accumulateDropped(state.omitted, section, keptData);
    state.omitted.fixed += titleCount - keptTitle;
}

function addKnownOmissions(omitted: Omissions, section: Section): void {
    const known = section.omitted ?? 0;

    if (section.kind === 'files') {
        omitted.files += known;
    } else if (section.kind === 'functions') {
        omitted.functions += known;
    } else if (section.kind === 'hotspots') {
        omitted.hotspots += known;
    }
}

/* Keeps whole lines while they fit; the reservation caps sections at `remaining`. */
function keepWithin(lines: string[], remaining: number): { lines: string[]; size: number } {
    const kept: string[] = [];
    let size = 0;

    for (const line of lines) {
        const lineSize = line.length + 1;

        if (size + lineSize > remaining) {
            break;
        }

        kept.push(line);
        size += lineSize;
    }

    // eslint-disable-next-line anti-slop/no-known-value-widening -- literal matches the declared fit contract
    return { lines: kept, size };
}

function accumulateDropped(omitted: Omissions, section: Section, keptData: number): void {
    const dropped = section.lines.length - keptData + (section.omitted ?? 0);

    if (section.kind === 'files') {
        omitted.files += dropped;
    } else if (section.kind === 'functions') {
        omitted.functions += dropped;
    } else if (section.kind === 'hotspots') {
        omitted.hotspots += dropped;
    } else {
        omitted.fixed += section.lines.length - keptData;
    }
}

function sectionLines(section: Section): string[] {
    if (section.title === '') {
        return section.lines;
    }

    return ['', `### ${section.title}`, ...section.lines];
}

function emptyOmissions(): Omissions {
    return { files: 0, functions: 0, hotspots: 0, fixed: 0 };
}

/* Upper bound of every counter before fitting; the closing block with these values is at least as long as final. */
function omittedBounds(sections: Section[]): Omissions {
    const bounds = emptyOmissions();

    for (const section of sections) {
        const entries = section.lines.length + (section.omitted ?? 0);

        if (section.kind === 'files') {
            bounds.files += entries;
        } else if (section.kind === 'functions') {
            bounds.functions += entries;
        } else if (section.kind === 'hotspots') {
            bounds.hotspots += entries;
        } else {
            bounds.fixed += section.lines.length;
        }

        if (section.title !== '') {
            bounds.fixed += 1;
        }
    }

    return bounds;
}

function closingBlockLength(sections: Section[], diff: ProjectionCounters['diff']): number {
    const closing = closingLines(countersOf(diff, omittedBounds(sections)));

    return blockLength(closing);
}

function countersOf(diff: ProjectionCounters['diff'], omitted: Omissions): ProjectionCounters {
    return {
        diff,
        omittedHotspots: omitted.hotspots,
        omittedFiles: omitted.files,
        omittedFunctions: omitted.functions,
        omittedFixed: omitted.fixed
    };
}

function diffMetadata(map: ReviewMap, coverage: DiffCoverage): ProjectionCounters['diff'] {
    const represented = coverage.files.filter(
        (file) => (file.state === 'complete' || file.state === 'truncated') && file.contextExcluded !== true
    ).length;

    const excluded = excludedContextSummary(map, coverage);

    return {
        changedFiles: coverage.files.length,
        representedFiles: represented,
        truncated: !coverage.complete,
        excludedFiles: excluded.count,
        excludedLines: excluded.changedLines
    };
}

/* Excluded paths for projection filtering: both endpoints of a rename, so a
   file excluded via its previous path still disappears. */
function excludedContextPaths(coverage: DiffCoverage): ReadonlySet<string> {
    const paths = new Set<string>();

    for (const file of coverage.files) {
        if (file.contextExcluded === true) {
            paths.add(file.path);

            if (file.previousPath !== undefined) {
                paths.add(file.previousPath);
            }
        }
    }

    return paths;
}

/* Global summary only: N excluded files, M summed changeMagnitude from the
   internal map. Internal data stays complete; the projection shows one line. */
interface ExcludedContextSummary {
    count: number;
    changedLines: number;
}

function excludedContextSummary(map: ReviewMap, coverage: DiffCoverage): ExcludedContextSummary {
    const excluded = new Set<string>();

    for (const file of coverage.files) {
        if (file.contextExcluded === true) {
            excluded.add(file.path);

            if (file.previousPath !== undefined) {
                excluded.add(file.previousPath);
            }
        }
    }

    if (excluded.size === 0) {
        return { count: 0, changedLines: 0 };
    }

    let count = 0;
    let changedLines = 0;

    for (const file of map.files) {
        if (excluded.has(file.path) || (file.previousPath !== undefined && excluded.has(file.previousPath))) {
            count += 1;
            changedLines += file.changeMagnitude;
        }
    }

    /* Coverage without a matching map entry (focused unit fixtures) still
       counts the exclusion; magnitude stays exact when the map is present. */
    if (count === 0) {
        count = coverage.files.filter((file) => file.contextExcluded === true).length;
    }

    return { count, changedLines };
}

function totalOmittedHotspots(map: ReviewMap): number {
    let total = 0;

    for (const count of Object.values(map.hotspotOmissions.omitted)) {
        total += count;
    }

    return total;
}

function headerLines(map: ReviewMap, diff: ProjectionCounters['diff']): string[] {
    const lines = [
        '## Deterministic review intelligence (ReviewMap)',
        `BASE \`${shortSha(map.revisions.baseSha)}\` -> HEAD \`${shortSha(map.revisions.headSha)}\`; SCC ${map.tools.scc.version} (${map.tools.scc.status}), CCCC ${map.tools.cccc.version} (${map.tools.cccc.status}).`,
        `Diff coverage: changedFiles=${diff.changedFiles}, representedFiles=${diff.representedFiles}, truncated=${String(diff.truncated)}.`
    ];

    if (diff.excludedFiles > 0) {
        lines.push(
            `Excluded from automatic context: ${diff.excludedFiles} files (${diff.excludedLines} changed lines).`
        );
    }

    return [...lines, ...map.warnings.map((warning) => `Warning: ${plainText(warning)}`)];
}

function shortSha(sha: string): string {
    return sha.slice(0, SHORT_SHA_LENGTH);
}

function repositoryLines(map: ReviewMap): string[] {
    const { base, head, delta } = map.repository;

    return [
        '',
        '### Repository (SCC base -> head -> delta)',
        `- files ${base.files} -> ${head.files} (${signed(delta.files)})`,
        `- lines ${base.lines} -> ${head.lines} (${signed(delta.lines)})`,
        `- code ${base.code} -> ${head.code} (${signed(delta.code)})`,
        `- comments ${base.comments} -> ${head.comments} (${signed(delta.comments)})`,
        `- blanks ${base.blanks} -> ${head.blanks} (${signed(delta.blanks)})`,
        `- bytes ${base.bytes} -> ${head.bytes} (${signed(delta.bytes)})`,
        `- complexity ${base.complexity} -> ${head.complexity} (${signed(delta.complexity)})`,
        `- cognitive ${base.cognitive} -> ${head.cognitive} (${signed(delta.cognitive)})`,
        `- uloc ${base.uloc} -> ${head.uloc} (${signed(delta.uloc)})`,
        `- dryness ${formatDryness(base.dryness)} -> ${formatDryness(head.dryness)} (${formatDryness(delta.dryness)})`,
        ...distributionLines(map)
    ];
}

function distributionLines(map: ReviewMap): string[] {
    const { base, head, delta } = map.distributions.cccc;

    if (base === null || head === null || delta === null) {
        return ['- CCCC distributions unavailable on one side.'];
    }

    return [
        `- functions ${base.functionCount} -> ${head.functionCount} (${signed(delta.functionCount)}); parse errors ${base.parseErrorCount} -> ${head.parseErrorCount} (${signed(delta.parseErrorCount)})`,
        `- cognitive sum ${base.cognitive.sum} -> ${head.cognitive.sum} (${signed(delta.cognitive.sum)}), p90 ${base.cognitive.p90} -> ${head.cognitive.p90}, p95 ${base.cognitive.p95} -> ${head.cognitive.p95}, max ${base.cognitive.max} -> ${head.cognitive.max}`,
        `- cyclomatic sum ${base.cyclomatic.sum} -> ${head.cyclomatic.sum} (${signed(delta.cyclomatic.sum)}), p90 ${base.cyclomatic.p90} -> ${head.cyclomatic.p90}, p95 ${base.cyclomatic.p95} -> ${head.cyclomatic.p95}, max ${base.cyclomatic.max} -> ${head.cyclomatic.max}`
    ];
}

function closingLines(metadata: ProjectionCounters): string[] {
    const omissions: string[] = [];

    if (metadata.omittedFiles > 0) {
        omissions.push(`omittedFiles=${metadata.omittedFiles}`);
    }

    if (metadata.omittedFunctions > 0) {
        omissions.push(`omittedFunctions=${metadata.omittedFunctions}`);
    }

    if (metadata.omittedHotspots > 0) {
        omissions.push(`omittedHotspots=${metadata.omittedHotspots}`);
    }

    if (metadata.omittedFixed > 0) {
        omissions.push(`omittedFixed=${metadata.omittedFixed}`);
    }

    let omissionSuffix = '';

    if (omissions.length > 0) {
        omissionSuffix = `; ${omissions.join(', ')}`;
    }

    return [
        '',
        '### How to use this evidence',
        '- Hotspots rank attention; they never define scope. A `Blocker` finding can exist outside them.',
        '- Prefer BASE->HEAD deltas over absolute values; no metric is a quality score.',
        '- Verify every finding against the real diff and code before reporting it.',
        `- Truncation: changedFiles=${metadata.diff.changedFiles}, representedFiles=${metadata.diff.representedFiles}, truncated=${String(metadata.diff.truncated)}${omissionSuffix}.`
    ];
}

function blockLength(lines: string[]): number {
    let length = 0;

    for (const line of lines) {
        length += line.length + 1;
    }

    return length;
}

export function projectionKindFor(agentId: string): ProjectionKind {
    if (agentId === 'maintainability') {
        return 'maintainability';
    }

    if (agentId === 'correctness') {
        return 'correctness';
    }

    if (agentId === 'performance') {
        return 'performance';
    }

    return 'common';
}
