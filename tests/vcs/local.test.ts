import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { planCoverageDiff } from '../../src/analysis/diff';
import { renderCoverageDiff } from '../../src/analysis/render';
import { escalationPriorityPatterns } from '../../src/analysis/risk-rules';
import { createGitRunner, type GitCommandResult, type GitRunner } from '../../src/vcs/git-command';
import {
    type LocalGitContext,
    type LocalGitRefs,
    LocalGitVcs,
    MAX_CONCURRENT_PATCH_READS,
    resolveLocalRefs
} from '../../src/vcs/local';
import type { VcsChangedFile } from '../../src/vcs/types';
import { rejectionOf } from '../helpers/rejection';

let root = '';

let baseSha = '';

let headSha = '';

beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'sakre-local-vcs-'));
    run('git', ['init', '-q', '-b', 'main'], root);
    await writeFile(path.join(root, 'keep.txt'), 'a\nb\nc\n');
    await writeFile(path.join(root, 'rename-me.txt'), 'x\ny\n');
    await writeFile(path.join(root, 'delete-me.txt'), 'gone\n');
    await writeFile(path.join(root, 'a@@b.txt'), 'before\n');
    await writeFile(path.join(root, 'unicode.txt'), 'héllo wörld\n');
    run('git', ['add', '.'], root);
    run('git', ['-c', 'user.name=Base', '-c', 'user.email=base@example.com', 'commit', '-qm', 'base commit'], root);
    baseSha = run('git', ['rev-parse', 'HEAD'], root);
    run('git', ['checkout', '-q', '-b', 'feature'], root);
    await writeFile(path.join(root, 'rename-me.txt'), 'x\ny\nz\n');
    run('git', ['mv', 'rename-me.txt', 'renamed.txt'], root);
    await writeFile(path.join(root, 'keep.txt'), 'a\nB\nc\nd\n');
    await writeFile(path.join(root, 'a@@b.txt'), 'after\n');
    await writeFile(path.join(root, 'unicode.txt'), 'héllo wörld!\n');
    await rm(path.join(root, 'delete-me.txt'));
    await writeFile(path.join(root, 'added.txt'), 'new\n');
    await writeFile(path.join(root, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
    run('git', ['add', '-A'], root);
    run('git', ['-c', 'user.name=Head', '-c', 'user.email=head@example.com', 'commit', '-qm', 'head commit'], root);
    headSha = run('git', ['rev-parse', 'HEAD'], root);
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

describe('local Git ref resolution', () => {
    test('detects the default base branch and computes the merge base', async () => {
        const refs = await resolveLocalRefs({ repositoryDir: root });
        expect(refs.baseRef).toBe('main');
        expect(refs.headRef).toBe('HEAD');
        expect(refs.baseSha).toBe(baseSha);
        expect(refs.headSha).toBe(headSha);
    });

    test('uses the fork point when the base branch advances after the fork', async () => {
        run('git', ['checkout', '-q', 'main'], root);
        await writeFile(path.join(root, 'main-only.txt'), 'main\n');
        run('git', ['add', '.'], root);
        run(
            'git',
            ['-c', 'user.name=Main', '-c', 'user.email=main@example.com', 'commit', '-qm', 'main advance'],
            root
        );
        const advancedMain = run('git', ['rev-parse', 'main'], root);

        const refs = await resolveLocalRefs({ repositoryDir: root, headRef: 'feature' });

        expect(refs.baseRef).toBe('main');
        expect(refs.baseSha).toBe(baseSha);
        expect(refs.baseSha).not.toBe(advancedMain);
        expect(refs.headSha).toBe(headSha);
    });

    test('prefers origin/HEAD when the remote head ref exists', async () => {
        run('git', ['update-ref', 'refs/remotes/origin/main', baseSha], root);
        run('git', ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'], root);

        const refs = await resolveLocalRefs({ repositoryDir: root });

        expect(refs.baseRef).toBe('origin/HEAD');
        expect(refs.baseSha).toBe(baseSha);
        expect(refs.headSha).toBe(headSha);
    });

    test('falls back to master when origin/HEAD and main are absent', async () => {
        const masterRoot = await mkdtemp(path.join(tmpdir(), 'sakre-local-master-'));

        try {
            run('git', ['init', '-q', '-b', 'master'], masterRoot);
            await writeFile(path.join(masterRoot, 'file.txt'), 'content\n');
            run('git', ['add', '.'], masterRoot);
            run(
                'git',
                ['-c', 'user.name=Master', '-c', 'user.email=master@example.com', 'commit', '-qm', 'master base'],
                masterRoot
            );
            const masterSha = run('git', ['rev-parse', 'HEAD'], masterRoot);

            const refs = await resolveLocalRefs({ repositoryDir: masterRoot });

            expect(refs.baseRef).toBe('master');
            expect(refs.baseSha).toBe(masterSha);
            expect(refs.headSha).toBe(masterSha);
        } finally {
            await rm(masterRoot, { recursive: true, force: true });
        }
    });

    test('fails with an actionable error when no base ref exists', async () => {
        const empty = await mkdtemp(path.join(tmpdir(), 'sakre-local-empty-'));

        try {
            run('git', ['init', '-q', '-b', 'trunk'], empty);
            await writeFile(path.join(empty, 'file.txt'), 'content\n');
            run('git', ['add', '.'], empty);
            run('git', ['-c', 'user.name=Base', '-c', 'user.email=base@example.com', 'commit', '-qm', 'base'], empty);
            const failure = await rejectionOf(resolveLocalRefs({ repositoryDir: empty }));
            expect(failure.message).toContain('Pass --base <ref>');
        } finally {
            await rm(empty, { recursive: true, force: true });
        }
    });
});

describe('local Git VCS adapter', () => {
    test('maps statuses, rename provenance, numstat and exact measured sizes', async () => {
        const vcs = await createVcs();
        const snapshot = await vcs.getPullRequestSnapshot(0);
        const byPath = new Map(snapshot.changedFiles.map((file) => [file.path, file]));

        expect(byPath.get('added.txt')).toMatchObject({ status: 'added', additions: 1, deletions: 0 });
        expect(byPath.get('delete-me.txt')).toMatchObject({ status: 'removed', additions: 0, deletions: 1 });
        expect(byPath.get('keep.txt')).toMatchObject({ status: 'modified', additions: 2, deletions: 1 });
        expect(byPath.get('renamed.txt')).toMatchObject({
            status: 'renamed',
            previousPath: 'rename-me.txt',
            additions: 1,
            deletions: 0
        });
        /* Exact sizes, including multibyte content and a path that itself contains `@@`. */
        expect(byPath.get('renamed.txt')?.patch).toEqual({
            state: 'measured',
            chars: referenceHunkLength(['rename-me.txt', 'renamed.txt'])
        });
        expect(byPath.get('keep.txt')?.patch).toEqual({
            state: 'measured',
            chars: referenceHunkLength(['keep.txt'])
        });
        expect(byPath.get('a@@b.txt')).toMatchObject({ status: 'modified', additions: 1, deletions: 1 });
        expect(byPath.get('a@@b.txt')?.patch).toEqual({
            state: 'measured',
            chars: referenceHunkLength(['a@@b.txt'])
        });
        expect(byPath.get('unicode.txt')?.patch).toEqual({
            state: 'measured',
            chars: referenceHunkLength(['unicode.txt'])
        });
        expect(byPath.get('binary.bin')?.patch).toEqual({ state: 'none' });
    });

    test('never retains content while measuring the snapshot', async () => {
        const vcs = await createVcs();
        const snapshot = await vcs.getPullRequestSnapshot(0);

        expect(snapshot.changedFiles.some((file) => file.patch.state === 'measured')).toBe(true);
        expect(snapshot.changedFiles.every((file) => file.patch.state !== 'retained')).toBe(true);
    });

    test('synthesizes the pull request context from the commit range', async () => {
        const vcs = await createVcs();
        const { pullRequest, comments } = await vcs.getPullRequestSnapshot(0);

        expect(pullRequest.title).toBe('head commit');
        expect(pullRequest.authorLogin).toBe('Head');
        expect(pullRequest.body).toContain('- head commit (Head)');
        expect(pullRequest.baseSha).toBe(baseSha);
        expect(pullRequest.headSha).toBe(headSha);
        expect(comments).toEqual([]);
    });

    test('prefers injected GitHub metadata and review history over the commit context', async () => {
        const vcs = await createVcs({
            owner: 'acme',
            repo: 'demo',
            number: 42,
            title: 'Real PR title',
            body: 'Real PR body',
            authorLogin: 'alice',
            comments: [{ id: 5, body: 'earlier review', createdAt: '2026-09-01T00:00:00Z', authorType: 'Bot' }]
        });

        const snapshot = await vcs.getPullRequestSnapshot(42);
        expect(snapshot.pullRequest).toMatchObject({
            owner: 'acme',
            repo: 'demo',
            number: 42,
            title: 'Real PR title',
            body: 'Real PR body',
            authorLogin: 'alice',
            baseRef: 'main',
            headRef: 'HEAD',
            baseSha,
            headSha
        });
        expect(snapshot.comments).toHaveLength(1);
    });

    test('reads protected content at an explicit ref and refuses unsafe paths', async () => {
        const vcs = await createVcs();
        expect(await vcs.getFileContent('keep.txt', baseSha)).toBe('a\nb\nc\n');
        expect(await vcs.getFileContent('keep.txt', headSha)).toBe('a\nB\nc\nd\n');
        expect(await vcs.getFileContent('missing.txt', baseSha)).toBeNull();
        const unsafe = await rejectionOf(vcs.getFileContent('../outside.txt', baseSha));
        expect(unsafe).toBeInstanceOf(Error);
    });

    test('reports a moved head as a new SHA for stale detection', async () => {
        const refs: LocalGitRefs = await resolveLocalRefs({ repositoryDir: root, baseRef: baseSha, headRef: 'HEAD' });
        const vcs = new LocalGitVcs({ repositoryDir: root, refs, git: createGitRunner(root) });
        expect(await vcs.getCurrentHeadSha(0)).toBe(headSha);
        await writeFile(path.join(root, 'later.txt'), 'later\n');
        run('git', ['add', '.'], root);
        run('git', ['-c', 'user.name=Later', '-c', 'user.email=later@example.com', 'commit', '-qm', 'later'], root);
        expect(await vcs.getCurrentHeadSha(0)).not.toBe(headSha);
    });

    test('measures every changed file with a single bulk diff process', async () => {
        const fileCount = 32;
        const host = createFakeGitHost(fileCount);

        const vcs = new LocalGitVcs({
            repositoryDir: root,
            refs: { baseRef: 'main', headRef: 'HEAD', baseSha, headSha },
            git: host.git
        });

        const snapshot = await vcs.getPullRequestSnapshot(0);

        expect(snapshot.changedFiles).toHaveLength(fileCount);
        expect(host.diffCalls()).toBe(1);
        expect(snapshot.changedFiles.every((file) => file.patch.state === 'measured')).toBe(true);
    });

    test('bounds the number of concurrent reads while materializing allocations', async () => {
        const fileCount = 32;
        const host = createFakeGitHost(fileCount);

        const vcs = new LocalGitVcs({
            repositoryDir: root,
            refs: { baseRef: 'main', headRef: 'HEAD', baseSha, headSha },
            git: host.git
        });

        const snapshot = await vcs.getPullRequestSnapshot(0);
        const allocations = new Map(snapshot.changedFiles.map((file) => [file.path, 5]));

        const files = await vcs.materializeCoveragePatches(snapshot.changedFiles, allocations);

        expect(files).toHaveLength(fileCount);
        expect(files.every((file) => file.patch.state === 'retained')).toBe(true);
        expect(host.maxActive).toBeGreaterThanOrEqual(2);
        expect(host.maxActive).toBeLessThanOrEqual(MAX_CONCURRENT_PATCH_READS);
        expect(host.readPaths()).toHaveLength(fileCount);
    });

    test('measures every file exactly without an aggregate retention cap', async () => {
        const fileCount = 24;
        const patchBytes = 200_000;
        const host = createFakeGitHost(fileCount, { patchBytes });

        const vcs = new LocalGitVcs({
            repositoryDir: root,
            refs: { baseRef: 'main', headRef: 'HEAD', baseSha, headSha },
            git: host.git
        });

        const snapshot = await vcs.getPullRequestSnapshot(0);
        const expected = fakeHunkChars(patchBytes);

        expect(snapshot.changedFiles).toHaveLength(fileCount);

        for (const file of snapshot.changedFiles) {
            expect(file.patch).toEqual({ state: 'measured', chars: expected });
        }
    });

    test('measures a large changed file at constant memory and without a fixed per-file cap', async () => {
        const bigRoot = await mkdtemp(path.join(tmpdir(), 'sakre-local-large-'));

        try {
            run('git', ['init', '-q', '-b', 'main'], bigRoot);
            await writeFile(path.join(bigRoot, 'large.txt'), 'a'.repeat(4_000_000));
            run('git', ['add', '.'], bigRoot);
            run('git', ['-c', 'user.name=Base', '-c', 'user.email=base@example.com', 'commit', '-qm', 'base'], bigRoot);
            const bigBase = run('git', ['rev-parse', 'HEAD'], bigRoot);
            await writeFile(path.join(bigRoot, 'large.txt'), `${'a'.repeat(4_000_000)}b`);
            run('git', ['add', '.'], bigRoot);
            run('git', ['-c', 'user.name=Head', '-c', 'user.email=head@example.com', 'commit', '-qm', 'head'], bigRoot);

            const refs = await resolveLocalRefs({
                repositoryDir: bigRoot,
                baseRef: bigBase,
                headRef: run('git', ['rev-parse', 'HEAD'], bigRoot)
            });

            const vcs = new LocalGitVcs({ repositoryDir: bigRoot, refs, git: createGitRunner(bigRoot) });
            const snapshot = await vcs.getPullRequestSnapshot(0);
            const [file] = snapshot.changedFiles;

            expect(file?.patch.state).toBe('measured');

            if (file?.patch.state !== 'measured') {
                throw new Error('expected a measured patch');
            }

            expect(file.patch.chars).toBeGreaterThan(4_000_000);
        } finally {
            await rm(bigRoot, { recursive: true, force: true });
        }
    });

    test('measures and retains hunks exactly across stream chunk boundaries', async () => {
        /* One character per chunk splits every marker across pushes. */
        const host = createFakeGitHost(1, { chunkSize: 1 });

        const vcs = new LocalGitVcs({
            repositoryDir: root,
            refs: { baseRef: 'main', headRef: 'HEAD', baseSha, headSha },
            git: host.git
        });

        const snapshot = await vcs.getPullRequestSnapshot(0);
        const [file] = snapshot.changedFiles;
        const expected = fakeHunkChars(0);

        expect(file?.patch).toEqual({ state: 'measured', chars: expected });

        const files = await vcs.materializeCoveragePatches(snapshot.changedFiles, new Map([['file-0.txt', 5]]));
        expect(files[0]?.patch).toEqual({ state: 'retained', chars: expected, content: '@@ -1' });
    });

    test('materializes only allocated slices, in allocation order', async () => {
        const host = createFakeGitHost(3);

        const vcs = new LocalGitVcs({
            repositoryDir: root,
            refs: { baseRef: 'main', headRef: 'HEAD', baseSha, headSha },
            git: host.git
        });

        const files: VcsChangedFile[] = [
            measuredFile('neutral.txt', 100),
            measuredFile('auth/login.ts', 100),
            measuredFile('skipped.txt', 100)
        ];

        const allocations = new Map([
            ['auth/login.ts', 4],
            ['neutral.txt', 2]
        ]);

        const materialized = await vcs.materializeCoveragePatches(files, allocations);
        const byPath = new Map(materialized.map((file) => [file.path, file]));

        expect(byPath.get('auth/login.ts')?.patch).toEqual({ state: 'retained', chars: 100, content: '@@ -' });
        expect(byPath.get('neutral.txt')?.patch).toEqual({ state: 'retained', chars: 100, content: '@@' });
        expect(byPath.get('skipped.txt')?.patch).toEqual({ state: 'measured', chars: 100 });
        expect(host.readPaths()).toEqual(['auth/login.ts', 'neutral.txt']);
    });

    test('retains escalation-matched files before neutral files across the real plan', async () => {
        const host = createFakeGitHost(3);

        const vcs = new LocalGitVcs({
            repositoryDir: root,
            refs: { baseRef: 'main', headRef: 'HEAD', baseSha, headSha },
            git: host.git
        });

        const files: VcsChangedFile[] = [
            /* The neutral path sorts first and carries the most changed lines,
               so only the priority rank can keep the dependency file ahead. */
            measuredFile('aaa/neutral.ts', 100, 5000),
            measuredFile('package.json', 100),
            measuredFile('src/other.ts', 100)
        ];

        const plan = planCoverageDiff(files, {
            maxChars: 100_000,
            priorityPatterns: escalationPriorityPatterns()
        });

        await vcs.materializeCoveragePatches(files, plan.allocations);

        expect(plan.entries.map((entry) => entry.path)).toEqual(['package.json', 'aaa/neutral.ts', 'src/other.ts']);
        expect(host.readPaths()[0]).toBe('package.json');
    });

    test('renders a complete diff over a real repository range', async () => {
        const refs = await resolveLocalRefs({ repositoryDir: root, baseRef: 'main', headRef: 'HEAD' });
        const vcs = new LocalGitVcs({ repositoryDir: root, refs, git: createGitRunner(root) });
        const snapshot = await vcs.getPullRequestSnapshot(0);

        const plan = planCoverageDiff(snapshot.changedFiles, {
            maxChars: 100_000,
            priorityPatterns: escalationPriorityPatterns()
        });

        const files = await vcs.materializeCoveragePatches(snapshot.changedFiles, plan.allocations);
        const coverage = renderCoverageDiff(plan, files);

        expect(coverage.complete).toBe(true);
        expect(coverage.unifiedDiff).toContain('diff --git a/keep.txt b/keep.txt');
        expect(coverage.unifiedDiff).toContain('+B');
    });
});

async function createVcs(context?: LocalGitContext): Promise<LocalGitVcs> {
    const refs: LocalGitRefs = await resolveLocalRefs({ repositoryDir: root, baseRef: 'main', headRef: 'HEAD' });

    return new LocalGitVcs({ repositoryDir: root, refs, context, git: createGitRunner(root) });
}

function measuredFile(filePath: string, chars: number, changes = 1): VcsChangedFile {
    return {
        path: filePath,
        status: 'modified',
        additions: changes,
        deletions: 0,
        patch: { state: 'measured', chars }
    };
}

function fakeHunkChars(patchBytes: number): number {
    const patch = fakePatch(patchBytes);
    const match = /^@@ /mu.exec(patch);

    if (match === null) {
        throw new Error('fake patch has no hunk header');
    }

    return patch.slice(match.index).length;
}

function fakePatch(patchBytes: number): string {
    return `diff --git a/x b/x\n@@ -1 +1 @@\n+${'a'.repeat(patchBytes)}\n`;
}

function fakeSection(filePath: string, patchBytes: number): string {
    return `diff --git a/${filePath} b/${filePath}\n@@ -1 +1 @@\n+${'a'.repeat(patchBytes)}\n`;
}

function splitIntoChunks(content: string, chunkSize: number | undefined): string[] {
    if (chunkSize === undefined) {
        return [content];
    }

    const chunks: string[] = [];

    for (let index = 0; index < content.length; index += chunkSize) {
        chunks.push(content.slice(index, index + chunkSize));
    }

    return chunks;
}

/* Reference hunk length straight from Git, used to prove the streaming count is
   exact (including multibyte content) rather than capped or approximate. */
function referenceHunkLength(paths: string[]): number {
    const result = spawnSync(
        'git',
        ['diff', '--no-color', '--unified=3', '--find-renames', baseSha, headSha, '--', ...paths],
        { cwd: root, encoding: 'utf8' }
    );

    if (result.status !== 0) {
        throw new Error(result.stderr.trim());
    }

    const match = /^@@ /mu.exec(result.stdout);

    if (match === null) {
        throw new Error(`no hunks for ${paths.join(', ')}`);
    }

    return result.stdout.slice(match.index).length;
}

/* Minimal Git host: metadata answers immediately, the bulk measurement streams
   every file section in order, and reads answer per path. `patchBytes` lets a
   test drive large sections, `chunkSize` forces sections across stream
   boundaries, `diffCalls` counts measurement processes, and `readPaths` records
   the read claims in order. */
function createFakeGitHost(
    fileCount: number,
    options: { patchBytes?: number; chunkSize?: number } = {}
): { git: GitRunner; maxActive: number; diffCalls: () => number; readPaths: () => string[] } {
    // SAFETY: reads collects the file paths pushed below; active/maxActive/diffs stay numeric counters.
    const state = { active: 0, maxActive: 0, reads: [] as string[], diffs: 0 };
    const patchBytes = options.patchBytes ?? 0;
    let bulk = '';
    let nameStatus = '';
    let numStat = '';

    for (let index = 0; index < fileCount; index += 1) {
        const filePath = `file-${index}.txt`;
        bulk += fakeSection(filePath, patchBytes);
        nameStatus += `M\0${filePath}\0`;
        numStat += `1\t0\t${filePath}\0`;
    }

    const bulkChunks = splitIntoChunks(bulk, options.chunkSize);

    const git: GitRunner = {
        run: async (arguments_, _signal, runOptions): Promise<GitCommandResult> => {
            if (arguments_[0] === 'rev-parse') {
                return { exitCode: 0, stdout: `${headSha}\n`, stderr: '' };
            }

            if (arguments_[0] === 'log') {
                return { exitCode: 0, stdout: '', stderr: '' };
            }

            if (arguments_.includes('--name-status')) {
                return { exitCode: 0, stdout: nameStatus, stderr: '' };
            }

            if (arguments_.includes('--numstat')) {
                return { exitCode: 0, stdout: numStat, stderr: '' };
            }

            if (!arguments_.includes('--')) {
                state.diffs += 1;

                if (runOptions?.onStdoutChunk !== undefined) {
                    streamChunks(bulkChunks, runOptions.onStdoutChunk);

                    return { exitCode: 0, stdout: '', stderr: '' };
                }

                return { exitCode: 0, stdout: bulk, stderr: '' };
            }

            state.active += 1;
            state.maxActive = Math.max(state.maxActive, state.active);
            const readPath = arguments_.at(-1) ?? '';
            state.reads.push(readPath);
            await delay(2);
            state.active -= 1;
            const section = fakeSection(readPath, patchBytes);

            if (runOptions?.onStdoutChunk !== undefined) {
                streamChunks(splitIntoChunks(section, options.chunkSize), runOptions.onStdoutChunk);

                return { exitCode: 0, stdout: '', stderr: '' };
            }

            return { exitCode: 0, stdout: section, stderr: '' };
        }
    };

    // eslint-disable-next-line anti-slop/no-known-value-widening -- fake git-host contract; annotation documents the exercised surface
    return {
        git,
        get maxActive(): number {
            return state.maxActive;
        },
        diffCalls: () => state.diffs,
        readPaths: () => [...state.reads]
    };
}

function streamChunks(chunks: string[], onChunk: (chunk: Buffer) => boolean | undefined): void {
    for (const chunk of chunks) {
        if (onChunk(Buffer.from(chunk)) === false) {
            break;
        }
    }
}

function run(command: string, arguments_: string[], cwd: string): string {
    const result = spawnSync(command, arguments_, { cwd, encoding: 'utf8' });

    if (result.status !== 0) {
        throw new Error(`${command} failed: ${result.stderr}`);
    }

    return result.stdout.trim();
}
