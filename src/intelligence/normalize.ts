import type { CcccSnapshot } from './measure-cccc';
import { roundTo, type SccSnapshot } from './measure-scc';
import { buildHotspots } from './hotspots';
import { bothOrNull, buildReviewFiles, nullable, type ReviewFilesInput } from './review-files';
import type { VcsChangedFile } from '../vcs/types';
import {
    type CcccDistributionBlock,
    type CcccDistributionDelta,
    type LanguageMetrics,
    type RepositoryDelta,
    type RepositoryMetrics,
    REVIEW_MAP_SCHEMA_VERSION,
    type ReviewMap,
    type ReviewMapChangedCounts,
    type ReviewMapRevisions,
    type ReviewMapTools,
    type SnapshotReviewData
} from './schema';

/* Deterministic ReviewMap assembly from snapshots plus file classification. No wall-clock value or scheduler ordering is part of the result. */

const DRYNESS_PRECISION = 4;

export interface BuildReviewMapInput extends ReviewFilesInput {
    revisions: ReviewMapRevisions;
    tools: ReviewMapTools;
    warnings?: string[];
}

export function buildReviewMap(input: BuildReviewMapInput): ReviewMap {
    const baseRepository = repositoryMetrics(input.base.scc);
    const headRepository = repositoryMetrics(input.head.scc);
    const languages = buildLanguages(input.base.scc, input.head.scc);
    const { files, functions } = buildReviewFiles(input);
    const { hotspots, omissions } = buildHotspots({ files, functions, languages });
    let ccccStatus = input.tools.cccc.status;

    if (input.base.cccc === null || input.head.cccc === null) {
        ccccStatus = 'unavailable';
    }

    return {
        schemaVersion: REVIEW_MAP_SCHEMA_VERSION,
        revisions: input.revisions,
        tools: {
            ...input.tools,
            /* A one-sided CCCC failure is unavailability; the caller cannot publish `ok` without a comparison. */
            cccc: { ...input.tools.cccc, status: ccccStatus }
        },
        coverage: buildCoverage(input.base, input.head),
        repository: {
            base: baseRepository,
            head: headRepository,
            delta: repositoryDelta(baseRepository, headRepository),
            changed: changedCounts(input.changedFiles)
        },
        languages,
        files,
        functions,
        distributions: { cccc: distributionBlock(input.base.cccc, input.head.cccc) },
        hotspots,
        hotspotOmissions: omissions,
        warnings: collectWarnings(input)
    };
}

function repositoryMetrics(scc: SccSnapshot): RepositoryMetrics {
    return languageMetrics(scc.totals);
}

function languageMetrics(metrics: RepositoryMetrics): RepositoryMetrics {
    return { ...metrics };
}

function repositoryDelta(base: RepositoryMetrics, head: RepositoryMetrics): RepositoryDelta {
    return {
        files: head.files - base.files,
        lines: head.lines - base.lines,
        code: head.code - base.code,
        comments: head.comments - base.comments,
        blanks: head.blanks - base.blanks,
        bytes: head.bytes - base.bytes,
        complexity: head.complexity - base.complexity,
        cognitive: head.cognitive - base.cognitive,
        uloc: head.uloc - base.uloc,
        dryness: bothOrNull(base.dryness, head.dryness, (left, right) => roundTo(right - left, DRYNESS_PRECISION))
    };
}

function buildLanguages(base: SccSnapshot, head: SccSnapshot): LanguageMetrics[] {
    const names = new Set<string>();

    for (const language of base.languages) {
        names.add(language.name);
    }

    for (const language of head.languages) {
        names.add(language.name);
    }

    return [...names]
        .toSorted((left, right) => left.localeCompare(right))
        .map((name) => {
            const baseMetrics = findLanguage(base, name);
            const headMetrics = findLanguage(head, name);

            return {
                name,
                base: nullable(baseMetrics, languageMetrics),
                head: nullable(headMetrics, languageMetrics),
                delta: bothOrNull(baseMetrics, headMetrics, repositoryDelta)
            };
        });
}

function findLanguage(scc: SccSnapshot, name: string): RepositoryMetrics | null {
    return scc.languages.find((candidate) => candidate.name === name) ?? null;
}

function changedCounts(changedFiles: readonly VcsChangedFile[]): ReviewMapChangedCounts {
    const counts: ReviewMapChangedCounts = { added: 0, modified: 0, removed: 0, renamed: 0 };

    for (const file of changedFiles) {
        counts[file.status] += 1;
    }

    return counts;
}

function buildCoverage(base: SnapshotReviewData, head: SnapshotReviewData): ReviewMap['coverage'] {
    return {
        scc: {
            languages: unionSorted(
                base.scc.languages.map((language) => language.name),
                head.scc.languages.map((language) => language.name)
            ),
            notCounted: unionSorted(base.notCounted, head.notCounted),
            unmeasurable: unionSorted(base.unmeasurable, head.unmeasurable),
            unsupported: unionSorted(unsupportedFiles(base), unsupportedFiles(head))
        },
        cccc: {
            /* CCCC reports paths and counters, not language names; the unsupported list is the coverage signal. */
            languages: [],
            unsupported: unionSorted(
                base.cccc?.unsupported ?? [],
                head.cccc?.unsupported ?? [],
                base.notCounted,
                head.notCounted
            ),
            parseErrorFiles: unionSorted(
                base.cccc?.summary.parseErrorFiles ?? [],
                head.cccc?.summary.parseErrorFiles ?? []
            )
        }
    };
}

function unsupportedFiles(snapshot: SnapshotReviewData): string[] {
    const known = new Set(snapshot.scc.files.map((file) => file.path));

    return snapshot.requested.filter((file) => !known.has(file));
}

function unionSorted(...lists: readonly string[][]): string[] {
    const union = new Set<string>();

    for (const list of lists) {
        for (const entry of list) {
            union.add(entry);
        }
    }

    return [...union].toSorted((left, right) => left.localeCompare(right));
}

function distributionBlock(base: CcccSnapshot | null, head: CcccSnapshot | null): ReviewMap['distributions']['cccc'] {
    const baseBlock = nullable(base, summaryBlock);
    const headBlock = nullable(head, summaryBlock);

    return { base: baseBlock, head: headBlock, delta: bothOrNull(baseBlock, headBlock, distributionDelta) };
}

function summaryBlock(cccc: CcccSnapshot): CcccDistributionBlock {
    return {
        functionCount: cccc.summary.functionCount,
        parseErrorCount: cccc.summary.parseErrorCount,
        cognitive: { ...cccc.summary.cognitive },
        cyclomatic: { ...cccc.summary.cyclomatic }
    };
}

function distributionDelta(base: CcccDistributionBlock, head: CcccDistributionBlock): CcccDistributionDelta {
    return {
        functionCount: head.functionCount - base.functionCount,
        parseErrorCount: head.parseErrorCount - base.parseErrorCount,
        cognitive: distributionDiff(base.cognitive, head.cognitive),
        cyclomatic: distributionDiff(base.cyclomatic, head.cyclomatic)
    };
}

function distributionDiff(
    base: CcccDistributionBlock['cognitive'],
    head: CcccDistributionBlock['cognitive']
): CcccDistributionBlock['cognitive'] {
    return {
        sum: head.sum - base.sum,
        max: head.max - base.max,
        median: head.median - base.median,
        p90: head.p90 - base.p90,
        p95: head.p95 - base.p95
    };
}

function collectWarnings(input: BuildReviewMapInput): string[] {
    const warnings = new Set<string>(input.warnings);
    appendWarnings(warnings, input.base, 'BASE');
    appendWarnings(warnings, input.head, 'HEAD');

    return [...warnings].toSorted((left, right) => left.localeCompare(right));
}

function appendWarnings(warnings: Set<string>, snapshot: SnapshotReviewData, side: string): void {
    if (snapshot.cccc === null) {
        warnings.add(`CCCC ${side} measurement unavailable.`);
    }

    for (const warning of snapshot.warnings ?? []) {
        warnings.add(warning);
    }
}
