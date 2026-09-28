import { type CoverageBudgetSummary, formatBudgetReport } from '../analysis/budget';

export interface OverBudgetPromptEnvironment {
    stdin: NodeJS.ReadableStream;
    stderr: NodeJS.WritableStream;
    stdinIsTty: boolean;
}

/* TTY-only y/N. Without a terminal nobody can answer, so the caller aborts. */
export async function confirmOverBudget(
    report: CoverageBudgetSummary,
    environment: OverBudgetPromptEnvironment
): Promise<boolean> {
    if (!environment.stdinIsTty) {
        return false;
    }

    environment.stderr.write(
        `Diff exceeds the review budget: ${formatBudgetReport(report)}\nProceed with a partial review? [y/N] `
    );
    const answer = await readLine(environment.stdin);

    return /^y(?:es)?$/iu.test(answer.trim());
}

function readLine(stream: NodeJS.ReadableStream): Promise<string> {
    return new Promise((resolve) => {
        let text = '';

        function finish(): void {
            stream.off('data', onData);
            stream.off('end', finish);
            stream.off('error', finish);
            stream.pause();
            resolve(text);
        }

        function onData(chunk: Buffer | string): void {
            text += chunk.toString();

            if (text.includes('\n')) {
                finish();
            }
        }

        stream.on('data', onData);
        stream.once('end', finish);
        stream.once('error', finish);
        stream.resume();
    });
}
