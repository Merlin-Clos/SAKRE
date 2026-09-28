import { describe, expect, test } from 'bun:test';
import { isTreePathSafe, normalizeToolPath } from '../../src/intelligence/tree-paths';

/* Both pinned tools report paths relative to the walked directory. On Windows
   the walked root and the native separator leak into the JSON (`.\src\a.ts`),
   so the canonical path must be unified before any snapshot index or matching
   key is built. */
describe('tool path normalization', () => {
    test('strips the walked root and unifies Windows separators', () => {
        expect(normalizeToolPath('src/a.ts')).toBe('src/a.ts');
        expect(normalizeToolPath('./src/a.ts')).toBe('src/a.ts');
        expect(normalizeToolPath(String.raw`src\a.ts`)).toBe('src/a.ts');
        expect(normalizeToolPath(String.raw`.\src\a.ts`)).toBe('src/a.ts');
        expect(normalizeToolPath('a.ts')).toBe('a.ts');
        expect(normalizeToolPath(String.raw`.\a.ts`)).toBe('a.ts');
    });
});

/* Materialization safety: a backslash is a legal POSIX filename byte but a
   Windows separator, so any path a platform join would reinterpret must be
   recorded instead of joined. */
describe('tree path materialization safety', () => {
    test('accepts relative POSIX paths and rejects separators or traversal', () => {
        expect(isTreePathSafe('src/a.ts')).toBe(true);
        expect(isTreePathSafe('a.ts')).toBe(true);
        expect(isTreePathSafe('src/a b.ts')).toBe(true);
        expect(isTreePathSafe('')).toBe(false);
        expect(isTreePathSafe('/etc/passwd')).toBe(false);
        expect(isTreePathSafe(String.raw`src\a.ts`)).toBe(false);
        expect(isTreePathSafe('a\u0000b.ts')).toBe(false);
        expect(isTreePathSafe('../escape.ts')).toBe(false);
        expect(isTreePathSafe('src/../../escape.ts')).toBe(false);
    });
});
