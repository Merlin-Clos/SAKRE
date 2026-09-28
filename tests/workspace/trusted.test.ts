import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTrustedWorkspace, type TrustedWorkspace, TrustedWorkspaceError } from '../../src/workspace/trusted';
import { rejectionOf } from '../helpers/rejection';

interface Fixture {
    root: string;
    repositoryDir: string;
    baseSha: string;
    headSha: string;
}

const roots: string[] = [];

const workspaces: TrustedWorkspace[] = [];

afterEach(async () => {
    await Promise.all(workspaces.splice(0).map((workspace) => workspace.close()));
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createFixture(): Promise<Fixture> {
    const root = await mkdtemp(path.join(tmpdir(), 'sakre-trusted-'));
    roots.push(root);
    const repositoryDir = path.join(root, 'repository');
    await mkdir(repositoryDir);
    git(repositoryDir, ['init', '-q', '-b', 'main']);
    git(repositoryDir, ['config', 'user.email', 'workspace@example.com']);
    git(repositoryDir, ['config', 'user.name', 'Workspace Fixture']);

    await writeFile(path.join(repositoryDir, 'AGENTS.md'), 'base root instructions\n');
    await writeNested(repositoryDir, 'nested/AGENTS.md', 'base nested instructions\n');
    await writeNested(repositoryDir, 'base-only/AGENTS.md', 'base only instructions\n');
    await writeNested(repositoryDir, 'src/app.js', 'export const value = 1;\n');
    git(repositoryDir, ['add', '-A']);
    git(repositoryDir, ['commit', '-q', '-m', 'base']);
    const baseSha = rev(repositoryDir, 'HEAD');

    await writeFile(path.join(repositoryDir, 'AGENTS.md'), 'head root instructions\n');
    await writeNested(repositoryDir, 'nested/AGENTS.md', 'head nested instructions\n');
    await rm(path.join(repositoryDir, 'base-only', 'AGENTS.md'), { force: true });
    await writeNested(repositoryDir, 'added/AGENTS.md', 'head added instructions\n');
    await writeNested(repositoryDir, 'src/app.js', 'export const value = 2;\n');
    git(repositoryDir, ['add', '-A']);
    git(repositoryDir, ['commit', '-q', '-m', 'head']);
    const headSha = rev(repositoryDir, 'HEAD');

    return { root, repositoryDir, baseSha, headSha };
}

async function writeNested(repositoryDir: string, relativePath: string, content: string): Promise<void> {
    const target = path.join(repositoryDir, ...relativePath.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
}

function git(repositoryDir: string, args: string[]): string {
    const result = spawnSync('git', args, { cwd: repositoryDir, encoding: 'utf8' });

    if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    }

    return result.stdout;
}

function rev(repositoryDir: string, ref: string): string {
    return git(repositoryDir, ['rev-parse', ref]).trim();
}

describe('trusted review workspace', () => {
    test('overlays BASE AGENTS.md files and keeps the analyzed diff visible', async () => {
        const fixture = await createFixture();

        const workspace = await createTrustedWorkspace({
            repositoryDir: fixture.repositoryDir,
            baseSha: fixture.baseSha,
            headSha: fixture.headSha,
            scratchRoot: fixture.root
        });

        workspaces.push(workspace);

        expect(await readFile(path.join(workspace.directory, 'AGENTS.md'), 'utf8')).toBe('base root instructions\n');
        expect(await readFile(path.join(workspace.directory, 'nested', 'AGENTS.md'), 'utf8')).toBe(
            'base nested instructions\n'
        );
        expect(await readFile(path.join(workspace.directory, 'base-only', 'AGENTS.md'), 'utf8')).toBe(
            'base only instructions\n'
        );
        const added = await rejectionOf(readFile(path.join(workspace.directory, 'added', 'AGENTS.md'), 'utf8'));
        expect(added).toBeInstanceOf(Error);
        /* All other content stays at HEAD: the workspace is a real checkout. */
        expect(await readFile(path.join(workspace.directory, 'src', 'app.js'), 'utf8')).toBe(
            'export const value = 2;\n'
        );

        /* The user's checkout is untouched. */
        expect(await readFile(path.join(fixture.repositoryDir, 'AGENTS.md'), 'utf8')).toBe('head root instructions\n');

        /* The analyzed diff still reports every AGENTS.md change. */
        const changed = git(fixture.repositoryDir, ['diff', '--name-only', fixture.baseSha, fixture.headSha]);
        expect(changed).toContain('AGENTS.md');
        expect(changed).toContain('nested/AGENTS.md');
        expect(changed).toContain('base-only/AGENTS.md');
        expect(changed).toContain('added/AGENTS.md');
    });

    test('closing removes the worktree and its scratch directory', async () => {
        const fixture = await createFixture();

        const workspace = await createTrustedWorkspace({
            repositoryDir: fixture.repositoryDir,
            baseSha: fixture.baseSha,
            headSha: fixture.headSha,
            scratchRoot: fixture.root
        });

        await workspace.close();

        const removed = await rejectionOf(readFile(path.join(workspace.directory, 'AGENTS.md'), 'utf8'));
        expect(removed).toBeInstanceOf(Error);
        expect(git(fixture.repositoryDir, ['worktree', 'list'])).not.toContain(workspace.directory);

        /* Closing twice stays silent: a missing worktree registration prunes
           stale metadata and still removes the scratch directory. */
        await workspace.close();
        expect(git(fixture.repositoryDir, ['worktree', 'list'])).not.toContain(workspace.directory);
    });

    test('a failed worktree add rejects and leaves no scratch behind', async () => {
        const fixture = await createFixture();

        const failure = await rejectionOf(
            createTrustedWorkspace({
                repositoryDir: fixture.repositoryDir,
                baseSha: fixture.baseSha,
                headSha: 'f'.repeat(40),
                scratchRoot: fixture.root
            })
        );

        expect(failure).toBeInstanceOf(TrustedWorkspaceError);
        expect(failure.message).toContain('Failed to create the review workspace');
        const entries = await readdir(fixture.root);
        const leftovers = entries.filter((entry) => entry !== 'repository');
        expect(leftovers).toEqual([]);
    });

    test('defaults the scratch parent to the platform temp directory', async () => {
        const fixture = await createFixture();

        const workspace = await createTrustedWorkspace({
            repositoryDir: fixture.repositoryDir,
            baseSha: fixture.baseSha,
            headSha: fixture.headSha
        });

        workspaces.push(workspace);

        expect(workspace.directory.startsWith(tmpdir())).toBe(true);
        expect(await readFile(path.join(workspace.directory, 'src', 'app.js'), 'utf8')).toBe(
            'export const value = 2;\n'
        );
        await workspace.close();
        const removed = await rejectionOf(readFile(path.join(workspace.directory, 'AGENTS.md'), 'utf8'));
        expect(removed).toBeInstanceOf(Error);
    });

    test('replaces a HEAD AGENTS.md symlink with the BASE file without writing through it', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'sakre-trusted-symlink-'));
        roots.push(root);
        const repositoryDir = await initRepository(root);
        const victim = path.join(root, 'victim.txt');
        await writeFile(victim, 'VICTIM CONTENT\n', 'utf8');
        await writeFile(path.join(repositoryDir, 'AGENTS.md'), 'base instructions\n', 'utf8');
        git(repositoryDir, ['add', '-A']);
        git(repositoryDir, ['commit', '-qm', 'base']);
        const baseSha = rev(repositoryDir, 'HEAD');

        await rm(path.join(repositoryDir, 'AGENTS.md'), { force: true });
        await symlink(victim, path.join(repositoryDir, 'AGENTS.md'), 'file');
        git(repositoryDir, ['add', '-A']);
        git(repositoryDir, ['commit', '-qm', 'head symlink']);

        const workspace = await createTrustedWorkspace({
            repositoryDir,
            baseSha,
            headSha: rev(repositoryDir, 'HEAD'),
            scratchRoot: root
        });

        workspaces.push(workspace);

        expect(await readFile(victim, 'utf8')).toBe('VICTIM CONTENT\n');
        const target = path.join(workspace.directory, 'AGENTS.md');
        const targetStats = await lstat(target);
        expect(targetStats.isFile()).toBe(true);
        expect(await readFile(target, 'utf8')).toBe('base instructions\n');
    });

    test('deletes a HEAD AGENTS.md symlink that does not exist at BASE without touching its target', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'sakre-trusted-delete-symlink-'));
        roots.push(root);
        const repositoryDir = await initRepository(root);
        const victim = path.join(root, 'victim.txt');
        await writeFile(victim, 'VICTIM CONTENT\n', 'utf8');
        await writeFile(path.join(repositoryDir, 'app.js'), 'export const value = 1;\n', 'utf8');
        git(repositoryDir, ['add', '-A']);
        git(repositoryDir, ['commit', '-qm', 'base']);
        const baseSha = rev(repositoryDir, 'HEAD');

        await symlink(victim, path.join(repositoryDir, 'AGENTS.md'), 'file');
        git(repositoryDir, ['add', '-A']);
        git(repositoryDir, ['commit', '-qm', 'head symlink']);

        const workspace = await createTrustedWorkspace({
            repositoryDir,
            baseSha,
            headSha: rev(repositoryDir, 'HEAD'),
            scratchRoot: root
        });

        workspaces.push(workspace);

        expect(await readFile(victim, 'utf8')).toBe('VICTIM CONTENT\n');
        const removed = await rejectionOf(lstat(path.join(workspace.directory, 'AGENTS.md')));
        expect(removed).toBeInstanceOf(Error);
    });

    test('replaces a HEAD AGENTS.md directory with the BASE file', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'sakre-trusted-directory-'));
        roots.push(root);
        const repositoryDir = await initRepository(root);
        await writeFile(path.join(repositoryDir, 'AGENTS.md'), 'base instructions\n', 'utf8');
        git(repositoryDir, ['add', '-A']);
        git(repositoryDir, ['commit', '-qm', 'base']);
        const baseSha = rev(repositoryDir, 'HEAD');

        await rm(path.join(repositoryDir, 'AGENTS.md'), { force: true, recursive: true });
        await writeNested(repositoryDir, 'AGENTS.md/inside.txt', 'directory content\n');
        git(repositoryDir, ['add', '-A']);
        git(repositoryDir, ['commit', '-qm', 'head directory']);

        const workspace = await createTrustedWorkspace({
            repositoryDir,
            baseSha,
            headSha: rev(repositoryDir, 'HEAD'),
            scratchRoot: root
        });

        workspaces.push(workspace);

        const target = path.join(workspace.directory, 'AGENTS.md');
        const targetStats = await lstat(target);
        expect(targetStats.isFile()).toBe(true);
        expect(await readFile(target, 'utf8')).toBe('base instructions\n');
    });

    test('does not write a nested BASE AGENTS.md through a HEAD directory symlink', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'sakre-trusted-parent-symlink-'));
        roots.push(root);
        const repositoryDir = await initRepository(root);
        await writeNested(repositoryDir, 'nested/AGENTS.md', 'base nested instructions\n');
        await writeNested(repositoryDir, 'app.js', 'export const value = 1;\n');
        git(repositoryDir, ['add', '-A']);
        git(repositoryDir, ['commit', '-qm', 'base']);
        const baseSha = rev(repositoryDir, 'HEAD');

        const outsideDir = path.join(root, 'outside');
        await mkdir(outsideDir);
        const victim = path.join(outsideDir, 'AGENTS.md');
        await writeFile(victim, 'VICTIM CONTENT\n', 'utf8');
        await rm(path.join(repositoryDir, 'nested'), { recursive: true, force: true });
        await symlink(outsideDir, path.join(repositoryDir, 'nested'), 'dir');
        git(repositoryDir, ['add', '-A']);
        git(repositoryDir, ['commit', '-qm', 'head parent symlink']);

        const workspace = await createTrustedWorkspace({
            repositoryDir,
            baseSha,
            headSha: rev(repositoryDir, 'HEAD'),
            scratchRoot: root
        });

        workspaces.push(workspace);

        expect(await readFile(victim, 'utf8')).toBe('VICTIM CONTENT\n');
        const nested = path.join(workspace.directory, 'nested');
        const nestedStats = await lstat(nested);
        expect(nestedStats.isDirectory()).toBe(true);
        expect(await readFile(path.join(nested, 'AGENTS.md'), 'utf8')).toBe('base nested instructions\n');
    });

    test('overlays case-variant agents.md files so no HEAD content survives', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'sakre-trusted-case-'));
        roots.push(root);
        const repositoryDir = await initRepository(root);
        await writeFile(path.join(repositoryDir, 'AGENTS.md'), 'base exact instructions\n', 'utf8');
        await writeFile(path.join(repositoryDir, 'app.js'), 'export const value = 1;\n', 'utf8');
        git(repositoryDir, ['add', '-A']);
        git(repositoryDir, ['commit', '-qm', 'base']);
        const baseSha = rev(repositoryDir, 'HEAD');

        /* HEAD renames the exact-case file to a lowercase variant and adds a
           second variant BASE never had. */
        await rm(path.join(repositoryDir, 'AGENTS.md'), { force: true });
        await writeFile(path.join(repositoryDir, 'agents.md'), 'head lowercase instructions\n', 'utf8');
        await writeNested(repositoryDir, 'docs/agents.md', 'head docs instructions\n');
        git(repositoryDir, ['add', '-A']);
        git(repositoryDir, ['commit', '-qm', 'head case variants']);

        const workspace = await createTrustedWorkspace({
            repositoryDir,
            baseSha,
            headSha: rev(repositoryDir, 'HEAD'),
            scratchRoot: root
        });

        workspaces.push(workspace);

        expect(await readFile(path.join(workspace.directory, 'agents.md'), 'utf8')).toBe('base exact instructions\n');
        const added = await rejectionOf(readFile(path.join(workspace.directory, 'docs', 'agents.md'), 'utf8'));
        expect(added).toBeInstanceOf(Error);
    });
});

async function initRepository(root: string): Promise<string> {
    const repositoryDir = path.join(root, 'repository');
    await mkdir(repositoryDir);
    git(repositoryDir, ['init', '-q', '-b', 'main']);
    git(repositoryDir, ['config', 'user.email', 'workspace@example.com']);
    git(repositoryDir, ['config', 'user.name', 'Workspace Fixture']);

    return repositoryDir;
}
