import type { FileClassification } from '../analysis/classification';
import type { VcsChangedFile } from '../vcs/types';
import { matchFunctions } from './match';
import type { CcccFileMetrics } from './measure-cccc';
import type { SccFileMetrics } from './measure-scc';
import type {
    FileMetricBlock,
    FileMetricDelta,
    ReviewMapFile,
    ReviewMapFunction,
    SccParseStatus,
    SnapshotReviewData
} from './schema';

/* Changed-file projection with SCC metrics, parse status, classification and function matching. Snapshots are indexed once, so large lists stay linear. */

export interface ReviewFilesInput {
    base: SnapshotReviewData;
    head: SnapshotReviewData;
    changedFiles: readonly VcsChangedFile[];
    /* One resolved classification per changed path, owned by the pre-pass. */
    classifications: ReadonlyMap<string, FileClassification>;
}

export interface ReviewFilesResult {
    files: ReviewMapFile[];
    functions: ReviewMapFunction[];
}

export function buildReviewFiles(input: ReviewFilesInput): ReviewFilesResult {
    const snapshots: SnapshotIndexes = {
        base: indexSnapshot(input.base),
        head: indexSnapshot(input.head)
    };

    const files = [...input.changedFiles]
        .toSorted((left, right) => left.path.localeCompare(right.path))
        .map((file) => reviewFile(input, snapshots, file));

    /* One-sided CCCC failure has no comparison; functions are omitted, never fabricated. */
    if (input.base.cccc === null || input.head.cccc === null) {
        return { files, functions: [] };
    }

    return { files, functions: changedFileFunctions(input) };
}

interface SnapshotIndexes {
    base: SnapshotIndex;
    head: SnapshotIndex;
}

interface SnapshotIndex {
    scc: Map<string, SccFileMetrics>;
    cccc: Map<string, CcccFileMetrics>;
}

function indexSnapshot(snapshot: SnapshotReviewData): SnapshotIndex {
    return {
        scc: indexByPath(snapshot.scc.files),
        cccc: indexByPath(snapshot.cccc?.files ?? [])
    };
}

function indexByPath<Entry extends { path: string }>(entries: readonly Entry[]): Map<string, Entry> {
    return new Map(entries.map((entry) => [entry.path, entry]));
}

function reviewFile(input: ReviewFilesInput, snapshots: SnapshotIndexes, file: VcsChangedFile): ReviewMapFile {
    const basePath = file.previousPath ?? file.path;
    const baseScc = snapshots.base.scc.get(basePath) ?? null;
    const headScc = snapshots.head.scc.get(file.path) ?? null;
    const baseCccc = snapshots.base.cccc.get(basePath) ?? null;
    const headCccc = snapshots.head.cccc.get(file.path) ?? null;
    const classification = resolvedClassification(input, file);
    const base = nullable(baseScc, fileBlock);
    const head = nullable(headScc, fileBlock);

    return {
        path: file.path,
        previousPath: file.previousPath,
        status: file.status,
        language: firstString(headScc?.language ?? null, baseScc?.language ?? null),
        classification: classification.classification,
        risk: classification.risk,
        analysis: classification.analysis,
        base,
        head,
        delta: bothOrNull(base, head, fileDelta),
        changeMagnitude: file.additions + file.deletions,
        parse: {
            scc: sccParseStatus({ classification, file, base: baseScc, head: headScc }),
            cccc: ccccParseStatus(classification, { base: baseCccc, head: headCccc })
        }
    };
}

interface SccParseInput {
    classification: FileClassification;
    file: VcsChangedFile;
    base: SccFileMetrics | null;
    head: SccFileMetrics | null;
}

function sccParseStatus(input: SccParseInput): SccParseStatus {
    if (input.classification.analysis.scc === 'not-counted') {
        return 'not-counted';
    }

    let relevant = input.head;

    if (input.file.status === 'removed') {
        relevant = input.base;
    }

    if (relevant === null) {
        return 'unsupported';
    }

    return 'ok';
}

interface CcccParseInput {
    base: CcccFileMetrics | null;
    head: CcccFileMetrics | null;
}

function ccccParseStatus(classification: FileClassification, files: CcccParseInput): ReviewMapFile['parse']['cccc'] {
    if (classification.analysis.cccc === 'unsupported') {
        return 'unsupported';
    }

    const record = firstNonNull(files.head, files.base);

    if (record === null) {
        return 'unsupported';
    }

    if (record.parseErrors.length > 0) {
        return 'parse-error';
    }

    return 'ok';
}

function resolvedClassification(input: ReviewFilesInput, file: VcsChangedFile): FileClassification {
    const classification = input.classifications.get(file.path);

    if (classification === undefined) {
        throw new Error(`No classification resolved for changed file ${JSON.stringify(file.path)}.`);
    }

    return classification;
}

function changedFileFunctions(input: ReviewFilesInput): ReviewMapFunction[] {
    const basePaths = new Set<string>();
    const headPaths = new Set<string>();
    const renames = new Map<string, string>();

    for (const file of input.changedFiles) {
        basePaths.add(file.previousPath ?? file.path);
        headPaths.add(file.path);

        if (file.previousPath !== undefined) {
            renames.set(file.previousPath, file.path);
        }
    }

    return matchFunctions({
        base: (input.base.cccc?.files ?? []).filter((file) => basePaths.has(file.path)),
        head: (input.head.cccc?.files ?? []).filter((file) => headPaths.has(file.path)),
        renames
    });
}

function fileBlock(file: SccFileMetrics): FileMetricBlock {
    return {
        code: file.code,
        comments: file.comments,
        blanks: file.blanks,
        bytes: file.bytes,
        complexity: file.complexity,
        cognitive: file.cognitive,
        ulocWithinFile: file.uloc
    };
}

function fileDelta(base: FileMetricBlock, head: FileMetricBlock): FileMetricDelta {
    return {
        code: head.code - base.code,
        comments: head.comments - base.comments,
        blanks: head.blanks - base.blanks,
        bytes: head.bytes - base.bytes,
        complexity: head.complexity - base.complexity,
        cognitive: head.cognitive - base.cognitive,
        ulocWithinFile: head.ulocWithinFile - base.ulocWithinFile
    };
}

/* Signed growth: BASE->HEAD delta when both exist, `HEAD - 0` for added files, nothing for removals. Hotspots and projections share this rule. */
export function fileGrowthValue(file: ReviewMapFile, field: 'code' | 'complexity'): number {
    if (file.delta !== null) {
        return file.delta[field];
    }

    if (file.status === 'added' && file.head !== null) {
        return file.head[field];
    }

    return 0;
}

/* Null-propagation helpers keep explicit absence semantics without call-site conditionals. */
export function nullable<Input, Output>(value: Input | null, transform: (value: Input) => Output): Output | null {
    if (value === null) {
        return null;
    }

    return transform(value);
}

export function bothOrNull<Input, Output>(
    base: Input | null,
    head: Input | null,
    transform: (base: Input, head: Input) => Output
): Output | null {
    if (base === null || head === null) {
        return null;
    }

    return transform(base, head);
}

function firstNonNull<Value>(left: Value | null, right: Value | null): Value | null {
    if (left !== null) {
        return left;
    }

    return right;
}

function firstString(left: string | null, right: string | null): string | null {
    if (left !== null) {
        return left;
    }

    return right;
}
