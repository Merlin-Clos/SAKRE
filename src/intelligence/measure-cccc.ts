import { z } from 'zod';
import { CancelledError } from '../analysis/cancellation';
import { runProcessCapture } from '../analysis/run-process';
import { describeError } from '../errors';
import { normalizeToolPath } from './tree-paths';

/* One run per snapshot on the filtered tree; unsupported files are skipped and reported, parse errors are data, and `--no-cache` keeps the workspace stateless. */

const CCCC_ARGUMENTS = ['--no-config', '--no-ignore', '--no-cache'] as const;

const distributionSchema = z.object({
    sum: z.number(),
    max: z.number(),
    median: z.number(),
    p90: z.number(),
    p95: z.number()
});

const ccccFunctionSchema: z.ZodType<CcccFunctionMetrics> = z.lazy(() =>
    z.object({
        name: z.string(),
        kind: z.string(),
        line: z.number(),
        cognitive: z.number(),
        cyclomatic: z.number(),
        children: z.array(ccccFunctionSchema).optional()
    })
);

const ccccFileSchema = z.object({
    path: z.string(),
    cognitive: z.number(),
    cyclomatic: z.number(),
    functions: z.array(ccccFunctionSchema).optional(),
    parse_errors: z.array(z.string()).optional()
});

const ccccSummarySchema = z.object({
    file_count: z.number(),
    function_count: z.number(),
    parse_error_count: z.number(),
    parse_error_file_count: z.number(),
    parse_error_files: z.array(z.string()).optional(),
    cognitive: distributionSchema,
    cyclomatic: distributionSchema
});

const ccccOutputSchema = z.object({
    files: z.array(ccccFileSchema),
    summary: ccccSummarySchema
});

export class CcccError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = 'CcccError';
    }
}

export interface CcccDistribution {
    sum: number;
    max: number;
    median: number;
    p90: number;
    p95: number;
}

export interface CcccFunctionMetrics {
    name: string;
    kind: string;
    line: number;
    cognitive: number;
    cyclomatic: number;
    children?: CcccFunctionMetrics[];
}

export interface CcccFlatFunction {
    name: string;
    kind: string;
    line: number;
    cognitive: number;
    cyclomatic: number;
    /* Root-first ancestor names derived from the nested `children` shape. */
    parentChain: string[];
}

export interface CcccFileMetrics {
    path: string;
    cognitive: number;
    cyclomatic: number;
    functions: CcccFlatFunction[];
    parseErrors: string[];
}

export interface CcccSummary {
    fileCount: number;
    functionCount: number;
    parseErrorCount: number;
    parseErrorFileCount: number;
    parseErrorFiles: string[];
    cognitive: CcccDistribution;
    cyclomatic: CcccDistribution;
}

export interface CcccSnapshot {
    files: CcccFileMetrics[];
    summary: CcccSummary;
    /* Requested files the tool skipped: unsupported extension or language. */
    unsupported: string[];
}

export interface MeasureCcccInput {
    binaryPath: string;
    /* Filtered analysis tree containing exactly the planned files. */
    directory: string;
    /* Canonical plan; only the directory is invoked, the list stays the coverage contract. */
    files: readonly string[];
    signal?: AbortSignal;
}

export async function measureCccc(input: MeasureCcccInput): Promise<CcccSnapshot> {
    throwIfAborted(input.signal);

    if (input.files.length === 0) {
        /* CCCC exits 0 with no JSON when the directory holds no matching file. */
        return emptyCcccSnapshot();
    }

    const output = await runCccc(input);

    return parseCcccSnapshot(output, input.files);
}

/* Positional `.` targets the filtered tree root: one invocation with no flag letting config or ignore files change the result. */
export function buildCcccArguments(): string[] {
    return [...CCCC_ARGUMENTS, '--', '.'];
}

export function emptyCcccSnapshot(): CcccSnapshot {
    const distribution = { sum: 0, max: 0, median: 0, p90: 0, p95: 0 };

    return {
        files: [],
        unsupported: [],
        summary: {
            fileCount: 0,
            functionCount: 0,
            parseErrorCount: 0,
            parseErrorFileCount: 0,
            parseErrorFiles: [],
            cognitive: { ...distribution },
            cyclomatic: { ...distribution }
        }
    };
}

export function parseCcccSnapshot(output: string, requestedFiles: readonly string[] = []): CcccSnapshot {
    const parsed = parseCcccOutput(output);
    const result = ccccOutputSchema.safeParse(parsed);

    if (!result.success) {
        throw new CcccError(`CCCC returned an unsupported JSON shape: ${result.error.message}`);
    }

    const files = result.data.files
        .map((file) => fileMetrics(file))
        .toSorted((left, right) => left.path.localeCompare(right.path));

    const paths = new Set(files.map((file) => file.path));

    return {
        files,
        summary: summaryMetrics(result.data.summary),
        unsupported: requestedFiles
            .filter((file) => !paths.has(file))
            .toSorted((left, right) => left.localeCompare(right))
    };
}

/* Depth-first flattening with root-first `parentChain`, so the matching key stays stable across runs. */
export function flattenFunctions(functions: readonly CcccFunctionMetrics[]): CcccFlatFunction[] {
    const flattened: CcccFlatFunction[] = [];

    for (const fn of functions) {
        appendFunction(flattened, fn, []);
    }

    return flattened.toSorted(compareFunctions);
}

function appendFunction(flattened: CcccFlatFunction[], fn: CcccFunctionMetrics, parents: string[]): void {
    flattened.push({
        name: fn.name,
        kind: fn.kind,
        line: fn.line,
        cognitive: fn.cognitive,
        cyclomatic: fn.cyclomatic,
        parentChain: parents
    });
    const childParents = [...parents, fn.name];

    for (const child of fn.children ?? []) {
        appendFunction(flattened, child, childParents);
    }
}

function compareFunctions(left: CcccFlatFunction, right: CcccFlatFunction): number {
    return (
        left.line - right.line ||
        left.name.localeCompare(right.name) ||
        left.kind.localeCompare(right.kind) ||
        left.parentChain.join('\u0000').localeCompare(right.parentChain.join('\u0000'))
    );
}

function fileMetrics(file: z.infer<typeof ccccFileSchema>): CcccFileMetrics {
    return {
        path: normalizeToolPath(file.path),
        cognitive: file.cognitive,
        cyclomatic: file.cyclomatic,
        functions: flattenFunctions(file.functions ?? []),
        parseErrors: file.parse_errors ?? []
    };
}

function summaryMetrics(summary: z.infer<typeof ccccSummarySchema>): CcccSummary {
    return {
        fileCount: summary.file_count,
        functionCount: summary.function_count,
        parseErrorCount: summary.parse_error_count,
        parseErrorFileCount: summary.parse_error_file_count,
        parseErrorFiles: (summary.parse_error_files ?? [])
            .map((file) => normalizeToolPath(file))
            .toSorted((left, right) => left.localeCompare(right)),
        cognitive: { ...summary.cognitive },
        cyclomatic: { ...summary.cyclomatic }
    };
}

// eslint-disable-next-line anti-slop/no-unknown-returns -- tool JSON parses to unknown until schema-validated
function parseCcccOutput(output: string): unknown {
    try {
        return JSON.parse(output);
    } catch (error) {
        throw new CcccError(`CCCC returned malformed JSON: ${describeError(error)}`);
    }
}

async function runCccc(input: MeasureCcccInput): Promise<string> {
    try {
        const result = await runProcessCapture({
            command: input.binaryPath,
            args: buildCcccArguments(),
            cwd: input.directory,
            signal: input.signal
        });

        if (result.exitCode !== 0) {
            throw new CcccError(`CCCC failed with exit code ${result.exitCode}: ${result.stderr.trim()}`);
        }

        return result.stdout;
    } catch (error) {
        if (error instanceof CancelledError || error instanceof CcccError) {
            throw error;
        }

        if (error instanceof Error && error.name === 'AbortError') {
            throw new CancelledError();
        }

        throw new CcccError(`CCCC failed to start: ${describeError(error)}`);
    }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted === true) {
        throw new CancelledError();
    }
}
