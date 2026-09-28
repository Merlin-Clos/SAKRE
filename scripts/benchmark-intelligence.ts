import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { type GitTreeSnapshot, materializeGitTree } from '../src/analysis/snapshot';
import { classifyFile, defaultClassificationRules } from '../src/analysis/classification';
import { mapWithConcurrency } from '../src/concurrency';
import { type AnalysisTree, createAnalysisTree } from '../src/intelligence/analysis-tree';
import { classifySnapshots } from '../src/intelligence/classify-snapshots';
import { reviewMapLogPayload } from '../src/intelligence/log';
import { buildCcccArguments, type CcccSnapshot, parseCcccSnapshot } from '../src/intelligence/measure-cccc';
import { buildSccArguments, parseSccSnapshot, type SccSnapshot } from '../src/intelligence/measure-scc';
import { buildReviewMap } from '../src/intelligence/normalize';
import { type IntelligencePrePassInput, runIntelligencePrePass } from '../src/intelligence/pre-pass';
import { type ProjectionKind, projectReviewMap } from '../src/intelligence/project';
import { planSnapshotFiles } from '../src/intelligence/snapshot-files';
import type { ReviewMap } from '../src/intelligence/schema';
import { nativeToolVersion } from '../src/native/assets';
import { pinnedNativeAssetManifest } from '../src/native/runtime';
import type { VcsChangedFile } from '../src/vcs/types';

/* Reproducible ReviewMap benchmark: full-tree tool times and JSON sizes, child
   RSS, parse/build/projection costs, sequential-vs-concurrent comparison with
   materialization excluded, synthetic tracked-tree scaling at 200 / 2,000 /
   10,000 files, and the end-to-end production pre-pass on those same sizes. It
   prints Markdown; no repository file is modified. */

const PROJECTION_KINDS: ProjectionKind[] = ['common', 'maintainability', 'correctness', 'performance'];

const TOKEN_CHARS = 4;

const RENAME_TOKENS = 3;

const STATUS_TOKENS = 2;

const SHORT_SHA = 7;

const SYNTHETIC_FILE_GROUP = 100;

const MODULE_PAD = 3;

const FILE_PAD = 5;

const SYNTHETIC_WRITE_CONCURRENCY = 32;

const RSS_SAMPLE_INTERVAL_MS = 5;

const SYNTHETIC_SMALL = 200;

const SYNTHETIC_MEDIUM = 2000;

const SYNTHETIC_LARGE = 10_000;

const DEFAULT_SYNTHETIC_SIZES = [SYNTHETIC_SMALL, SYNTHETIC_MEDIUM, SYNTHETIC_LARGE];

const BYTES_PER_KIB = 1024;

const KIB_PER_MIB = 1024;

interface Options {
    repo: string;
    base: string;
    head: string;
    scc: string;
    cccc: string;
    runs: number;
    synthetic: number[];
    syntheticRuns: number;
}

async function main(): Promise<void> {
    const options = parseOptions(process.argv.slice(2));

    const sections = [
        await measureRepository(options),
        await measureSyntheticTrees(options),
        await measureSyntheticPrePass(options)
    ];

    console.log(sections.filter((section) => section !== '').join('\n\n'));
}

async function measureRepository(options: Options): Promise<string> {
    const baseTree = await materializeGitTree({ worktreeDir: options.repo, sha: options.base });
    const headTree = await materializeGitTree({ worktreeDir: options.repo, sha: options.head });

    try {
        const baseFiles = baseTree.listing.files.map((file) => file.path);
        const headFiles = headTree.listing.files.map((file) => file.path);
        const baseScc = await runScc(options, baseTree.directory);
        const headScc = await runScc(options, headTree.directory);
        const baseCccc = await runCccc(options, baseTree.directory, baseFiles);
        const headCccc = await runCccc(options, headTree.directory, headFiles);

        const parse = measureParseCosts({
            scc: [baseScc.raw, headScc.raw],
            cccc: [baseCccc.raw, headCccc.raw]
        });

        const changedFiles = readChangedFiles(options);

        const built = measureBuild(options, {
            baseScc: baseScc.snapshot,
            headScc: headScc.snapshot,
            baseCccc: baseCccc.snapshot,
            headCccc: headCccc.snapshot,
            baseFiles,
            headFiles,
            changedFiles
        });

        const timing = await compareSequentialVsConcurrent(options, {
            directory: baseTree.directory,
            files: baseFiles
        });

        return renderReport({
            options,
            baseFiles: baseFiles.length,
            headFiles: headFiles.length,
            changedFiles: changedFiles.length,
            sccSizes: [baseScc.duration, headScc.duration],
            ccccSizes: [baseCccc.duration, headCccc.duration],
            sccJsonSizes: [baseScc.raw.length, headScc.raw.length],
            ccccJsonSizes: [baseCccc.raw.length, headCccc.raw.length],
            sccRss: [baseScc.rssBytes, headScc.rssBytes],
            ccccRss: [baseCccc.rssBytes, headCccc.rssBytes],
            parse,
            projections: measureProjections(built.map),
            timing,
            mapJsonSize: JSON.stringify(built.map).length,
            logPayloadSize: reviewMapLogPayload(built.map).length,
            map: built.map,
            buildMs: built.buildMs
        });
    } finally {
        await headTree.close();
        await baseTree.close();
    }
}

interface BuildInput {
    baseScc: SccSnapshot;
    headScc: SccSnapshot;
    baseCccc: CcccSnapshot;
    headCccc: CcccSnapshot;
    baseFiles: string[];
    headFiles: string[];
    changedFiles: readonly VcsChangedFile[];
}

function measureBuild(options: Options, input: BuildInput): { map: ReviewMap; buildMs: number } {
    const rules = defaultClassificationRules();

    const classifications = new Map(
        input.changedFiles.map((file) => [
            file.path,
            classifyFile({ path: file.path, previousPath: file.previousPath, rules })
        ])
    );

    const started = performance.now();

    const map = buildReviewMap({
        revisions: { baseSha: options.base, headSha: options.head },
        tools: {
            scc: { version: nativeToolVersion(pinnedNativeAssetManifest, 'scc'), status: 'ok' },
            cccc: { version: nativeToolVersion(pinnedNativeAssetManifest, 'cccc'), status: 'ok' }
        },
        base: {
            scc: input.baseScc,
            cccc: input.baseCccc,
            requested: input.baseFiles,
            notCounted: [],
            unmeasurable: []
        },
        head: {
            scc: input.headScc,
            cccc: input.headCccc,
            requested: input.headFiles,
            notCounted: [],
            unmeasurable: []
        },
        changedFiles: input.changedFiles,
        classifications
    });

    // eslint-disable-next-line anti-slop/no-known-value-widening -- benchmark result contract; annotation documents the measured shape
    return { map, buildMs: performance.now() - started };
}

interface SyntheticTree {
    directory: string;
    files: string[];
}

async function measureSyntheticTrees(options: Options): Promise<string> {
    if (options.synthetic.length === 0) {
        return '';
    }

    const rounds: SyntheticRow[] = [];
    const trees: SyntheticTree[] = [];
    const root = await mkdtemp(path.join(tmpdir(), 'sakre-bench-synthetic-'));

    try {
        for (const size of options.synthetic) {
            const tree = await createSyntheticTree(root, size);
            const scc = await runScc(options, tree.directory);
            const cccc = await runCccc(options, tree.directory, tree.files);
            trees.push(tree);
            rounds.push({
                files: tree.files.length,
                pathChars: tree.files.reduce((total, file) => total + file.length + 1, 0),
                sccMs: scc.duration,
                sccBytes: scc.raw.length,
                sccRssBytes: scc.rssBytes,
                ccccMs: cccc.duration,
                ccccBytes: cccc.raw.length,
                ccccRssBytes: cccc.rssBytes
            });
        }

        const largest = trees.at(-1);
        const timing = await compareLargestSynthetic(options, largest);

        return renderSyntheticReport(rounds, timing, largest?.files.length ?? 0);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

function compareLargestSynthetic(
    options: Options,
    largest: SyntheticTree | undefined
): Promise<{ sequential: number[]; concurrent: number[] }> {
    if (largest === undefined) {
        return Promise.resolve({ sequential: [], concurrent: [] });
    }

    return compareSequentialVsConcurrent(
        { ...options, runs: Math.min(options.runs, options.syntheticRuns) },
        { directory: largest.directory, files: largest.files }
    );
}

interface SyntheticRow {
    files: number;
    pathChars: number;
    sccMs: number;
    sccBytes: number;
    sccRssBytes?: number;
    ccccMs: number;
    ccccBytes: number;
    ccccRssBytes?: number;
}

async function createSyntheticTree(root: string, size: number): Promise<SyntheticTree> {
    const directory = path.join(root, `tree-${String(size)}`);
    const files: string[] = [];

    for (let index = 0; index < size; index += 1) {
        files.push(
            `src/module-${String(Math.floor(index / SYNTHETIC_FILE_GROUP)).padStart(MODULE_PAD, '0')}/file-${String(index).padStart(FILE_PAD, '0')}.ts`
        );
    }

    await mapWithConcurrency(files, SYNTHETIC_WRITE_CONCURRENCY, async (file) => {
        const target = path.join(directory, file);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, `export const value${String(file.length)} = 1;\n`);
    });

    return { directory, files };
}

interface SyntheticRepository {
    directory: string;
    baseSha: string;
    headSha: string;
    changedFiles: VcsChangedFile[];
    files: string[];
}

interface PrePassRow {
    files: number;
    prePassMs: number;
    extractionMs: number;
    classificationMs: number;
    planningMs: number;
    materializationMs: number;
    cleanupMs: number;
    functions: number;
}

/* The production pre-pass measures full BASE and HEAD trees on a real two-commit repository; a second pass attributes the cost
   to extraction, classification, planning, materialization and cleanup. */
async function measureSyntheticPrePass(options: Options): Promise<string> {
    if (options.synthetic.length === 0) {
        return '';
    }

    const root = await mkdtemp(path.join(tmpdir(), 'sakre-bench-prepass-'));
    const rows: PrePassRow[] = [];

    try {
        for (const size of options.synthetic) {
            const tree = await createSyntheticTree(path.join(root, `size-${String(size)}`), size);
            const repository = commitSyntheticRepository(tree);
            rows.push(await measurePrePassRow(options, repository));
        }

        return renderPrePassReport(rows);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

function commitSyntheticRepository(tree: SyntheticTree): SyntheticRepository {
    git(tree.directory, ['init', '-q', '--initial-branch', 'main']);
    git(tree.directory, ['config', 'user.email', 'bench@sakre.local']);
    git(tree.directory, ['config', 'user.name', 'SAKRE Benchmark']);
    git(tree.directory, ['add', '-A']);
    git(tree.directory, ['commit', '-qm', 'base']);
    const baseSha = rev(tree.directory);
    /* One changed file: both full trees are still measured. */
    const changed = tree.files[0] ?? '';
    appendFileSync(path.join(tree.directory, changed), 'export const changed = 1;\n');
    git(tree.directory, ['add', '-A']);
    git(tree.directory, ['commit', '-qm', 'head']);

    return {
        directory: tree.directory,
        baseSha,
        headSha: rev(tree.directory),
        changedFiles: [{ path: changed, status: 'modified', additions: 1, deletions: 0, patch: { state: 'none' } }],
        files: tree.files
    };
}

async function measurePrePassRow(options: Options, repository: SyntheticRepository): Promise<PrePassRow> {
    const input: IntelligencePrePassInput = {
        worktreeDir: repository.directory,
        baseSha: repository.baseSha,
        headSha: repository.headSha,
        changedFiles: repository.changedFiles,
        classification: defaultClassificationRules(),
        sccBinaryPath: options.scc,
        ccccBinaryPath: options.cccc,
        sccVersion: nativeToolVersion(pinnedNativeAssetManifest, 'scc'),
        ccccVersion: nativeToolVersion(pinnedNativeAssetManifest, 'cccc')
    };

    const prePassStarted = performance.now();
    const output = await runIntelligencePrePass(input);
    const prePassMs = performance.now() - prePassStarted;

    const phases = await measurePrePassPhases(input);

    return { files: repository.files.length, prePassMs, ...phases, functions: output.map.functions.length };
}

interface PrePassPhases {
    extractionMs: number;
    classificationMs: number;
    planningMs: number;
    materializationMs: number;
    cleanupMs: number;
}

async function measurePrePassPhases(input: IntelligencePrePassInput): Promise<PrePassPhases> {
    const extractionStarted = performance.now();

    const baseTree = await materializeGitTree({
        worktreeDir: input.worktreeDir,
        sha: input.baseSha,
        signal: input.signal
    });

    let headTree: GitTreeSnapshot | undefined = undefined;

    try {
        headTree = await materializeGitTree({
            worktreeDir: input.worktreeDir,
            sha: input.headSha,
            signal: input.signal
        });
        const extractionMs = performance.now() - extractionStarted;

        const classificationStarted = performance.now();

        const classifications = await classifySnapshots({
            changedFiles: input.changedFiles,
            rules: input.classification,
            baseTree,
            headTree,
            signal: input.signal
        });

        const classificationMs = performance.now() - classificationStarted;

        const planningStarted = performance.now();
        const baseLists = planSnapshotFiles(baseTree.listing.files, classifications.base);
        const headLists = planSnapshotFiles(headTree.listing.files, classifications.head);
        const planningMs = performance.now() - planningStarted;

        const materializationStarted = performance.now();
        const materialized: AnalysisTree[] = [];

        try {
            materialized.push(
                await createAnalysisTree({
                    sourceDirectory: baseTree.directory,
                    files: baseLists.requested,
                    signal: input.signal
                }),
                await createAnalysisTree({
                    sourceDirectory: headTree.directory,
                    files: headLists.requested,
                    signal: input.signal
                })
            );
        } catch (error) {
            await Promise.all(materialized.map((tree) => tree.close()));
            throw error;
        }

        const materializationMs = performance.now() - materializationStarted;

        const cleanupStarted = performance.now();
        await Promise.all(materialized.map((tree) => tree.close()));
        const cleanupMs = performance.now() - cleanupStarted;

        return { extractionMs, classificationMs, planningMs, materializationMs, cleanupMs };
    } finally {
        await headTree?.close();
        await baseTree.close();
    }
}

function git(directory: string, args: readonly string[]): void {
    execFileSync('git', ['-C', directory, ...args], { stdio: 'ignore' });
}

function rev(directory: string): string {
    return execFileSync('git', ['-C', directory, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

interface RawRun<Snapshot> {
    raw: string;
    snapshot: Snapshot;
    duration: number;
    rssBytes?: number;
}

async function runScc(options: Options, directory: string): Promise<RawRun<SccSnapshot>> {
    const started = performance.now();

    const result = await runCaptured({
        command: options.scc,
        args: buildSccArguments(),
        directory,
        env: { ...process.env, SCC_CONFIG_PATH: '' }
    });

    const duration = performance.now() - started;

    if (result.exitCode !== 0) {
        throw new Error(`SCC failed with exit code ${result.exitCode}: ${result.stderr.trim()}`);
    }

    return { raw: result.stdout, snapshot: parseSccSnapshot(result.stdout), duration, rssBytes: result.rssBytes };
}

async function runCccc(options: Options, directory: string, files: string[]): Promise<RawRun<CcccSnapshot>> {
    const started = performance.now();

    const result = await runCaptured({
        command: options.cccc,
        args: buildCcccArguments(),
        directory,
        env: process.env
    });

    const duration = performance.now() - started;

    if (result.exitCode !== 0) {
        throw new Error(`CCCC failed with exit code ${result.exitCode}: ${result.stderr.trim()}`);
    }

    return {
        raw: result.stdout,
        snapshot: parseCcccSnapshot(result.stdout, files),
        duration,
        rssBytes: result.rssBytes
    };
}

interface CapturedRun {
    exitCode: number;
    stdout: string;
    stderr: string;
    rssBytes?: number;
}

interface CapturedInput {
    command: string;
    args: string[];
    directory: string;
    env: NodeJS.ProcessEnv;
}

/* Direct spawn so the child pid is available for RSS sampling; the sampling is
   Linux-only and reported as n/a elsewhere. */
function runCaptured(input: CapturedInput): Promise<CapturedRun> {
    return new Promise((resolve, reject) => {
        const child = spawn(input.command, input.args, {
            cwd: input.directory,
            env: input.env,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let stdout = '';
        let stderr = '';
        const samples: number[] = [];

        function sample(): void {
            sampleChildRss(child.pid).then((value) => {
                if (value !== undefined) {
                    samples.push(value);
                }
            }, ignoreSampleFailure);
        }

        const sampler = setInterval(sample, RSS_SAMPLE_INTERVAL_MS);
        /* Fast processes finish before the first interval tick. */
        sample();
        child.stdout.on('data', (chunk: Buffer) => {
            stdout += chunk.toString('utf8');
        });
        child.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString('utf8');
        });
        child.on('error', (error) => {
            clearInterval(sampler);
            reject(error);
        });
        child.on('close', (code) => {
            clearInterval(sampler);
            resolve({ exitCode: code ?? -1, stdout, stderr, rssBytes: peak(samples) });
        });
    });
}

async function sampleChildRss(pid: number | undefined): Promise<number | undefined> {
    if (process.platform !== 'linux' || pid === undefined) {
        return undefined;
    }

    try {
        const status = await readFile(`/proc/${String(pid)}/status`, 'utf8');
        const match = /^VmRSS:\s+(?<kib>\d+)\s+kB$/mu.exec(status);
        const kib = match?.groups?.kib;

        if (kib === undefined) {
            return undefined;
        }

        return Number(kib) * BYTES_PER_KIB;
    } catch {
        return undefined;
    }
}

function ignoreSampleFailure(): void {
    // A vanished process is not a benchmark failure; the sample is optional.
}

function peak(values: readonly number[]): number | undefined {
    if (values.length === 0) {
        return undefined;
    }

    return Math.max(...values);
}

function measureParseCosts(raw: { scc: string[]; cccc: string[] }): {
    sccMs: number;
    ccccMs: number;
} {
    const sccStarted = performance.now();

    for (const scc of raw.scc) {
        parseSccSnapshot(scc);
    }

    const sccMs = performance.now() - sccStarted;
    const ccccStarted = performance.now();

    for (const cccc of raw.cccc) {
        parseCcccSnapshot(cccc);
    }

    const ccccMs = performance.now() - ccccStarted;

    // eslint-disable-next-line anti-slop/no-known-value-widening -- benchmark result contract; annotation documents the measured shape
    return { sccMs, ccccMs };
}

function measureProjections(map: ReviewMap): { kind: string; chars: number; tokens: number; duration: number }[] {
    return PROJECTION_KINDS.map((kind) => {
        const started = performance.now();
        const text = projectReviewMap({ map, coverage: emptyCoverage(), kind });
        const duration = performance.now() - started;

        return { kind, chars: text.length, tokens: Math.ceil(text.length / TOKEN_CHARS), duration };
    });
}

/* The comparison times only the tool invocations on an already materialized
   directory; extraction is never part of the measured round. */
async function compareSequentialVsConcurrent(
    options: Options,
    tree: { directory: string; files: string[] }
): Promise<{ sequential: number[]; concurrent: number[] }> {
    const sequential: number[] = [];
    const concurrent: number[] = [];

    for (let run = 0; run < options.runs; run += 1) {
        sequential.push(await oneToolRound(options, tree, false));
        concurrent.push(await oneToolRound(options, tree, true));
    }

    return {
        sequential: sequential.toSorted((left, right) => left - right),
        concurrent: concurrent.toSorted((left, right) => left - right)
    };
}

async function oneToolRound(
    options: Options,
    tree: { directory: string; files: string[] },
    concurrent: boolean
): Promise<number> {
    const started = performance.now();

    if (concurrent) {
        await Promise.all([runScc(options, tree.directory), runCccc(options, tree.directory, tree.files)]);
    } else {
        await runScc(options, tree.directory);
        await runCccc(options, tree.directory, tree.files);
    }

    return performance.now() - started;
}

function readChangedFiles(options: Options): VcsChangedFile[] {
    const output = execFileSync(
        'git',
        ['-C', options.repo, 'diff', '--name-status', '-z', options.base, options.head],
        {
            encoding: 'utf8'
        }
    );

    const tokens = output.split('\0');
    const files: VcsChangedFile[] = [];
    let index = 0;

    while (index < tokens.length) {
        const status = tokens[index];

        if (status === undefined || status === '') {
            index += 1;
        } else {
            const renamed = status.startsWith('R');

            if (renamed) {
                files.push({
                    path: tokens[index + 2] ?? '',
                    previousPath: tokens[index + 1],
                    status: 'renamed',
                    additions: 0,
                    deletions: 0,
                    patch: { state: 'none' }
                });
                index += RENAME_TOKENS;
            } else {
                files.push({
                    path: tokens[index + 1] ?? '',
                    status: mapGitStatus(status[0] ?? 'M'),
                    additions: 0,
                    deletions: 0,
                    patch: { state: 'none' }
                });
                index += STATUS_TOKENS;
            }
        }
    }

    return files;
}

function mapGitStatus(kind: string): VcsChangedFile['status'] {
    if (kind === 'A') {
        return 'added';
    }

    if (kind === 'D') {
        return 'removed';
    }

    if (kind === 'R') {
        return 'renamed';
    }

    return 'modified';
}

function emptyCoverage(): Parameters<typeof projectReviewMap>[0]['coverage'] {
    return { unifiedDiff: '', files: [], complete: true };
}

interface ReportInput {
    options: Options;
    baseFiles: number;
    headFiles: number;
    changedFiles: number;
    sccSizes: number[];
    ccccSizes: number[];
    sccJsonSizes: number[];
    ccccJsonSizes: number[];
    sccRss: (number | undefined)[];
    ccccRss: (number | undefined)[];
    parse: { sccMs: number; ccccMs: number };
    projections: { kind: string; chars: number; tokens: number; duration: number }[];
    timing: { sequential: number[]; concurrent: number[] };
    mapJsonSize: number;
    logPayloadSize: number;
    map: ReviewMap;
    buildMs: number;
}

function renderReport(input: ReportInput): string {
    const lines: string[] = [
        '# SAKRE intelligence benchmark',
        '',
        `Repository: \`${input.options.repo}\`, BASE \`${input.options.base.slice(0, SHORT_SHA)}\` -> HEAD \`${input.options.head.slice(0, SHORT_SHA)}\``,
        `Snapshots: BASE ${input.baseFiles} files, HEAD ${input.headFiles} files, changed ${input.changedFiles}`,
        `Map: ${input.map.files.length} changed files, ${input.map.functions.length} functions, warnings ${input.map.warnings.length}`,
        '',
        '## Tool times, JSON sizes and child RSS',
        '',
        '| Tool | Run | ms | JSON chars | child RSS |',
        '| --- | --- | ---: | ---: | ---: |',
        `| SCC | BASE | ${input.sccSizes[0]?.toFixed(1)} | ${input.sccJsonSizes[0]} | ${formatBytes(input.sccRss[0])} |`,
        `| SCC | HEAD | ${input.sccSizes[1]?.toFixed(1)} | ${input.sccJsonSizes[1]} | ${formatBytes(input.sccRss[1])} |`,
        `| CCCC | BASE | ${input.ccccSizes[0]?.toFixed(1)} | ${input.ccccJsonSizes[0]} | ${formatBytes(input.ccccRss[0])} |`,
        `| CCCC | HEAD | ${input.ccccSizes[1]?.toFixed(1)} | ${input.ccccJsonSizes[1]} | ${formatBytes(input.ccccRss[1])} |`,
        '',
        '## Parse and assemble',
        '',
        '| Step | ms |',
        '| --- | ---: |',
        `| parse both SCC snapshots | ${input.parse.sccMs.toFixed(2)} |`,
        `| parse both CCCC snapshots | ${input.parse.ccccMs.toFixed(2)} |`,
        `| build ReviewMap | ${input.buildMs.toFixed(2)} |`,
        '',
        '## Projection sizes',
        '',
        '| Projection | chars | ~tokens | ms |',
        '| --- | ---: | ---: | ---: |',
        ...input.projections.map(
            (projection) =>
                `| ${projection.kind} | ${projection.chars} | ${projection.tokens} | ${projection.duration.toFixed(2)} |`
        ),
        '',
        '## Sequential vs concurrent (BASE SCC + CCCC, extraction excluded)',
        '',
        `Runs: ${input.timing.sequential.length}; sequential samples [${input.timing.sequential.map((value) => value.toFixed(0)).join(', ')}] ms.`,
        `Concurrent samples [${input.timing.concurrent.map((value) => value.toFixed(0)).join(', ')}] ms.`,
        `Sequential median ${formatNumber(median(input.timing.sequential))} ms; concurrent median ${formatNumber(median(input.timing.concurrent))} ms.`,
        '',
        '## Full-map and log payload',
        '',
        '| Payload | chars |',
        '| --- | ---: |',
        `| canonical ReviewMap JSON | ${input.mapJsonSize} |`,
        `| log payload (cap applied) | ${input.logPayloadSize} |`
    ];

    return lines.join('\n');
}

function renderSyntheticReport(
    rows: SyntheticRow[],
    timing: { sequential: number[]; concurrent: number[] },
    largest: number
): string {
    const lines: string[] = [
        '# SAKRE synthetic tracked-tree scaling',
        '',
        'Full SCC + CCCC scans per tree size, measured on materialized directories.',
        '',
        '| tracked files | path argv chars | SCC ms | SCC JSON | SCC RSS | CCCC ms | CCCC JSON | CCCC RSS |',
        '| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
        ...rows.map(
            (row) =>
                `| ${row.files} | ${row.pathChars} | ${row.sccMs.toFixed(1)} | ${row.sccBytes} | ${formatBytes(row.sccRssBytes)} | ${row.ccccMs.toFixed(1)} | ${row.ccccBytes} | ${formatBytes(row.ccccRssBytes)} |`
        ),
        '',
        `## Sequential vs concurrent at ${largest} files (extraction excluded)`,
        '',
        `Runs: ${timing.sequential.length}; sequential samples [${timing.sequential.map((value) => value.toFixed(0)).join(', ')}] ms.`,
        `Concurrent samples [${timing.concurrent.map((value) => value.toFixed(0)).join(', ')}] ms.`,
        `Sequential median ${formatNumber(median(timing.sequential))} ms; concurrent median ${formatNumber(median(timing.concurrent))} ms.`
    ];

    return lines.join('\n');
}

/* Only the end-to-end section includes extraction, classification, filtered materialization and cleanup; the tool-only sections exclude them. */
function renderPrePassReport(rows: PrePassRow[]): string {
    return [
        '# SAKRE synthetic pre-pass end-to-end',
        '',
        'The production `runIntelligencePrePass` on a real two-commit repository with one changed file, plus one phase-attribution pass on the same fixture. The pre-pass column includes `git archive | tar` extraction, bounded prefix classification of both trees, filtered analysis-tree materialization, both tool runs and cleanup.',
        '',
        '| tracked files | pre-pass E2E ms | extraction ms | classification ms | planning ms | materialization ms | cleanup ms | functions |',
        '| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
        ...rows.map(
            (row) =>
                `| ${row.files} | ${row.prePassMs.toFixed(1)} | ${row.extractionMs.toFixed(1)} | ${row.classificationMs.toFixed(1)} | ${row.planningMs.toFixed(1)} | ${row.materializationMs.toFixed(1)} | ${row.cleanupMs.toFixed(1)} | ${row.functions} |`
        )
    ].join('\n');
}

/* Proper median: the average of the two middle values for an even count. */
export function median(values: number[]): number {
    if (values.length === 0) {
        return 0;
    }

    const sorted = [...values].toSorted((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);

    if (sorted.length % 2 === 1) {
        return sorted[middle] ?? 0;
    }

    const lower = sorted[middle - 1];
    const upper = sorted[middle];

    if (lower === undefined || upper === undefined) {
        return 0;
    }

    return (lower + upper) / 2;
}

function formatNumber(value: number): string {
    return value.toFixed(1);
}

function formatBytes(value: number | undefined): string {
    if (value === undefined) {
        return 'n/a';
    }

    if (value < BYTES_PER_KIB * KIB_PER_MIB) {
        return `${(value / BYTES_PER_KIB).toFixed(0)} KB`;
    }

    return `${(value / (BYTES_PER_KIB * KIB_PER_MIB)).toFixed(1)} MB`;
}

// eslint-disable-next-line anti-slop/no-unknown-parameters -- catch-path normalizer; narrows with instanceof before use
function describeError(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }

    return String(error);
}

const VALUED_OPTIONS = new Set([
    '--repo',
    '--base',
    '--head',
    '--scc',
    '--cccc',
    '--runs',
    '--synthetic-runs',
    '--synthetic'
]);

export function parseOptions(args: string[]): Options {
    const options: Options = {
        repo: process.cwd(),
        base: 'HEAD~1',
        head: 'HEAD',
        scc: process.env.SAKRE_SCC_BINARY ?? 'scc',
        cccc: process.env.SAKRE_CCCC_BINARY ?? 'cccc',
        runs: 5,
        synthetic: [...DEFAULT_SYNTHETIC_SIZES],
        syntheticRuns: 3
    };

    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index] ?? '';

        if (argument === '--no-synthetic') {
            options.synthetic = [];
        } else {
            index = applyOption(options, { args, index, name: argument });
        }
    }

    return options;
}

interface OptionToken {
    args: string[];
    index: number;
    name: string;
}

function applyOption(options: Options, token: OptionToken): number {
    if (!VALUED_OPTIONS.has(token.name)) {
        throw new Error(`Unknown option ${JSON.stringify(token.name)}.`);
    }

    const value = optionValue(token.args, token.index, token.name);

    if (token.name === '--repo') {
        options.repo = value;
    } else if (token.name === '--base') {
        options.base = value;
    } else if (token.name === '--head') {
        options.head = value;
    } else if (token.name === '--scc') {
        options.scc = value;
    } else if (token.name === '--cccc') {
        options.cccc = value;
    } else if (token.name === '--runs') {
        options.runs = positiveInteger(value, '--runs');
    } else if (token.name === '--synthetic-runs') {
        options.syntheticRuns = positiveInteger(value, '--synthetic-runs');
    } else {
        options.synthetic = parseSizes(value);
    }

    return token.index + 1;
}

/* A valued option never consumes the next option token: `--synthetic
   --no-synthetic` must fail instead of silently changing the measured scope. */
function optionValue(args: readonly string[], index: number, option: string): string {
    const value = args[index + 1];

    if (value === undefined || value === '' || value.startsWith('--')) {
        throw new Error(`${option} requires a value.`);
    }

    return value;
}

/* Commander has no integer parser here; an invalid count must fail instead of
   producing a plausible report with zero runs. */
function positiveInteger(value: string, option: string): number {
    if (!/^\d+$/u.test(value) || Number(value) < 1) {
        throw new Error(`${option} must be a positive integer, received ${JSON.stringify(value)}.`);
    }

    return Number(value);
}

function parseSizes(value: string): number[] {
    return value.split(',').map((entry) => positiveInteger(entry, '--synthetic'));
}

if (import.meta.main) {
    try {
        await main();
    } catch (error) {
        console.error(describeError(error));
        process.exit(1);
    }
}
