import { writeFile } from 'node:fs/promises';
import { buildFinalComment, type ReviewReportProvenance } from '../action/state';
import type { ReviewResult } from '../contracts/review';

/* Same Markdown the Action publishes, minus HTML state markers: a local review
   is a report, not an idempotent PR comment. */
export function renderReviewResult(result: ReviewResult, report: ReviewReportProvenance): string {
    return stripCommentMarkers(buildFinalComment(result, report));
}

export function stripCommentMarkers(markdown: string): string {
    const lines = markdown.split('\n').filter((line) => !isMarkerLine(line));
    const firstContent = lines.findIndex((line) => line.trim() !== '');

    if (firstContent === -1) {
        return '';
    }

    return lines.slice(firstContent).join('\n');
}

function isMarkerLine(line: string): boolean {
    return /^\s*<!--.*-->\s*$/u.test(line);
}

export async function writeOutputFile(filePath: string, content: string): Promise<void> {
    await writeFile(filePath, ensureTrailingNewline(content), 'utf8');
}

export function writeTerminal(stream: NodeJS.WritableStream, content: string): void {
    stream.write(ensureTrailingNewline(content));
}

function ensureTrailingNewline(content: string): string {
    if (content === '' || content.endsWith('\n')) {
        return content;
    }

    return `${content}\n`;
}
