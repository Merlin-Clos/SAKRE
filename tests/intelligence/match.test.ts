import { describe, expect, test } from 'bun:test';
import type { CcccFileMetrics, CcccFlatFunction } from '../../src/intelligence/measure-cccc';
import { matchFunctions } from '../../src/intelligence/match';

function fn(
    name: string,
    line: number,
    cognitive: number,
    cyclomatic: number,
    parentChain: string[] = []
): CcccFlatFunction {
    return { name, kind: 'function', line, cognitive, cyclomatic, parentChain };
}

function file(path: string, functions: CcccFlatFunction[]): CcccFileMetrics {
    return { path, cognitive: 0, cyclomatic: 0, functions, parseErrors: [] };
}

describe('conservative function matching', () => {
    test('matches a unique unchanged function and computes the delta', () => {
        const functions = matchFunctions({
            base: [file('src/a.ts', [fn('handler', 10, 2, 3)])],
            head: [file('src/a.ts', [fn('handler', 12, 5, 4)])],
            renames: new Map()
        });

        expect(functions).toEqual([
            {
                path: 'src/a.ts',
                name: 'handler',
                kind: 'function',
                parentChain: [],
                base: { line: 10, cognitive: 2, cyclomatic: 3 },
                head: { line: 12, cognitive: 5, cyclomatic: 4 },
                delta: { cognitive: 3, cyclomatic: 1 },
                match: 'matched'
            }
        ]);
    });

    test('reports added and deleted functions without a fake delta', () => {
        const functions = matchFunctions({
            base: [file('src/a.ts', [fn('gone', 1, 1, 1)])],
            head: [file('src/a.ts', [fn('fresh', 2, 1, 1)])],
            renames: new Map()
        });

        expect(functions.map((entry) => entry.match)).toEqual(['deleted', 'added']);
        expect(functions.find((entry) => entry.match === 'added')?.base).toBeNull();
        expect(functions.find((entry) => entry.match === 'deleted')?.head).toBeNull();
        expect(functions.find((entry) => entry.match === 'matched')).toBeUndefined();
    });

    test('matches across a rename using the mapped path', () => {
        const functions = matchFunctions({
            base: [file('src/old.ts', [fn('handler', 4, 1, 2)])],
            head: [file('src/new.ts', [fn('handler', 6, 1, 3)])],
            renames: new Map([['src/old.ts', 'src/new.ts']])
        });

        expect(functions).toHaveLength(1);
        expect(functions[0]?.path).toBe('src/new.ts');
        expect(functions[0]?.match).toBe('matched');
        expect(functions[0]?.delta).toEqual({ cognitive: 0, cyclomatic: 1 });
    });

    test('does not match a function moved to a different path without a rename', () => {
        const functions = matchFunctions({
            base: [file('src/a.ts', [fn('handler', 4, 1, 2)])],
            head: [file('src/b.ts', [fn('handler', 4, 1, 2)])],
            renames: new Map()
        });

        expect(functions.map((entry) => entry.match)).toEqual(['deleted', 'added']);
    });

    test('marks duplicate keys ambiguous instead of guessing', () => {
        const functions = matchFunctions({
            base: [
                file('src/a.ts', [fn('handler', 1, 0, 1), fn('handler', 9, 0, 1)]),
                file('src/b.ts', [fn('handler', 2, 0, 1)])
            ],
            head: [file('src/a.ts', [fn('handler', 3, 0, 1)])],
            renames: new Map()
        });

        const aFunctions = functions.filter((entry) => entry.path === 'src/a.ts');
        expect(aFunctions).toHaveLength(3);
        expect(aFunctions.every((entry) => entry.match === 'ambiguous')).toBe(true);
        expect(functions.find((entry) => entry.path === 'src/b.ts')?.match).toBe('deleted');
    });

    test('keeps nested functions distinct through the parent chain', () => {
        const outer = fn('outer', 1, 0, 1);
        const inner = fn('inner', 2, 3, 2, ['outer']);

        const functions = matchFunctions({
            base: [file('src/a.ts', [outer, inner])],
            head: [file('src/a.ts', [outer, fn('inner', 2, 4, 2, ['outer'])])],
            renames: new Map()
        });

        const matched = functions.find((entry) => entry.name === 'inner');
        expect(matched?.parentChain).toEqual(['outer']);
        expect(matched?.match).toBe('matched');
        expect(matched?.delta).toEqual({ cognitive: 1, cyclomatic: 0 });
    });

    test('orders results by path, line, name and kind', () => {
        const functions = matchFunctions({
            base: [file('src/b.ts', [fn('beta', 5, 0, 1)]), file('src/a.ts', [fn('alpha', 9, 0, 1)])],
            head: [file('src/b.ts', [fn('beta', 5, 0, 1)]), file('src/a.ts', [fn('alpha', 9, 0, 1)])],
            renames: new Map()
        });

        expect(functions.map((entry) => entry.path)).toEqual(['src/a.ts', 'src/b.ts']);
    });
});
