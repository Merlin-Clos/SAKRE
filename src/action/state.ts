import {
    reviewSeverities,
    type ReviewFailure,
    type ReviewResult,
    type ReviewVerdict,
    type VerifiedFinding
} from '../contracts/review';
import type { ModelInvocationProvenance } from '../ai/provenance';
import { type CoverageBudgetSummary, formatBudgetReport } from '../analysis/budget';
import { escapeHtmlText, escapeTableCell, inlineCode, neutralizeLineBreaks } from '../intelligence/format';
import { renderIntelligenceComment, renderPrSignalsTable } from '../intelligence/render';
import { type ReviewGuidanceSource, guidanceSourceLabel } from '../review/guidance';
import { METADATA_COMMENT_MARKER, PRODUCT_NAME, PRODUCT_VERSION, REVIEW_COMMENT_MARKER } from '../identity';

export interface PublishedResult {
    result: ReviewResult;
    stale: boolean;
    /* Actual invocations; empty when no call started. Feeds the comment and the
       caller provenance. */
    models: ModelInvocationProvenance[];
}

/* Where the review ran. Set at the entrypoint, never derived from the channel:
   a local run publishing to a PR stays `Local CLI`. */
export type ReviewExecution = 'github-action' | 'local-cli';

/* Provenance and exact normalized guidance used by this run. */
export interface ReviewReportProvenance {
    execution: ReviewExecution;
    baseSha: string;
    guidance?: ReviewGuidanceSource;
    guidanceText?: string;
    runId?: string;
    /* Actual invocations; renderer and metadata share one canonical list. */
    models: ModelInvocationProvenance[];
}

const EXECUTION_LABELS: Record<ReviewExecution, string> = {
    'github-action': 'GitHub Action',
    'local-cli': 'Local CLI'
};

const METADATA_MARKER = METADATA_COMMENT_MARKER;

const REVIEW_MARKER = REVIEW_COMMENT_MARKER;

const SHORT_SHA_LENGTH = 7;

const MAX_COMMENT_LENGTH = 60_000;

const PERCENT_FACTOR = 100;

const FINDING_NUMBER_WIDTH = 3;

const MAX_FAILURE_REASON_LENGTH = 240;

const COMMENT_TRUNCATION_NOTICE = '\n\n_Additional review output was omitted to fit the GitHub comment limit._';

/* Idempotence reads only status and head. Unknown keys are ignored, so old
   metadata and malformed `agents` values stay parseable. */
interface ReviewMetadata {
    headSha: string;
    status: string;
}

const METADATA_PATTERN = new RegExp(`<!-- ${METADATA_MARKER} (?<metadata>\\{[\\s\\S]*?\\}) -->`, 'u');

export function parseReviewMetadata(commentBody: string): ReviewMetadata | undefined {
    const match = METADATA_PATTERN.exec(commentBody);
    const metadataRaw = match?.groups?.metadata;

    if (metadataRaw === undefined) {
        return undefined;
    }

    try {
        // SAFETY: JSON.parse returns any; only headSha/status are consumed, each validated as string below.
        // eslint-disable-next-line anti-slop/no-unsafe-dictionary-type -- untrusted comment JSON narrowed field-by-field below
        const parsed = JSON.parse(metadataRaw) as Record<string, unknown>;
        const headSha = parsed.headSha;
        const status = parsed.status;

        // eslint-disable-next-line anti-slop/no-runtime-typeof -- boundary parse of untrusted comment metadata
        if (typeof headSha === 'string' && typeof status === 'string') {
            return { headSha, status };
        }

        return undefined;
    } catch {
        return undefined;
    }
}

export function isAlreadyReviewed(comments: { body: string }[], headSha: string): boolean {
    return comments.some((comment) => {
        const metadata = parseReviewMetadata(comment.body);

        return metadata?.status === 'complete' && metadata.headSha === headSha;
    });
}

export function buildInProgressComment(input: {
    headSha: string;
    baseSha: string;
    triggerCommentId?: number;
    runId?: string;
}): string {
    const metadata = JSON.stringify({
        headSha: input.headSha,
        baseSha: input.baseSha,
        triggerCommentId: input.triggerCommentId,
        runId: input.runId,
        status: 'in-progress'
    });

    return [
        `<!-- ${REVIEW_MARKER} -->`,
        `<!-- ${METADATA_MARKER} ${metadata} -->`,
        `## 🔄 ${PRODUCT_NAME}: review in progress`,
        '',
        `Reviewing commit \`${input.headSha.slice(0, SHORT_SHA_LENGTH)}\`...`
    ].join('\n');
}

export function buildFinalComment(result: ReviewResult, report: ReviewReportProvenance): string {
    const intelligence = result.intelligence;

    const metadata = JSON.stringify({
        headSha: result.reviewedHeadSha,
        baseSha: report.baseSha,
        riskTier: result.riskTier,
        status: result.status,
        verdict: result.verdict,
        execution: report.execution,
        engineVersion: PRODUCT_VERSION,
        guidance: report.guidance ?? 'none',
        runId: report.runId,
        agents: report.models.length === 0 ? undefined : report.models,
        toolVersions: intelligence === undefined ? undefined : intelligenceMetadata(intelligence)
    });

    const verdictEmoji: Record<ReviewVerdict, string> = {
        clean: '✅',
        comments: '💬',
        changes_required: '🛑'
    };

    const verdictLabel: Record<ReviewVerdict, string> = {
        clean: 'Clean',
        comments: 'Comments',
        changes_required: 'Changes requested'
    };

    const lines = [`<!-- ${REVIEW_MARKER} -->`, `<!-- ${METADATA_MARKER} ${metadata} -->`];

    if (result.status === 'complete') {
        const emoji = verdictEmoji[result.verdict] ?? '❓';
        const label = verdictLabel[result.verdict] ?? 'Unknown';
        lines.push(`## ${emoji} ${PRODUCT_NAME}: ${label} (risk ${result.riskTier})`);
    } else if (result.status === 'incomplete') {
        lines.push(`## ⚠️ ${PRODUCT_NAME}: review incomplete (risk ${result.riskTier})`);
    } else {
        lines.push(`## ⚠️ ${PRODUCT_NAME}: findings from a previous commit (risk ${result.riskTier})`);
    }

    lines.push('', `Reviewed commit: \`${result.reviewedHeadSha}\``);

    if (result.status === 'stale') {
        lines.push(`Current commit: \`${result.currentHeadSha}\``);
    }

    lines.push(
        `Risk tier: \`${result.riskTier}\``,
        /* Run provenance without guidance text: execution, engine, revisions, and
           whether guidance was used. */
        `Execution: ${EXECUTION_LABELS[report.execution]}`,
        `Engine: ${PRODUCT_NAME} ${PRODUCT_VERSION}`,
        `Base: \`${shortSha(report.baseSha)}\``,
        `Head: \`${shortSha(result.reviewedHeadSha)}\``,
        guidanceLine(report),
        '',
        compactSummary(result),
        ...severitySummary(result),
        ...incompleteNotice(result),
        ...aboutStatesBlock(result)
    );
    appendGuidance(lines, report);

    if (intelligence !== undefined) {
        lines.push('', ...renderPrSignalsTable(intelligence));
    }

    appendModelsUsed(lines, report.models);
    /* Findings first: the actionable result precedes every diagnostic block. */
    appendActionableFindings(lines, result);
    appendRejectedFindings(
        lines,
        result.findings.filter((finding) => finding.verification.state === 'rejected')
    );

    if (intelligence !== undefined) {
        lines.push(...renderIntelligenceComment(intelligence));
    }

    appendEscalationReasons(lines, result.riskSummary);
    appendDiagnostics(lines, result.riskSummary);
    appendCoverage(
        lines,
        // SAFETY: status-gated: complete passes [] without touching failures; incomplete/stale carry failures per contract.
        result.status === 'complete' ? [] : ((result as { failures?: ReviewFailure[] }).failures ?? [])
    );

    return limitComment(lines.join('\n'));
}

// eslint-disable-next-line anti-slop/no-unsafe-dictionary-type -- metadata bag serialized verbatim into the comment
function intelligenceMetadata(map: NonNullable<ReviewResult['intelligence']>): Record<string, unknown> {
    const changed = map.repository.changed;

    // eslint-disable-next-line anti-slop/no-known-value-widening -- fixed metadata fields collected into the comment bag
    return {
        sccVersion: map.tools.scc.version,
        ccccVersion: map.tools.cccc.version,
        changed: `+${String(changed.added)} ~${String(changed.modified)} -${String(changed.removed)} r${String(changed.renamed)}`,
        baseSha: map.revisions.baseSha.slice(0, SHORT_SHA_LENGTH),
        headSha: map.revisions.headSha.slice(0, SHORT_SHA_LENGTH)
    };
}

function guidanceLine(report: ReviewReportProvenance): string {
    if (report.guidance === undefined) {
        return 'User guidance: none';
    }

    return `User guidance: provided (${guidanceSourceLabel(report.guidance)})`;
}

/* Headline: finding states plus files fully covered. Parsed from the risk
   summary; with no coverage counts it states findings only. */
function compactSummary(result: ReviewResult): string {
    const confirmed = result.findings.filter((finding) => finding.verification.state === 'confirmed').length;
    const rejected = result.findings.filter((finding) => finding.verification.state === 'rejected').length;

    const unverified =
        result.findings.filter((finding) => finding.verification.state === 'unverified').length +
        (result.status === 'complete' ? 0 : result.unverifiedFindings.length);

    const coverage = parseCoverage(result.riskSummary);
    const states = `${String(confirmed)} confirmed · ${String(unverified)} unverified · ${String(rejected)} rejected`;

    if (coverage === undefined) {
        return `**${states}**`;
    }

    return `**${states} · ${String(coverage.covered)}/${String(coverage.reviewable)} files fully covered (${coverage.percent})**`;
}

function parseCoverage(riskSummary: string): { covered: number; reviewable: number; percent: string } | undefined {
    const match = /Coverage:\s*(?<covered>\d+)\/(?<reviewable>\d+)\s*reviewable files fully covered/u.exec(riskSummary);
    const covered = match?.groups?.covered;
    const reviewable = match?.groups?.reviewable;

    if (covered === undefined || reviewable === undefined) {
        return undefined;
    }

    const coveredCount = Number(covered);
    const reviewableCount = Number(reviewable);

    if (reviewableCount === 0) {
        return { covered: coveredCount, reviewable: reviewableCount, percent: 'n/a' };
    }

    const percent = `${((coveredCount / reviewableCount) * PERCENT_FACTOR).toFixed(1)}%`;

    return { covered: coveredCount, reviewable: reviewableCount, percent };
}

function severitySummary(result: ReviewResult): string[] {
    const findings = activeFindings(result);

    if (findings.length === 0) {
        return [];
    }

    const counts = severityCounts(findings);

    return [
        '',
        `**🔴 ${String(counts.Blocker)} Blocker · 🟠 ${String(counts.Important)} Important · 🟡 ${String(counts.Minor)} Minor**`
    ];
}

function activeFindings(result: ReviewResult): VerifiedFinding[] {
    return [
        ...result.findings.filter((finding) => finding.verification.state !== 'rejected'),
        ...(result.status === 'complete' ? [] : result.unverifiedFindings)
    ];
}

function severityCounts(findings: VerifiedFinding[]): Record<'Blocker' | 'Important' | 'Minor', number> {
    const counts = { Blocker: 0, Important: 0, Minor: 0 };

    for (const finding of findings) {
        counts[finding.severity] += 1;
    }

    return counts;
}

function incompleteNotice(result: ReviewResult): string[] {
    if (result.status === 'complete' || result.failures.length === 0) {
        return [];
    }

    const failures = result.failures.filter((failure) => failure.stage !== 'coverage');

    if (failures.length === 0) {
        return [];
    }

    return ['', `**⚠️ ${String(failures.length)} agent failures made this review incomplete.**`];
}

/* Coverage note covers budgeted diff inclusion only, not other file reads. */
function aboutStatesBlock(result: ReviewResult): string[] {
    const failures =
        result.status === 'complete' ? [] : result.failures.filter((failure) => failure.stage !== 'coverage');

    const lines = [
        '',
        '<details>',
        '<summary>Review completeness, coverage, and agent failures</summary>',
        '',
        '### Review states',
        '',
        '- **Confirmed**: independently checked by the verifier against the reviewed diff.',
        '- **Unverified**: reported by a specialist but not independently confirmed. Minor findings are never sent to verification, and verifier failures leave findings visible as unverified.',
        '- **Rejected**: independently checked and refuted. Rejected findings stay available as adjudication evidence but are excluded from active severity counts.',
        '- **Files fully covered**: the complete canonical Git diff for those files fit inside the configured review budget. Agents may inspect repository files directly when needed, but full diff coverage is only guaranteed for files counted here.',
        ''
    ];

    if (failures.length > 0) {
        lines.push('### Agent failures', '', ...failureLines(failures), '');
    }

    lines.push('</details>');

    return lines;
}

/* Clean reviews stay one line. Unverified findings stay visible; incomplete or
   stale reviews never hide one. Numbers run F-001 up, R-001 up for rejected. */
function appendActionableFindings(lines: string[], result: ReviewResult): void {
    const confirmed = result.findings.filter((finding) => finding.verification.state === 'confirmed');

    /* Unverified findings come in two shapes: inside `findings` when complete,
       plus the dedicated list otherwise. Render both so none drop silently. */
    const unverified = [
        ...result.findings.filter((finding) => finding.verification.state === 'unverified'),
        ...(result.status === 'complete' ? [] : result.unverifiedFindings)
    ];

    const known = result.findings.length + (result.status === 'complete' ? 0 : result.unverifiedFindings.length);

    if (known === 0) {
        lines.push('', 'No findings.');

        return;
    }

    lines.push('', `## Findings: ${String(known)}`);
    let counter = 0;

    for (const [label, group] of [
        ['Confirmed', confirmed],
        ['Unverified', unverified]
    ] as const) {
        if (group.length > 0) {
            lines.push('', `## ${label}: ${String(group.length)}`);
            const counts = severityCounts(group);

            for (const severity of ['Blocker', 'Important', 'Minor'] as const) {
                counter += appendSeverityFindings(lines, {
                    group,
                    severity,
                    count: counts[severity],
                    firstNumber: counter + 1
                });
            }
        }
    }
}

function appendSeverityFindings(
    lines: string[],
    input: { group: VerifiedFinding[]; severity: VerifiedFinding['severity']; count: number; firstNumber: number }
): number {
    const matches = input.group.filter((finding) => finding.severity === input.severity);

    if (matches.length === 0) {
        return 0;
    }

    lines.push(
        '',
        '<details open>',
        `<summary>${severityEmoji(input.severity)} ${input.severity} (${String(input.count)})</summary>`,
        ''
    );

    for (const [index, finding] of matches.entries()) {
        const number = input.firstNumber + index;
        lines.push(...findingLines(finding, formatFindingNumber('F', number)));
    }

    lines.push('', '</details>');

    return matches.length;
}

function severityEmoji(severity: VerifiedFinding['severity']): string {
    if (severity === 'Blocker') {
        return '🔴';
    }

    if (severity === 'Important') {
        return '🟠';
    }

    return '🟡';
}

function formatFindingNumber(prefix: string, counter: number): string {
    return `${prefix}-${String(counter).padStart(FINDING_NUMBER_WIDTH, '0')}`;
}

/* Provenance: only agents whose call reached the provider, in order. A catalog
   URL links the model name; without one the name stays plain text. */
function appendModelsUsed(lines: string[], models: ModelInvocationProvenance[]): void {
    if (models.length === 0) {
        return;
    }

    lines.push(
        '',
        '<details>',
        `<summary>Models used (${String(models.length)})</summary>`,
        '',
        '| Agent | Model |',
        '| --- | --- |'
    );

    for (const entry of models) {
        lines.push(`| ${escapeTableCell(entry.agentId)} | ${modelCell(entry)} |`);
    }

    lines.push('', '</details>');
}

function modelCell(entry: ModelInvocationProvenance): string {
    const model = escapeTableCell(entry.model);

    if (entry.artificialAnalysisUrl === undefined) {
        return model;
    }

    return `[${model}](${entry.artificialAnalysisUrl})`;
}

/* Rejected findings stay collapsed so confirmed results read first. The true
   verifier reason shows when present; none is fabricated. */
function appendRejectedFindings(lines: string[], rejected: VerifiedFinding[]): void {
    if (rejected.length === 0) {
        return;
    }

    const counts = severityCounts(rejected);

    const summary = reviewSeverities
        .flatMap((severity) => {
            if (counts[severity] === 0) {
                return [];
            }

            return [`${severityEmoji(severity)} ${severity} ${String(counts[severity])}`];
        })
        .join(' · ');

    lines.push('', '<details>', `<summary>Rejected findings: ${String(rejected.length)} · ${summary}</summary>`, '');
    let rejectedCounter = 0;

    for (const severity of ['Blocker', 'Important', 'Minor'] as const) {
        const matches = rejected.filter((finding) => finding.severity === severity);

        if (matches.length > 0) {
            lines.push(
                '<details>',
                `<summary>${severityEmoji(severity)} ${severity} (${String(matches.length)})</summary>`,
                ''
            );

            for (const finding of matches) {
                rejectedCounter += 1;
                lines.push(...findingLines(finding, formatFindingNumber('R', rejectedCounter), true));
            }

            lines.push('', '</details>', '');
        }
    }

    lines.push('', '</details>');
}

/* Routing diagnostics are provenance, never the summary. The Escalations line
   renders in its own block below, never here. */
function appendDiagnostics(lines: string[], diagnostics: string): void {
    const filtered = diagnostics
        .split('\n')
        .filter((line) => !line.startsWith('Escalations:'))
        .join('\n')
        .trim();

    if (filtered === '') {
        return;
    }

    lines.push('', '<details>', '<summary>Review diagnostics</summary>', '', filtered, '', '</details>');
}

/* Escalation reasons show the recorded assessment only: volume to final tier plus
   one bullet per escalation. Absent when no escalation was recorded. */
function appendEscalationReasons(lines: string[], riskSummary: string): void {
    const parsed = parseEscalations(riskSummary);

    if (parsed === undefined) {
        return;
    }

    lines.push(
        '',
        '### Risk escalation reasons',
        '',
        `Volume tier \`${parsed.volumeTier}\` -> final tier \`${parsed.finalTier}\`.`,
        ''
    );

    for (const item of parsed.items) {
        lines.push(`- ${item}`);
    }
}

function parseEscalations(riskSummary: string): { volumeTier: string; finalTier: string; items: string[] } | undefined {
    const tierMatch = /^Tier:\s*(?<finalTier>\w+)\s*\(volume tier\s*(?<volumeTier>\w+),/mu.exec(riskSummary);
    const escalationLine = riskSummary.split('\n').find((line) => line.startsWith('Escalations:'));

    if (escalationLine === undefined) {
        return undefined;
    }

    const raw = escalationLine.slice('Escalations:'.length).trim().replace(/\.$/u, '').trim();

    if (raw === '' || raw === 'none') {
        return undefined;
    }

    const finalTier = tierMatch?.groups?.finalTier ?? 'unknown';
    const volumeTier = tierMatch?.groups?.volumeTier ?? 'unknown';

    const items = raw
        .split('; ')
        .map((item) => item.trim())
        .filter((item) => item !== '')
        .map((item) => inlineEscalation(item));

    if (items.length === 0) {
        return undefined;
    }

    return { volumeTier, finalTier, items };
}

/* Escalation items keep recorded text intact; line breaks are neutralized since
   paths inside details are untrusted. */
function inlineEscalation(item: string): string {
    return neutralizeLineBreaks(item);
}

function shortSha(sha: string): string {
    return sha.slice(0, SHORT_SHA_LENGTH);
}

function limitComment(comment: string): string {
    if (comment.length <= MAX_COMMENT_LENGTH) {
        return comment;
    }

    return `${comment.slice(0, MAX_COMMENT_LENGTH - COMMENT_TRUNCATION_NOTICE.length)}${COMMENT_TRUNCATION_NOTICE}`;
}

function findingLines(finding: VerifiedFinding, number: string, rejected = false): string[] {
    const location = finding.location === undefined ? 'repository' : formatLocation(finding.location);
    const reportedBy = finding.sourceAgents.length === 0 ? 'unknown' : finding.sourceAgents.join(', ');

    const lines = [
        '',
        `##### ${number}: ${neutralizeLineBreaks(finding.title)}`,
        '',
        ...(rejected ? [`Severity: ${finding.severity}`] : []),
        `Location: ${location}`,
        `Reported by: ${reportedBy}`,
        '',
        `${rejected ? 'Claimed impact' : 'Impact'}: ${finding.impact}`,
        '',
        `${rejected ? 'Evidence considered' : 'Evidence'}: ${finding.evidence}`
    ];

    if (finding.suggestedFix !== undefined) {
        lines.push('', `${rejected ? 'Suggested fix if re-opened' : 'Suggested fix'}: ${finding.suggestedFix}`);
    }

    if (rejected && finding.verification.state === 'rejected' && finding.verification.reason !== undefined) {
        lines.push('', `Why it was rejected: ${finding.verification.reason}`);
    }

    return lines;
}

function formatLocation(location: NonNullable<VerifiedFinding['location']>): string {
    if (location.line === undefined) {
        return inlineCode(location.file);
    }

    return inlineCode(
        `${location.file}:${String(location.line)}${location.lineEnd === undefined ? '' : `-${String(location.lineEnd)}`}`
    );
}

function failureLines(failures: ReviewFailure[]): string[] {
    return failures.map((failure) => {
        const reason = escapeHtmlText(neutralizeLineBreaks(failure.message));
        const ellipsis = reason.length > MAX_FAILURE_REASON_LENGTH ? '…' : '';

        return `- **\`${failure.stage}\`**: ${failureKindLabel(failure.kind)}. ${reason.slice(0, MAX_FAILURE_REASON_LENGTH)}${ellipsis}`;
    });
}

function failureKindLabel(kind: ReviewFailure['kind']): string {
    return kind === 'invalid-output' ? 'invalid output' : kind.replaceAll('-', ' ');
}

function appendGuidance(lines: string[], report: ReviewReportProvenance): void {
    if (report.guidanceText === undefined || report.guidanceText === '') {
        return;
    }

    lines.push(
        '',
        '<details>',
        '<summary>User guidance used</summary>',
        '',
        '<pre>',
        escapeHtmlText(report.guidanceText),
        '</pre>',
        '',
        '</details>'
    );
}

/* Coverage lists live here, never in Failures. Full messages show verbatim in
   this collapsed block. */
function appendCoverage(lines: string[], failures: ReviewFailure[]): void {
    const coverage = failures.filter((failure) => failure.stage === 'coverage');

    if (coverage.length === 0) {
        return;
    }

    lines.push('', '<details>', '<summary>Coverage</summary>', '');

    for (const failure of coverage) {
        lines.push(`- \`${failure.stage}\` (${failure.kind}): ${failure.message}`);
    }

    lines.push('', '</details>');
}

/* Aborts before any provider call on over-budget diffs: exact numbers plus the
   per-run options that force a partial review. */
export function buildBudgetAbortComment(report: CoverageBudgetSummary, triggerCommand: string): string {
    return [
        `## ⚠️ ${PRODUCT_NAME}: review aborted, diff over budget`,
        '',
        `${formatBudgetReport(report)}.`,
        '',
        `Set the \`force_over_budget\` input to \`true\` or comment \`${triggerCommand} --force-over-budget\` to review only the portion that fits the budget. Coverage will be partial.`
    ].join('\n');
}

export function buildFailureComment(headSha: string, runId?: string): string {
    const metadata = JSON.stringify({ headSha, status: 'incomplete', verdict: null, runId });

    return [
        `<!-- ${REVIEW_MARKER} -->`,
        `<!-- ${METADATA_MARKER} ${metadata} -->`,
        `## ⚠️ ${PRODUCT_NAME}: review incomplete`,
        '',
        'The review failed before completion. Inspect the Action logs for the redacted diagnostic.'
    ].join('\n');
}

/* Log summary of a result: counts for comparing runs without parsing comments. */
// eslint-disable-next-line anti-slop/no-unsafe-dictionary-type -- log bag serialized verbatim by the logger
export function summarizeResultForLog(result: ReviewResult): Record<string, unknown> {
    // eslint-disable-next-line anti-slop/no-known-value-widening -- fixed count fields collected into the log bag
    return {
        status: result.status,
        verdict: result.verdict,
        findings: result.findings.length,
        unverifiedFindings:
            result.status === 'complete'
                ? result.findings.filter((finding) => finding.verification.state === 'unverified').length
                : result.unverifiedFindings.length,
        failures: result.status === 'incomplete' ? result.failures.length : 0
    };
}
