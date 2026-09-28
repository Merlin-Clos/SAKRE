import { describe, expect, test } from 'bun:test';
import { Readable, Writable } from 'node:stream';
import type { CoverageBudgetSummary } from '../../src/analysis/budget';
import { confirmOverBudget } from '../../src/cli/prompt';

const REPORT: CoverageBudgetSummary = {
    totalChars: 1000,
    limitChars: 400,
    coveredChars: 250,
    reviewableFiles: 4,
    completeFiles: 1
};

interface CapturedStream {
    stream: NodeJS.WritableStream;
    read: () => string;
}

function captureStream(): CapturedStream {
    let text = '';

    const stream = new Writable({
        write(chunk: Buffer, _encoding, callback): void {
            text += chunk.toString('utf8');
            callback();
        }
    });

    return { stream, read: () => text };
}

describe('over-budget confirmation prompt', () => {
    test('a TTY prompt with y or yes proceeds and shows the reviewable share', async () => {
        for (const answer of ['y\n', 'yes\n']) {
            const stderr = captureStream();

            const confirmed = await confirmOverBudget(REPORT, {
                stdin: Readable.from([answer]),
                stderr: stderr.stream,
                stdinIsTty: true
            });

            expect(confirmed).toBe(true);
            expect(stderr.read()).toContain('reviewable 25.0 % (1/4 files complete)');
            expect(stderr.read()).toContain('[y/N]');
        }
    });

    test('any other answer aborts', async () => {
        for (const answer of ['n\n', '\n', 'maybe\n']) {
            const confirmed = await confirmOverBudget(REPORT, {
                stdin: Readable.from([answer]),
                stderr: captureStream().stream,
                stdinIsTty: true
            });

            expect(confirmed).toBe(false);
        }
    });

    test('a non-TTY stdin aborts without prompting', async () => {
        const stderr = captureStream();

        const confirmed = await confirmOverBudget(REPORT, {
            stdin: Readable.from(['y\n']),
            stderr: stderr.stream,
            stdinIsTty: false
        });

        expect(confirmed).toBe(false);
        expect(stderr.read()).toBe('');
    });

    test('a closed stdin aborts instead of hanging', async () => {
        const confirmed = await confirmOverBudget(REPORT, {
            stdin: Readable.from([]),
            stderr: captureStream().stream,
            stdinIsTty: true
        });

        expect(confirmed).toBe(false);
    });
});
