import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { materializeEnginePlugin } from '../../src/engine/plugin-source';
import { createEmbeddedEngineRuntime, type EmbeddedEngineRuntime } from '../../src/engine/runtime';
import { embeddedPrompts } from '../../src/review/embedded-prompts';
import type { DeadlineHandle } from '../../src/review/pipeline-steps';
import { isEligibleForVerification, verifyFindings } from '../../src/review/verifier';
import { type FakeAnthropicProvider, startFakeAnthropic } from '../helpers/fake-anthropic';

/* Provider-payload proof for the verifier: the production `verifyFindings`
   call sends the canonical hunk of the finding's `location.file` through the
   real embedded engine. A shape mismatch is not observable at this level. */
setDefaultTimeout(60_000);

const MODEL = 'claude-opus-5';

const FINDING_ID = 'correctness:src/a.ts:2:abc';

const DIFF = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 1111111..2222222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,2 +1,2 @@',
    ' const first = 1;',
    '-const value = 1;',
    '+const value = 2;'
].join('\n');

interface Harness {
    runtime: EmbeddedEngineRuntime;
    provider: FakeAnthropicProvider;
    root: string;
}

const harnesses: Harness[] = [];

async function startHarness(): Promise<Harness> {
    const root = await mkdtemp(path.join(tmpdir(), 'sakre-verifier-'));
    const workspace = path.join(root, 'workspace');
    await mkdir(workspace, { recursive: true });

    const provider = startFakeAnthropic([
        {
            type: 'tool',
            name: 'submit_verdict',
            input: { findingId: FINDING_ID, state: 'confirmed', reason: 'Proven by the diff.' }
        }
    ]);

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

function expiredDeadline(): DeadlineHandle {
    return {
        signal: new AbortController().signal,
        isExpired: () => false,
        configure: () => {
            /* The test owns the deadline and never reconfigures it. */
        },
        cancel: () => {
            /* The test owns the deadline and has no timer to cancel. */
        }
    };
}

describe('verification eligibility', () => {
    test('every Blocker is eligible at every tier', () => {
        for (const tier of ['lite', 'standard', 'hard'] as const) {
            expect(isEligibleForVerification('Blocker', tier)).toBe(true);
        }
    });

    test('Important is eligible at every tier', () => {
        for (const tier of ['lite', 'standard', 'hard'] as const) {
            expect(isEligibleForVerification('Important', tier)).toBe(true);
        }
    });

    test('Minor is never eligible', () => {
        for (const tier of ['lite', 'standard', 'hard'] as const) {
            expect(isEligibleForVerification('Minor', tier)).toBe(false);
        }
    });
});

describe('verifier provider payload', () => {
    test('the production finding shape yields the canonical hunk in the provider request', async () => {
        const harness = await startHarness();

        const outcome = await verifyFindings({
            findings: [
                {
                    id: FINDING_ID,
                    severity: 'Blocker',
                    title: 'Wrong value',
                    impact: 'The wrong value ships.',
                    evidence: 'The value changed in the diff.',
                    location: { file: 'src/a.ts', line: 2 }
                }
            ],
            tier: 'lite',
            runtime: harness.runtime,
            prompts: { templates: embeddedPrompts, repositoryOverrides: [] },
            modelFor: () => ({ providerID: 'anthropic', modelID: MODEL }),
            diff: DIFF,
            projection: '',
            guidance: { present: false },
            deadline: expiredDeadline()
        });

        expect(outcome.failures).toEqual([]);
        expect(outcome.verified.get(FINDING_ID)?.state).toBe('confirmed');
        const request = harness.provider.requests.findLast((candidate) => candidate.tools.length > 0);
        /* The finding and its hunk travel on the message surface; the
           instruction entry carries policy only. */
        expect(request?.userText).toContain('<untrusted-data name="hunk">');
        expect(request?.userText).toContain('+const value = 2;');
        expect(request?.userText).toContain('"location":{"file":"src/a.ts","line":2}');
        expect(request?.userText).toContain('"impact":"The wrong value ships."');
        expect(request?.userText).toContain('"evidence":"The value changed in the diff."');
        expect(request?.system).not.toContain('name="hunk"');
    });
});
