import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { recordModelInvocations } from '../../src/ai/provenance';
import type { AiStructuredCall } from '../../src/ai/runtime';
import { rejectionOf } from '../helpers/rejection';
import { ENGINE_TEST_MODEL, type EngineHarness, startEngineHarness } from '../helpers/engine-harness';

setDefaultTimeout(120_000);

const UNKNOWN_MODEL = 'claude-model-not-in-the-catalogue';

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
    test('records nothing when a started session fails before the provider', async () => {
        const harness = await startHarness([]);
        const log = recordModelInvocations(harness.runtime);

        /* The session opens before the unknown model fails without a provider
           request, unlike the oversized instruction rejection. The model must not
           appear in "Models used". */
        await rejectionOf(log.runtime.runStructured(agentCall('SYSTEM MARKER', UNKNOWN_MODEL)));

        expect(log.modelsUsed()).toEqual([]);
        expect(harness.provider.requests).toHaveLength(0);
    });
});
