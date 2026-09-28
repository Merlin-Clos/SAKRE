import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildFinalComment, type ReviewReportProvenance } from '../../src/action/state';
import { renderReviewResult, stripCommentMarkers, writeOutputFile } from '../../src/cli/output';
import type { ReviewResult } from '../../src/contracts/review';
import { PRODUCT_NAME } from '../../src/identity';
import { sampleMap } from '../helpers/intelligence-map';

const REPORT: ReviewReportProvenance = {
    execution: 'local-cli',
    baseSha: 'c'.repeat(40),
    models: []
};

const LOCAL_MODELS = [
    { agentId: 'correctness', model: 'kimi-k2.6' },
    { agentId: 'coordinator', model: 'glm-5.2' },
    { agentId: 'tests', model: 'kimi-k2.6' }
];

const COMPLETE: ReviewResult = {
    riskSummary: 'Review complete.',
    riskTier: 'lite',
    reviewedHeadSha: 'a'.repeat(40),
    findings: [],
    status: 'complete',
    verdict: 'clean'
};

const INCOMPLETE: ReviewResult = {
    riskSummary: 'Coverage was truncated.',
    riskTier: 'hard',
    reviewedHeadSha: 'b'.repeat(40),
    findings: [],
    status: 'incomplete',
    verdict: null,
    unverifiedFindings: [],
    failures: [{ kind: 'deadline-exceeded', stage: 'coverage', message: 'Diff coverage is incomplete.' }]
};

describe('local review output', () => {
    test('renders the published Markdown without HTML state markers', () => {
        const rendered = renderReviewResult(COMPLETE, REPORT);
        expect(rendered).toBe(stripCommentMarkers(buildFinalComment(COMPLETE, REPORT)));
        expect(rendered).not.toContain('<!--');
        expect(rendered.startsWith(`## ✅ ${PRODUCT_NAME}: Clean (risk lite)`)).toBe(true);
        expect(rendered).toContain('Reviewed commit:');
        expect(rendered).toContain('Execution: Local CLI');
    });

    test('keeps incomplete diagnostics readable', () => {
        const rendered = renderReviewResult(INCOMPLETE, REPORT);
        expect(rendered).not.toContain('<!--');
        expect(rendered).toContain('review incomplete');
        expect(rendered).toContain('Diff coverage is incomplete.');
    });

    test('renders the models used in a local clean review before No findings', () => {
        const rendered = renderReviewResult(COMPLETE, { ...REPORT, models: LOCAL_MODELS });

        expect(rendered).toContain('<summary>Models used');
        expect(rendered).toContain('| correctness | kimi-k2.6 |');
        expect(rendered).toContain('| coordinator | glm-5.2 |');
        expect(rendered).toContain('| tests | kimi-k2.6 |');
        expect(rendered.indexOf('<summary>Models used')).toBeLessThan(rendered.indexOf('No findings.'));
        expect(rendered).not.toContain('<!--');
    });

    test('keeps the Local CLI body and its model table when publishing to a GitHub PR', () => {
        const result: ReviewResult = {
            ...COMPLETE,
            verdict: 'comments',
            findings: [
                {
                    id: 'correctness:src/a.ts:1:abc',
                    fingerprint: 'abc',
                    sourceAgents: ['correctness'],
                    severity: 'Important',
                    category: 'correctness',
                    title: 'Retry loop drops the last attempt',
                    impact: 'The last attempt can be lost.',
                    evidence: 'The final attempt is skipped when the deadline expires.',
                    location: { file: 'src/a.ts', line: 1 },
                    verification: { state: 'confirmed', reason: 'Reproduced.', verifiedBy: 'verifier' }
                }
            ]
        };

        const rendered = renderReviewResult(result, { ...REPORT, models: LOCAL_MODELS });

        expect(rendered).toContain('Execution: Local CLI');
        expect(rendered).not.toContain('Execution: GitHub Action');
        expect(rendered).toContain('<summary>Models used');
        expect(rendered).toContain('| tests | kimi-k2.6 |');
        expect(rendered.indexOf('<summary>Models used')).toBeLessThan(rendered.indexOf('##### F-001'));
    });

    test('renders the identical intelligence Markdown for the CLI', () => {
        const result: ReviewResult = { ...COMPLETE, intelligence: sampleMap() };
        const rendered = renderReviewResult(result, REPORT);
        expect(rendered).toBe(stripCommentMarkers(buildFinalComment(result, REPORT)));
        expect(rendered).toContain('<summary>Review intelligence · deterministic SCC + CCCC</summary>');
        expect(rendered).toContain('do not decide findings or review scope');
        expect(rendered).not.toContain('Top functions');
    });

    test('writes the same content to a file with one trailing newline', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'sakre-output-'));

        try {
            const target = path.join(root, 'review.md');
            await writeOutputFile(target, renderReviewResult(COMPLETE, REPORT));
            const content = await readFile(target, 'utf8');
            expect(content).toBe(`${stripCommentMarkers(buildFinalComment(COMPLETE, REPORT))}\n`);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
