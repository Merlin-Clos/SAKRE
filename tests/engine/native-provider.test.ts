import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { AiError, type AiModelRoute, type AiStructuredCall } from '../../src/ai/runtime';
import { createEngineHost, type EngineHost } from '../../src/engine/host';
import { materializeEnginePlugin } from '../../src/engine/plugin-source';
import { createEmbeddedEngineRuntime, type EmbeddedEngineRuntime } from '../../src/engine/runtime';
import {
    configureLogRedaction,
    configureLogSink,
    createLogger,
    createStreamLogSink,
    resetLogSink
} from '../../src/logger';
import { releaseAfterSetupFailure } from '../helpers/engine-harness';
import { selectCatalogueModel } from '../helpers/catalogue-models';
import { type FakeResponsesProvider, type FakeResponsesReply, startFakeResponses } from '../helpers/fake-responses';
import { rejectionOf } from '../helpers/rejection';

/* The routed native provider is the OpenCode catalogue: the engine resolves the
   model id through its bundled snapshot and that entry selects the provider
   package and endpoint. These tests exercise the production host, session and
   runtime against a deterministic local transport, so they prove the routing
   boundary without claiming that OpenCode Go itself works. */
setDefaultTimeout(120_000);

const PROVIDER_ID = 'opencode-go';

const PROVIDER_PACKAGE = '@opencode/ai/providers/openai';

const CATALOGUE_MODEL = selectCatalogueModel(
    (model) => model.providerID === PROVIDER_ID && model.package === PROVIDER_PACKAGE && model.variants.length > 0
);

const MODEL_ID = CATALOGUE_MODEL.id;

type NativeModel = Pick<AiModelRoute, 'providerID' | 'modelID'>;

const DEFAULT_MODEL = { providerID: PROVIDER_ID, modelID: MODEL_ID };

const API_KEY = 'fake-opencode-go-key';

const FINDINGS = { summary: 'One review summary.', findings: [], usedContext7: false, context7Topics: [] };

const DEFAULT_SCRIPT: FakeResponsesReply[] = [{ type: 'tool', name: 'submit_findings', input: FINDINGS }];

interface NativeHarness {
    runtime: EmbeddedEngineRuntime;
    provider: FakeResponsesProvider;
    stop: () => Promise<void>;
}

async function startNativeHarness(
    model: NativeModel = DEFAULT_MODEL,
    script: FakeResponsesReply[] = DEFAULT_SCRIPT
): Promise<NativeHarness> {
    const root = await mkdtemp(path.join(tmpdir(), 'sakre-native-provider-'));
    const workspace = path.join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const provider = startFakeResponses(script);

    try {
        const runtime = await createEmbeddedEngineRuntime({
            providerID: model.providerID,
            providerFamily: 'native',
            modelIds: [model.modelID],
            apiKey: API_KEY,
            baseURL: provider.baseURL,
            checkoutDir: workspace,
            pluginDir: await materializeEnginePlugin(path.join(root, 'plugin-cache')),
            databasePath: path.join(root, 'engine.db')
        });

        return {
            runtime,
            provider,
            stop: async () => {
                try {
                    await provider.stop();
                } finally {
                    try {
                        await runtime.close();
                    } finally {
                        await rm(root, { recursive: true, force: true });
                    }
                }
            }
        };
    } catch (error) {
        /* A rejected setup never returns a handle, so release the provider
           socket and the temp root here instead of leaking them. */
        await releaseAfterSetupFailure(provider, root);
        throw error;
    }
}

async function startNativeHost(
    model: NativeModel = DEFAULT_MODEL
): Promise<{ host: EngineHost; stop: () => Promise<void> }> {
    const root = await mkdtemp(path.join(tmpdir(), 'sakre-native-catalogue-'));
    const workspace = path.join(root, 'workspace');
    await mkdir(workspace, { recursive: true });

    try {
        const host = await createEngineHost({
            providerID: model.providerID,
            providerFamily: 'native',
            modelIds: [model.modelID],
            apiKey: API_KEY,
            checkoutDir: workspace,
            pluginDir: await materializeEnginePlugin(path.join(root, 'plugin-cache')),
            databasePath: path.join(root, 'engine.db')
        });

        return {
            host,
            stop: async () => {
                try {
                    await host.client.close();
                } finally {
                    await rm(root, { recursive: true, force: true });
                }
            }
        };
    } catch (error) {
        await rm(root, { recursive: true, force: true });
        throw error;
    }
}

function agentCall(model: NativeModel = DEFAULT_MODEL): AiStructuredCall {
    return {
        agentId: 'correctness',
        model,
        systemPrompt: 'SYSTEM MARKER',
        userPrompt: 'Reply with exactly: OK',
        retryPrompt: 'Reply with exactly: OK'
    };
}

function captureStream(): { stream: NodeJS.WritableStream; read: () => string } {
    let text = '';

    const stream = new Writable({
        write(chunk: Buffer, _encoding, callback): void {
            text += chunk.toString('utf8');
            callback();
        }
    });

    // eslint-disable-next-line anti-slop/no-known-value-widening -- stream-capture helper; annotation documents the readable pair
    return { stream, read: () => text };
}

const harnesses: NativeHarness[] = [];

const hosts: { stop: () => Promise<void> }[] = [];

afterEach(async () => {
    for (const harness of harnesses.splice(0)) {
        await harness.stop();
    }

    for (const host of hosts.splice(0)) {
        await host.stop();
    }
});

describe('native provider routing', () => {
    test('discovers and dispatches a bundled OpenAI Responses model', async () => {
        const providerID = 'openai';

        const selected = selectCatalogueModel(
            (model) => model.providerID === providerID && model.package === PROVIDER_PACKAGE
        );

        const modelID = selected.id;
        const route = { providerID, modelID };
        const nativeHost = await startNativeHost(route);
        hosts.push({ stop: nativeHost.stop });

        const catalogue = await nativeHost.host.client.model.list({
            location: { directory: nativeHost.host.directory }
        });

        const model = catalogue.data.find((entry) => entry.providerID === providerID && entry.id === modelID);

        expect(model?.enabled).toBe(true);
        expect(model?.package).toBe(PROVIDER_PACKAGE);

        const harness = await startNativeHarness(route);
        harnesses.push(harness);
        const result = await harness.runtime.runStructured(agentCall(route));

        expect(result.structured).toEqual(FINDINGS);
        expect(harness.provider.requests[0]).toMatchObject({
            path: '/v1/responses',
            model: selected.modelID,
            authHeaders: { authorization: `Bearer ${API_KEY}` }
        });
    });

    test('resolves the routed model through the bundled catalogue with its provider package', async () => {
        const nativeHost = await startNativeHost();
        hosts.push({ stop: nativeHost.stop });

        const list = await nativeHost.host.client.model.list({ location: { directory: nativeHost.host.directory } });
        const model = list.data.find((entry) => entry.providerID === PROVIDER_ID && entry.id === MODEL_ID);

        /* The catalogue entry, not a SAKRE declaration, owns the model and
           its provider package: that override is what selects the endpoint. */
        expect(model).toBeDefined();
        expect(model?.providerID).toBe(PROVIDER_ID);
        expect(model?.package).toBe(PROVIDER_PACKAGE);
    });

    test('dispatches the routed model to the catalogue endpoint with the injected credential', async () => {
        const harness = await startNativeHarness();
        harnesses.push(harness);

        const result = await harness.runtime.runStructured(agentCall());

        expect(result.structured).toEqual(FINDINGS);
        expect(harness.provider.requests).toHaveLength(2);
        const [first] = harness.provider.requests;
        expect(first?.path).toBe('/v1/responses');
        expect(first?.model).toBe(CATALOGUE_MODEL.modelID);
        expect(first?.authHeaders.authorization).toBe(`Bearer ${API_KEY}`);
        expect(first?.userText).toContain('Reply with exactly: OK');
    });

    test('passes a catalogue-supported variant and preserves the unmodified default', async () => {
        const harness = await startNativeHarness();
        harnesses.push(harness);
        const nativeHost = await startNativeHost();
        hosts.push({ stop: nativeHost.stop });
        const models = await nativeHost.host.client.model.list({ location: { directory: nativeHost.host.directory } });
        const model = models.data.find((entry) => entry.providerID === PROVIDER_ID && entry.id === MODEL_ID);
        expect(model?.variants.length).toBeGreaterThan(0);
        const variant = model?.variants[0]?.id;

        if (variant === undefined) {
            throw new Error('The selected catalogue model has no supported variant.');
        }

        const result = await harness.runtime.runStructured({
            ...agentCall(),
            model: { providerID: PROVIDER_ID, modelID: MODEL_ID, variant }
        });

        expect(result.structured).toEqual(FINDINGS);
        expect(harness.provider.requests[0]?.model).toBe(CATALOGUE_MODEL.modelID);
    });

    test('reports an unsupported variant without dispatching to the provider', async () => {
        const harness = await startNativeHarness();
        harnesses.push(harness);

        const error = await rejectionOf(
            harness.runtime.runStructured({
                ...agentCall(),
                model: { providerID: PROVIDER_ID, modelID: MODEL_ID, variant: 'variant-not-in-catalogue' }
            })
        );

        expect(error.message).toContain('variant-not-in-catalogue');
        expect(error.message).toMatch(/variant.*unavailable/iu);
        expect(harness.provider.requests).toHaveLength(0);
    });

    test('redacts credential material echoed by the provider error before any sink', async () => {
        configureLogRedaction([API_KEY]);
        const captured = captureStream();
        configureLogSink(createStreamLogSink(captured.stream));

        try {
            const harness = await startNativeHarness(DEFAULT_MODEL, [
                { type: 'error', status: 401, body: { error: { message: `invalid key: ${API_KEY}` } } }
            ]);

            harnesses.push(harness);

            const error = await rejectionOf(harness.runtime.runStructured(agentCall()));

            /* The fake provider deliberately echoed the credential; the single
               failure-normalization boundary must have sanitized it before any
               ReviewFailure, renderer, file, stderr or publication sink sees it. */
            expect(error).toBeInstanceOf(AiError);

            if (error instanceof AiError) {
                expect(error.kind).toBe('provider-auth');
            }

            expect(error.message).toContain('[redacted]');
            expect(error.message).not.toContain(API_KEY);
            expect(harness.provider.requests[0]?.authHeaders.authorization).toBe(`Bearer ${API_KEY}`);

            /* The same surfaced text through the review logger sink stays clean. */
            createLogger('review').error('Review cycle failed', { error: error.message });
            expect(captured.read()).not.toContain(API_KEY);
        } finally {
            resetLogSink();
            configureLogRedaction([]);
        }
    });

    test('preserves the pre-provider failure detail for an unknown native model', async () => {
        const route = { providerID: PROVIDER_ID, modelID: 'test-model-not-in-the-catalogue' };
        const harness = await startNativeHarness(route);
        harnesses.push(harness);

        const error = await rejectionOf(harness.runtime.runStructured(agentCall(route)));

        expect(error.message).toBe(`Model unavailable: ${PROVIDER_ID}/${route.modelID}`);
        expect(harness.provider.requests).toHaveLength(0);
    });

    test('attributes concurrent pre-provider failures to their own session and model', async () => {
        const harness = await startNativeHarness();
        harnesses.push(harness);
        const firstModel = 'test-model-not-in-the-catalogue-a';
        const secondModel = 'test-model-not-in-the-catalogue-b';

        /* One runtime, two sessions that fail before provider dispatch: each
           rejection must carry its own session's model, and no provider request
           may be made for either. */
        const firstCall = harness.runtime.runStructured(agentCall({ providerID: PROVIDER_ID, modelID: firstModel }));
        const secondCall = harness.runtime.runStructured(agentCall({ providerID: PROVIDER_ID, modelID: secondModel }));
        const [first, second] = await Promise.all([rejectionOf(firstCall), rejectionOf(secondCall)]);

        expect(first.message).toContain(`${PROVIDER_ID}/${firstModel}`);
        expect(first.message).not.toContain(secondModel);
        expect(second.message).toContain(`${PROVIDER_ID}/${secondModel}`);
        expect(second.message).not.toContain(firstModel);
        expect(harness.provider.requests).toHaveLength(0);
    });
});
