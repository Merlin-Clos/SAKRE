import { expect, test } from 'bun:test';
import { createMockRuntime } from '../../src/ai/mock-runtime';
import type { AiRuntime } from '../../src/ai/runtime';
import { runReviewCycle } from '../../src/action/run';
import type { TrustedWorkspace } from '../../src/workspace/trusted';
import type { VcsClient } from '../../src/vcs/types';
import { withCapturedLogs } from '../helpers/log-sink';
import { rejectionOf } from '../helpers/rejection';
import { currentHeadSha, fakeIntelligence, INPUTS, makeSnapshot } from '../helpers/review-cycle-fixture';

/* The review cycle owns the runtime and the workspace; each close is guarded so
   one failure cannot skip the other or hide the review failure. */
function runCycle(input: {
    runtime: AiRuntime;
    workspace?: TrustedWorkspace;
    runIntelligence?: () => Promise<never>;
}): ReturnType<typeof runReviewCycle> {
    const headSha = currentHeadSha();

    const vcs: VcsClient = {
        getPullRequestSnapshot: () => Promise.resolve(makeSnapshot(headSha)),
        materializeCoveragePatches: (files) => Promise.resolve([...files]),
        getFileContent: () => Promise.resolve(null),
        getCurrentHeadSha: () => Promise.resolve(headSha)
    };

    return runReviewCycle({
        vcs,
        inputs: INPUTS,
        prNumber: 1,
        execution: 'github-action',
        force: false,
        runIntelligence: input.runIntelligence ?? fakeIntelligence(),
        createRuntime: () => Promise.resolve(input.runtime),
        createWorkspace: createWorkspaceFactory(input.workspace)
    });
}

function createWorkspaceFactory(
    workspace: TrustedWorkspace | undefined
): (() => Promise<TrustedWorkspace>) | undefined {
    if (workspace === undefined) {
        return undefined;
    }

    return () => Promise.resolve(workspace);
}

test('a failing runtime close does not skip workspace cleanup or replace the review error', async () => {
    let workspaceClosed = false;

    const runtime: AiRuntime = {
        ...createMockRuntime(),
        close: () => Promise.reject(new Error('close failed'))
    };

    const workspace: TrustedWorkspace = {
        directory: process.cwd(),
        close: () => {
            workspaceClosed = true;

            return Promise.resolve();
        }
    };

    const failure = await withCapturedLogs(async (logs) => {
        const rejected = await rejectionOf(
            runCycle({
                runtime,
                workspace,
                runIntelligence: () => Promise.reject(new Error('primary failure'))
            })
        );

        /* The primary failure is expected here; capturing the sink keeps its log
           out of the real Action annotation stream. */
        expect(logs.text()).toContain('Review cycle failed');

        return rejected;
    });

    expect(failure.message).toBe('primary failure');
    expect(workspaceClosed).toBe(true);
});

test('a close failure surfaces when the review itself succeeded', async () => {
    const failure = await rejectionOf(
        runCycle({
            runtime: { ...createMockRuntime(), close: () => Promise.reject(new Error('close failed')) }
        })
    );

    expect(failure.message).toBe('close failed');
});
