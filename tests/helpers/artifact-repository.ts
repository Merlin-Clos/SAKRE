import { spawnSync } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/* Shared fixture helpers for the compiled-artifact tests. */

export interface ArtifactRepository {
    rootDir: string;
    baseSha: string;
    headSha: string;
}

export async function createRepository(root: string): Promise<{ rootDir: string; baseSha: string; headSha: string }> {
    const rootDir = path.join(root, 'repository');
    await mkdir(path.join(rootDir, 'src'), { recursive: true });
    git(rootDir, ['init', '-q', '-b', 'main']);
    git(rootDir, ['config', 'user.email', 'artifact@example.com']);
    git(rootDir, ['config', 'user.name', 'Artifact Fixture']);
    await writeFile(path.join(rootDir, 'src', 'app.js'), 'export const value = 1;\n', 'utf8');
    git(rootDir, ['add', '-A']);
    git(rootDir, ['commit', '-qm', 'base']);
    const baseSha = rev(rootDir, 'HEAD');
    await writeFile(path.join(rootDir, 'src', 'app.js'), 'export const value = 2;\n', 'utf8');
    git(rootDir, ['add', '-A']);
    git(rootDir, ['commit', '-qm', 'head']);
    const headSha = rev(rootDir, 'HEAD');

    return { rootDir, baseSha, headSha };
}

export function git(rootDir: string, args: string[]): void {
    const result = spawnSync('git', args, { cwd: rootDir, encoding: 'utf8' });

    if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    }
}

export function rev(rootDir: string, ref: string): string {
    return spawnSync('git', ['rev-parse', ref], { cwd: rootDir, encoding: 'utf8' }).stdout.trim();
}

export function systemBinary(name: string): string {
    const binary = optionalSystemBinary(name);

    if (binary === undefined) {
        throw new Error(`The artifact test requires ${name} on PATH.`);
    }

    return binary;
}

export function optionalSystemBinary(name: string): string | undefined {
    const result = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
    const binary = result.stdout.trim();

    if (result.status !== 0 || binary === '') {
        return undefined;
    }

    return binary;
}

export async function fileExists(filePath: string): Promise<boolean> {
    try {
        await access(filePath);

        return true;
    } catch {
        return false;
    }
}
