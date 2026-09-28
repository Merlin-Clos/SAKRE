import { describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { classifyFile, defaultClassificationRules } from '../../src/analysis/classification';
import { CancelledError } from '../../src/analysis/cancellation';
import { SnapshotError } from '../../src/analysis/snapshot';
import { type IntelligencePrePassInput, runIntelligencePrePass } from '../../src/intelligence/pre-pass';
import { planSnapshotFiles } from '../../src/intelligence/snapshot-files';
import type { VcsChangedFile } from '../../src/vcs/types';
import { resolvePinnedBinary } from '../helpers/native-binary';
import { rejectionOf } from '../helpers/rejection';
import { scriptedTool } from '../helpers/scripted-tool';

/* End-to-end pre-pass integration on a real Git repository. The real-tool case
   needs the pinned SCC/CCCC binaries; the failure-semantics and dirty-tree cases
   script the tools so they stay deterministic everywhere. */

const sccBinary = await resolvePinnedBinary('scc', '4.1.0', 'SAKRE_SCC_BINARY');

const ccccBinary = await resolvePinnedBinary('cccc', '1.6.0', 'SAKRE_CCCC_BINARY');

const realTools = sccBinary !== undefined && ccccBinary !== undefined;

/* A scripted SCC whose `Code` is the line count of `src/a.ts` read from the
   directory it is invoked on: comparing a clean and a dirty run then proves
   which tree was actually measured. */
const LINE_COUNTING_SCC = `import { readFileSync } from 'node:fs';

const code = readFileSync('src/a.ts', 'utf8').split('\\n').length - 1;
console.log(JSON.stringify([{ Name: 'TypeScript', Count: 1, Lines: code, Code: code, Comment: 0, Blank: 0, Bytes: 10, Complexity: 0, Cognitive: 0, ULOC: code, Files: [] }]));
`;

const EMPTY_CCCC = `console.log(JSON.stringify({ files: [], summary: { file_count: 0, function_count: 0, parse_error_count: 0, parse_error_file_count: 0, cognitive: { sum: 0, max: 0, median: 0, p90: 0, p95: 0 }, cyclomatic: { sum: 0, max: 0, median: 0, p90: 0, p95: 0 } } }));
`;

const FIXED_SCC = `console.log(JSON.stringify([{ Name: 'TypeScript', Count: 1, Lines: 5, Code: 4, Comment: 0, Blank: 1, Bytes: 50, Complexity: 1, Cognitive: 1, ULOC: 4, Files: [] }]));
`;

interface Fixture {
    rootDir: string;
    baseSha: string;
    headSha: string;
}

async function createFixture(): Promise<Fixture> {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'sakre-prepass-'));
    git(rootDir, ['init', '--initial-branch', 'main']);
    git(rootDir, ['config', 'user.email', 'fixture@sakre.local']);
    git(rootDir, ['config', 'user.name', 'SAKRE Fixture']);
    await mkdir(path.join(rootDir, 'src'), { recursive: true });
    await Promise.all([
        writeFile(path.join(rootDir, 'src', 'a.ts'), 'export function handler(a: number) { return a + 1; }\n'),
        writeFile(path.join(rootDir, 'README.md'), '# fixture\n\nbase docs\n'),
        writeFile(path.join(rootDir, 'bun.lock'), '{"lockfileVersion":1}\n')
    ]);
    git(rootDir, ['add', '-A']);
    git(rootDir, ['commit', '-m', 'base']);
    const baseSha = rev(rootDir);
    await Promise.all([
        writeFile(
            path.join(rootDir, 'src', 'a.ts'),
            'export function handler(a: number) { if (a > 0) { return a + 1; } return 0; }\nexport function added() { return 1; }\n'
        ),
        writeFile(path.join(rootDir, 'src', 'b.ts'), 'export const b = 1;\n'),
        writeFile(path.join(rootDir, 'bun.lock'), '{"lockfileVersion":2}\n'),
        /* Hostile tool configuration committed at HEAD: --no-config, --no-ignore
           and --no-cache must keep it out of the measurement. */
        writeFile(path.join(rootDir, 'cccc.toml'), 'exclude = ["**/*.ts"]\n'),
        writeFile(path.join(rootDir, '.cccc.toml'), 'exclude = ["**/*.ts"]\n'),
        writeFile(path.join(rootDir, '.gitignore'), '*.ts\n'),
        writeFile(path.join(rootDir, '.cccc.cache'), 'hostile cache bytes\n')
    ]);
    git(rootDir, ['add', '-A']);
    git(rootDir, ['commit', '-m', 'head']);

    return { rootDir, baseSha, headSha: rev(rootDir) };
}

function git(cwd: string, args: readonly string[]): void {
    execSync(['git', ...args].join(' '), { cwd, encoding: 'utf8', stdio: 'ignore' });
}

function rev(cwd: string): string {
    return execSync('git rev-parse HEAD', { cwd, encoding: 'utf8' }).trim();
}

async function waitForFile(file: string): Promise<void> {
    const deadline = Date.now() + 10_000;

    while (!(await Bun.file(file).exists())) {
        if (Date.now() > deadline) {
            throw new Error(`Timed out waiting for ${file}.`);
        }

        await new Promise((resolve) => {
            setTimeout(resolve, 10);
        });
    }
}

/* The cancellation test leaves its measured analysis tree mode 000 on POSIX so
   the cleanup failure cannot be avoided. Restore access before removing it. */
async function removeMeasuredTree(directory: string | null): Promise<void> {
    if (directory === null) {
        return;
    }

    try {
        await chmod(directory, 0o700);
        await rm(directory, { recursive: true, force: true });
    } catch {
        // The assertion already reported the behavior under test.
    }
}

function changedFiles(): VcsChangedFile[] {
    return [
        { path: 'src/a.ts', status: 'modified', additions: 2, deletions: 1, patch: { state: 'none' } },
        { path: 'src/b.ts', status: 'added', additions: 1, deletions: 0, patch: { state: 'none' } },
        { path: 'bun.lock', status: 'modified', additions: 1, deletions: 1, patch: { state: 'none' } }
    ];
}

describe('deterministic pre-pass', () => {
    test('plans a counted but unmaterializable path as unmeasurable instead of failing', () => {
        const rules = defaultClassificationRules();
        const backslash = String.raw`src/a\b.ts`;

        const files = [
            { path: 'src/a.ts', blobSha: 'a'.repeat(40) },
            { path: backslash, blobSha: 'b'.repeat(40) },
            { path: 'bun.lock', blobSha: 'c'.repeat(40) }
        ];

        const classifications = new Map([
            ['src/a.ts', classifyFile({ path: 'src/a.ts', rules })],
            [backslash, classifyFile({ path: backslash, rules })],
            ['bun.lock', classifyFile({ path: 'bun.lock', rules })]
        ]);

        expect(planSnapshotFiles(files, classifications)).toEqual({
            requested: ['src/a.ts'],
            notCounted: ['bun.lock'],
            unmeasurable: [backslash]
        });
    });

    test.skipIf(process.platform === 'win32')(
        'reviews a repository whose HEAD adds a backslash path instead of aborting',
        async () => {
            const fixture = await createBackslashFixture();
            const tools = await mkdtemp(path.join(tmpdir(), 'sakre-prepass-backslash-tools-'));

            try {
                const sccTool = await scriptedTool(tools, 'scc', FIXED_SCC);
                const ccccTool = await scriptedTool(tools, 'cccc', EMPTY_CCCC);
                const backslash = String.raw`src/a\b.ts`;

                const measured = await runIntelligencePrePass({
                    worktreeDir: fixture.rootDir,
                    baseSha: fixture.baseSha,
                    headSha: fixture.headSha,
                    changedFiles: [
                        { path: 'src/a.ts', status: 'modified', additions: 1, deletions: 1, patch: { state: 'none' } },
                        { path: backslash, status: 'added', additions: 1, deletions: 0, patch: { state: 'none' } }
                    ],
                    classification: defaultClassificationRules(),
                    sccBinaryPath: sccTool,
                    ccccBinaryPath: ccccTool,
                    sccVersion: '4.1.0',
                    ccccVersion: '1.6.0'
                });

                expect(measured.map.coverage.scc.unmeasurable).toEqual([backslash]);
                expect(measured.map.coverage.scc.unsupported).not.toContain(backslash);
                expect(
                    measured.map.warnings.some((warning) =>
                        warning.includes('1 HEAD tracked path(s) cannot be materialized')
                    )
                ).toBe(true);
                /* The file stays visible with an explicit no-metrics state. */
                const file = measured.map.files.find((entry) => entry.path === backslash);
                expect(file?.status).toBe('added');
                expect(file?.parse.scc).toBe('unsupported');
            } finally {
                await Promise.all([
                    rm(fixture.rootDir, { recursive: true, force: true }),
                    rm(tools, { recursive: true, force: true })
                ]);
            }
        }
    );

    test.skipIf(!realTools)('builds the same ReviewMap from real tools', async () => {
        if (sccBinary === undefined || ccccBinary === undefined) {
            throw new Error('The pre-pass test started without the pinned tools.');
        }

        const fixture = await createFixture();

        try {
            const input = {
                worktreeDir: fixture.rootDir,
                baseSha: fixture.baseSha,
                headSha: fixture.headSha,
                changedFiles: changedFiles(),
                classification: defaultClassificationRules(),
                sccBinaryPath: sccBinary,
                ccccBinaryPath: ccccBinary,
                sccVersion: '4.1.0',
                ccccVersion: '1.6.0'
            };

            const first = await runIntelligencePrePass(input);
            const second = await runIntelligencePrePass(input);

            expect(first.map.tools).toEqual({
                scc: { version: '4.1.0', status: 'ok' },
                cccc: { version: '1.6.0', status: 'ok' }
            });
            expect(first.map.revisions.baseSha).toBe(fixture.baseSha);
            expect(first.map.revisions.headSha).toBe(fixture.headSha);
            expect(first.baseMetrics.recognizedFilesCount).toBeGreaterThan(0);

            const lockfile = first.map.files.find((file) => file.path === 'bun.lock');
            expect(lockfile?.classification).toBe('lockfile');
            expect(lockfile?.risk.noise).toBe(true);
            expect(first.map.coverage.scc.notCounted).toContain('bun.lock');

            /* Tool paths must index the changed files. An unnormalized Windows
               `.\src\a.ts` would null the file metrics and report every
               requested path as unsupported. */
            const changed = first.map.files.find((file) => file.path === 'src/a.ts');
            expect(changed?.head?.code).toBeGreaterThan(0);
            expect(first.map.coverage.scc.unsupported).not.toContain('src/a.ts');
            expect(first.map.coverage.cccc.unsupported).not.toContain('src/a.ts');

            const handler = first.map.functions.find((fn) => fn.name === 'handler');
            expect(handler?.match).toBe('matched');
            expect(handler?.delta).not.toBeNull();
            expect(first.map.functions.find((fn) => fn.name === 'added')?.match).toBe('added');
            expect(JSON.stringify(second.map)).toBe(JSON.stringify(first.map));
        } finally {
            await rm(fixture.rootDir, { recursive: true, force: true });
        }
    });

    test('degrades explicitly when CCCC fails and keeps SCC fail-closed', async () => {
        const fixture = await createFixture();
        const tools = await mkdtemp(path.join(tmpdir(), 'sakre-prepass-tools-'));

        try {
            const fakeScc = await scriptedTool(tools, 'scc', FIXED_SCC);
            const failingCccc = await scriptedTool(tools, 'cccc', 'process.exit(2);\n');

            const base = {
                worktreeDir: fixture.rootDir,
                baseSha: fixture.baseSha,
                headSha: fixture.headSha,
                changedFiles: changedFiles(),
                classification: defaultClassificationRules()
            };

            const degraded = await runIntelligencePrePass({
                ...base,
                sccBinaryPath: fakeScc,
                ccccBinaryPath: failingCccc,
                sccVersion: '4.1.0',
                ccccVersion: '1.6.0'
            });

            expect(degraded.map.tools.cccc.status).toBe('unavailable');
            expect(degraded.map.distributions.cccc.base).toBeNull();
            expect(degraded.map.warnings.some((warning) => warning.includes('CCCC BASE measurement failed'))).toBe(
                true
            );
            expect(degraded.map.files).toHaveLength(3);

            const failingScc = await scriptedTool(tools, 'scc-fail', 'process.exit(3);\n');

            const failure = await rejectionOf(
                runIntelligencePrePass({
                    ...base,
                    sccBinaryPath: failingScc,
                    ccccBinaryPath: failingCccc,
                    sccVersion: '4.1.0',
                    ccccVersion: '1.6.0'
                })
            );

            expect(failure.message).toContain('exit code 3');
        } finally {
            await Promise.all([
                rm(fixture.rootDir, { recursive: true, force: true }),
                rm(tools, { recursive: true, force: true })
            ]);
        }
    });

    test.skipIf(!realTools)('keeps a @generated changed file visible without inflating source metrics', async () => {
        const fixture = await createGeneratedFixture();

        try {
            const measured = await runIntelligencePrePass(realInput(fixture, changedGeneratedFiles()));
            const { map } = measured;

            const generated = map.files.find((file) => file.path === 'src/gen.ts');
            expect(generated?.classification).toBe('generated');
            expect(generated?.risk.noise).toBe(true);
            expect(generated?.analysis).toEqual({ scc: 'not-counted', cccc: 'unsupported' });
            expect(generated?.parse).toEqual({ scc: 'not-counted', cccc: 'unsupported' });
            expect(map.coverage.scc.notCounted).toContain('src/gen.ts');
            /* The 120 generated code lines stay out of the repository totals, and
               no function of the generated file reaches the function map. */
            expect(map.repository.head.code).toBeLessThan(100);
            expect(map.functions.some((fn) => fn.path === 'src/gen.ts')).toBe(false);

            /* A resolved repository override is the same source for planning,
               the map and coverage: excluding an otherwise-counted file by the
               override removes its metrics and its classification stays
               consistent everywhere. */
            const rules = defaultClassificationRules();
            const base = await runIntelligencePrePass(realInput(fixture, changedGeneratedFiles()));

            const overridden = await runIntelligencePrePass({
                ...realInput(fixture, changedGeneratedFiles()),
                classification: {
                    ...rules,
                    generatedPathPatterns: [...rules.generatedPathPatterns, 'src/a.ts']
                }
            });

            const overriddenFile = overridden.map.files.find((file) => file.path === 'src/a.ts');
            expect(overriddenFile?.classification).toBe('generated');
            expect(overridden.map.coverage.scc.notCounted).toContain('src/a.ts');
            expect(overridden.map.repository.head.files).toBe(base.map.repository.head.files - 1);
        } finally {
            await rm(fixture.rootDir, { recursive: true, force: true });
        }
    });

    test('measures the exact head commit even when the working tree is dirty', async () => {
        const fixture = await createFixture();
        const tools = await mkdtemp(path.join(tmpdir(), 'sakre-prepass-dirty-'));

        try {
            const sccTool = await scriptedTool(tools, 'scc', LINE_COUNTING_SCC);
            const ccccTool = await scriptedTool(tools, 'cccc', EMPTY_CCCC);

            const input: IntelligencePrePassInput = {
                worktreeDir: fixture.rootDir,
                baseSha: fixture.baseSha,
                headSha: fixture.headSha,
                changedFiles: changedFiles(),
                classification: defaultClassificationRules(),
                sccBinaryPath: sccTool,
                ccccBinaryPath: ccccTool,
                sccVersion: '4.1.0',
                ccccVersion: '1.6.0'
            };

            const clean = await runIntelligencePrePass(input);

            /* The dirty checkout differs from headSha; the measured map must not. */
            await writeFile(
                path.join(fixture.rootDir, 'src', 'a.ts'),
                'export function handler(a: number) { return a + 1; }\n'.repeat(40)
            );
            const dirty = await runIntelligencePrePass(input);
            expect(JSON.stringify(dirty.map)).toBe(JSON.stringify(clean.map));
        } finally {
            await Promise.all([
                rm(fixture.rootDir, { recursive: true, force: true }),
                rm(tools, { recursive: true, force: true })
            ]);
        }
    });

    test('propagates cancellation during a CCCC measurement instead of degrading', async () => {
        const fixture = await createFixture();
        const tools = await mkdtemp(path.join(tmpdir(), 'sakre-prepass-cancel-'));
        let measuredTree: string | null = null;

        try {
            const started = path.join(tools, 'cccc-started');
            const measured = path.join(tools, 'cccc-measured');
            const sccTool = await scriptedTool(tools, 'scc', LINE_COUNTING_SCC);

            const ccccTool = await scriptedTool(
                tools,
                'cccc',
                `import { chmodSync, writeFileSync } from 'node:fs';

const measuredTree = process.cwd();
writeFileSync(${JSON.stringify(measured)}, measuredTree);
/* POSIX lets a process keep its cwd while the directory is removed, so the
   cleanup failure a killed tool causes on Windows is reproduced by making the
   measured tree undeletable. The cancellation must still win. */
if (process.platform !== 'win32') {
    chmodSync(measuredTree, 0o000);
}
writeFileSync(${JSON.stringify(started)}, '');
await new Promise((resolve) => setTimeout(resolve, 5000));
`
            );

            const controller = new AbortController();

            const pending = runIntelligencePrePass({
                worktreeDir: fixture.rootDir,
                baseSha: fixture.baseSha,
                headSha: fixture.headSha,
                changedFiles: changedFiles(),
                classification: defaultClassificationRules(),
                sccBinaryPath: sccTool,
                ccccBinaryPath: ccccTool,
                sccVersion: '4.1.0',
                ccccVersion: '1.6.0',
                signal: controller.signal
            });

            /* Abort only once the running CCCC has proven it started, so the
               test cannot pass on a pre-spawn cancellation check. */
            await waitForFile(started);
            measuredTree = await Bun.file(measured).text();
            controller.abort();
            const failure = await rejectionOf(pending);
            expect(failure).toBeInstanceOf(CancelledError);
        } finally {
            await removeMeasuredTree(measuredTree);
            await Promise.all([
                rm(fixture.rootDir, { recursive: true, force: true }),
                rm(tools, { recursive: true, force: true })
            ]);
        }
    });

    test('reports an unavailable base SHA as a typed SnapshotError', async () => {
        const fixture = await createFixture();
        const tools = await mkdtemp(path.join(tmpdir(), 'sakre-prepass-missing-'));

        try {
            const sccTool = await scriptedTool(tools, 'scc', LINE_COUNTING_SCC);
            const ccccTool = await scriptedTool(tools, 'cccc', EMPTY_CCCC);

            const failure = await rejectionOf(
                runIntelligencePrePass({
                    worktreeDir: fixture.rootDir,
                    baseSha: 'f'.repeat(40),
                    headSha: fixture.headSha,
                    changedFiles: changedFiles(),
                    classification: defaultClassificationRules(),
                    sccBinaryPath: sccTool,
                    ccccBinaryPath: ccccTool,
                    sccVersion: '4.1.0',
                    ccccVersion: '1.6.0'
                })
            );

            expect(failure).toBeInstanceOf(SnapshotError);
        } finally {
            await Promise.all([
                rm(fixture.rootDir, { recursive: true, force: true }),
                rm(tools, { recursive: true, force: true })
            ]);
        }
    });
});

/* A tracked POSIX filename containing a backslash: a legal git path, but one a
   platform path join would reinterpret, so it must stay unmeasurable. */
async function createBackslashFixture(): Promise<Fixture> {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'sakre-prepass-backslash-'));
    git(rootDir, ['init', '--initial-branch', 'main']);
    git(rootDir, ['config', 'user.email', 'fixture@sakre.local']);
    git(rootDir, ['config', 'user.name', 'SAKRE Fixture']);
    await mkdir(path.join(rootDir, 'src'), { recursive: true });
    await writeFile(path.join(rootDir, 'src', 'a.ts'), 'export const a = 1;\n');
    git(rootDir, ['add', '-A']);
    git(rootDir, ['commit', '-m', 'base']);
    const baseSha = rev(rootDir);
    await Promise.all([
        writeFile(path.join(rootDir, 'src', 'a.ts'), 'export const a = 2;\n'),
        writeFile(path.join(rootDir, 'src', String.raw`a\b.ts`), 'export const b = 1;\n')
    ]);
    git(rootDir, ['add', '-A']);
    git(rootDir, ['commit', '-m', 'head']);

    return { rootDir, baseSha, headSha: rev(rootDir) };
}

async function createGeneratedFixture(): Promise<Fixture> {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'sakre-prepass-generated-'));
    git(rootDir, ['init', '--initial-branch', 'main']);
    git(rootDir, ['config', 'user.email', 'fixture@sakre.local']);
    git(rootDir, ['config', 'user.name', 'SAKRE Fixture']);
    await mkdir(path.join(rootDir, 'src'), { recursive: true });
    await Promise.all([
        writeFile(path.join(rootDir, 'src', 'a.ts'), 'export const a = 1;\n'),
        writeFile(path.join(rootDir, 'README.md'), '# generated fixture\n')
    ]);
    git(rootDir, ['add', '-A']);
    git(rootDir, ['commit', '-m', 'base']);
    const baseSha = rev(rootDir);
    await Promise.all([
        writeFile(path.join(rootDir, 'src', 'a.ts'), 'export const a = 2;\n'),
        writeFile(
            path.join(rootDir, 'src', 'gen.ts'),
            `// @generated\n${Array.from({ length: 120 }, (_unused, index) => `export const value${String(index)} = 1;`).join('\n')}\n`
        )
    ]);
    git(rootDir, ['add', '-A']);
    git(rootDir, ['commit', '-m', 'head']);

    return { rootDir, baseSha, headSha: rev(rootDir) };
}

function changedGeneratedFiles(): VcsChangedFile[] {
    return [
        { path: 'src/a.ts', status: 'modified', additions: 1, deletions: 1, patch: { state: 'none' } },
        { path: 'src/gen.ts', status: 'added', additions: 121, deletions: 0, patch: { state: 'none' } }
    ];
}

function realInput(fixture: Fixture, files: VcsChangedFile[]): IntelligencePrePassInput {
    if (sccBinary === undefined || ccccBinary === undefined) {
        throw new Error('The pre-pass test started without the pinned tools.');
    }

    return {
        worktreeDir: fixture.rootDir,
        baseSha: fixture.baseSha,
        headSha: fixture.headSha,
        changedFiles: files,
        classification: defaultClassificationRules(),
        sccBinaryPath: sccBinary,
        ccccBinaryPath: ccccBinary,
        sccVersion: '4.1.0',
        ccccVersion: '1.6.0'
    };
}
