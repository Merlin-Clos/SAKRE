import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { AiError, type AiStructuredCall } from '../../src/ai/runtime';
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
import { type FakeResponsesProvider, type FakeResponsesReply, startFakeResponses } from '../helpers/fake-responses';
import { rejectionOf } from '../helpers/rejection';

/* The routed native provider is the OpenCode catalogue: the engine resolves the
   model id through its bundled snapshot and that entry selects the provider
   package and endpoint. These tests exercise the production host, session and
   runtime against a deterministic local transport, so they prove the routing
   boundary without claiming that OpenCode Go itself works. */
setDefaultTimeout(120_000);

const PROVIDER_ID = 'opencode-go';

const MODEL_ID = 'muse-spark-1.3-contributor';

const API_KEY = 'fake-opencode-go-key';

const FINDINGS = { summary: 'One review summary.', findings: [], usedContext7: false, context7Topics: [] };

const DEFAULT_SCRIPT: FakeResponsesReply[] = [{ type: 'tool', name: 'submit_findings', input: FINDINGS }];

interface NativeHarness {
    runtime: EmbeddedEngineRuntime;
    provider: FakeResponsesProvider;
    stop: () => Promise<void>;
}

async function startNativeHarness(
    modelID: string = MODEL_ID,
    script: FakeResponsesReply[] = DEFAULT_SCRIPT
): Promise<NativeHarness> {
    const root = await mkdtemp(path.join(tmpdir(), 'sakre-native-provider-'));
    const workspace = path.join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const provider = startFakeResponses(script);

    try {
        const runtime = await createEmbeddedEngineRuntime({
            providerID: PROVIDER_ID,
            providerFamily: 'native',
            modelIds: [modelID],
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

async function startNativeHost(): Promise<{ host: EngineHost; stop: () => Promise<void> }> {
    const root = await mkdtemp(path.join(tmpdir(), 'sakre-native-catalogue-'));
    const workspace = path.join(root, 'workspace');
    await mkdir(workspace, { recursive: true });

    try {
        const host = await createEngineHost({
            providerID: PROVIDER_ID,
            providerFamily: 'native',
            modelIds: [MODEL_ID],
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

function agentCall(modelID = MODEL_ID): AiStructuredCall {
    return {
        agentId: 'correctness',
        model: { providerID: PROVIDER_ID, modelID },
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

// eslint-disable-next-line anti-slop/no-unsafe-dictionary-type -- type-guard predicate over the fake catalogue payload
function isRecord(value: unknown): value is Record<string, unknown> {
    // eslint-disable-next-line anti-slop/no-runtime-typeof -- type-guard narrowing of untrusted input; the predicate is the boundary
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// eslint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type -- catalogue helper narrows the fake response with Array.isArray before use; entries are schemaless fake data
function findModel(models: unknown, id: string): Record<string, unknown> | undefined {
    if (!Array.isArray(models)) {
        return undefined;
    }

    const entries: unknown[] = models;

    for (const entry of entries) {
        if (isRecord(entry) && entry.id === id) {
            return entry;
        }
    }

    return undefined;
}

describe('native provider routing', () => {
    test('resolves the routed model through the bundled catalogue with its provider package', async () => {
        const nativeHost = await startNativeHost();
        hosts.push({ stop: nativeHost.stop });

        const list = await nativeHost.host.client.model.list({ location: { directory: nativeHost.host.directory } });
        // SAFETY: the native host model.list resolves with a { data } catalogue envelope; findModel narrows the entries.
        const model = findModel((list as { data?: unknown }).data, MODEL_ID);

        /* The catalogue entry, not a SAKRE declaration, owns the model and
           its provider package: that override is what selects the endpoint. */
        expect(model).toBeDefined();
        expect(model?.providerID).toBe(PROVIDER_ID);
        expect(model?.package).toBe('@opencode/ai/providers/openai');
    });

    test('dispatches the routed model to the catalogue endpoint with the injected credential', async () => {
        const harness = await startNativeHarness();
        harnesses.push(harness);

        const result = await harness.runtime.runStructured(agentCall());

        expect(result.structured).toEqual(FINDINGS);
        expect(harness.provider.requests).toHaveLength(2);
        const [first] = harness.provider.requests;
        expect(first?.path).toBe('/v1/responses');
        expect(first?.model).toBe(MODEL_ID);
        expect(first?.authHeaders.authorization).toBe(`Bearer ${API_KEY}`);
        expect(first?.userText).toContain('Reply with exactly: OK');
    });

    test('passes a catalogue-supported variant and preserves the unmodified default', async () => {
        const harness = await startNativeHarness();
        harnesses.push(harness);
        const nativeHost = await startNativeHost();
        hosts.push({ stop: nativeHost.stop });
        const models = await nativeHost.host.client.model.list({ location: { directory: nativeHost.host.directory } });
        const model = models.data.find((entry) => entry.providerID === PROVIDER_ID && entry.modelID === MODEL_ID);
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
        expect(harness.provider.requests[0]?.model).toBe(MODEL_ID);
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
            const harness = await startNativeHarness(MODEL_ID, [
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
        const harness = await startNativeHarness('muse-spark-not-in-the-catalogue');
        harnesses.push(harness);

        const error = await rejectionOf(harness.runtime.runStructured(agentCall('muse-spark-not-in-the-catalogue')));

        expect(error.message).toBe(`Model unavailable: ${PROVIDER_ID}/muse-spark-not-in-the-catalogue`);
        expect(harness.provider.requests).toHaveLength(0);
    });

    test('attributes concurrent pre-provider failures to their own session and model', async () => {
        const harness = await startNativeHarness();
        harnesses.push(harness);
        const firstModel = 'muse-spark-not-in-the-catalogue-a';
        const secondModel = 'muse-spark-not-in-the-catalogue-b';

        /* One runtime, two sessions that fail before provider dispatch: each
           rejection must carry its own session's model, and no provider request
           may be made for either. */
        const firstCall = harness.runtime.runStructured(agentCall(firstModel));
        const secondCall = harness.runtime.runStructured(agentCall(secondModel));
        const [first, second] = await Promise.all([rejectionOf(firstCall), rejectionOf(secondCall)]);

        expect(first.message).toContain(`${PROVIDER_ID}/${firstModel}`);
        expect(first.message).not.toContain(secondModel);
        expect(second.message).toContain(`${PROVIDER_ID}/${secondModel}`);
        expect(second.message).not.toContain(firstModel);
        expect(harness.provider.requests).toHaveLength(0);
    });
});
