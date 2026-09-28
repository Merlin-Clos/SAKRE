import type { FileClassification } from '../analysis/classification';
import type { TreeFile } from '../vcs/tree';
import { isTreePathSafe } from './tree-paths';

/* One canonical plan per snapshot of tool inputs. Classification decides noise; uninterpretable paths (like a POSIX name with a backslash) become unmeasurable instead of failing the review. */

export interface SnapshotFileLists {
    requested: string[];
    notCounted: string[];
    unmeasurable: string[];
}

export function planSnapshotFiles(
    files: readonly TreeFile[],
    classifications: ReadonlyMap<string, FileClassification>
): SnapshotFileLists {
    const lists: SnapshotFileLists = { requested: [], notCounted: [], unmeasurable: [] };

    for (const file of files) {
        planFile(file, classifications, lists);
    }

    return lists;
}

/* A missing classification is an error, never a silent fallback. */
function planFile(
    file: TreeFile,
    classifications: ReadonlyMap<string, FileClassification>,
    lists: SnapshotFileLists
): void {
    const classification = classifications.get(file.path);

    if (classification === undefined) {
        throw new Error(`No classification resolved for tracked file ${JSON.stringify(file.path)}.`);
    }

    if (classification.analysis.scc !== 'counted') {
        lists.notCounted.push(file.path);
    } else if (isTreePathSafe(file.path)) {
        lists.requested.push(file.path);
    } else {
        lists.unmeasurable.push(file.path);
    }
}
