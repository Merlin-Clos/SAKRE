import { classifyFile, type FileClassification } from '../analysis/classification';
import { mapWithConcurrency } from '../concurrency';
import type { ClassificationRules } from '../config/schema';
import type { GitTreeSnapshot } from '../analysis/snapshot';
import type { TreeFile } from '../vcs/tree';
import type { VcsChangedFile } from '../vcs/types';
import { readTreePrefix, type TreePrefixResult } from './content-prefix';

/* Every tracked file is classified once; every changed path keeps one entry. Unchanged blobs skip a second read; failed reads fall back to reported path-only classification. */

const MAX_CONCURRENT_PREFIX_READS = 8;

export interface SnapshotClassifications {
    base: ReadonlyMap<string, FileClassification>;
    head: ReadonlyMap<string, FileClassification>;
    changed: ReadonlyMap<string, FileClassification>;
    readFailures: { base: number; head: number };
}

export interface ClassifySnapshotsInput {
    changedFiles: readonly VcsChangedFile[];
    rules: ClassificationRules;
    baseTree: GitTreeSnapshot;
    headTree: GitTreeSnapshot;
    signal?: AbortSignal;
}

export async function classifySnapshots(input: ClassifySnapshotsInput): Promise<SnapshotClassifications> {
    const previousPaths = previousPathsByHeadPath(input.changedFiles);

    const base = await classifySnapshot({
        directory: input.baseTree.directory,
        files: input.baseTree.listing.files,
        previousPaths: new Map(),
        rules: input.rules,
        signal: input.signal
    });

    const head = await classifySnapshot({
        directory: input.headTree.directory,
        files: input.headTree.listing.files,
        previousPaths,
        /* An unchanged blob has identical content, so only changed files pay a second prefix read. */
        reusable: reusableClassifications(input.baseTree.listing.files, base),
        rules: input.rules,
        signal: input.signal
    });

    return {
        base: base.classifications,
        head: head.classifications,
        changed: changedClassifications({
            changedFiles: input.changedFiles,
            base: base.classifications,
            head: head.classifications,
            rules: input.rules
        }),
        readFailures: { base: base.failedPaths.size, head: head.failedPaths.size }
    };
}

export function classificationWarnings(classifications: SnapshotClassifications): string[] {
    const warnings: string[] = [];
    appendReadFailureWarning(warnings, classifications.readFailures.base, 'BASE');
    appendReadFailureWarning(warnings, classifications.readFailures.head, 'HEAD');

    return warnings;
}

interface SnapshotClassificationInput {
    directory: string;
    files: readonly TreeFile[];
    previousPaths: ReadonlyMap<string, string>;
    /* Stable-path entries already classified for BASE, keyed by path. */
    reusable?: ReadonlyMap<string, ReusableClassification>;
    rules: ClassificationRules;
    signal?: AbortSignal;
}

interface ReusableClassification {
    blobSha: string;
    classification: FileClassification;
}

interface SnapshotClassificationResult {
    classifications: Map<string, FileClassification>;
    /* Paths whose bounded prefix read failed: reported, never reused silently. */
    failedPaths: Set<string>;
}

async function classifySnapshot(input: SnapshotClassificationInput): Promise<SnapshotClassificationResult> {
    const state = { failedPaths: new Set<string>() };

    const entries = await mapWithConcurrency(input.files, MAX_CONCURRENT_PREFIX_READS, async (file) => {
        const reused = reusableFor(input, file);

        if (reused !== undefined) {
            return [file.path, reused] as const;
        }

        const prefix = await readTreePrefix(input.directory, file.path);

        if (prefix.kind === 'failed') {
            state.failedPaths.add(file.path);
        }

        const classification = classifyFile({
            path: file.path,
            previousPath: input.previousPaths.get(file.path),
            content: prefixContent(prefix),
            rules: input.rules
        });

        return [file.path, classification] as const;
    });

    return { classifications: new Map(entries), failedPaths: state.failedPaths };
}

/* A stable path with matching blob SHA reuses the BASE classification; renames and failed BASE reads are read again. */
function reusableFor(input: SnapshotClassificationInput, file: TreeFile): FileClassification | undefined {
    if (input.reusable === undefined || input.previousPaths.has(file.path)) {
        return undefined;
    }

    const base = input.reusable.get(file.path);

    if (base === undefined || base.blobSha !== file.blobSha) {
        return undefined;
    }

    return base.classification;
}

function reusableClassifications(
    files: readonly TreeFile[],
    base: SnapshotClassificationResult
): Map<string, ReusableClassification> {
    const reusable = new Map<string, ReusableClassification>();

    for (const file of files) {
        if (!base.failedPaths.has(file.path)) {
            const classification = base.classifications.get(file.path);

            if (classification !== undefined) {
                reusable.set(file.path, { blobSha: file.blobSha, classification });
            }
        }
    }

    return reusable;
}

function prefixContent(prefix: TreePrefixResult): string | undefined {
    if (prefix.kind !== 'content') {
        return undefined;
    }

    const { content } = prefix;

    return content;
}

function previousPathsByHeadPath(changedFiles: readonly VcsChangedFile[]): Map<string, string> {
    const previousPaths = new Map<string, string>();

    for (const file of changedFiles) {
        if (file.previousPath !== undefined) {
            previousPaths.set(file.path, file.previousPath);
        }
    }

    return previousPaths;
}

interface ChangedClassificationInput {
    changedFiles: readonly VcsChangedFile[];
    base: ReadonlyMap<string, FileClassification>;
    head: ReadonlyMap<string, FileClassification>;
    rules: ClassificationRules;
}

/* Every changed path gets one classification: HEAD entry, BASE entry for removals, canonical classifier for gitlinks. */
function changedClassifications(input: ChangedClassificationInput): Map<string, FileClassification> {
    const classifications = new Map<string, FileClassification>();

    for (const file of input.changedFiles) {
        classifications.set(file.path, classificationFor(file, input));
    }

    return classifications;
}

function classificationFor(file: VcsChangedFile, input: ChangedClassificationInput): FileClassification {
    const fromTrees = classificationFromTrees(file, input);

    if (fromTrees !== undefined) {
        return fromTrees;
    }

    return classifyFile({ path: file.path, previousPath: file.previousPath, rules: input.rules });
}

function classificationFromTrees(
    file: VcsChangedFile,
    input: ChangedClassificationInput
): FileClassification | undefined {
    if (file.status === 'removed') {
        return input.base.get(file.path);
    }

    return input.head.get(file.path) ?? input.base.get(file.path);
}

function appendReadFailureWarning(warnings: string[], failed: number, side: string): void {
    if (failed > 0) {
        warnings.push(
            `${failed} ${side} file prefix(es) could not be read for generated-marker detection; classified by path only.`
        );
    }
}
