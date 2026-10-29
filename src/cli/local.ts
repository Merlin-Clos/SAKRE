import type { AiRuntime } from '../ai/runtime';
import { DiffBudgetExceededError } from '../action/errors';
import type { ActionRuntimeInput } from '../action/runtime-factory';
import { type CoverageBudgetSummary, formatBudgetReport } from '../analysis/budget';
import { configureLogRedaction, configureLogSink, createStreamLogSink, resetLogSink } from '../logger';
import type { NativeRuntime } from '../native/runtime';
import type { GitHubClientDependencies } from './forge';
import { CliExitError, parseLocalCliArgs } from './program';
import { writeCliError } from './root';

/* Only boundary tests must replace: runs the cycle without starting the engine. */
export type LocalRuntimeFactory = (input: ActionRuntimeInput) => Promise<AiRuntime>;

export interface LocalCliEnvironment {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
    /* Interactive confirmation: injected stdin and TTY state; defaults to the
       process stdin and its own TTY state. */
    stdin?: NodeJS.ReadableStream;
    isTty?: boolean;
    signal?: AbortSignal;
    authStorePath?: string;
    githubClientDependencies?: GitHubClientDependencies;
    /* Native assets resolved from the embedded runtime; tests inject a fake to
       avoid downloading or embedding archives. */
    native?: NativeRuntime;
    createRuntime?: LocalRuntimeFactory;
}

/* Parsing owns early exits; only valid review options load the execution graph. */
export async function runLocalCli(args: string[], environment: LocalCliEnvironment = {}): Promise<number> {
    const stdout = environment.stdout ?? process.stdout;
    const stderr = environment.stderr ?? process.stderr;
    configureLogSink(createStreamLogSink(stderr));

    try {
        const options = parseLocalCliArgs(args, { stdout, stderr });
        const { executeLocalReview } = await import('./local-review');

        return await executeLocalReview(options, environment, stdout);
    } catch (error) {
        if (error instanceof CliExitError) {
            return error.exitCode;
        }

        if (error instanceof DiffBudgetExceededError) {
            stderr.write(`${budgetAbortMessage(error.report)}\n`);

            return 1;
        }

        writeCliError(stderr, error);

        return 1;
    } finally {
        resetLogSink();
        configureLogRedaction([]);
    }
}

function budgetAbortMessage(report: CoverageBudgetSummary): string {
    return [
        `Error: Diff exceeds the review budget: ${formatBudgetReport(report)}.`,
        'Re-run with --force-over-budget to review only the portion that fits the budget. Coverage will be partial.'
    ].join('\n');
}
