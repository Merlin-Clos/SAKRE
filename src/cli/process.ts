import { spawn } from 'node:child_process';

export interface CommandResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

export interface CommandInput {
    command: string;
    args: string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
}

export function runCommand(input: CommandInput): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
        const child = spawn(input.command, input.args, {
            cwd: input.cwd,
            env: input.env,
            signal: input.signal,
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
            resolve({ exitCode: code ?? -1, stdout, stderr });
        });
    });
}
