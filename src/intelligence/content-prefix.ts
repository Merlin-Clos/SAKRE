import { lstat, open } from 'node:fs/promises';
import { GENERATED_MARKER_BYTES } from '../analysis/classification';
import { describeError } from '../errors';
import { joinTreePath } from './tree-paths';

/* Bounded reads from an extracted tree; traversal, absolute paths and non-regular entries are rejected. A HEAD-controlled symlink is never followed, not even as a marker oracle. */

export type TreePrefixResult =
    | { kind: 'content'; content: string }
    | { kind: 'absent' }
    | { kind: 'failed'; reason: string };

const ABSENT_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR', 'EISDIR', 'ELOOP']);

export async function readTreePrefix(root: string, filePath: string): Promise<TreePrefixResult> {
    const target = joinTreePath(root, filePath);

    if (target === undefined) {
        return { kind: 'absent' };
    }

    try {
        /* `lstat` does not follow the final component, so symlinks and non-files are refused before any read. */
        const stats = await lstat(target);

        if (!stats.isFile()) {
            return { kind: 'absent' };
        }

        return await readRegularFile(target);
    } catch (error) {
        return classifyReadFailure(error);
    }
}

async function readRegularFile(target: string): Promise<TreePrefixResult> {
    const handle = await open(target, 'r');

    try {
        return { kind: 'content', content: await readBounded(handle) };
    } finally {
        await handle.close();
    }
}

// eslint-disable-next-line anti-slop/no-unknown-parameters -- thrown filesystem values cross this boundary as unknown
function classifyReadFailure(error: unknown): TreePrefixResult {
    if (isAbsent(error)) {
        return { kind: 'absent' };
    }

    return { kind: 'failed', reason: describeError(error) };
}

async function readBounded(handle: Awaited<ReturnType<typeof open>>): Promise<string> {
    const buffer = Buffer.alloc(GENERATED_MARKER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);

    return buffer.subarray(0, bytesRead).toString('utf8');
}

// eslint-disable-next-line anti-slop/no-unknown-parameters -- thrown filesystem values cross this boundary as unknown
function isAbsent(error: unknown): boolean {
    return error instanceof Error && 'code' in error && ABSENT_CODES.has(String(error.code));
}
