import { copyFile, link, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { mapWithConcurrency } from '../concurrency';
import { removeTree, throwIfAborted, withTempTree } from '../analysis/temp-tree';
import { joinTreePath } from './tree-paths';

/* Filtered tree holds exactly the allowed files, measured with one invocation so the OS argument limit never caps it. Files are hardlinked or copied; paths are revalidated and symlinks never created. */

const MAX_CONCURRENT_LINKS = 16;

const CANCELLATION_MESSAGE = 'The analysis tree materialization was cancelled.';

const HARDLINK_FALLBACK_CODES: ReadonlySet<string> = new Set([
    'EXDEV',
    'EPERM',
    'EACCES',
    'ENOSYS',
    'EMLINK',
    'ENOTSUP'
]);

export class AnalysisTreeError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = 'AnalysisTreeError';
    }
}

export interface AnalysisTree {
    directory: string;
    close: () => Promise<void>;
}

export interface CreateAnalysisTreeInput {
    sourceDirectory: string;
    files: readonly string[];
    signal?: AbortSignal;
    /* Tests pin the scratch parent; production uses the platform temp dir. */
    scratchRoot?: string;
}

export function createAnalysisTree(input: CreateAnalysisTreeInput): Promise<AnalysisTree> {
    return withTempTree(
        {
            label: 'analysis',
            cancellationMessage: CANCELLATION_MESSAGE,
            signal: input.signal,
            scratchRoot: input.scratchRoot
        },
        async (directory) => {
            await mapWithConcurrency(input.files, MAX_CONCURRENT_LINKS, (file) =>
                materializeFile(input, directory, file)
            );

            return { directory, close: () => removeTree(directory) };
        }
    );
}

async function materializeFile(input: CreateAnalysisTreeInput, targetRoot: string, filePath: string): Promise<void> {
    throwIfAborted(input.signal, CANCELLATION_MESSAGE);
    const source = joinTreePath(input.sourceDirectory, filePath);
    const target = joinTreePath(targetRoot, filePath);

    if (source === undefined || target === undefined) {
        throw new AnalysisTreeError(`Unsafe analysis path: ${JSON.stringify(filePath)}.`);
    }

    await mkdir(path.dirname(target), { recursive: true });
    await linkOrCopy(source, target);
}

async function linkOrCopy(source: string, target: string): Promise<void> {
    try {
        await link(source, target);
    } catch (error) {
        if (!isHardlinkUnsupported(error)) {
            throw error;
        }

        await copyFile(source, target);
    }
}

// eslint-disable-next-line anti-slop/no-unknown-parameters -- thrown filesystem values cross this boundary as unknown
function isHardlinkUnsupported(error: unknown): boolean {
    return error instanceof Error && 'code' in error && HARDLINK_FALLBACK_CODES.has(String(error.code));
}
