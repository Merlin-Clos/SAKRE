import { describe, expect, test } from 'bun:test';
import type { AiRuntime, AiStructuredCall, AiStructuredResult } from '../../src/ai/runtime';
import { recordModelInvocations } from '../../src/ai/provenance';
import { rejectionOf } from '../helpers/rejection';

const OK: AiStructuredResult = { structured: {}, text: '' };

function recordingRuntime(): { runtime: AiRuntime; calls: AiStructuredCall[] } {
    const calls: AiStructuredCall[] = [];

    // eslint-disable-next-line anti-slop/no-known-value-widening -- fixture contract annotation; documents the helper result shape
    return {
        calls,
        runtime: {
            runStructured: (input) => {
                calls.push(input);
                /* The fake runtime represents a call that crossed the provider
                   boundary; a runtime that fails earlier never signals. */
                input.onProviderDispatch?.();

                return Promise.resolve(OK);
            },
            close: () => Promise.resolve()
        }
    };
}

function call(agentId: string, modelID: string): AiStructuredCall {
    return {
        agentId,
        model: { providerID: 'anthropic', modelID },
        systemPrompt: '',
        userPrompt: '',
        retryPrompt: ''
    };
}

const ARTIFICIAL_ANALYSIS_URL = 'https://artificialanalysis.ai/models/kimi-k2-6';

describe('model invocation provenance', () => {
    test('records only calls that reached the provider and collapses identical (agent, model) pairs', async () => {
        const { runtime } = recordingRuntime();
        const log = recordModelInvocations(runtime);

        expect(log.modelsUsed()).toEqual([]);
        await log.runtime.runStructured(call('verifier', 'model-a'));
        await log.runtime.runStructured(call('verifier', 'model-a'));
        await log.runtime.runStructured(call('tests', 'model-a'));

        expect(log.modelsUsed()).toEqual([
            { agentId: 'tests', model: 'model-a' },
            { agentId: 'verifier', model: 'model-a' }
        ]);
    });

    test('preserves distinct models for the same agent in deterministic order', async () => {
        const { runtime } = recordingRuntime();
        const log = recordModelInvocations(runtime);

        await log.runtime.runStructured(call('verifier', 'model-b'));
        await log.runtime.runStructured(call('correctness', 'model-a'));
        await log.runtime.runStructured(call('verifier', 'model-a'));

        expect(log.modelsUsed()).toEqual([
            { agentId: 'correctness', model: 'model-a' },
            { agentId: 'verifier', model: 'model-a' },
            { agentId: 'verifier', model: 'model-b' }
        ]);
    });

    test('links a configured catalog URL and never synthesizes one', async () => {
        const { runtime } = recordingRuntime();
        const catalog = new Map([['kimi-k2.6', ARTIFICIAL_ANALYSIS_URL]]);
        const log = recordModelInvocations(runtime, (modelId) => catalog.get(modelId));

        await log.runtime.runStructured(call('correctness', 'kimi-k2.6'));
        await log.runtime.runStructured(call('tests', 'glm-5.2'));

        const [correctness, tests] = log.modelsUsed();
        expect(correctness).toEqual({
            agentId: 'correctness',
            model: 'kimi-k2.6',
            artificialAnalysisUrl: ARTIFICIAL_ANALYSIS_URL
        });
        expect(tests).toEqual({ agentId: 'tests', model: 'glm-5.2' });
        expect(tests === undefined || Object.hasOwn(tests, 'artificialAnalysisUrl')).toBe(false);
        expect(JSON.stringify(tests)).not.toContain('artificialanalysis');
    });

    test('keeps a call that reached the provider and failed as actual usage', async () => {
        const runtime: AiRuntime = {
            runStructured: (input) => {
                input.onProviderDispatch?.();

                return Promise.reject(new Error('provider failed'));
            },
            close: () => Promise.resolve()
        };

        const log = recordModelInvocations(runtime);

        const error = await rejectionOf(log.runtime.runStructured(call('security', 'model-a')));
        expect(error.message).toBe('provider failed');
        expect(log.modelsUsed()).toEqual([{ agentId: 'security', model: 'model-a' }]);
    });

    test('records nothing when the runtime fails before the provider boundary', async () => {
        const runtime: AiRuntime = {
            runStructured: () => Promise.reject(new Error('instruction entry is too large')),
            close: () => Promise.resolve()
        };

        const log = recordModelInvocations(runtime);

        const error = await rejectionOf(log.runtime.runStructured(call('correctness', 'model-a')));
        expect(error.message).toBe('instruction entry is too large');
        expect(log.modelsUsed()).toEqual([]);
    });

    test('closes the wrapped runtime through the recorder', async () => {
        let closed = 0;

        const runtime: AiRuntime = {
            runStructured: () => Promise.resolve(OK),
            close: () => {
                closed += 1;

                return Promise.resolve();
            }
        };

        const log = recordModelInvocations(runtime);

        await log.runtime.close();
        expect(closed).toBe(1);
    });
});
