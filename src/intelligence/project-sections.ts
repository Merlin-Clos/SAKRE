import { plainText, signed } from './format';
import { fileGrowthValue } from './review-files';
import type { Hotspot, ReviewMap, ReviewMapFile, ReviewMapFunction } from './schema';

/* Projection sections with hard-capped file and function lists; budget truncation follows the layout. Every line maps to a counted entry so omission counters stay exact. */

const MAX_FILES = 200;

const MAX_FUNCTIONS = 200;

const MAX_STRUCTURAL_PER_LIST = 5;

export interface SectionContent {
    lines: string[];
    omitted: number;
}

export interface StructuralContent {
    lines: string[];
    /* Hotspot entries not shown because of the per-list display cap. */
    omitted: number;
    /* Hotspot lines actually rendered; zero means the section is a placeholder. */
    entries: number;
}

export function fileSection(
    map: ReviewMap,
    kind: 'common' | 'maintainability' | 'correctness' | 'performance',
    excludedPaths?: ReadonlySet<string>
): SectionContent {
    const ranked = rankedFiles(map, kind, excludedPaths);
    const files = ranked.slice(0, MAX_FILES);

    return {
        lines: files.map((file) => fileLine(file, kind)),
        omitted: Math.max(0, ranked.length - files.length)
    };
}

/* Common and maintainability show every visible file; correctness and performance show the largest movers. Added files rank with HEAD metrics. Context-excluded files never appear individually. */
function rankedFiles(map: ReviewMap, kind: string, excludedPaths?: ReadonlySet<string>): ReviewMapFile[] {
    let visible = map.files;

    if (excludedPaths !== undefined) {
        visible = map.files.filter((file) => !isExcludedPath(file, excludedPaths));
    }

    if (kind === 'common' || kind === 'maintainability') {
        return visible;
    }

    return [...visible]
        .filter((file) => growthOf(file) > 0)
        .toSorted((left, right) => growthOf(right) - growthOf(left) || left.path.localeCompare(right.path));
}

function isExcludedPath(file: ReviewMapFile, excludedPaths: ReadonlySet<string>): boolean {
    if (excludedPaths.has(file.path)) {
        return true;
    }

    return file.previousPath !== undefined && excludedPaths.has(file.previousPath);
}

/* Absolute movement across both metrics, from the single growth rule. */
function growthOf(file: ReviewMapFile): number {
    return Math.abs(fileGrowthValue(file, 'code')) + Math.abs(fileGrowthValue(file, 'complexity'));
}

function fileLine(file: ReviewMapFile, kind: string): string {
    let noise = '';

    if (file.risk.noise) {
        noise = ', noise';
    }

    const scope = `${file.status} ${plainText(file.path)} [${plainText(file.language ?? 'unknown')}, ${file.classification}${noise}] +${file.changeMagnitude}`;

    if (kind === 'common') {
        return `- ${scope} | ${blockDeltaLine(file)}`;
    }

    return `- ${scope} | ${blockDeltaLine(file)} | parse scc=${file.parse.scc} cccc=${file.parse.cccc}`;
}

function blockDeltaLine(file: ReviewMapFile): string {
    if (file.base === null || file.head === null || file.delta === null) {
        return singleSideBlockLine(file);
    }

    return `code ${file.base.code}->${file.head.code} (${signed(file.delta.code)}), complexity ${file.base.complexity}->${file.head.complexity} (${signed(file.delta.complexity)}), cognitive ${file.base.cognitive}->${file.head.cognitive} (${signed(file.delta.cognitive)}), uloc ${file.base.ulocWithinFile}->${file.head.ulocWithinFile} (${signed(file.delta.ulocWithinFile)})`;
}

function singleSideBlockLine(file: ReviewMapFile): string {
    const block = file.head ?? file.base;

    if (block === null) {
        return 'no metrics';
    }

    return `code ${block.code}, complexity ${block.complexity}, cognitive ${block.cognitive}, uloc ${block.ulocWithinFile}`;
}

export function structuralSection(map: ReviewMap): StructuralContent {
    const lists: { label: string; hotspots: Hotspot[] }[] = [
        { label: 'code growth', hotspots: map.hotspots.largestCodeGrowth },
        { label: 'file complexity growth', hotspots: map.hotspots.largestFileComplexityGrowth },
        { label: 'function cognitive growth', hotspots: map.hotspots.largestCognitiveGrowth },
        { label: 'function cyclomatic growth', hotspots: map.hotspots.largestCyclomaticGrowth },
        { label: 'dryness regression', hotspots: map.hotspots.drynessRegression },
        { label: 'new functions', hotspots: map.hotspots.newFunctions },
        { label: 'parse failures', hotspots: map.hotspots.parseFailures }
    ];

    const lines = lists.flatMap(({ label, hotspots }) => hotspotLines(label, hotspots));

    if (lines.length === 0) {
        return { lines: ['- None in the measured snapshots.'], omitted: 0, entries: 0 };
    }

    const omitted = lists.reduce((total, { hotspots }) => total + displayOmissions(hotspots), 0);

    return { lines, omitted, entries: lines.length };
}

function displayOmissions(hotspots: Hotspot[]): number {
    return Math.max(0, hotspots.length - MAX_STRUCTURAL_PER_LIST);
}

function hotspotLines(label: string, hotspots: Hotspot[]): string[] {
    return hotspots
        .slice(0, MAX_STRUCTURAL_PER_LIST)
        .map((hotspot) => `- ${label}: ${hotspotPath(hotspot)} (${String(hotspot.value)})`);
}

function hotspotPath(hotspot: Hotspot): string {
    if (hotspot.name !== undefined && hotspot.line !== undefined) {
        return `${plainText(hotspot.path)}:${hotspot.line} ${plainText(hotspot.name)}`;
    }

    if (hotspot.name !== undefined) {
        return `${plainText(hotspot.path)} ${plainText(hotspot.name)}`;
    }

    return plainText(hotspot.path);
}

export function functionSection(
    map: ReviewMap,
    kind: 'common' | 'maintainability' | 'correctness' | 'performance'
): SectionContent {
    if (kind === 'common') {
        return { lines: [], omitted: 0 };
    }

    const ranked = rankedFunctions(map, kind);
    const shown = ranked.slice(0, MAX_FUNCTIONS);

    return {
        lines: shown.map((fn) => functionLine(fn)),
        omitted: Math.max(0, ranked.length - shown.length)
    };
}

function rankedFunctions(map: ReviewMap, kind: string): ReviewMapFunction[] {
    if (kind === 'maintainability') {
        return map.functions;
    }

    if (kind === 'correctness') {
        return map.functions.filter((fn) => fn.match === 'added' || positiveDelta(fn) || fn.match === 'ambiguous');
    }

    return [...map.functions]
        .filter((fn) => fn.head !== null)
        .toSorted(
            (left, right) =>
                (right.head?.cognitive ?? 0) - (left.head?.cognitive ?? 0) ||
                (right.head?.cyclomatic ?? 0) - (left.head?.cyclomatic ?? 0) ||
                left.path.localeCompare(right.path)
        );
}

function positiveDelta(fn: ReviewMapFunction): boolean {
    if (fn.delta === null) {
        return false;
    }

    return fn.delta.cognitive > 0 || fn.delta.cyclomatic > 0;
}

function functionLine(fn: ReviewMapFunction): string {
    let chain = '';

    if (fn.parentChain.length > 0) {
        chain = `${fn.parentChain.map((parent) => plainText(parent)).join('.')}.`;
    }

    const identity = `${plainText(fn.path)} ${chain}${plainText(fn.name)} (${plainText(fn.kind)})`;

    if (fn.match === 'matched' && fn.base !== null && fn.head !== null && fn.delta !== null) {
        return `- ${identity} matched: cognitive ${fn.base.cognitive}->${fn.head.cognitive} (${signed(fn.delta.cognitive)}), cyclomatic ${fn.base.cyclomatic}->${fn.head.cyclomatic} (${signed(fn.delta.cyclomatic)})`;
    }

    if (fn.match === 'added' && fn.head !== null) {
        return `- ${identity} added at line ${fn.head.line}: cognitive ${fn.head.cognitive}, cyclomatic ${fn.head.cyclomatic}`;
    }

    if (fn.match === 'deleted' && fn.base !== null) {
        return `- ${identity} deleted (was at line ${fn.base.line}): cognitive ${fn.base.cognitive}, cyclomatic ${fn.base.cyclomatic}`;
    }

    return `- ${identity} ambiguous: duplicate key on one side, not matched`;
}
