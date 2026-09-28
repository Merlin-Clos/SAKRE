import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AiStructuredCall } from '../../src/ai/runtime';
import { materializeEnginePlugin } from '../../src/engine/plugin-source';
import { createEmbeddedEngineRuntime, type EmbeddedEngineRuntime } from '../../src/engine/runtime';
import { startFakeAnthropic } from '../helpers/fake-anthropic';

setDefaultTimeout(120_000);

const MODEL = 'claude-opus-5';

const FINDINGS = { summary: 'One review summary.', findings: [], usedContext7: false, context7Topics: [] };

interface Harness {
    runtime: EmbeddedEngineRuntime;
    stopProvider: () => Promise<void>;
}

const harnesses: Harness[] = [];

afterEach(async () => {
    for (const harness of harnesses.splice(0)) {
        await harness.stopProvider();
        await harness.runtime.close();
    }
});

function agentCall(promptPadding: number): AiStructuredCall {
    return {
        agentId: 'correctness',
        model: { providerID: 'anthropic', modelID: MODEL },
        systemPrompt: `SYSTEM MARKER ${'s'.repeat(promptPadding)}`,
        userPrompt: 'Produce your review as specified.',
        retryPrompt: 'Produce your review as specified.'
    };
}

async function pathExists(target: string): Promise<boolean> {
    try {
        await stat(target);

        return true;
    } catch {
        return false;
    }
}

describe('engine database lifecycle', () => {
    test('removes the per-run engine database directory when the runtime closes', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'sakre-run-db-'));
        const workspace = path.join(root, 'workspace');
        const runDirectory = path.join(root, 'engine', 'runs', 'fixture');
        await mkdir(workspace, { recursive: true });

        const provider = startFakeAnthropic([
            { type: 'tool', name: 'submit_findings', input: FINDINGS },
            { type: 'text', text: 'DONE' }
        ]);

        const runtime = await createEmbeddedEngineRuntime({
            providerID: 'anthropic',
            providerFamily: 'anthropic',
            modelIds: [MODEL],
            apiKey: 'sk-ant-fake',
            baseURL: provider.baseURL,
            checkoutDir: workspace,
            pluginDir: await materializeEnginePlugin(path.join(root, 'plugin-cache')),
            databasePath: path.join(runDirectory, 'engine.db'),
            databaseDirectory: runDirectory
        });

        harnesses.push({ runtime, stopProvider: provider.stop });

        try {
            await runtime.runStructured(agentCall(32 * 1024));
            expect(await pathExists(runDirectory)).toBe(true);

            await runtime.close();

            expect(await pathExists(runDirectory)).toBe(false);
        } finally {
            await provider.stop();
            await runtime.close();
            await rm(root, { recursive: true, force: true });
        }
    });
});
