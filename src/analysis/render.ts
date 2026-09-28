import { classifyFile, defaultClassificationRules, type FileClass, type FileClassification } from './classification';
import {
    BUDGET_REASON,
    type CoverageDiffOptions,
    type CoveragePlan,
    type CoveragePlanEntry,
    type DiffCoverage,
    type DiffFileCoverage,
    isCoveredFile,
    planCoverageDiff,
    publishablePatchChars,
    renderedHeader,
    UNAVAILABLE_REASON
} from './diff';
import type { ClassificationRules } from '../config/schema';
import type { VcsChangedFile } from '../vcs/types';

/* Rendered states, not the plan, decide completeness. Entries carry the pre-pass classification; unseen paths (gitlinks) use the canonical owner with resolved rules, never embedded defaults. */
export interface CoverageRenderOptions {
    classification?: ClassificationRules;
    fileClassifications?: ReadonlyMap<string, FileClassification>;
}

export function renderCoverageDiff(
    plan: CoveragePlan,
    files: readonly VcsChangedFile[],
    options: CoverageRenderOptions = {}
): DiffCoverage {
    const byPath = new Map(files.map((file) => [file.path, file]));
    const rendered = plan.entries.map((entry) => renderEntry(entry, byPath.get(entry.path), options));

    return {
        unifiedDiff: sectionsOf(rendered).join('\n\n'),
        files: rendered.map((entry) => entry.coverage),
        complete: rendered.every((entry) => isCoveredFile(entry.coverage))
    };
}

/* Coverage for callers whose files already carry retained content. */
export function buildCoverageDiff(files: readonly VcsChangedFile[], options: CoverageDiffOptions): DiffCoverage {
    return renderCoverageDiff(planCoverageDiff(files, options), files);
}

interface RenderedEntry {
    coverage: DiffFileCoverage;
    section?: string;
}

const OMITTED_HEADER = '[omitted: ';

function sectionsOf(rendered: RenderedEntry[]): string[] {
    const sections: string[] = [];

    for (const entry of rendered) {
        if (entry.section !== undefined) {
            sections.push(entry.section);
        }
    }

    return sections;
}

function renderEntry(
    entry: CoveragePlanEntry,
    file: VcsChangedFile | undefined,
    options: CoverageRenderOptions
): RenderedEntry {
    const classification = classificationOf(entry, file, options);

    if (entry.contextExcluded === true) {
        return {
            coverage: {
                path: entry.path,
                previousPath: entry.previousPath,
                state: 'complete',
                reason: entry.reason,
                classification,
                contextExcluded: true
            }
        };
    }

    if (entry.state === 'excluded') {
        return {
            coverage: {
                path: entry.path,
                previousPath: entry.previousPath,
                state: 'excluded',
                reason: entry.reason,
                classification
            }
        };
    }

    if (entry.reason === UNAVAILABLE_REASON) {
        return {
            coverage: {
                path: entry.path,
                previousPath: entry.previousPath,
                state: 'budget-truncated',
                reason: UNAVAILABLE_REASON,
                classification
            }
        };
    }

    return renderReviewableEntry(entry, file, classification);
}

function renderReviewableEntry(
    entry: CoveragePlanEntry,
    file: VcsChangedFile | undefined,
    classification: FileClass
): RenderedEntry {
    const base = { path: entry.path, previousPath: entry.previousPath, classification };
    const header = entryHeader(file);
    const content = retainedContent(file) ?? '';

    if (content.length >= entry.need - header.length && entry.state === 'complete') {
        return { coverage: { ...base, state: 'complete' }, section: `${header}${content}` };
    }

    const patchBudget = publishablePatchChars(entry.allocated, header.length);

    if (content.length > 0 && patchBudget > 0) {
        return {
            coverage: { ...base, state: 'truncated', reason: BUDGET_REASON },
            section: `${header}${content.slice(0, patchBudget)}${OMITTED_HEADER}truncated at ${patchBudget} chars]`
        };
    }

    return { coverage: { ...base, state: 'budget-truncated', reason: BUDGET_REASON } };
}

function classificationOf(
    entry: CoveragePlanEntry,
    file: VcsChangedFile | undefined,
    options: CoverageRenderOptions
): FileClass {
    const resolved = options.fileClassifications?.get(entry.path);

    if (resolved !== undefined) {
        return resolved.classification;
    }

    const paths = {
        path: file?.path ?? entry.path,
        previousPath: file?.previousPath ?? entry.previousPath,
        rules: options.classification ?? defaultClassificationRules()
    };

    return classifyFile(paths).classification;
}

function entryHeader(file: VcsChangedFile | undefined): string {
    if (file === undefined) {
        return '';
    }

    return renderedHeader(file);
}

function retainedContent(file: VcsChangedFile | undefined): string | undefined {
    if (file?.patch.state !== 'retained') {
        return undefined;
    }

    return file.patch.content;
}
