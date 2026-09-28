import type { FileClassification } from '../analysis/classification';
import { CancelledError } from '../analysis/cancellation';
import { describeError } from '../errors';
import { type GitTreeSnapshot, materializeGitTree, resolveMergeBaseSha } from '../analysis/snapshot';
import { closeAfterFailure } from '../analysis/temp-tree';
import type { ClassificationRules } from '../config/schema';
import type { VcsChangedFile } from '../vcs/types';
import { type AnalysisTree, createAnalysisTree } from './analysis-tree';
import { classificationWarnings, classifySnapshots, type SnapshotClassifications } from './classify-snapshots';
import { type CcccSnapshot, measureCccc } from './measure-cccc';
import { measureScc, type SccSnapshot } from './measure-scc';
import { buildReviewMap } from './normalize';
import { planSnapshotFiles, type SnapshotFileLists } from './snapshot-files';
import type { ReviewMap, SnapshotReviewData, ToolStatus } from './schema';

/* One SCC and one CCCC run per snapshot from exact commits, fed by one classification into a filtered tree. SCC stays fail-closed; one-sided CCCC failure degrades without fabricated deltas. */

export interface IntelligencePrePassInput {
    /* Directory for `git archive`; measured trees are exact BASE and HEAD commits, not this checkout. */
    worktreeDir: string;
    baseSha: string;
    headSha: string;
    changedFiles: readonly VcsChangedFile[];
    classification: ClassificationRules;
    sccBinaryPath: string;
    ccccBinaryPath: string;
    sccVersion: string;
    ccccVersion: string;
    signal?: AbortSignal;
}

export interface IntelligenceOutput {
    map: ReviewMap;
    baseMetrics: { recognizedFilesCount: number; physicalLines: number };
}

/* Pre-pass input; binaries come from the entrypoint, classification from resolved configuration. */
export interface IntelligenceRunOptions {
    worktreeDir: string;
    baseSha: string;
    headSha: string;
    changedFiles: readonly VcsChangedFile[];
    classification: ClassificationRules;
    signal?: AbortSignal;
}

/* Pre-pass classifications (content-aware) drive risk volume. */
export function classificationsOfReviewMap(map: ReviewMap): ReadonlyMap<string, FileClassification> {
    return new Map(
        map.files.map((file) => [
            file.path,
            { classification: file.classification, risk: file.risk, analysis: file.analysis }
        ])
    );
}

export async function runIntelligencePrePass(input: IntelligencePrePassInput): Promise<IntelligenceOutput> {
    const baseTree = await materializeGitTree({
        worktreeDir: input.worktreeDir,
        sha: input.baseSha,
        signal: input.signal
    });

    let headTree: GitTreeSnapshot | undefined = undefined;

    try {
        headTree = await materializeGitTree({
            worktreeDir: input.worktreeDir,
            sha: input.headSha,
            signal: input.signal
        });

        return await measureAndAssemble(input, baseTree, headTree);
    } finally {
        await headTree?.close();
        await baseTree.close();
    }
}

async function measureAndAssemble(
    input: IntelligencePrePassInput,
    baseTree: GitTreeSnapshot,
    headTree: GitTreeSnapshot
): Promise<IntelligenceOutput> {
    const classifications = await classifySnapshots({
        changedFiles: input.changedFiles,
        rules: input.classification,
        baseTree,
        headTree,
        signal: input.signal
    });

    const baseLists = planSnapshotFiles(baseTree.listing.files, classifications.base);
    const headLists = planSnapshotFiles(headTree.listing.files, classifications.head);
    const measured = await measureSnapshots(input, { baseTree, headTree, baseLists, headLists });

    const map = assembleMap({
        input,
        measured,
        baseLists,
        headLists,
        classifications,
        mergeBaseSha: await resolveMergeBaseSha({
            directory: input.worktreeDir,
            baseSha: input.baseSha,
            headSha: input.headSha,
            signal: input.signal
        })
    });

    return {
        map,
        baseMetrics: {
            recognizedFilesCount: measured.baseScc.totals.files,
            physicalLines: measured.baseScc.totals.lines
        }
    };
}

interface AssembleInput {
    input: IntelligencePrePassInput;
    measured: MeasuredSnapshots;
    baseLists: SnapshotFileLists;
    headLists: SnapshotFileLists;
    classifications: SnapshotClassifications;
    mergeBaseSha: string | undefined;
}

function assembleMap(assembly: AssembleInput): ReviewMap {
    const { input, measured } = assembly;
    const ccccAvailable = measured.baseCccc.snapshot !== null && measured.headCccc.snapshot !== null;
    let ccccStatus: ToolStatus = 'unavailable';

    if (ccccAvailable) {
        ccccStatus = 'ok';
    }

    const revisions: ReviewMap['revisions'] = { baseSha: input.baseSha, headSha: input.headSha };

    if (assembly.mergeBaseSha !== undefined) {
        revisions.mergeBaseSha = assembly.mergeBaseSha;
    }

    return buildReviewMap({
        revisions,
        tools: {
            scc: { version: input.sccVersion, status: 'ok' },
            cccc: { version: input.ccccVersion, status: ccccStatus }
        },
        base: snapshotData(measured.baseScc, measured.baseCccc.snapshot, assembly.baseLists),
        head: snapshotData(measured.headScc, measured.headCccc.snapshot, assembly.headLists),
        changedFiles: input.changedFiles,
        classifications: assembly.classifications.changed,
        warnings: collectWarnings(assembly)
    });
}

function collectWarnings(assembly: AssembleInput): string[] {
    const warnings = classificationWarnings(assembly.classifications);
    appendUnmeasurableWarning(warnings, assembly.baseLists, 'BASE');
    appendUnmeasurableWarning(warnings, assembly.headLists, 'HEAD');

    for (const attempt of [assembly.measured.baseCccc, assembly.measured.headCccc]) {
        if (attempt.warning !== undefined) {
            warnings.push(attempt.warning);
        }
    }

    return warnings;
}

/* Unmaterializable paths are explicit omissions listed in `coverage.scc.unmeasurable`. */
function appendUnmeasurableWarning(warnings: string[], lists: SnapshotFileLists, side: string): void {
    if (lists.unmeasurable.length > 0) {
        warnings.push(
            `${lists.unmeasurable.length} ${side} tracked path(s) cannot be materialized in the analysis tree and were excluded from SCC/CCCC measurement.`
        );
    }
}

interface MeasurementInput {
    baseTree: GitTreeSnapshot;
    headTree: GitTreeSnapshot;
    baseLists: SnapshotFileLists;
    headLists: SnapshotFileLists;
}

interface MeasuredSnapshots {
    baseScc: SccSnapshot;
    headScc: SccSnapshot;
    baseCccc: CcccAttempt;
    headCccc: CcccAttempt;
}

async function measureSnapshots(
    input: IntelligencePrePassInput,
    measurement: MeasurementInput
): Promise<MeasuredSnapshots> {
    const baseAnalysis = await createAnalysisTree({
        sourceDirectory: measurement.baseTree.directory,
        files: measurement.baseLists.requested,
        signal: input.signal
    });

    let headAnalysis: AnalysisTree | undefined = undefined;
    let failure: unknown = undefined;

    try {
        headAnalysis = await createAnalysisTree({
            sourceDirectory: measurement.headTree.directory,
            files: measurement.headLists.requested,
            signal: input.signal
        });

        return await measureOnTrees({ input, baseAnalysis, headAnalysis, measurement });
    } catch (error) {
        failure = error;
        throw error;
    } finally {
        await closeAfterFailure(headAnalysis, failure);
        await closeAfterFailure(baseAnalysis, failure);
    }
}

/* Tools run sequentially; a 2-vCPU runner showed no win from concurrency. */
async function measureOnTrees(pairs: ToolPairsInput): Promise<MeasuredSnapshots> {
    const scc = await measureSccPair(pairs);
    const cccc = await measureCcccPair(pairs);

    return { ...scc, ...cccc };
}

interface ToolPairsInput {
    input: IntelligencePrePassInput;
    baseAnalysis: AnalysisTree;
    headAnalysis: AnalysisTree;
    measurement: MeasurementInput;
}

async function measureSccPair(pairs: ToolPairsInput): Promise<{ baseScc: SccSnapshot; headScc: SccSnapshot }> {
    const { input, baseAnalysis, headAnalysis, measurement } = pairs;

    const baseScc = await measureScc({
        binaryPath: input.sccBinaryPath,
        directory: baseAnalysis.directory,
        files: measurement.baseLists.requested,
        signal: input.signal
    });

    const headScc = await measureScc({
        binaryPath: input.sccBinaryPath,
        directory: headAnalysis.directory,
        files: measurement.headLists.requested,
        signal: input.signal
    });

    return { baseScc, headScc };
}

async function measureCcccPair(pairs: ToolPairsInput): Promise<{ baseCccc: CcccAttempt; headCccc: CcccAttempt }> {
    const { input, baseAnalysis, headAnalysis, measurement } = pairs;

    const baseCccc = await measureCcccOrNull(input, {
        directory: baseAnalysis.directory,
        files: measurement.baseLists.requested,
        side: 'BASE'
    });

    const headCccc = await measureCcccOrNull(input, {
        directory: headAnalysis.directory,
        files: measurement.headLists.requested,
        side: 'HEAD'
    });

    return { baseCccc, headCccc };
}

function snapshotData(scc: SccSnapshot, cccc: CcccSnapshot | null, lists: SnapshotFileLists): SnapshotReviewData {
    return {
        scc,
        cccc,
        requested: lists.requested,
        notCounted: lists.notCounted,
        unmeasurable: lists.unmeasurable
    };
}

interface CcccAttempt {
    snapshot: CcccSnapshot | null;
    warning?: string;
}

async function measureCcccOrNull(input: IntelligencePrePassInput, attempt: CcccAttemptInput): Promise<CcccAttempt> {
    try {
        const snapshot = await measureCccc({
            binaryPath: input.ccccBinaryPath,
            directory: attempt.directory,
            files: attempt.files,
            signal: input.signal
        });

        return { snapshot };
    } catch (error) {
        /* A cancelled run is not a tool degradation: it must keep propagating. */
        if (error instanceof CancelledError || (error instanceof Error && error.name === 'AbortError')) {
            throw error;
        }

        return { snapshot: null, warning: `CCCC ${attempt.side} measurement failed: ${describeError(error)}` };
    }
}

interface CcccAttemptInput {
    directory: string;
    files: readonly string[];
    side: string;
}
