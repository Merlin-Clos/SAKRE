import { z } from 'zod';
import { CancelledError } from '../analysis/cancellation';
import { runProcessCapture } from '../analysis/run-process';
import { describeError } from '../errors';
import { normalizeToolPath } from './tree-paths';

/* One run per snapshot on the filtered tree with no config able to change the result. DRYness is `ULOC / Lines`, the formula the official report shows. */

const SCC_ARGUMENTS = [
    '--by-file',
    '--format',
    'json',
    '--no-cocomo',
    '-a',
    '--cognitive',
    '--no-config',
    '--no-gitignore',
    '--no-ignore',
    '--no-scc-ignore',
    '--no-gitmodule'
] as const;

const DRYNESS_PRECISION = 4;

const DECIMAL_BASE = 10;

/* Counters are optional so a minor release dropping a dead field cannot fail a review. */
const sccFileSchema = z.object({
    Language: z.string(),
    PossibleLanguages: z.array(z.string()).optional(),
    Location: z.string(),
    Bytes: z.number().optional(),
    Lines: z.number(),
    Code: z.number().optional(),
    Comment: z.number().optional(),
    Blank: z.number().optional(),
    Complexity: z.number().optional(),
    Cognitive: z.number().optional(),
    Binary: z.boolean().optional(),
    Minified: z.boolean().optional(),
    Generated: z.boolean().optional(),
    Uloc: z.number().optional()
});

const sccLanguageSchema = z.object({
    Name: z.string(),
    Bytes: z.number().optional(),
    Lines: z.number(),
    Code: z.number().optional(),
    Comment: z.number().optional(),
    Blank: z.number().optional(),
    Complexity: z.number().optional(),
    Cognitive: z.number().optional(),
    Count: z.number(),
    ULOC: z.number().optional(),
    Files: z.array(sccFileSchema).optional()
});

const sccOutputSchema = z.array(sccLanguageSchema);

export class SccMetricsError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = 'SccMetricsError';
    }
}

export interface SccFileMetrics {
    path: string;
    language: string;
    possibleLanguages: string[];
    lines: number;
    code: number;
    comments: number;
    blanks: number;
    bytes: number;
    complexity: number;
    cognitive: number;
    uloc: number;
    binary: boolean;
    minified: boolean;
    generated: boolean;
}

export interface SccRepositoryMetrics {
    files: number;
    lines: number;
    code: number;
    comments: number;
    blanks: number;
    bytes: number;
    complexity: number;
    cognitive: number;
    uloc: number;
    dryness: number | null;
}

export interface SccLanguageMetrics extends SccRepositoryMetrics {
    name: string;
}

export interface SccSnapshot {
    languages: SccLanguageMetrics[];
    files: SccFileMetrics[];
    totals: SccRepositoryMetrics;
}

export interface MeasureSccInput {
    binaryPath: string;
    /* Filtered analysis tree containing exactly the planned files. */
    directory: string;
    /* Canonical plan; only the directory is invoked, the list stays the coverage contract. */
    files: readonly string[];
    signal?: AbortSignal;
}

/* Caller owns the binary, tree and file list. */
export async function measureScc(input: MeasureSccInput): Promise<SccSnapshot> {
    throwIfAborted(input.signal);

    if (input.files.length === 0) {
        return parseSccSnapshot('[]');
    }

    const output = await runScc(input);

    return parseSccSnapshot(output);
}

/* Positional `.` targets the filtered tree root: one invocation with no flag letting ignore or config files change the result. */
export function buildSccArguments(): string[] {
    return [...SCC_ARGUMENTS, '--', '.'];
}

export function parseSccSnapshot(output: string): SccSnapshot {
    const parsed = parseSccOutput(output);
    const languages = sccOutputSchema.safeParse(parsed);

    if (!languages.success) {
        throw new SccMetricsError(`SCC returned an unsupported JSON shape: ${languages.error.message}`);
    }

    return normalizeSccOutput(languages.data);
}

/* ULOC / Lines, rounded like the SCC report. Empty languages yield null, never a fake zero. */
export function deriveDryness(uloc: number, lines: number): number | null {
    if (lines <= 0) {
        return null;
    }

    return roundTo(uloc / lines, DRYNESS_PRECISION);
}

export function roundTo(value: number, precision: number): number {
    const factor = DECIMAL_BASE ** precision;

    return Math.round(value * factor) / factor;
}

// eslint-disable-next-line anti-slop/no-unknown-returns -- tool JSON parses to unknown until schema-validated
function parseSccOutput(output: string): unknown {
    try {
        return JSON.parse(output);
    } catch (error) {
        throw new SccMetricsError(`SCC returned malformed JSON: ${describeError(error)}`);
    }
}

function normalizeSccOutput(languages: z.infer<typeof sccLanguageSchema>[]): SccSnapshot {
    const normalizedLanguages = languages
        .map((language) => languageMetrics(language))
        .toSorted((left, right) => left.name.localeCompare(right.name));

    const files = languages
        .flatMap((language) => (language.Files ?? []).map((file) => fileMetrics(file)))
        .toSorted((left, right) => left.path.localeCompare(right.path));

    const totals = sumMetrics(normalizedLanguages);

    if (!Number.isSafeInteger(totals.files) || !Number.isSafeInteger(totals.lines)) {
        throw new SccMetricsError('SCC metrics exceed JavaScript safe integer limits.');
    }

    return { languages: normalizedLanguages, files, totals };
}

function languageMetrics(language: z.infer<typeof sccLanguageSchema>): SccLanguageMetrics {
    const { uloc, cognitive } = optionalMetrics(language);

    return {
        name: language.Name,
        files: language.Count,
        lines: language.Lines,
        code: language.Code ?? 0,
        comments: language.Comment ?? 0,
        blanks: language.Blank ?? 0,
        bytes: language.Bytes ?? 0,
        complexity: language.Complexity ?? 0,
        cognitive,
        uloc,
        dryness: deriveDryness(uloc, language.Lines)
    };
}

function fileMetrics(file: z.infer<typeof sccFileSchema>): SccFileMetrics {
    const { uloc, cognitive } = optionalMetrics(file);

    return {
        path: normalizeToolPath(file.Location),
        language: file.Language,
        possibleLanguages: [...(file.PossibleLanguages ?? [])].toSorted((left, right) => left.localeCompare(right)),
        lines: file.Lines,
        code: file.Code ?? 0,
        comments: file.Comment ?? 0,
        blanks: file.Blank ?? 0,
        bytes: file.Bytes ?? 0,
        complexity: file.Complexity ?? 0,
        cognitive,
        uloc,
        binary: file.Binary ?? false,
        minified: file.Minified ?? false,
        generated: file.Generated ?? false
    };
}

/* A language without a metric reports nothing, which is a real zero for it. */
function optionalMetrics(entry: { ULOC?: number; Uloc?: number; Cognitive?: number }): {
    uloc: number;
    cognitive: number;
} {
    if ('ULOC' in entry) {
        // eslint-disable-next-line anti-slop/no-known-value-widening -- literal matches the declared metric contract
        return { uloc: entry.ULOC ?? 0, cognitive: entry.Cognitive ?? 0 };
    }

    // eslint-disable-next-line anti-slop/no-known-value-widening -- literal matches the declared metric contract
    return { uloc: entry.Uloc ?? 0, cognitive: entry.Cognitive ?? 0 };
}

const NUMERIC_METRIC_FIELDS = [
    'files',
    'lines',
    'code',
    'comments',
    'blanks',
    'bytes',
    'complexity',
    'cognitive',
    'uloc'
] as const;

function sumMetrics(languages: SccLanguageMetrics[]): SccRepositoryMetrics {
    const totals: SccRepositoryMetrics = {
        files: 0,
        lines: 0,
        code: 0,
        comments: 0,
        blanks: 0,
        bytes: 0,
        complexity: 0,
        cognitive: 0,
        uloc: 0,
        dryness: null
    };

    for (const language of languages) {
        accumulateMetrics(totals, language);
    }

    totals.dryness = deriveDryness(totals.uloc, totals.lines);

    return totals;
}

function accumulateMetrics(totals: SccRepositoryMetrics, language: SccLanguageMetrics): void {
    for (const field of NUMERIC_METRIC_FIELDS) {
        totals[field] += language[field];
    }
}

async function runScc(input: MeasureSccInput): Promise<string> {
    try {
        const result = await runProcessCapture({
            command: input.binaryPath,
            args: buildSccArguments(),
            cwd: input.directory,
            /* A committed .sccconfig or inherited SCC_CONFIG_PATH must not change the measurement. */
            env: { ...process.env, SCC_CONFIG_PATH: '' },
            signal: input.signal
        });

        if (result.exitCode !== 0) {
            throw new SccMetricsError(`SCC failed with exit code ${result.exitCode}: ${result.stderr.trim()}`);
        }

        return result.stdout;
    } catch (error) {
        if (error instanceof CancelledError || error instanceof SccMetricsError) {
            throw error;
        }

        if (error instanceof Error && error.name === 'AbortError') {
            throw new CancelledError();
        }

        throw new SccMetricsError(`SCC failed to start: ${describeError(error)}`);
    }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted === true) {
        throw new CancelledError();
    }
}
