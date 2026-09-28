import { type DiffCoverage, isCoveredFile, isReviewableFile } from '../analysis/diff';
import type { RiskAssessment } from '../analysis/risk';
import type { VcsPullRequestSnapshot, VcsReviewComment } from '../vcs/types';
import { delimitUntrusted } from './prompts';

const MAX_HISTORY_ENTRIES = 5;

const MAX_PR_BODY_CHARS = 5000;

const MAX_HISTORY_CHARS = 4000;

export interface ReviewContext {
    prContext: string;
    diff: string;
    riskSummary: string;
    history: string;
    risk: RiskAssessment;
    coverage: DiffCoverage;
    baseSha: string;
    headSha: string;
}

/* Shared context: PR body and history are untrusted and delimited; the diff
   comes from the budgeted coverage. */
export function buildSharedReviewContext(input: {
    snapshot: VcsPullRequestSnapshot;
    coverage: DiffCoverage;
    risk: RiskAssessment;
}): ReviewContext {
    const { snapshot, coverage, risk } = input;

    return {
        prContext: buildPrContext(snapshot),
        diff: coverage.unifiedDiff,
        riskSummary: buildRiskSummary(risk, coverage),
        history: buildHistory(snapshot.comments),
        risk,
        coverage,
        baseSha: snapshot.pullRequest.baseSha,
        headSha: snapshot.pullRequest.headSha
    };
}

function truncateWithEllipsis(content: string, maxChars: number): string {
    if (content.length <= maxChars) {
        return content;
    }

    return `${content.slice(0, maxChars)}...`;
}

function buildPrContext(snapshot: VcsPullRequestSnapshot): string {
    const pr = snapshot.pullRequest;
    const body = truncateWithEllipsis(pr.body, MAX_PR_BODY_CHARS);

    return [
        `Pull request #${pr.number}: ${pr.title}`,
        `Author: ${pr.authorLogin}`,
        `Base: ${pr.baseRef} (${pr.baseSha})`,
        `Head: ${pr.headRef} (${pr.headSha})`,
        delimitUntrusted('pr-description', body)
    ].join('\n');
}

export function buildRiskSummary(risk: RiskAssessment, coverage: DiffCoverage): string {
    const reviewable = coverage.files.filter((file) => isReviewableFile(file));
    const covered = reviewable.filter((file) => isCoveredFile(file)).length;
    const { thresholds, weights, ratios, largeChangeLines } = risk.appliedRules;

    const escalationSummary = risk.escalations
        .map((escalation) => `${escalation.id} -> ${escalation.minTier} (${escalation.detail})`)
        .join('; ');

    const lines = [
        `Tier: ${risk.tier} (volume tier ${risk.volumeTier}, score ${risk.volumeScore}).`,
        `Changed files: ${risk.changedFilesCount}, changed lines: ${risk.changedLines}.`
    ];

    if (risk.noiseFilesCount > 0) {
        lines.push(`Noise files excluded from source metrics: ${risk.noiseFilesCount}.`);
    }

    lines.push(
        `File ratio: ${risk.fileRatio}, line ratio: ${risk.lineRatio}.`,
        `Score thresholds: lite <= ${thresholds.liteMaxScore}, standard <= ${thresholds.standardMaxScore}.`,
        `Score weights: files=${weights.changedFiles}, lines=${weights.changedLines}.`,
        `Ratio thresholds: files=${ratios.fileRatio}, lines=${ratios.lineRatio}.`,
        `Performance specialist threshold: ${largeChangeLines} changed lines.`,
        `Escalations: ${escalationSummary || 'none'}.`,
        `Coverage: ${covered}/${reviewable.length} reviewable files fully covered.`
    );

    return lines.join('\n');
}

function buildHistory(comments: VcsReviewComment[]): string {
    if (comments.length === 0) {
        return 'No previous reviews.';
    }

    const entries = comments.slice(0, MAX_HISTORY_ENTRIES).map((comment) => {
        const body = truncateWithEllipsis(comment.body, MAX_HISTORY_CHARS);

        return `Review from ${comment.createdAt}:\n${delimitUntrusted(`comment:${comment.id}`, body)}`;
    });

    return entries.join('\n\n');
}
