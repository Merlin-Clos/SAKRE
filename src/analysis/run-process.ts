import { spawn } from 'node:child_process';

const PROCESS_KILL_EXIT_CODE = -1;

export interface RunProcessOptions {
    command: string;
    args: string[];
    signal?: AbortSignal;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    pipeStdout?: (stdout: NodeJS.ReadableStream) => Promise<void>;
}

export interface CapturedProcess {
    exitCode: number;
    stdout: string;
    stderr: string;
}

/* Captured output for tools returning JSON on stdout; the caller translates errors into its own failure class. */
export function runProcessCapture(options: RunProcessOptions): Promise<CapturedProcess> {
    return new Promise((resolve, reject) => {
        const child = spawn(options.command, options.args, {
            signal: options.signal,
            cwd: options.cwd,
            env: options.env,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => {
            stdout += chunk.toString('utf8');
        });
        child.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString('utf8');
        });
        child.on('error', reject);
        child.on('close', (code) => {
            resolve({ exitCode: code ?? PROCESS_KILL_EXIT_CODE, stdout, stderr });
        });
    });
}

export function runProcess(options: RunProcessOptions): Promise<{ exitCode: number }> {
    return new Promise((resolve, reject) => {
        const child = spawn(options.command, options.args, {
            signal: options.signal,
            cwd: options.cwd,
            env: options.env,
            stdio: buildStdio(options)
        });

        let stderr = '';
        child.stderr?.on('data', (chunk: Buffer) => {
            stderr += chunk.toString('utf8');
        });
        const piped = startPipe(child, options, reject);
        child.on('error', reject);
        child.on('close', (code) => {
            settleChild({ code, stderr, piped, pipeStdout: options.pipeStdout, resolve, reject });
        });
    });
}

function buildStdio(options: RunProcessOptions): ('ignore' | 'pipe')[] {
    if (options.pipeStdout) {
        return ['ignore', 'pipe', 'ignore'];
    }

    return ['ignore', 'ignore', 'pipe'];
}

function startPipe(
    child: ReturnType<typeof spawn>,
    options: RunProcessOptions,
    // eslint-disable-next-line anti-slop/no-unknown-parameters -- promise reject callback carries unknown by contract
    reject: (reason?: unknown) => void
): Promise<void> {
    if (!options.pipeStdout || !child.stdout) {
        return Promise.resolve();
    }

    return options.pipeStdout(child.stdout).catch(reject);
}

interface SettleContext {
    code: number | null;
    stderr: string;
    piped: Promise<void>;
    pipeStdout?: (stdout: NodeJS.ReadableStream) => Promise<void>;
    resolve: (value: { exitCode: number }) => void;
    // eslint-disable-next-line anti-slop/no-unknown-parameters -- promise reject callback carries unknown by contract
    reject: (reason?: unknown) => void;
}

function settleChild(context: SettleContext): void {
    context.piped.then(() => {
        if (context.code === 0 || context.pipeStdout !== undefined) {
            context.resolve({ exitCode: context.code ?? PROCESS_KILL_EXIT_CODE });

            return;
        }

        context.reject(new Error(`Process failed: ${context.stderr.trim()}`));
    }, context.reject);
}
