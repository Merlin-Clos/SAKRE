import type { CcccFileMetrics, CcccFlatFunction } from './measure-cccc';
import type { FunctionMatch, FunctionMetricBlock, ReviewMapFunction } from './schema';

/* A pair exists only when its key is unique on both sides; CCCC has no stable ids, so a guessed delta stays worse than a stated addition. Moved functions are unmatched in v1. */

interface FunctionEntry {
    path: string;
    fn: CcccFlatFunction;
}

export interface FunctionMatchInput {
    base: readonly CcccFileMetrics[];
    head: readonly CcccFileMetrics[];
    /* BASE path -> HEAD path for git/API renames. */
    renames: ReadonlyMap<string, string>;
}

export function matchFunctions(input: FunctionMatchInput): ReviewMapFunction[] {
    const baseEntries = entriesFor(input.base, input.renames);
    const headEntries = entriesFor(input.head);
    const baseByKey = indexByKey(baseEntries);
    const headByKey = indexByKey(headEntries);

    const keys = [...new Set([...baseByKey.keys(), ...headByKey.keys()])].toSorted((left, right) =>
        left.localeCompare(right)
    );

    const functions: ReviewMapFunction[] = [];

    for (const key of keys) {
        functions.push(...matchKey(baseByKey.get(key) ?? [], headByKey.get(key) ?? []));
    }

    return functions.toSorted(compareFunctions);
}

function entriesFor(files: readonly CcccFileMetrics[], renames?: ReadonlyMap<string, string>): FunctionEntry[] {
    const entries: FunctionEntry[] = [];

    for (const file of files) {
        let mapped = file.path;

        if (renames !== undefined) {
            mapped = renames.get(file.path) ?? file.path;
        }

        for (const fn of file.functions) {
            entries.push({ path: mapped, fn });
        }
    }

    return entries;
}

function keyOf(entry: FunctionEntry): string {
    const { fn } = entry;

    return [entry.path, fn.parentChain.join('\u0001'), fn.kind, fn.name].join('\u0000');
}

function indexByKey(entries: readonly FunctionEntry[]): Map<string, FunctionEntry[]> {
    const index = new Map<string, FunctionEntry[]>();

    for (const entry of entries) {
        const key = keyOf(entry);
        const group = index.get(key);

        if (group === undefined) {
            index.set(key, [entry]);
        } else {
            group.push(entry);
        }
    }

    return index;
}

function matchKey(baseGroup: FunctionEntry[], headGroup: FunctionEntry[]): ReviewMapFunction[] {
    const [base] = baseGroup;
    const [head] = headGroup;

    if (baseGroup.length === 1 && headGroup.length === 1 && base !== undefined && head !== undefined) {
        return [matchedFunction(base, head)];
    }

    if (baseGroup.length === 0 && headGroup.length === 1 && head !== undefined) {
        return [singleSideFunction(head, 'added', 'head')];
    }

    if (baseGroup.length === 1 && headGroup.length === 0 && base !== undefined) {
        return [singleSideFunction(base, 'deleted', 'base')];
    }

    return [
        ...baseGroup.map((entry) => singleSideFunction(entry, 'ambiguous', 'base')),
        ...headGroup.map((entry) => singleSideFunction(entry, 'ambiguous', 'head'))
    ];
}

function matchedFunction(base: FunctionEntry, head: FunctionEntry): ReviewMapFunction {
    return {
        path: head.path,
        name: head.fn.name,
        kind: head.fn.kind,
        parentChain: [...head.fn.parentChain],
        base: blockOf(base.fn),
        head: blockOf(head.fn),
        delta: {
            cognitive: head.fn.cognitive - base.fn.cognitive,
            cyclomatic: head.fn.cyclomatic - base.fn.cyclomatic
        },
        match: 'matched'
    };
}

function singleSideFunction(entry: FunctionEntry, match: FunctionMatch, side: 'base' | 'head'): ReviewMapFunction {
    const block = blockOf(entry.fn);
    let base: FunctionMetricBlock | null = null;
    let head: FunctionMetricBlock | null = null;

    if (side === 'base') {
        base = block;
    } else {
        head = block;
    }

    return {
        path: entry.path,
        name: entry.fn.name,
        kind: entry.fn.kind,
        parentChain: [...entry.fn.parentChain],
        base,
        head,
        delta: null,
        match
    };
}

function blockOf(fn: CcccFlatFunction): FunctionMetricBlock {
    return { line: fn.line, cognitive: fn.cognitive, cyclomatic: fn.cyclomatic };
}

function compareFunctions(left: ReviewMapFunction, right: ReviewMapFunction): number {
    const leftLine = lineOf(left);
    const rightLine = lineOf(right);

    return (
        left.path.localeCompare(right.path) ||
        leftLine - rightLine ||
        left.name.localeCompare(right.name) ||
        left.kind.localeCompare(right.kind)
    );
}

function lineOf(fn: ReviewMapFunction): number {
    if (fn.head !== null) {
        return fn.head.line;
    }

    if (fn.base !== null) {
        return fn.base.line;
    }

    return 0;
}
