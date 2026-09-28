import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readTreePrefix } from '../../src/intelligence/content-prefix';

/* Bounded content reads: the generated-marker oracle must never follow a symlink
   out of the tree, and traversal or absolute paths are refused before opening. */
describe('tree content prefixes', () => {
    test('never follows a symlink to a file outside the tree', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'sakre-prefix-root-'));
        const outside = await mkdtemp(path.join(tmpdir(), 'sakre-prefix-outside-'));

        try {
            await writeFile(path.join(outside, 'secret.ts'), '// @generated secret\n');
            await symlink(path.join(outside, 'secret.ts'), path.join(root, 'escape.ts'));
            const result = await readTreePrefix(root, 'escape.ts');
            expect(result.kind).toBe('absent');
        } finally {
            await Promise.all([
                rm(root, { recursive: true, force: true }),
                rm(outside, { recursive: true, force: true })
            ]);
        }
    });

    test('reads only a bounded prefix of a regular file', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'sakre-prefix-read-'));

        try {
            await mkdir(path.join(root, 'src'), { recursive: true });
            await writeFile(path.join(root, 'src', 'a.ts'), 'a'.repeat(10_000));
            const result = await readTreePrefix(root, 'src/a.ts');
            expect(result.kind).toBe('content');

            if (result.kind === 'content') {
                expect(result.content.length).toBe(2048);
            }
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test('refuses traversal, absolute and NUL paths', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'sakre-prefix-unsafe-'));

        try {
            const traversal = await readTreePrefix(root, '../escape.ts');
            const absolute = await readTreePrefix(root, '/etc/passwd');
            const nul = await readTreePrefix(root, 'a\u0000b.ts');
            expect(traversal).toEqual({ kind: 'absent' });
            expect(absolute).toEqual({ kind: 'absent' });
            expect(nul).toEqual({ kind: 'absent' });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
