import { type CoverageBudgetSummary, formatBudgetReport } from '../analysis/budget';

export class AlreadyReviewedError extends Error {
    public constructor(headSha: string) {
        super(`A review is already complete for head SHA ${headSha}. Use --force to re-review.`);
        this.name = 'AlreadyReviewedError';
    }
}

/* Raised before any provider call when the diff exceeds budget without force.
   The report lets the caller publish exact numbers without re-deriving them. */
export class DiffBudgetExceededError extends Error {
    public readonly report: CoverageBudgetSummary;

    public constructor(report: CoverageBudgetSummary) {
        super(`Diff exceeds the review budget: ${formatBudgetReport(report)}.`);
        this.name = 'DiffBudgetExceededError';
        this.report = report;
    }
}
