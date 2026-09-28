import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/* Measures the delivered composite Action instead of assuming a cache win:
   direct release download, cache-hit bootstrap (resolve + verify + chmod),
   resolver execution and binary cold start. The resolver review runs execute
   the real `local --mock` cycle, so native materialization, the engine host and
   the review pipeline are included, not just `--version` startup. It is driven
   by the workflow_dispatch Engine delivery benchmark workflow and writes a
   markdown table to $GITHUB_STEP_SUMMARY. */

const REPOSITORY_ROOT = path.resolve(import.meta.dir, '..');

const DOWNLOAD_RUNS = 3;

const CACHE_RUNS = 5;

const COLD_START_RUNS = 5;

const CACHE_STAGING_DIRECTORY = 'benchmark-cache';

const PHASE_LINE_PREFIX = 'sakre-engine: ';

const ENGINE_CACHE_DIRECTORY = 'sakre-engine';

const JSON_INDENT = 4;

const KIBIBYTE = 1024;

const BYTES_PER_MEBIBYTE = KIBIBYTE * KIBIBYTE;

const DEFAULT_ARCHITECTURE = 'X64';

interface BenchmarkOptions {
    tag: string;
    artifact: string;
}

interface PhaseMetrics {
    source: string;
    resolve_ms: number;
    download_ms: number;
    verify_ms: number;
    install_ms: number;
    bootstrap_ms: number;
    execute_ms: number;
    total_ms: number;
}

interface CommandResult {
    exitCode: number | null;
    stdout: string;
    stderr: string;
}

interface TimedCommand extends CommandResult {
    elapsedMs: number;
}

interface ReviewFixture {
    repositoryDir: string;
    baseSha: string;
    headSha: string;
}

interface ResolverContext {
    actionPath: string;
    runnerTemp: string;
    repository: string;
    summaryPath: string;
    home: string;
    cache: string;
    fixture: ReviewFixture;
}

function readOptionPairs(args: readonly string[]): Map<string, string> {
    const values = new Map<string, string>();

    for (let index = 0; index < args.length; index += 2) {
        const name = args[index] ?? '';
        const value = args[index + 1];

        if (!name.startsWith('--') || value === undefined) {
            throw new Error(`Unknown argument: ${name}`);
        }

        values.set(name.slice(2), value);
    }

    return values;
}

function parseOptions(args: readonly string[]): BenchmarkOptions {
    const values = readOptionPairs(args);
    const tag = values.get('tag') ?? '';
    const artifact = values.get('artifact') ?? '';

    if (tag === '' || artifact === '') {
        throw new Error('Usage: bun scripts/benchmark-action.ts --tag <benchmark-tag> --artifact <path>');
    }

    return { tag, artifact };
}

function runnerOs(): string {
    if (process.env.RUNNER_OS !== undefined && process.env.RUNNER_OS !== '') {
        return process.env.RUNNER_OS;
    }

    if (process.platform === 'linux') {
        return 'Linux';
    }

    if (process.platform === 'darwin') {
        return 'macOS';
    }

    return 'Windows';
}

function runnerArch(): string {
    if (process.env.RUNNER_ARCH !== undefined && process.env.RUNNER_ARCH !== '') {
        return process.env.RUNNER_ARCH;
    }

    if (process.arch === 'arm64') {
        return 'ARM64';
    }

    return DEFAULT_ARCHITECTURE;
}

function resolverInvocation(args: readonly string[]): { command: string; arguments: string[] } {
    if (process.platform === 'win32') {
        // eslint-disable-next-line anti-slop/no-known-value-widening -- script-local result contract; both branches return this shape
        return {
            command: 'pwsh',
            arguments: ['-NoProfile', '-File', path.join(REPOSITORY_ROOT, 'action', 'resolve-engine.ps1'), ...args]
        };
    }

    // eslint-disable-next-line anti-slop/no-known-value-widening -- script-local result contract; both branches return this shape
    return {
        command: 'bash',
        arguments: [path.join(REPOSITORY_ROOT, 'action', 'resolve-engine.sh'), ...args]
    };
}

function reviewArguments(context: ResolverContext): string[] {
    return [
        'local',
        '--mock',
        '--base',
        context.fixture.baseSha,
        '--head',
        context.fixture.headSha,
        '--repo',
        context.fixture.repositoryDir
    ];
}

function toNumber(fields: ReadonlyMap<string, string>, name: string): number {
    const value = fields.get(name);

    if (value === undefined) {
        throw new Error(`The composite resolver did not report ${name}.`);
    }

    return Number(value);
}

function parsePhaseMetrics(stderr: string): PhaseMetrics {
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

    const phases: PhaseMetrics = {
        source: fields.get('source') ?? 'unknown',
        resolve_ms: toNumber(fields, 'resolve_ms'),
        download_ms: toNumber(fields, 'download_ms'),
        verify_ms: toNumber(fields, 'verify_ms'),
        install_ms: toNumber(fields, 'install_ms'),
        bootstrap_ms: toNumber(fields, 'bootstrap_ms'),
        execute_ms: toNumber(fields, 'execute_ms'),
        total_ms: toNumber(fields, 'total_ms')
    };

    /* A benchmark must fail on implausible timings instead of printing zeros:
       a real download cannot take no time, and the total includes it. */
    if (phases.total_ms < phases.download_ms) {
        throw new Error(
            `The composite resolver reported total_ms (${phases.total_ms}) below download_ms (${phases.download_ms}): ${line}`
        );
    }

    if (phases.source === 'download' && phases.download_ms <= 0) {
        throw new Error(`The composite resolver reported a non-positive download_ms for a download: ${line}`);
    }

    return phases;
}

function timeResolver(
    context: ResolverContext,
    args: readonly string[]
): Promise<{ result: TimedCommand; phases: PhaseMetrics }> {
    const invocation = resolverInvocation(args);

    return new Promise((resolve, reject) => {
        const started = Date.now();

        const child = spawn(invocation.command, invocation.arguments, {
            env: {
                ...process.env,
                HOME: context.home,
                XDG_CACHE_HOME: context.cache,
                XDG_DATA_HOME: path.join(context.home, 'data'),
                LOCALAPPDATA: context.cache,
                GITHUB_ACTION_PATH: context.actionPath,
                GITHUB_ACTION_REPOSITORY: context.repository,
                GITHUB_ACTION_REF: '',
                GITHUB_STEP_SUMMARY: context.summaryPath,
                RUNNER_OS: runnerOs(),
                RUNNER_ARCH: runnerArch(),
                RUNNER_TEMP: context.runnerTemp,
                SAKRE_ENGINE_BINARY: ''
            },
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
        child.on('close', (exitCode) => {
            const result = { exitCode, stdout, stderr, elapsedMs: Date.now() - started };

            try {
                resolve({ result, phases: parsePhaseMetrics(stderr) });
            } catch (error) {
                reject(toError(error));
            }
        });
    });
}

// eslint-disable-next-line anti-slop/no-unknown-parameters -- catch-path normalizer; narrows with instanceof before use
function toError(error: unknown): Error {
    if (error instanceof Error) {
        return error;
    }

    return new Error(String(error));
}

function timeDirect(command: string, args: readonly string[]): Promise<TimedCommand> {
    return new Promise((resolve, reject) => {
        const started = Date.now();
        const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => {
            stdout += chunk.toString('utf8');
        });
        child.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString('utf8');
        });
        child.on('error', reject);
        child.on('close', (exitCode) => {
            resolve({ exitCode, stdout, stderr, elapsedMs: Date.now() - started });
        });
    });
}

function summarize(values: readonly number[]): string {
    const sorted = [...values].toSorted((left, right) => left - right);
    const minimum = sorted.at(0) ?? 0;
    const middle = sorted.at(Math.floor(sorted.length / 2)) ?? 0;
    const maximum = sorted.at(-1) ?? 0;

    return `${minimum} | ${middle} | ${maximum}`;
}

function requireSuccess(result: CommandResult, label: string): void {
    if (result.exitCode !== 0) {
        throw new Error(`${label} failed with exit code ${String(result.exitCode)}:\n${result.stderr}`);
    }
}

async function measureDownloads(context: ResolverContext, tag: string): Promise<PhaseMetrics[]> {
    const phases: PhaseMetrics[] = [];

    for (let run = 0; run < DOWNLOAD_RUNS; run += 1) {
        await rm(path.join(context.runnerTemp, ENGINE_CACHE_DIRECTORY, tag), { recursive: true, force: true });
        const measured = await timeResolver(context, reviewArguments(context));
        requireSuccess(measured.result, `download benchmark run ${run + 1}`);

        if (!measured.result.stdout.includes('Reviewed commit:')) {
            throw new Error(`The download benchmark review did not complete:\n${measured.result.stdout}`);
        }

        phases.push(measured.phases);
    }

    return phases;
}

async function measureCacheBootstrap(context: ResolverContext): Promise<PhaseMetrics[]> {
    const phases: PhaseMetrics[] = [];

    for (let run = 0; run < CACHE_RUNS; run += 1) {
        const measured = await timeResolver(context, reviewArguments(context));
        requireSuccess(measured.result, `cache bootstrap run ${run + 1}`);

        if (measured.phases.source !== 'cache') {
            throw new Error(`Expected a cache hit on bootstrap run ${run + 1}, got ${measured.phases.source}.`);
        }

        if (!measured.result.stdout.includes('Reviewed commit:')) {
            throw new Error(`The cache benchmark review did not complete:\n${measured.result.stdout}`);
        }

        phases.push(measured.phases);
    }

    return phases;
}

async function measureColdStarts(artifact: string): Promise<number[]> {
    const durations: number[] = [];

    for (let run = 0; run < COLD_START_RUNS; run += 1) {
        const result = await timeDirect(artifact, ['--version']);
        requireSuccess(result, `cold start run ${run + 1}`);
        durations.push(result.elapsedMs);
    }

    return durations;
}

function benchmarkTable(input: {
    asset: string;
    tag: string;
    artifactBytes: number;
    downloads: readonly PhaseMetrics[];
    cache: readonly PhaseMetrics[];
    coldStarts: readonly number[];
}): string {
    const megabytes = Math.round(input.artifactBytes / BYTES_PER_MEBIBYTE);

    return [
        `### SAKRE delivery benchmark: ${input.asset}`,
        '',
        `Pin: \`${input.tag}\`, artifact: ${megabytes} MiB, runner: ${runnerOs()}/${runnerArch()}`,
        '',
        '| Measurement | min (ms) | median (ms) | max (ms) |',
        '| --- | ---: | ---: | ---: |',
        `| composite bootstrap, direct download (${DOWNLOAD_RUNS} cold runs) | ${summarize(input.downloads.map((phase) => phase.bootstrap_ms))} |`,
        `| direct release download only (${DOWNLOAD_RUNS} cold runs) | ${summarize(input.downloads.map((phase) => phase.download_ms))} |`,
        `| composite bootstrap, RUNNER_TEMP cache hit (${CACHE_RUNS} runs) | ${summarize(input.cache.map((phase) => phase.bootstrap_ms))} |`,
        `| verify (SHA-256) on cache hit (${CACHE_RUNS} runs) | ${summarize(input.cache.map((phase) => phase.verify_ms))} |`,
        `| mock review through the resolver, cold download (${DOWNLOAD_RUNS} runs) | ${summarize(input.downloads.map((phase) => phase.execute_ms))} |`,
        `| mock review through the resolver, cache hit (${CACHE_RUNS} runs) | ${summarize(input.cache.map((phase) => phase.execute_ms))} |`,
        `| binary cold start, direct \`--version\` (${COLD_START_RUNS} runs) | ${summarize(input.coldStarts)} |`,
        ''
    ].join('\n');
}

async function writeTable(table: string): Promise<void> {
    const summary = process.env.GITHUB_STEP_SUMMARY;

    if (summary !== undefined && summary !== '') {
        await writeFile(summary, table, { flag: 'a' });
    }

    console.log(table);
}

function git(repositoryDir: string, args: readonly string[]): string {
    const result = spawnSync('git', [...args], { cwd: repositoryDir, encoding: 'utf8' });

    if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    }

    return result.stdout.trim();
}

/* A tiny repository with a real base..head diff; the mock review still runs the
   diff coverage, native SCC materialization, the engine host and the pipeline. */
async function createReviewFixture(root: string): Promise<ReviewFixture> {
    const repositoryDir = path.join(root, 'repository');
    await mkdir(path.join(repositoryDir, 'src'), { recursive: true });
    git(repositoryDir, ['init', '-q', '-b', 'main']);
    git(repositoryDir, ['config', 'user.email', 'benchmark@example.com']);
    git(repositoryDir, ['config', 'user.name', 'Benchmark Fixture']);
    await writeFile(path.join(repositoryDir, 'src', 'app.js'), 'export const value = 1;\n', 'utf8');
    git(repositoryDir, ['add', '-A']);
    git(repositoryDir, ['commit', '-qm', 'base']);
    const baseSha = git(repositoryDir, ['rev-parse', 'HEAD']);
    await writeFile(path.join(repositoryDir, 'src', 'app.js'), 'export const value = 2;\n', 'utf8');
    git(repositoryDir, ['add', '-A']);
    git(repositoryDir, ['commit', '-qm', 'head']);

    return { repositoryDir, baseSha, headSha: git(repositoryDir, ['rev-parse', 'HEAD']) };
}

async function main(): Promise<void> {
    const options = parseOptions(process.argv.slice(2));
    const artifact = path.resolve(options.artifact);
    const artifactStat = await stat(artifact);

    const digest = createHash('sha256')
        .update(await readFile(artifact))
        .digest('hex');

    const repository = process.env.GITHUB_REPOSITORY ?? '';

    if (repository === '') {
        throw new Error('GITHUB_REPOSITORY is not set; the benchmark downloads a real release asset.');
    }

    const asset = path.basename(artifact);
    const root = await mkdtemp(path.join(tmpdir(), 'sakre-benchmark-'));
    const actionPath = path.join(root, 'action');
    const runnerTemp = path.join(root, 'runner-temp');
    const home = path.join(root, 'home');
    const cache = path.join(root, 'cache');
    const summaryPath = path.join(root, 'step-summary.md');

    try {
        await Promise.all([mkdir(actionPath), mkdir(runnerTemp), mkdir(home), mkdir(cache)]);
        await writeFile(
            path.join(actionPath, 'engine-pins.json'),
            `${JSON.stringify({ tag: options.tag, assets: { [`${asset}.gz`]: digest } }, null, JSON_INDENT)}\n`,
            'utf8'
        );
        const fixture = await createReviewFixture(root);
        const context = { actionPath, runnerTemp, repository, summaryPath, home, cache, fixture };
        const downloads = await measureDownloads(context, options.tag);
        const cacheHits = await measureCacheBootstrap(context);
        const coldStarts = await measureColdStarts(artifact);
        const staging = path.join(REPOSITORY_ROOT, CACHE_STAGING_DIRECTORY);
        await mkdir(staging, { recursive: true });
        await copyFile(path.join(runnerTemp, ENGINE_CACHE_DIRECTORY, options.tag, asset), path.join(staging, asset));
        await writeTable(
            benchmarkTable({
                asset,
                tag: options.tag,
                artifactBytes: artifactStat.size,
                downloads,
                cache: cacheHits,
                coldStarts
            })
        );
        console.log(`Staged the delivered engine in ${staging} for the cache measurement.`);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

// eslint-disable-next-line anti-slop/no-unknown-parameters -- catch-path normalizer; narrows with instanceof before use
function describeError(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }

    return String(error);
}

if (import.meta.main) {
    try {
        await main();
    } catch (error) {
        console.error(describeError(error));
        process.exit(1);
    }
}
