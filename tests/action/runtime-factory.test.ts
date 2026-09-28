import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMockRuntime } from '../../src/ai/mock-runtime';
import { createActionRuntime } from '../../src/action/runtime-factory';
import { resolveEffectiveRun } from '../../src/config/effective-run';
import { loadReviewConfig } from '../../src/config/load';
import { builtInAgentIds } from '../../src/config/schema';
import { buildEngineConfigContent } from '../../src/engine/config';
import type { EngineHostOptions } from '../../src/engine/host';
import { materializeEnginePlugin } from '../../src/engine/plugin-source';
import type { NativeRuntime } from '../../src/native/runtime';
import { collectRoutedModelIds, resolveModelRoute } from '../../src/review/agents';

const BASE_SHA = 'a'.repeat(40);

const ROUTING_CONFIG = [
    'provider: openai-compatible',
    'model: gateway-global',
    'models:',
    '  routing:',
    '    verifier:',
    '      default: gateway-verifier',
    '    security:',
    '      hard: gateway-security'
].join('\n');

test('the runtime catalogue covers every model the pipeline routes to', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'sakre-runtime-factory-'));
    const originalPath = process.env.PATH;

    try {
        const config = await loadReviewConfig(
            {
                getFileContent: (filePath, ref) => {
                    expect(filePath).toBe('.github/sakre.yml');
                    expect(ref).toBe(BASE_SHA);

                    return Promise.resolve(ROUTING_CONFIG);
                }
            },
            BASE_SHA
        );

        const effective = resolveEffectiveRun({ config, apiKey: 'test-key', isMockMode: false });
        // eslint-disable-next-line anti-slop/no-known-value-widening -- capture slot filled by the exercised code; annotation declares the collected shape
        const captured: { options?: EngineHostOptions } = {};

        await createActionRuntime(
            { effective, config, isMockMode: false, native: fakeNative(root) },
            {
                createEngineRuntime: (options) => {
                    captured.options = options;

                    return Promise.resolve(createMockRuntime());
                }
            }
        );
        const { options } = captured;

        if (options === undefined) {
            throw new Error('The engine runtime was not created.');
        }

        const routedModels = builtInAgentIds.flatMap((agentId) =>
            (['lite', 'standard', 'hard'] as const).flatMap((tier) => {
                const route = resolveModelRoute(config, agentId, tier);

                if (route.model === undefined) {
                    return [];
                }

                return [route.model];
            })
        );

        expect(collectRoutedModelIds(config)).toEqual(['gateway-global', 'gateway-security', 'gateway-verifier']);

        for (const model of routedModels) {
            expect(options.modelIds).toContain(model);
        }

        const content = buildEngineConfigContent(options);
        // SAFETY: buildEngineConfigContent returns an untyped record; the providers block is built from the declared options and the routed model keys are asserted below.
        // eslint-disable-next-line anti-slop/no-unsafe-dictionary-type -- generated config content is an untyped record; only the declared model keys are read
        const providers = content.providers as Record<string, { models: Record<string, unknown> }>;
        const declared = Object.keys(providers['openai-compatible']?.models ?? {});

        for (const model of routedModels) {
            expect(declared).toContain(model);
        }
    } finally {
        process.env.PATH = originalPath;
        await rm(root, { recursive: true, force: true });
    }
});

function fakeNative(root: string): NativeRuntime {
    return {
        target: 'linux-x64',
        cacheRoot: root,
        materializeRipgrep: () => Promise.resolve(path.join(root, 'rg')),
        materializeScc: () => Promise.resolve(path.join(root, 'scc')),
        materializeCccc: () => Promise.resolve(path.join(root, 'cccc')),
        materializeEnginePlugin: () => materializeEnginePlugin(path.join(root, 'plugin-cache')),
        engineCredentialPath: path.join(root, 'engine', 'credentials.json'),
        engineOAuthCredentialPath: path.join(root, 'data', 'engine', 'credentials.db'),
        engineDatabasePath: path.join(root, 'engine', 'runs', 'fixture', 'engine.db'),
        engineDatabaseDirectory: path.join(root, 'engine', 'runs', 'fixture')
    };
}
