import { parse as parseYaml } from 'yaml';
import embeddedDefaults from '../../defaults/review.yml' with { type: 'text' };
import { type ClassificationRules, classificationRulesSchema } from '../config/schema';
import { matchesAnyGlob } from './globs';

/* Single owner of file classification. Rules come from embedded defaults and the repo override; risk, ReviewMap, measurements and diff metadata consume it. */

export const fileClasses = [
    'source',
    'test',
    'docs',
    'config',
    'lockfile',
    'generated',
    'vendor',
    'asset',
    'other'
] as const;

export type FileClass = (typeof fileClasses)[number];

/* Policies derived from the class for both measurement tools, never stored as the class. */
export type SccEligibility = 'counted' | 'not-counted';

export type CcccEligibility = 'attempted' | 'unsupported';

export interface FileClassification {
    classification: FileClass;
    risk: { noise: boolean };
    analysis: { scc: SccEligibility; cccc: CcccEligibility };
}

export interface FileClassificationInput {
    path: string;
    previousPath?: string;
    /* Bounded file prefix; markers are only searched in the first bytes. */
    content?: string;
    rules?: ClassificationRules;
}

/* Only the file start is searched, keeping reads bounded for large files. */
export const GENERATED_MARKER_BYTES = 2048;

const NOISE_CLASSES: ReadonlySet<FileClass> = new Set(['lockfile', 'generated', 'vendor', 'asset']);

/* Permissive source extensions separate source from `other` when no rule matches. SCC and CCCC still decide what they analyze. */
const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
    'ts',
    'tsx',
    'mts',
    'cts',
    'js',
    'jsx',
    'mjs',
    'cjs',
    'py',
    'pyi',
    'rb',
    'go',
    'rs',
    'java',
    'kt',
    'kts',
    'c',
    'h',
    'cc',
    'cpp',
    'cxx',
    'hpp',
    'hh',
    'cs',
    'swift',
    'm',
    'mm',
    'php',
    'scala',
    'clj',
    'cljs',
    'ex',
    'exs',
    'erl',
    'hrl',
    'hs',
    'ml',
    'mli',
    'lua',
    'pl',
    'pm',
    'r',
    'dart',
    'vue',
    'svelte',
    'astro',
    'html',
    'htm',
    'css',
    'scss',
    'sass',
    'less',
    'sql',
    'graphql',
    'gql',
    'proto',
    'tf',
    'sh',
    'bash',
    'zsh',
    'fish',
    'ps1',
    'psm1',
    'bat',
    'cmd',
    'groovy',
    'gradle',
    'fs',
    'fsx',
    'vb',
    'asm',
    's',
    'zig',
    'nim',
    'cr',
    'jl',
    'sol',
    'thrift',
    'wat'
]);

export function isNoiseClass(fileClass: FileClass): boolean {
    return NOISE_CLASSES.has(fileClass);
}

export function analysisFor(fileClass: FileClass): FileClassification['analysis'] {
    if (isNoiseClass(fileClass)) {
        return { scc: 'not-counted', cccc: 'unsupported' };
    }

    return { scc: 'counted', cccc: 'attempted' };
}

/* Path-only classification: deterministic and independent of file content.
   Content-marked generated files are only detected when a prefix is provided. */
export function classifyPath(filePath: string, rules: ClassificationRules = defaultClassificationRules()): FileClass {
    return classifyStrongPath(filePath, rules) ?? classifyWeakPath(filePath, rules) ?? extensionClass(filePath);
}

/* Strong signals first: build artifacts and third-party trees outrank every
   path that could also look like documentation or a test fixture. */
function classifyStrongPath(filePath: string, rules: ClassificationRules): FileClass | undefined {
    if (matchesAnyGlob(filePath, rules.lockfilePatterns)) {
        return 'lockfile';
    }

    if (matchesAnyGlob(filePath, rules.vendorPatterns)) {
        return 'vendor';
    }

    if (matchesAnyGlob(filePath, rules.assetPatterns)) {
        return 'asset';
    }

    if (matchesAnyGlob(filePath, rules.generatedPathPatterns)) {
        return 'generated';
    }

    return undefined;
}

function classifyWeakPath(filePath: string, rules: ClassificationRules): FileClass | undefined {
    if (matchesAnyGlob(filePath, rules.docsPatterns)) {
        return 'docs';
    }

    if (matchesAnyGlob(filePath, rules.testPatterns)) {
        return 'test';
    }

    if (matchesAnyGlob(filePath, rules.configPatterns)) {
        return 'config';
    }

    return undefined;
}

function extensionClass(filePath: string): FileClass {
    if (hasSourceExtension(filePath)) {
        return 'source';
    }

    return 'other';
}

export function classifyFile(input: FileClassificationInput): FileClassification {
    const rules = input.rules ?? defaultClassificationRules();
    const classification = classifyFileClass(input, rules);

    return { classification, risk: { noise: isNoiseClass(classification) }, analysis: analysisFor(classification) };
}

/* A rename keeps the noisiest endpoint visible: moving a lockfile or a vendored
   file must not launder it into source code. */
function classifyFileClass(input: FileClassificationInput, rules: ClassificationRules): FileClass {
    if (hasGeneratedMarker(input, rules)) {
        return 'generated';
    }

    const primary = classifyPath(input.path, rules);

    if (input.previousPath === undefined) {
        return primary;
    }

    const previous = classifyPath(input.previousPath, rules);

    if (isNoiseClass(previous) && !isNoiseClass(primary)) {
        return previous;
    }

    return primary;
}

function hasGeneratedMarker(input: FileClassificationInput, rules: ClassificationRules): boolean {
    const { content } = input;

    if (content === undefined || content === '') {
        return false;
    }

    const prefix = content.slice(0, GENERATED_MARKER_BYTES);

    if (!containsMarker(prefix, rules.generatedMarkers)) {
        return false;
    }

    return !pathsMatch(input, rules.generatedExceptions);
}

function containsMarker(prefix: string, markers: readonly string[]): boolean {
    for (const marker of markers) {
        if (prefix.includes(marker)) {
            return true;
        }
    }

    return false;
}

function pathsMatch(input: FileClassificationInput, patterns: readonly string[]): boolean {
    if (matchesAnyGlob(input.path, patterns)) {
        return true;
    }

    return input.previousPath !== undefined && matchesAnyGlob(input.previousPath, patterns);
}

function hasSourceExtension(filePath: string): boolean {
    const name = filePath.slice(filePath.lastIndexOf('/') + 1);
    const dot = name.lastIndexOf('.');

    if (dot <= 0 || dot === name.length - 1) {
        return false;
    }

    return SOURCE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

function parseDefaultClassificationRules(): ClassificationRules {
    const document: unknown = parseYaml(String(embeddedDefaults));

    // eslint-disable-next-line anti-slop/no-runtime-typeof -- validates embedded YAML boundary before schema parse
    if (typeof document !== 'object' || document === null || !('classification' in document)) {
        throw new Error('Embedded review defaults are missing classification rules.');
    }

    return classificationRulesSchema.parse(document.classification);
}

/* Parsed once at module load: an invalid embedded defaults file fails the
   process that imports the classifier instead of producing silent defaults. */
const DEFAULT_CLASSIFICATION_RULES: ClassificationRules = parseDefaultClassificationRules();

export function defaultClassificationRules(): ClassificationRules {
    return DEFAULT_CLASSIFICATION_RULES;
}
