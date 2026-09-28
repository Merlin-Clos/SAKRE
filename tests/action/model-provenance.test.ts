import { expect, test } from 'bun:test';
import { createMockRuntime } from '../../src/ai/mock-runtime';
import { runReviewCycle } from '../../src/action/run';
import { currentHeadSha, fakeIntelligence, INPUTS, makeSnapshot } from '../helpers/review-cycle-fixture';

/* End-to-end proof that the review cycle records the model invocations that
   actually started: the published comment and the metadata consume the same
   list, and a planned-but-uninvoked verifier never appears. */
test('records the actual model invocations in the published comment and metadata', async () => {
    const headSha = currentHeadSha();
    const bodies: string[] = [];

    const configContent = [
        'models:',
        '  catalog:',
        '    test-model:',
        '      artificialAnalysisUrl: https://artificialanalysis.ai/models/test-model'
    ].join('\n');

    const published = await runReviewCycle({
        vcs: {
            getPullRequestSnapshot: () => Promise.resolve(makeSnapshot(headSha)),
            materializeCoveragePatches: (files) => Promise.resolve([...files]),
            getFileContent: () => Promise.resolve(configContent),
            getCurrentHeadSha: () => Promise.resolve(headSha)
        },
        inputs: INPUTS,
        prNumber: 1,
        execution: 'github-action',
        force: false,
        runIntelligence: fakeIntelligence(),
        createRuntime: () => Promise.resolve(createMockRuntime()),
        publication: {
            triggerCommentId: 50,
            create: () => Promise.resolve(101),
            update: (_commentId, body) => {
                bodies.push(body);

                return Promise.resolve();
            }
        }
    });

    expect(published.result.status).toBe('complete');
    const agentIds = published.models.map((entry) => entry.agentId);
    expect(agentIds).toContain('correctness');
    expect(agentIds).toContain('tests');
    expect(agentIds).toContain('coordinator');
    expect(agentIds).not.toContain('verifier');
    expect(published.models.every((entry) => entry.model === 'test-model')).toBe(true);
    expect(
        published.models.every(
            (entry) => entry.artificialAnalysisUrl === 'https://artificialanalysis.ai/models/test-model'
        )
    ).toBe(true);

    expect(bodies).toHaveLength(1);
    const [body] = bodies;
    expect(body).toContain('<summary>Models used');
    expect(body).toContain('| correctness | [test-model](https://artificialanalysis.ai/models/test-model) |');
    expect(body).toContain('"agents":');
    expect(body).not.toContain('| verifier |');
});
