import { describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CancelledError } from '../../src/analysis/cancellation';
import { closeAfterFailure, withTempTree } from '../../src/analysis/temp-tree';
import { rejectionOf } from '../helpers/rejection';

/* One lifecycle owner for extracted and filtered trees: a failed body never
   leaves its temporary directory behind, and cancellation keeps its canonical
   error instead of the platform AbortError. */

const LABEL = 'test';

describe('temporary tree lifecycle', () => {
    test('removes the directory and keeps the original failure when the body throws', async () => {
        const scratchRoot = await mkdtemp(path.join(tmpdir(), 'sakre-temp-tree-'));

        try {
            const failure = await rejectionOf(
                withTempTree({ label: LABEL, cancellationMessage: 'Cancelled.', scratchRoot }, () =>
                    Promise.reject(new Error('materialization failed'))
                )
            );

            expect(failure.message).toBe('materialization failed');
            expect(await readdir(scratchRoot)).toEqual([]);
        } finally {
            await rm(scratchRoot, { recursive: true, force: true });
        }
    });

    test('refuses an aborted signal before creating a directory', async () => {
        const scratchRoot = await mkdtemp(path.join(tmpdir(), 'sakre-temp-tree-abort-'));
        const controller = new AbortController();
        controller.abort();

        try {
            const failure = await rejectionOf(
                withTempTree(
                    {
                        label: LABEL,
                        cancellationMessage: 'The test tree was cancelled.',
                        scratchRoot,
                        signal: controller.signal
                    },
                    () => Promise.resolve(1)
                )
            );

            expect(failure).toBeInstanceOf(CancelledError);
            expect(failure.message).toBe('The test tree was cancelled.');
            expect(await readdir(scratchRoot)).toEqual([]);
        } finally {
            await rm(scratchRoot, { recursive: true, force: true });
        }
    });

    test('keeps the measurement failure when closing the measured tree fails', async () => {
        const failure = new CancelledError();
        const cleanup = new Error('EBUSY: resource busy or locked');
        let attempted = false;
        await closeAfterFailure(
            {
                close: () => {
                    attempted = true;

                    return Promise.reject(cleanup);
                }
            },
            failure
        );
        expect(attempted).toBe(true);
    });

    test('propagates a close failure when the measurement succeeded', async () => {
        const cleanup = new Error('EBUSY: resource busy or locked');
        const failure = await rejectionOf(closeAfterFailure({ close: () => Promise.reject(cleanup) }));
        expect(failure).toBe(cleanup);
    });

    test('translates a platform AbortError into the canonical cancellation error', async () => {
        const scratchRoot = await mkdtemp(path.join(tmpdir(), 'sakre-temp-tree-translate-'));
        const aborted = new Error('aborted');
        aborted.name = 'AbortError';

        try {
            const failure = await rejectionOf(
                withTempTree({ label: LABEL, cancellationMessage: 'The test tree was cancelled.', scratchRoot }, () =>
                    Promise.reject(aborted)
                )
            );

            expect(failure).toBeInstanceOf(CancelledError);
            expect(failure.message).toBe('The test tree was cancelled.');
            expect(await readdir(scratchRoot)).toEqual([]);
        } finally {
            await rm(scratchRoot, { recursive: true, force: true });
        }
    });
});
