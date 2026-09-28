/* Shared engine-surface harness: the real embedded engine against the deterministic fake provider, so tests exercise
   the production request path without any external call. */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { materializeEnginePlugin } from '../../src/engine/plugin-source';
import { createEmbeddedEngineRuntime, type EmbeddedEngineRuntime } from '../../src/engine/runtime';
import { type FakeAnthropicProvider, type FakeAnthropicReply, startFakeAnthropic } from './fake-anthropic';

export const ENGINE_TEST_MODEL = 'claude-opus-5';

export interface EngineHarness {
    runtime: EmbeddedEngineRuntime;
    provider: FakeAnthropicProvider;
    stop: () => Promise<void>;
}

export async function startEngineHarness(script: FakeAnthropicReply[]): Promise<EngineHarness> {
    const root = await mkdtemp(path.join(tmpdir(), 'sakre-engine-surface-'));
    const workspace = path.join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const provider = startFakeAnthropic(script);

    try {
        const runtime = await createEmbeddedEngineRuntime({
            providerID: 'anthropic',
            providerFamily: 'anthropic',
            modelIds: [ENGINE_TEST_MODEL],
            apiKey: 'sk-ant-fake',
            baseURL: provider.baseURL,
            checkoutDir: workspace,
            pluginDir: await materializeEnginePlugin(path.join(root, 'plugin-cache')),
            databasePath: path.join(root, 'engine.db')
        });

        return {
            runtime,
            provider,
            stop: async () => {
                /* Every resource is released even when an earlier release
                   rejects; the first rejection still reaches the caller. */
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
        await releaseAfterSetupFailure(provider, root);
        throw error;
    }
}

/* Setup failed before the handle existed, so the caller cannot stop anything: release the provider socket and temp root here.
   The setup failure stays the reported error. Shared by every engine-surface harness (Anthropic and native-provider fakes). */
export async function releaseAfterSetupFailure(provider: { stop: () => Promise<void> }, root: string): Promise<void> {
    try {
        await provider.stop();
    } catch {
        // Best effort: the cleanup below still runs and the setup error is kept.
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}
