import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertPinnedBunVersion } from '../../scripts/bun-version';
import { rejectionOf } from '../helpers/rejection';

const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(prefix: string): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), prefix));
    roots.push(root);

    return root;
}

async function pinFile(content: string): Promise<string> {
    const root = await tempRoot('sakre-bun-version-');
    const file = path.join(root, '.bun-version');
    await writeFile(file, content);

    return file;
}

describe('pinned Bun toolchain guard', () => {
    test('accepts a pin that matches the running Bun', async () => {
        await assertPinnedBunVersion(await pinFile(`${Bun.version}\n`));
    });

    test('rejects a pin that differs from the running Bun', async () => {
        const error = await rejectionOf(assertPinnedBunVersion(await pinFile('0.0.0\n')));
        expect(error.message).toContain('0.0.0');
        expect(error.message).toContain(Bun.version);
    });

    test('rejects an empty pin file', async () => {
        const error = await rejectionOf(assertPinnedBunVersion(await pinFile('\n')));
        expect(error.message).toContain('does not pin a Bun version');
    });
});

describe('pinned Bun toolchain guard wiring', () => {
    test('build-release fails on a mismatched pin before writing release output', async () => {
        const root = await tempRoot('sakre-build-release-');
        await writeFile(path.join(root, '.bun-version'), '0.0.0\n');

        const result = spawnSync(
            process.execPath,
            [path.resolve('scripts/build-release.ts'), '--target', 'linux-x64'],
            { cwd: root, encoding: 'utf8' }
        );

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('pins 0.0.0');
        expect(await fileExists(path.join(root, 'dist-release'))).toBe(false);
    });
});

async function fileExists(file: string): Promise<boolean> {
    try {
        await stat(file);

        return true;
    } catch {
        return false;
    }
}
