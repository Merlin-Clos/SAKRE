import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { AiStructuredCall } from '../../src/ai/runtime';
import { embeddedPrompts } from '../../src/review/embedded-prompts';
import {
    buildAgentPrompt,
    buildCoordinatorPrompt,
    buildVerifierPrompt,
    type PromptPayload
} from '../../src/review/prompts';
import { rejectionOf } from '../helpers/rejection';
import { ENGINE_TEST_MODEL, type EngineHarness, startEngineHarness } from '../helpers/engine-harness';
import type { FakeAnthropicProvider } from '../helpers/fake-anthropic';

setDefaultTimeout(120_000);

const FINDINGS = { summary: 'One review summary.', findings: [], usedContext7: false, context7Topics: [] };

const COORDINATION = { summary: 'Coordinated.', findings: [] };

const VERDICT = { findingId: 'correctness:src/generated/file-000.ts:1:abc', state: 'confirmed', reason: 'Proven.' };

/* InstructionEntry.MaxValueBytes in the installed engine. */
const INSTRUCTION_ENTRY_LIMIT_BYTES = 262_144;

const DIFF_TAIL_MARKER = 'CANONICAL-DIFF-TAIL-MARKER';

const AGENT_SPEC = { id: 'correctness', kind: 'builtin' as const, objective: 'Review behavioral correctness.' };

const harnesses: EngineHarness[] = [];

async function startHarness(script: Parameters<typeof startEngineHarness>[0]): Promise<EngineHarness> {
    const harness = await startEngineHarness(script);
    harnesses.push(harness);

    return harness;
}

afterEach(async () => {
    for (const harness of harnesses.splice(0)) {
        await harness.stop();
    }
});

/* Deterministic unified diff of the dogfood size class (KlodWorld PR #232:
   ~344 kB, 97 files). The tail marker proves the end of the diff reached the
   provider. */
function largeDiff(targetBytes: number): string {
    const sections: string[] = [];
    let size = 0;
    let index = 0;

    while (size < targetBytes) {
        const file = `src/generated/file-${String(index).padStart(3, '0')}.ts`;

        const lines = [
            `diff --git a/${file} b/${file}`,
            'new file mode 100644',
            '--- /dev/null',
            `+++ b/${file}`,
            '@@ -0,0 +1,120 @@'
        ];

        for (let line = 0; line < 120; line += 1) {
            lines.push(`+export const value${line} = compute(${index}, ${line}); // deterministic fixture line`);
        }

        if (size + lines.join('\n').length >= targetBytes) {
            lines.push(`+// ${DIFF_TAIL_MARKER}`);
        }

        const section = `${lines.join('\n')}\n`;
        sections.push(section);
        size += section.length;
        index += 1;
    }

    return sections.join('\n');
}

function agentPayload(diff: string): PromptPayload {
    return buildAgentPrompt({
        spec: AGENT_SPEC,
        templates: embeddedPrompts,
        prContext: 'PR #232 fixture: 97 files, 3813 changed lines.',
        diff,
        history: 'No previous review.',
        riskSummary: 'Tier: hard.',
        reviewMap: '## Deterministic review intelligence\n- changed files=40'
    });
}

function agentCall(payload: PromptPayload, onProviderDispatch?: () => void): AiStructuredCall {
    return {
        agentId: 'correctness',
        model: { providerID: 'anthropic', modelID: ENGINE_TEST_MODEL },
        systemPrompt: payload.systemPrompt,
        userPrompt: payload.userPrompt,
        retryPrompt: payload.retryPrompt,
        onProviderDispatch
    };
}

function toolRequest(provider: FakeAnthropicProvider): { system: string; userText: string; bodyBytes: number } {
    const request = provider.requests.find((entry) => entry.tools.length > 0);

    if (request === undefined) {
        throw new Error('The provider boundary was never reached.');
    }

    return request;
}

function expectOrder(text: string, markers: string[]): void {
    let previous = -1;

    for (const marker of markers) {
        const index = text.indexOf(marker);
        expect(index, `missing marker: ${marker}`).toBeGreaterThanOrEqual(0);
        expect(index, `out of order: ${marker}`).toBeGreaterThan(previous);
        previous = index;
    }
}

describe('large review reaches the provider through the split engine surfaces', () => {
    test('a ~344 kB review keeps the instruction entry small and carries the full diff exactly once', async () => {
        const harness = await startHarness([{ type: 'tool', name: 'submit_findings', input: FINDINGS }]);
        const diff = largeDiff(344_000);
        const payload = agentPayload(diff);

        /* The old single-entry assembly exceeded the engine cap; the split keeps
           the instruction entry bounded while the message surface carries it. */
        expect(Buffer.byteLength(payload.systemPrompt, 'utf8')).toBeLessThan(INSTRUCTION_ENTRY_LIMIT_BYTES);
        expect(Buffer.byteLength(`${payload.systemPrompt}\n${payload.userPrompt}`, 'utf8')).toBeGreaterThan(
            INSTRUCTION_ENTRY_LIMIT_BYTES
        );

        const result = await harness.runtime.runStructured(agentCall(payload));

        expect(result.structured).toEqual(FINDINGS);
        const request = toolRequest(harness.provider);
        expect(request.bodyBytes).toBeGreaterThan(INSTRUCTION_ENTRY_LIMIT_BYTES);
        /* Full coverage: the canonical diff and its tail are present exactly
           once on the message surface, never silently truncated. */
        expect(request.userText.split(diff)).toHaveLength(2);
        expect(request.userText).toContain(DIFF_TAIL_MARKER);
        /* Policy stays on the instruction surface; the evidence never leaks into
           it. */
        expect(request.system).toContain('Non-negotiable rules:');
        expect(request.system).toContain('behavioral correctness');
        expect(request.system).not.toContain(DIFF_TAIL_MARKER);
        expect(request.system).not.toContain('name="unified-diff"');
        /* Ordering and untrusted framing survive the surface split. */
        expectOrder(request.userText, [
            'name="review-map"',
            'name="risk-assessment"',
            'name="pull-request"',
            'name="previous-reviews"',
            'name="unified-diff"',
            'Produce your review as specified.'
        ]);
        expect(request.userText).toContain('</untrusted-data>');
    });

    test('the pre-split assembly of the same fixture is rejected by the engine', async () => {
        const harness = await startHarness([{ type: 'tool', name: 'submit_findings', input: FINDINGS }]);
        const diff = largeDiff(344_000);
        const payload = agentPayload(diff);

        /* The regression proof: assembling the same fixture the old way (one
           instruction entry) hits the exact engine limit, while the split
           assembly above reaches the provider. */
        const error = await rejectionOf(
            harness.runtime.runStructured({
                agentId: 'correctness',
                model: { providerID: 'anthropic', modelID: ENGINE_TEST_MODEL },
                systemPrompt: `${payload.systemPrompt}\n${payload.userPrompt}`,
                userPrompt: payload.retryPrompt,
                retryPrompt: payload.retryPrompt
            })
        );

        expect(error.message).toContain(`the limit is ${INSTRUCTION_ENTRY_LIMIT_BYTES} bytes`);
        expect(harness.provider.requests).toHaveLength(0);
    });

    test('diffs just under and just over the entry cap both reach the provider intact', async () => {
        for (const size of [250_000, 300_000]) {
            const harness = await startHarness([{ type: 'tool', name: 'submit_findings', input: FINDINGS }]);
            const diff = largeDiff(size);
            const payload = agentPayload(diff);
            expect(Buffer.byteLength(payload.systemPrompt, 'utf8')).toBeLessThan(INSTRUCTION_ENTRY_LIMIT_BYTES);

            const result = await harness.runtime.runStructured(agentCall(payload));

            expect(result.structured).toEqual(FINDINGS);
            const request = toolRequest(harness.provider);
            expect(request.userText.split(diff)).toHaveLength(2);
            expect(request.userText).toContain(DIFF_TAIL_MARKER);
        }
    });

    test('a maximum-budget diff (~1 MB) still reaches the provider intact', async () => {
        const harness = await startHarness([{ type: 'tool', name: 'submit_findings', input: FINDINGS }]);
        const diff = largeDiff(1_000_000);
        const payload = agentPayload(diff);

        const result = await harness.runtime.runStructured(agentCall(payload));

        expect(result.structured).toEqual(FINDINGS);
        const request = toolRequest(harness.provider);
        expect(request.userText.split(diff)).toHaveLength(2);
        expect(request.userText).toContain(DIFF_TAIL_MARKER);
        expect(Buffer.byteLength(payload.systemPrompt, 'utf8')).toBeLessThan(INSTRUCTION_ENTRY_LIMIT_BYTES);
    });

    test('the coordinator path carries candidate evidence and the full diff on the message surface', async () => {
        const harness = await startHarness([{ type: 'tool', name: 'submit_coordination', input: COORDINATION }]);
        const diff = largeDiff(344_000);

        const payload = buildCoordinatorPrompt({
            spec: { id: 'coordinator', kind: 'builtin', objective: 'Adjudicate specialist findings.' },
            templates: embeddedPrompts,
            evidence: {
                baseSha: 'b'.repeat(40),
                headSha: 'f'.repeat(40),
                findings: [
                    {
                        id: 'correctness:src/generated/file-000.ts:1:abc',
                        sourceAgent: 'correctness',
                        path: 'src/generated/file-000.ts',
                        title: 'Fixture finding',
                        severity: 'Important',
                        category: 'correctness',
                        impact: 'Impact.',
                        evidence: 'Evidence.'
                    }
                ],
                diff
            },
            riskSummary: 'Tier: hard.',
            history: 'none',
            reviewMap: 'review-map-body'
        });

        expect(Buffer.byteLength(payload.systemPrompt, 'utf8')).toBeLessThan(INSTRUCTION_ENTRY_LIMIT_BYTES);

        const result = await harness.runtime.runStructured({
            agentId: 'coordinator',
            model: { providerID: 'anthropic', modelID: ENGINE_TEST_MODEL },
            systemPrompt: payload.systemPrompt,
            userPrompt: payload.userPrompt,
            retryPrompt: payload.retryPrompt
        });

        expect(result.structured).toEqual(COORDINATION);
        const request = toolRequest(harness.provider);
        expect(request.userText).toContain('"id":"correctness:src/generated/file-000.ts:1:abc"');
        expect(request.userText.split(diff)).toHaveLength(2);
        expect(request.system).toContain('You are the review coordinator');
        expect(request.system).not.toContain(DIFF_TAIL_MARKER);
    });

    test('the verifier path keeps only the cited hunk and still reaches the provider', async () => {
        const harness = await startHarness([{ type: 'tool', name: 'submit_verdict', input: VERDICT }]);
        const diff = largeDiff(344_000);

        const payload = buildVerifierPrompt({
            templates: embeddedPrompts,
            finding: {
                id: VERDICT.findingId,
                title: 'Fixture finding',
                impact: 'Impact.',
                evidence: 'The diff proves it.',
                location: { file: 'src/generated/file-000.ts', line: 1 }
            },
            diff,
            reviewMap: 'review-map-body'
        });

        const result = await harness.runtime.runStructured({
            agentId: 'verifier',
            model: { providerID: 'anthropic', modelID: ENGINE_TEST_MODEL },
            systemPrompt: payload.systemPrompt,
            userPrompt: payload.userPrompt,
            retryPrompt: payload.retryPrompt
        });

        expect(result.structured).toEqual(VERDICT);
        const request = toolRequest(harness.provider);
        expect(request.userText).toContain('<untrusted-data name="hunk">');
        expect(request.userText).toContain('src/generated/file-000.ts');
        /* Only the cited file section travels; the whole diff is not duplicated. */
        expect(request.userText).not.toContain(DIFF_TAIL_MARKER);
    });

    test('a retry sends the short continuation and never duplicates the evidence', async () => {
        const harness = await startHarness([
            { type: 'text', text: 'No submission yet.' },
            { type: 'tool', name: 'submit_findings', input: FINDINGS }
        ]);

        const diff = largeDiff(344_000);
        const payload = agentPayload(diff);

        const result = await harness.runtime.runStructured(agentCall(payload));

        expect(result.structured).toEqual(FINDINGS);
        /* Turn one (no submission), the retry turn, then the tool-result turn. */
        const requests = harness.provider.requests.filter((entry) => entry.tools.length > 0);
        expect(requests).toHaveLength(3);

        for (const request of requests) {
            /* The evidence appears once in the session history: the retry
               message is the short continuation only. */
            expect(request.userText.split(diff)).toHaveLength(2);
            expect(request.userText.endsWith(payload.retryPrompt)).toBe(true);
        }
    });
});
