import type { CoveragePlan, CoveragePlanEntry } from './diff';

/* Exact budget numbers shared by the abort message, the CLI prompt, and the
   Action comment. */
export interface CoverageBudgetSummary {
    totalChars: number;
    limitChars: number;
    coveredChars: number;
    reviewableFiles: number;
    completeFiles: number;
}

interface CoverageTotals {
    totalChars: number;
    coveredChars: number;
    reviewableFiles: number;
    completeFiles: number;
}

const PERCENT_SCALE = 100;

const FULL_PERCENT = 100;

/* Abort message share uses covered characters from the real allocation, not chars/limit. */
export function summarizeCoverage(plan: CoveragePlan, limitChars: number): CoverageBudgetSummary {
    const totals: CoverageTotals = { totalChars: 0, coveredChars: 0, reviewableFiles: 0, completeFiles: 0 };

    for (const entry of plan.entries) {
        accumulateCoverage(totals, entry);
    }

    return { ...totals, limitChars };
}

function accumulateCoverage(totals: CoverageTotals, entry: CoveragePlanEntry): void {
    if (entry.state === 'excluded' || entry.contextExcluded === true) {
        return;
    }

    totals.reviewableFiles += 1;
    totals.totalChars += entry.need;

    if (entry.state === 'complete') {
        totals.coveredChars += entry.need;
        totals.completeFiles += 1;

        return;
    }

    if (entry.state === 'truncated') {
        totals.coveredChars += entry.allocated;
    }
}

export function formatBudgetReport(summary: CoverageBudgetSummary): string {
    const percent = coveragePercent(summary);

    return `diff = ${summary.totalChars} characters, limit = ${summary.limitChars}; reviewable ${percent.toFixed(1)} % (${summary.completeFiles}/${summary.reviewableFiles} files complete)`;
}

function coveragePercent(summary: CoverageBudgetSummary): number {
    if (summary.totalChars === 0) {
        return FULL_PERCENT;
    }

    return (summary.coveredChars / summary.totalChars) * PERCENT_SCALE;
}
