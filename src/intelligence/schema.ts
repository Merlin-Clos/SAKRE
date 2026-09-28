import type { CcccEligibility, FileClass, SccEligibility } from '../analysis/classification';
import type { CcccDistribution, CcccSnapshot } from './measure-cccc';
import type { SccSnapshot } from './measure-scc';

/* Versioned code-intelligence object built before the first provider call; routing evidence only, never a finding or score. */
export const REVIEW_MAP_SCHEMA_VERSION = 1;

export type ReviewMapSchemaVersion = typeof REVIEW_MAP_SCHEMA_VERSION;

export interface ReviewMapRevisions {
    baseSha: string;
    headSha: string;
    /* Present only when it differs from baseSha. */
    mergeBaseSha?: string;
}

export type ToolStatus = 'ok' | 'unavailable';

export interface ReviewMapTools {
    scc: { version: string; status: ToolStatus };
    cccc: { version: string; status: ToolStatus };
}

export interface SccCoverage {
    languages: string[];
    notCounted: string[];
    /* Counted paths the analysis tree cannot materialize; recorded per snapshot instead of failing the run. */
    unmeasurable: string[];
    unsupported: string[];
}

export interface CcccCoverage {
    languages: string[];
    unsupported: string[];
    parseErrorFiles: string[];
}

export interface ReviewMapCoverage {
    scc: SccCoverage;
    cccc: CcccCoverage;
}

export interface RepositoryMetrics {
    files: number;
    lines: number;
    code: number;
    comments: number;
    blanks: number;
    bytes: number;
    complexity: number;
    cognitive: number;
    uloc: number;
    dryness: number | null;
}

/* Delta shares the absolute shape; one definition keeps them from drifting. */
export type RepositoryDelta = RepositoryMetrics;

export interface ReviewMapChangedCounts {
    added: number;
    modified: number;
    removed: number;
    renamed: number;
}

export interface LanguageMetrics {
    name: string;
    /* Null when absent from a snapshot; absence is stated, not faked with zeros. */
    base: RepositoryMetrics | null;
    head: RepositoryMetrics | null;
    delta: RepositoryDelta | null;
}

export interface FileMetricBlock {
    code: number;
    comments: number;
    blanks: number;
    bytes: number;
    complexity: number;
    cognitive: number;
    ulocWithinFile: number;
}

export type FileMetricDelta = FileMetricBlock;

export type SccParseStatus = 'ok' | 'not-counted' | 'unsupported';

export type CcccParseStatus = 'ok' | 'unsupported' | 'parse-error';

export type ReviewFileStatus = 'added' | 'modified' | 'removed' | 'renamed';

export interface FileParseStatus {
    scc: SccParseStatus;
    cccc: CcccParseStatus;
}

export interface ReviewMapFile {
    path: string;
    previousPath?: string;
    status: ReviewFileStatus;
    language: string | null;
    classification: FileClass;
    risk: { noise: boolean };
    analysis: { scc: SccEligibility; cccc: CcccEligibility };
    base: FileMetricBlock | null;
    head: FileMetricBlock | null;
    delta: FileMetricDelta | null;
    /* Additions plus deletions from the canonical Git diff. */
    changeMagnitude: number;
    parse: FileParseStatus;
}

export interface FunctionMetricBlock {
    line: number;
    cognitive: number;
    cyclomatic: number;
}

export interface FunctionMetricDelta {
    cognitive: number;
    cyclomatic: number;
}

export type FunctionMatch = 'matched' | 'added' | 'deleted' | 'ambiguous';

export interface ReviewMapFunction {
    path: string;
    name: string;
    kind: string;
    parentChain: string[];
    base: FunctionMetricBlock | null;
    head: FunctionMetricBlock | null;
    delta: FunctionMetricDelta | null;
    match: FunctionMatch;
}

export interface CcccDistributionBlock {
    functionCount: number;
    parseErrorCount: number;
    cognitive: CcccDistribution;
    cyclomatic: CcccDistribution;
}

export type CcccDistributionDelta = CcccDistributionBlock;

export interface ReviewMapDistributions {
    cccc: {
        base: CcccDistributionBlock | null;
        head: CcccDistributionBlock | null;
        delta: CcccDistributionDelta | null;
    };
}

export const hotspotNames = [
    'largestCodeGrowth',
    'largestFileComplexityGrowth',
    'largestCognitiveGrowth',
    'largestCyclomaticGrowth',
    'drynessRegression',
    'newFunctions',
    'parseFailures'
] as const;

export type HotspotName = (typeof hotspotNames)[number];

export type HotspotKind = 'file' | 'function' | 'language';

export interface Hotspot {
    kind: HotspotKind;
    /* File path, or language name for dryness regressions. */
    path: string;
    name?: string;
    line?: number;
    value: number;
}

export type ReviewMapHotspots = Record<HotspotName, Hotspot[]>;

export interface ReviewMapHotspotOmissions {
    omitted: Record<HotspotName, number>;
}

export interface ReviewMap {
    schemaVersion: ReviewMapSchemaVersion;
    revisions: ReviewMapRevisions;
    tools: ReviewMapTools;
    coverage: ReviewMapCoverage;
    repository: {
        base: RepositoryMetrics;
        head: RepositoryMetrics;
        delta: RepositoryDelta;
        changed: ReviewMapChangedCounts;
    };
    languages: LanguageMetrics[];
    files: ReviewMapFile[];
    functions: ReviewMapFunction[];
    distributions: ReviewMapDistributions;
    hotspots: ReviewMapHotspots;
    hotspotOmissions: ReviewMapHotspotOmissions;
    warnings: string[];
}

export const DEFAULT_HOTSPOT_LIMIT = 10;

export interface SnapshotReviewData {
    /* SCC is fail-closed, so snapshots always carry its metrics. CCCC stays nullable because its failure is an explicit degradation. */
    scc: SccSnapshot;
    cccc: CcccSnapshot | null;
    /* Canonical file list given to both measurement tools. */
    requested: string[];
    /* Files the classifier excluded from the tool run. */
    notCounted: string[];
    /* Counted files the analysis tree could not materialize. */
    unmeasurable: string[];
    warnings?: string[];
}

/* Boundary check where the map enters a parsed contract; versioned anchors are validated, full shape stays owned here. */
// eslint-disable-next-line anti-slop/no-unknown-parameters -- zod custom predicate validates external maps at this boundary
export function isReviewMapBoundary(value: unknown): boolean {
    // eslint-disable-next-line anti-slop/no-runtime-typeof -- object guard at the map entry boundary
    if (typeof value !== 'object' || value === null) {
        return false;
    }

    // SAFETY: null was excluded above, so the object can be viewed through the all-optional partial type.
    const map = value as Partial<ReviewMap>;

    return (
        map.schemaVersion === REVIEW_MAP_SCHEMA_VERSION &&
        // eslint-disable-next-line anti-slop/no-runtime-typeof -- narrows the decoded revision anchors
        typeof map.revisions?.baseSha === 'string' &&
        // eslint-disable-next-line anti-slop/no-runtime-typeof -- narrows the decoded revision anchors
        typeof map.revisions.headSha === 'string' &&
        Array.isArray(map.files) &&
        Array.isArray(map.warnings)
    );
}
