import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/* Shared harness for executing the real composite Action resolver scripts
   against a temporary Action tree, a stubbed curl and a fixture engine. It is
   used by the resolver contract tests and the engine credential tests. */

export const RESOLVER = path.resolve('action', 'resolve-engine.sh');

export const PS_RESOLVER = path.resolve('action', 'resolve-engine.ps1');

export const PINNED_DIGEST = 'a'.repeat(64);

export interface ResolverRun {
    exitCode: number | null;
    stdout: string;
    stderr: string;
}

export interface ResolverPhases {
    source: string;
    resolve_ms: number;
    download_ms: number;
    verify_ms: number;
    install_ms: number;
    bootstrap_ms: number;
    execute_ms: number;
    total_ms: number;
}

const PHASE_LINE_PREFIX = 'sakre-engine: ';

/* Parses the machine-readable phase line the resolvers write to stderr: the regression surface for delivery
   instrumentation, where silent zeros would look like a fast delivery. */
export function parseResolverPhases(stderr: string): ResolverPhases {
    const line = stderr.split('\n').find((candidate) => candidate.startsWith(PHASE_LINE_PREFIX));

    if (line === undefined) {
        throw new Error(`The composite resolver did not report its phases:\n${stderr}`);
    }

    const fields = new Map<string, string>();

    for (const token of line.slice(PHASE_LINE_PREFIX.length).trim().split(/\s+/u)) {
        const separator = token.indexOf('=');

        if (separator > 0) {
            fields.set(token.slice(0, separator), token.slice(separator + 1));
        }
    }

    function readNumber(name: string): number {
        const value = fields.get(name);

        if (value === undefined) {
            throw new Error(`The composite resolver did not report ${name}: ${line}`);
        }

        return Number(value);
    }

    return {
        source: fields.get('source') ?? 'unknown',
        resolve_ms: readNumber('resolve_ms'),
        download_ms: readNumber('download_ms'),
        verify_ms: readNumber('verify_ms'),
        install_ms: readNumber('install_ms'),
        bootstrap_ms: readNumber('bootstrap_ms'),
        execute_ms: readNumber('execute_ms'),
        total_ms: readNumber('total_ms')
    };
}

export interface ResolverInput {
    root: string;
    actionPath?: string;
    args?: string[];
    env?: Record<string, string>;
}

const roots: string[] = [];

export async function cleanupRoots(): Promise<void> {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}

function resolverEnvironment(input: ResolverInput): Record<string, string> {
    // eslint-disable-next-line anti-slop/no-known-value-widening -- environment-map fixture; Record documents the runner contract
    return {
        ...process.env,
        GITHUB_ACTION_PATH: input.actionPath ?? path.join(input.root, 'action'),
        GITHUB_ACTION_REF: '',
        GITHUB_ACTION_REPOSITORY: 'acme/sakre-fixture',
        GITHUB_STEP_SUMMARY: path.join(input.root, 'summary.md'),
        RUNNER_OS: 'Linux',
        RUNNER_ARCH: 'X64',
        RUNNER_TEMP: path.join(input.root, 'runner-temp'),
        INPUT_GITHUB_TOKEN: '',
        INPUT_ENGINE_TOKEN: '',
        SAKRE_ENGINE_TOKEN: '',
        GITHUB_TOKEN: '',
        SAKRE_ENGINE_BINARY: '',
        ...input.env
    };
}

function collectOutput(child: ReturnType<typeof spawn>): { read: (exitCode: number | null) => ResolverRun } {
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
    });

    // eslint-disable-next-line anti-slop/no-known-value-widening -- fixture contract annotation; documents the helper result shape
    return {
        read: (exitCode: number | null) => ({ exitCode, stdout, stderr })
    };
}

export function runResolver(input: ResolverInput): Promise<ResolverRun> {
    return new Promise((resolve, reject) => {
        const child = spawn('bash', [RESOLVER, ...(input.args ?? [])], {
            env: resolverEnvironment(input),
            stdio: ['ignore', 'pipe', 'pipe']
        });

        const output = collectOutput(child);
        child.on('error', reject);
        child.on('close', (exitCode) => {
            resolve(output.read(exitCode));
        });
    });
}

/* The PowerShell resolver runs in the Windows artifact job; it is executed
   locally too when `pwsh` is installed. Its download path cannot be stubbed
   with a local curl, so tests drive the cache-hit and mismatch branches. */
export function pwshAvailable(): boolean {
    const probe = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], {
        encoding: 'utf8'
    });

    return probe.status === 0;
}

export function runPwshResolver(input: ResolverInput): Promise<ResolverRun> {
    return new Promise((resolve, reject) => {
        const child = spawn('pwsh', ['-NoProfile', '-File', PS_RESOLVER, ...(input.args ?? [])], {
            env: resolverEnvironment(input),
            stdio: ['ignore', 'pipe', 'pipe']
        });

        const output = collectOutput(child);
        child.on('error', reject);
        child.on('close', (exitCode) => {
            resolve(output.read(exitCode));
        });
    });
}

export async function tempRoot(prefix: string): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), prefix));
    roots.push(root);

    return root;
}

export async function writeActionPin(
    root: string,
    tag: string | null,
    assets: Record<string, string>
): Promise<string> {
    const actionPath = path.join(root, 'action');
    await mkdir(actionPath, { recursive: true });
    await writeFile(path.join(actionPath, 'engine-pins.json'), `${JSON.stringify({ tag, assets }, null, 4)}\n`, 'utf8');

    return actionPath;
}

export async function writeExecutable(file: string, content: string): Promise<string> {
    await writeFile(file, content, { mode: 0o755 });

    return file;
}

/* PowerShell only executes real executables, so on Windows the resolver fixture
   is a copy of the running Bun binary and the native runner target applies; the
   shell fixture stays on Linux. Both fixtures report their own marker. */
export function pwshEngineTarget(linuxAsset: string): { runnerOs: string; asset: string; binary: string } {
    if (process.platform === 'win32') {
        // eslint-disable-next-line anti-slop/no-known-value-widening -- platform-specific engine target; annotation documents the shared shape
        return { runnerOs: 'Windows', asset: 'sakre-windows-x64.exe.gz', binary: 'sakre-windows-x64.exe' };
    }

    // eslint-disable-next-line anti-slop/no-known-value-widening -- platform-specific engine target; annotation documents the shared shape
    return { runnerOs: 'Linux', asset: linuxAsset, binary: 'sakre-linux-x64' };
}

export async function writePwshEngineFixture(root: string): Promise<{ path: string; marker: string }> {
    if (process.platform === 'win32') {
        const fixture = path.join(root, 'fixture-engine.exe');
        await copyFile(process.execPath, fixture);

        return { path: fixture, marker: Bun.version };
    }

    const fixture = await writeExecutable(
        path.join(root, 'fixture-engine.sh'),
        '#!/usr/bin/env bash\nprintf "engine:%s\\n" "$*"\n'
    );

    return { path: fixture, marker: 'engine:--version' };
}

export function sha256(content: Uint8Array): string {
    return createHash('sha256').update(content).digest('hex');
}

export async function fileExists(file: string): Promise<boolean> {
    try {
        await stat(file);

        return true;
    } catch {
        return false;
    }
}
