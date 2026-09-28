import { describe, expect, test } from 'bun:test';
import { matchesAnyGlob, matchesGlob } from '../../src/analysis/globs';

describe('glob matching', () => {
    test('double-star patterns cover root files and nested files', () => {
        expect(matchesGlob('bun.lock', '**/bun.lock')).toBe(true);
        expect(matchesGlob('packages/app/bun.lock', '**/bun.lock')).toBe(true);
        expect(matchesGlob('src/other/file.ts', '**/bun.lock')).toBe(false);
    });

    test('directory prefixes do not match unrelated roots', () => {
        expect(matchesGlob('src/a.ts', 'src/**')).toBe(true);
        expect(matchesGlob('lib/a.ts', 'src/**')).toBe(false);
        expect(matchesGlob('.github/workflows/ci.yml', '.github/workflows/**')).toBe(true);
    });

    test('exact patterns match exactly', () => {
        expect(matchesGlob('package.json', 'package.json')).toBe(true);
        expect(matchesGlob('nested/package.json', 'package.json')).toBe(false);
    });

    test('matching is case-insensitive and dot-aware', () => {
        expect(matchesGlob('README.md', 'readme.md')).toBe(true);
        expect(matchesGlob('.env.local', '**/.env*')).toBe(true);
    });

    test('matchesAnyGlob reports the first matching pattern family', () => {
        expect(matchesAnyGlob('db/migrations/001.sql', ['**/*.sql', '**/migrations/**'])).toBe(true);
        expect(matchesAnyGlob('src/ui/button.tsx', ['**/*.sql', '**/migrations/**'])).toBe(false);
    });
});
