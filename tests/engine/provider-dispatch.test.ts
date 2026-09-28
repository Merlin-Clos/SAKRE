import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { recordModelInvocations } from '../../src/ai/provenance';
import type { AiStructuredCall } from '../../src/ai/runtime';
import { rejectionOf } from '../helpers/rejection';
import { ENGINE_TEST_MODEL, type EngineHarness, startEngineHarness } from '../helpers/engine-harness';

setDefaultTimeout(120_000);

const FINDINGS = { summary: 'One review summary.', findings: [], usedContext7: false, context7Topics: [] };

const UNKNOWN_MODEL = 'claude-model-not-in-the-catalogue';

/* InstructionEntry.MaxValueBytes in the installed engine. */
const INSTRUCTION_ENTRY_LIMIT_BYTES = 262_144;

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

function agentCall(systemPrompt: string, modelID = ENGINE_TEST_MODEL): AiStructuredCall {
    return {
        agentId: 'correctness',
        model: { providerID: 'anthropic', modelID },
        systemPrompt,
        userPrompt: 'Produce your review as specified.',
        retryPrompt: 'Produce your review as specified.'
    };
}

/* The provenance contract is observed through the same decorator the Action
   and the CLI install: "Models used" is exactly what the recorder published. */
describe('model provenance at the provider boundary', () => {
    test('records the actual model after the provider returns a submission', async () => {
        const harness = await startHarness([{ type: 'tool', name: 'submit_findings', input: FINDINGS }]);
        const log = recordModelInvocations(harness.runtime);

        await log.runtime.runStructured(agentCall('SYSTEM MARKER'));

        expect(log.modelsUsed()).toEqual([{ agentId: 'correctness', model: ENGINE_TEST_MODEL }]);
    });

    test('records the actual model when the provider rejects the request', async () => {
        const harness = await startHarness([
            {
                type: 'error',
                status: 401,
                body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }
            }
        ]);

        const log = recordModelInvocations(harness.runtime);

        const error = await rejectionOf(log.runtime.runStructured(agentCall('SYSTEM MARKER')));

        expect(error.message).toBe('invalid x-api-key');
        expect(log.modelsUsed()).toEqual([{ agentId: 'correctness', model: ENGINE_TEST_MODEL }]);
    });

    test('records nothing when the instruction entry is rejected before the provider', async () => {
        const harness = await startHarness([{ type: 'tool', name: 'submit_findings', input: FINDINGS }]);
        const log = recordModelInvocations(harness.runtime);
        const oversized = 'z'.repeat(INSTRUCTION_ENTRY_LIMIT_BYTES + 10_000);

        const error = await rejectionOf(log.runtime.runStructured(agentCall(oversized)));

        expect(error.message).toContain(`the limit is ${INSTRUCTION_ENTRY_LIMIT_BYTES} bytes`);
        expect(log.modelsUsed()).toEqual([]);
        expect(harness.provider.requests).toHaveLength(0);
    });

    test('records nothing when a started session fails before the provider', async () => {
        const harness = await startHarness([]);
        const log = recordModelInvocations(harness.runtime);

        /* Reachable in-session pre-provider failure: the session opens, so the
           oversized-entry case above is not the only shape. The engine fails on
           the unknown model without a provider request, and the model must not
           appear in "Models used". */
        await rejectionOf(log.runtime.runStructured(agentCall('SYSTEM MARKER', UNKNOWN_MODEL)));

        expect(log.modelsUsed()).toEqual([]);
        expect(harness.provider.requests).toHaveLength(0);
    });
});
