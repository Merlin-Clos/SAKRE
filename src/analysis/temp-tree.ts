import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PRODUCT_SLUG } from '../identity';
import { CancelledError } from './cancellation';

/* One owner of the tree lifecycle: creation, failure cleanup and cancellation. Snapshot and analysis tree share it so semantics cannot drift. */

export interface TempTreeOptions {
    /* Suffix appended after the product slug. */
    label: string;
    cancellationMessage: string;
    signal?: AbortSignal;
    /* Tests pin the scratch parent; production uses the platform temp dir. */
    scratchRoot?: string;
}

export async function withTempTree<Value>(
    options: TempTreeOptions,
    run: (directory: string) => Promise<Value>
): Promise<Value> {
    throwIfAborted(options.signal, options.cancellationMessage);
    const directory = await mkdtemp(path.join(options.scratchRoot ?? tmpdir(), `${PRODUCT_SLUG}-${options.label}-`));

    try {
        return await run(directory);
    } catch (error) {
        const failure = translateCancellation(error, options.cancellationMessage);
        await cleanupQuietly(directory);
        throw failure;
    }
}

export async function removeTree(directory: string): Promise<void> {
    await rm(directory, { recursive: true, force: true });
}

/* Measurement failure stays actionable and survives cleanup, including a Windows-held directory. Without one the close error stays visible. */
export async function closeAfterFailure(
    tree: { close: () => Promise<void> } | undefined,
    // eslint-disable-next-line anti-slop/no-unknown-parameters -- preserves the caller's original thrown failure
    failure?: unknown
): Promise<void> {
    if (tree === undefined) {
        return;
    }

    try {
        await tree.close();
    } catch (error) {
        if (failure === undefined) {
            throw error;
        }
    }
}

export function throwIfAborted(signal: AbortSignal | undefined, message: string): void {
    if (signal?.aborted === true) {
        throw new CancelledError(message);
    }
}

// eslint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- rethrows the caller's original failure type
export function translateCancellation(error: unknown, message: string): unknown {
    if (error instanceof CancelledError || (error instanceof Error && error.name === 'AbortError')) {
        // eslint-disable-next-line anti-slop/no-known-value-widening -- cancellation maps to CancelledError, other failures pass through
        return new CancelledError(message);
    }

    return error;
}

/* The original failure stays actionable; a cleanup error must not replace it. */
async function cleanupQuietly(directory: string): Promise<void> {
    try {
        await removeTree(directory);
    } catch {
        // Best effort; the original failure still reaches the caller.
    }
}
