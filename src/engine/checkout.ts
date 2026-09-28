import { readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { CancelledError } from '../analysis/cancellation';
import { describeError } from '../errors';

export class UnsafeCheckoutError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = 'UnsafeCheckoutError';
    }
}

/* Engine re-opens read/grep/glob for `<checkout>/**`; a committed symlink could point it at host files.
   Inspect once before any session; config and sessions use the canonical path. */
export async function resolveSafeCheckoutDirectory(checkoutDir: string, signal?: AbortSignal): Promise<string> {
    try {
        throwIfAborted(signal);
        const canonicalCheckoutDir = await realpath(checkoutDir);
        await inspectCheckout(canonicalCheckoutDir, canonicalCheckoutDir, signal);

        return canonicalCheckoutDir;
    } catch (error) {
        if (error instanceof CancelledError || error instanceof UnsafeCheckoutError) {
            throw error;
        }

        throw new UnsafeCheckoutError(`Review checkout at ${checkoutDir} is unavailable: ${describeError(error)}`);
    }
}

async function inspectCheckout(rootDir: string, currentDir: string, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const entries = await readdir(currentDir, { withFileTypes: true });
    await Promise.all(
        entries.map(async (entry) => {
            throwIfAborted(signal);
            const entryPath = path.join(currentDir, entry.name);

            if (entry.isSymbolicLink()) {
                const target = await resolveSymlink(entryPath);

                if (!isInside(rootDir, target)) {
                    throw new UnsafeCheckoutError(`Checkout contains a symlink outside the checkout: ${entryPath}.`);
                }
            } else if (entry.isDirectory()) {
                await inspectCheckout(rootDir, entryPath, signal);
            }
        })
    );
}

async function resolveSymlink(entryPath: string): Promise<string> {
    try {
        return await realpath(entryPath);
    } catch {
        throw new UnsafeCheckoutError(`Checkout contains an unresolved symlink: ${entryPath}.`);
    }
}

function isInside(rootDir: string, candidate: string): boolean {
    const relative = path.relative(rootDir, candidate);

    return (
        relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted === true) {
        throw new CancelledError();
    }
}
