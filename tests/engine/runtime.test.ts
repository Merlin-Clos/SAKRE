import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AiError, type AiStructuredCall } from '../../src/ai/runtime';
import { materializeEnginePlugin } from '../../src/engine/plugin-source';
import { createEmbeddedEngineRuntime, type EmbeddedEngineRuntime } from '../../src/engine/runtime';
import { rejectionOf } from '../helpers/rejection';
import {
    type FakeAnthropicProvider,
    type FakeAnthropicReply,
    type FakeAnthropicRequestRecord,
    startFakeAnthropic
} from '../helpers/fake-anthropic';

setDefaultTimeout(60_000);

const MODEL = 'claude-opus-5';

const FINDINGS = { summary: 'One review summary.', findings: [], usedContext7: false, context7Topics: [] };

const COORDINATION = { summary: 'Coordinated.', findings: [] };

const VERDICT = { findingId: 'correctness:a.ts:1:abc', state: 'confirmed', reason: 'The diff proves it.' };

interface Harness {
    runtime: EmbeddedEngineRuntime;
    provider: FakeAnthropicProvider;
    root: string;
}

const harnesses: Harness[] = [];

async function startHarness(script: FakeAnthropicReply[]): Promise<Harness> {
    const root = await mkdtemp(path.join(tmpdir(), 'sakre-engine-'));
    const workspace = path.join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const provider = startFakeAnthropic(script);

    const runtime = await createEmbeddedEngineRuntime({
        providerID: 'anthropic',
        providerFamily: 'anthropic',
        modelIds: [MODEL],
        apiKey: 'sk-ant-fake',
        baseURL: provider.baseURL,
        checkoutDir: workspace,
        pluginDir: await materializeEnginePlugin(path.join(root, 'plugin-cache')),
        databasePath: path.join(root, 'engine.db')
    });

    const harness: Harness = { runtime, provider, root };
    harnesses.push(harness);

    return harness;
}

afterEach(async () => {
    for (const harness of harnesses.splice(0)) {
        await harness.provider.stop();
        await harness.runtime.close();
        await rm(harness.root, { recursive: true, force: true });
    }
});

function agentCall(agentId = 'correctness'): AiStructuredCall {
    return {
        agentId,
        model: { providerID: 'anthropic', modelID: MODEL },
        systemPrompt: 'SYSTEM MARKER: review as the requested role.',
        userPrompt: 'Produce your review as specified.',
        retryPrompt: 'Produce your review as specified.'
    };
}

function toolRequests(provider: FakeAnthropicProvider): FakeAnthropicRequestRecord[] {
    return provider.requests.filter((request) => request.tools.length > 0);
}

async function expectAiError(promise: Promise<unknown>): Promise<AiError> {
    const error = await rejectionOf(promise);

    if (!(error instanceof AiError)) {
        throw new Error(`Expected AiError, received ${error.name}: ${error.message}`);
    }

    return error;
}

describe('embedded engine runtime', () => {
    test('returns the structured output submitted through the embedded tool', async () => {
        const harness = await startHarness([{ type: 'tool', name: 'submit_findings', input: FINDINGS }]);

        const result = await harness.runtime.runStructured(agentCall());

        expect(result.structured).toEqual(FINDINGS);
        const requests = toolRequests(harness.provider);
        expect(requests).toHaveLength(2);
        expect(requests[0]?.tools).toContain('submit_findings');
        expect(requests[0]?.system).toContain('SYSTEM MARKER');
        expect(requests[1]?.hasToolResult).toBe(true);
        expect(result.text).toBe('DONE');
    });

    test('routes coordinator and verifier calls to their own submit tools', async () => {
        const harness = await startHarness([
            { type: 'tool', name: 'submit_coordination', input: COORDINATION },
            { type: 'text', text: 'Coordinator done.' },
            { type: 'tool', name: 'submit_verdict', input: VERDICT },
            { type: 'text', text: 'Verifier done.' }
        ]);

        const coordinator = await harness.runtime.runStructured(agentCall('coordinator'));
        const verifier = await harness.runtime.runStructured(agentCall('verifier'));

        expect(coordinator.structured).toEqual(COORDINATION);
        expect(coordinator.text).toBe('Coordinator done.');
        expect(verifier.structured).toEqual(VERDICT);
        expect(verifier.text).toBe('Verifier done.');
        const requests = toolRequests(harness.provider);
        expect(requests[0]?.tools).toContain('submit_coordination');
        expect(requests[2]?.tools).toContain('submit_verdict');
    });

    test('rejects a schema-invalid submission and accepts the corrected one in the same turn', async () => {
        const harness = await startHarness([
            { type: 'tool', name: 'submit_findings', input: { ...FINDINGS, summary: 42 } },
            { type: 'tool', name: 'submit_findings', input: FINDINGS }
        ]);

        const result = await harness.runtime.runStructured(agentCall());

        expect(result.structured).toEqual(FINDINGS);
        const requests = toolRequests(harness.provider);
        expect(requests).toHaveLength(3);
        expect(requests[1]?.hasToolResult).toBe(true);
    });

    test('retries once when a completed turn has no submission, then fails invalid-output', async () => {
        const harness = await startHarness([]);

        const error = await expectAiError(harness.runtime.runStructured(agentCall()));

        expect(error.kind).toBe('invalid-output');
        expect(toolRequests(harness.provider)).toHaveLength(2);
    });

    test('keeps the first valid submission when the model submits twice', async () => {
        const second = { ...FINDINGS, summary: 'Second submission.' };

        const harness = await startHarness([
            { type: 'tool', name: 'submit_findings', input: FINDINGS },
            { type: 'tool', name: 'submit_findings', input: second }
        ]);

        const result = await harness.runtime.runStructured(agentCall());

        expect(result.structured).toEqual(FINDINGS);
        const requests = toolRequests(harness.provider);
        expect(requests).toHaveLength(3);
        expect(requests[2]?.hasToolResult).toBe(true);
        /* The refusal must reach the model, not just be dropped locally. */
        const refusal = requests[2]?.toolResults.find((toolResult) => toolResult.isError);
        expect(refusal?.text).toContain('already recorded');
    });

    test('maps a provider authentication failure to provider-auth', async () => {
        const harness = await startHarness([
            {
                type: 'error',
                status: 401,
                body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }
            }
        ]);

        const error = await expectAiError(harness.runtime.runStructured(agentCall()));

        expect(error.kind).toBe('provider-auth');
        expect(error.message).toBe('invalid x-api-key');
    });

    test('cancels an in-flight turn and stops retrying', async () => {
        const harness = await startHarness([{ type: 'hang' }]);
        const controller = new AbortController();
        const call = { ...agentCall(), signal: controller.signal };

        const pending = harness.runtime.runStructured(call);
        await harness.provider.waitForRequest(1);
        controller.abort();

        const error = await expectAiError(pending);
        expect(error.kind).toBe('cancelled');
        expect(toolRequests(harness.provider)).toHaveLength(1);
    });

    test('refuses to start a turn when the signal is already aborted', async () => {
        const harness = await startHarness([]);
        const controller = new AbortController();
        controller.abort();

        const error = await expectAiError(harness.runtime.runStructured({ ...agentCall(), signal: controller.signal }));

        expect(error.kind).toBe('cancelled');
        expect(toolRequests(harness.provider)).toHaveLength(0);
    });
});
