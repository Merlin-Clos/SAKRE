import { fileGrowthValue } from './review-files';
import {
    DEFAULT_HOTSPOT_LIMIT,
    type Hotspot,
    type HotspotName,
    hotspotNames,
    type LanguageMetrics,
    type ReviewMapFile,
    type ReviewMapFunction,
    type ReviewMapHotspotOmissions,
    type ReviewMapHotspots
} from './schema';

/* Ranked routing evidence only; no threshold is a finding. A fixed cap with omission counters bounds the map; added files rank as HEAD - 0 and removed files never rank. */

export interface HotspotInput {
    files: readonly ReviewMapFile[];
    functions: readonly ReviewMapFunction[];
    languages: readonly LanguageMetrics[];
    limit?: number;
}

export interface HotspotResult {
    hotspots: ReviewMapHotspots;
    omissions: ReviewMapHotspotOmissions;
}

export function buildHotspots(input: HotspotInput): HotspotResult {
    const limit = input.limit ?? DEFAULT_HOTSPOT_LIMIT;
    const ranked = buildRanked(input);
    const hotspots = buildRecord((name) => ranked[name].slice(0, limit));
    const omitted = buildRecord((name) => Math.max(0, ranked[name].length - limit));

    return { hotspots, omissions: { omitted } };
}

/* Rankers derive from the canonical name list, so a new hotspot name fails to compile without one. */
const RANKERS: Record<HotspotName, (input: HotspotInput) => Hotspot[]> = {
    largestCodeGrowth: (input) => rankFiles(input.files, (file) => fileGrowthValue(file, 'code')),
    largestFileComplexityGrowth: (input) => rankFiles(input.files, (file) => fileGrowthValue(file, 'complexity')),
    largestCognitiveGrowth: (input) => rankFunctions(input.functions, 'cognitive'),
    largestCyclomaticGrowth: (input) => rankFunctions(input.functions, 'cyclomatic'),
    drynessRegression: (input) => rankDryness(input.languages),
    newFunctions: (input) => rankNewFunctions(input.functions),
    parseFailures: (input) => rankParseFailures(input.files)
};

function buildRanked(input: HotspotInput): ReviewMapHotspots {
    return buildRecord((name) => RANKERS[name](input));
}

/* SAFETY: `hotspotNames` is the exhaustive key set of the record, so the
   entry-constructed object satisfies the type; the assertion keeps one derived
   key list instead of a second hand-written one. */
function buildRecord<Value>(build: (name: HotspotName) => Value): Record<HotspotName, Value> {
    // eslint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: exhaustive hotspotNames key set
    return Object.fromEntries(hotspotNames.map((name) => [name, build(name)])) as Record<HotspotName, Value>;
}

function rankFiles(files: readonly ReviewMapFile[], valueOf: (file: ReviewMapFile) => number): Hotspot[] {
    return files
        .flatMap((file): Hotspot[] => {
            const value = valueOf(file);

            if (value <= 0) {
                return [];
            }

            return [{ kind: 'file', path: file.path, value }];
        })
        .toSorted(compareHotspots);
}

function rankFunctions(functions: readonly ReviewMapFunction[], field: 'cognitive' | 'cyclomatic'): Hotspot[] {
    return functions
        .filter(
            (
                fn
            ): fn is ReviewMapFunction & {
                delta: NonNullable<ReviewMapFunction['delta']>;
                head: NonNullable<ReviewMapFunction['head']>;
            } => fn.delta !== null && fn.head !== null
        )
        .flatMap((fn): Hotspot[] => {
            const hotspot: Hotspot = {
                kind: 'function',
                path: fn.path,
                name: fn.name,
                line: fn.head.line,
                value: fn.delta[field]
            };

            if (hotspot.value <= 0) {
                return [];
            }

            return [hotspot];
        })
        .toSorted(compareHotspots);
}

function rankDryness(languages: readonly LanguageMetrics[]): Hotspot[] {
    return languages
        .flatMap((language): Hotspot[] => {
            const regression = drynessRegression(language);

            if (regression === null) {
                return [];
            }

            return [{ kind: 'language', path: language.name, value: regression }];
        })
        .toSorted(compareHotspots);
}

function drynessRegression(language: LanguageMetrics): number | null {
    const base = language.base?.dryness;
    const head = language.head?.dryness;

    if (base === undefined || head === undefined || base === null || head === null) {
        return null;
    }

    const regression = base - head;

    if (regression > 0) {
        return regression;
    }

    return null;
}

function rankNewFunctions(functions: readonly ReviewMapFunction[]): Hotspot[] {
    const ranked: { hotspot: Hotspot; cyclomatic: number; name: string }[] = [];

    for (const fn of functions) {
        if (fn.match === 'added' && fn.head !== null) {
            ranked.push({
                hotspot: {
                    kind: 'function',
                    path: fn.path,
                    name: fn.name,
                    line: fn.head.line,
                    value: fn.head.cognitive
                },
                cyclomatic: fn.head.cyclomatic,
                name: fn.name
            });
        }
    }

    /* Cognitive first, cyclomatic only as the tiebreaker; no composite score. */
    ranked.sort(
        (left, right) =>
            right.hotspot.value - left.hotspot.value ||
            right.cyclomatic - left.cyclomatic ||
            left.hotspot.path.localeCompare(right.hotspot.path) ||
            left.name.localeCompare(right.name)
    );

    return ranked.map((entry) => entry.hotspot);
}

/* One entry per CCCC parse-error file; the summary carries the count, this list carries the paths. */
function rankParseFailures(files: readonly ReviewMapFile[]): Hotspot[] {
    return files
        .flatMap((file): Hotspot[] => {
            if (file.parse.cccc !== 'parse-error') {
                return [];
            }

            return [{ kind: 'file', path: file.path, value: 1 }];
        })
        .toSorted(compareHotspots);
}

function compareHotspots(left: Hotspot, right: Hotspot): number {
    return (
        right.value - left.value ||
        left.path.localeCompare(right.path) ||
        (left.line ?? 0) - (right.line ?? 0) ||
        (left.name ?? '').localeCompare(right.name ?? '')
    );
}
