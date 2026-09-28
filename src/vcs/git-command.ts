import { spawn } from 'node:child_process';
import { LocalGitError } from './errors';

/* Thin Git boundary: the local VCS and the CLI prerequisites run through this
   runner, so every invocation shares the same working directory, cancellation,
   and error mapping. */
export interface GitCommandResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

/* Optional streaming mode: the consumer receives raw stdout chunks instead of
   a retained string, and can stop the invocation once it has read enough. */
export interface GitRunOptions {
    onStdoutChunk?: (chunk: Buffer) => boolean | undefined;
}

export interface GitRunner {
    run: (args: string[], signal?: AbortSignal, options?: GitRunOptions) => Promise<GitCommandResult>;
}

const GIT_BINARY = 'git';

export function createGitRunner(repositoryDir: string): GitRunner {
    return {
        run: (args, signal, options) => runGitCommand(repositoryDir, args, { ...options, signal })
    };
}

function runGitCommand(
    repositoryDir: string,
    args: string[],
    options: GitRunOptions & { signal?: AbortSignal }
): Promise<GitCommandResult> {
    return new Promise((resolve, reject) => {
        const child = spawn(GIT_BINARY, args, {
            cwd: repositoryDir,
            signal: options.signal,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        const streamed = options.onStdoutChunk;
        const state = { stopped: false };
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => {
            if (streamed === undefined) {
                stdout += chunk.toString('utf8');

                return;
            }

            if (!state.stopped && streamed(chunk) === false) {
                state.stopped = true;
                child.kill();
            }
        });
        child.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString('utf8');
        });
        child.on('error', reject);
        child.on('close', (code) => {
            /* Consumer that stopped reading is not a failure: the content it
               asked for was delivered, so the invocation resolves successfully. */
            resolve({ exitCode: exitCodeOf(state.stopped, code), stdout, stderr });
        });
    });
}

function exitCodeOf(stopped: boolean, code: number | null): number {
    if (stopped) {
        return 0;
    }

    return code ?? -1;
}

/* Strict invocation: a non-zero exit becomes a typed error carrying the
   operation and the first stderr line. */
export async function gitOutput(input: {
    runner: GitRunner;
    operation: string;
    args: string[];
    signal?: AbortSignal;
}): Promise<string> {
    const result = await input.runner.run(input.args, input.signal);

    if (result.exitCode !== 0) {
        throw new LocalGitError(input.operation, exitReason(result));
    }

    return result.stdout;
}

/* Strict streaming invocation: stdout is delivered chunk by chunk without
   retention, and a non-zero exit becomes the same typed error. */
export async function gitStream(input: {
    runner: GitRunner;
    operation: string;
    args: string[];
    signal?: AbortSignal;
    onStdoutChunk: (chunk: Buffer) => boolean | undefined;
}): Promise<void> {
    const result = await input.runner.run(input.args, input.signal, { onStdoutChunk: input.onStdoutChunk });

    if (result.exitCode !== 0) {
        throw new LocalGitError(input.operation, exitReason(result));
    }
}

/* Availability probe: used for optional refs and optional commands, where a
   failure is an expected answer rather than an error. */
export async function gitSucceeds(runner: GitRunner, args: string[], signal?: AbortSignal): Promise<boolean> {
    const result = await runner.run(args, signal);

    return result.exitCode === 0;
}

function exitReason(result: GitCommandResult): string {
    const reason = firstLine(result.stderr);

    if (reason === '') {
        return `exit code ${result.exitCode}`;
    }

    return reason;
}

function firstLine(text: string): string {
    const [line = ''] = text.trim().split('\n');

    return line.trim();
}
