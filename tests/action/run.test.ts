import { expect, test } from 'bun:test';
import { CancelledError } from '../../src/analysis/cancellation';
import { createMockRuntime } from '../../src/ai/mock-runtime';
import { DiffBudgetExceededError } from '../../src/action/errors';
import type { ActionInputs } from '../../src/action/inputs';
import { runReviewCycle } from '../../src/action/run';
import type { IntelligenceRunOptions } from '../../src/intelligence/pre-pass';
import type { PublishedResult } from '../../src/action/state';
import type { DeadlineHandle } from '../../src/review/pipeline-steps';
import type { VcsChangedFile, VcsClient } from '../../src/vcs/types';
import { withCapturedLogs } from '../helpers/log-sink';
import { rejectionOf } from '../helpers/rejection';
import {
    currentHeadSha,
    fakeIntelligence,
    fakeIntelligenceOutput,
    INPUTS,
    makeSnapshot
} from '../helpers/review-cycle-fixture';

test('starts one deadline before VCS reads and reuses it through publication', async () => {
    const headSha = currentHeadSha();
    const snapshotSignal: { value?: AbortSignal } = {};
    const configSignal: { value?: AbortSignal } = {};
    const runtimeSignal: { value?: AbortSignal } = {};
    const measurement: { options?: IntelligenceRunOptions } = {};
    const operationSignals: (AbortSignal | undefined)[] = [];
    const snapshot = makeSnapshot(headSha);

    const vcs: VcsClient = {
        getPullRequestSnapshot: (_number, signal) => {
            snapshotSignal.value = signal;

            return Promise.resolve(snapshot);
        },
        materializeCoveragePatches: (files) => Promise.resolve([...files]),
        getFileContent: (_path, _ref, signal) => {
            configSignal.value = signal;

            return Promise.resolve(null);
        },
        getCurrentHeadSha: (_number, signal) => {
            operationSignals.push(signal);

            return Promise.resolve(headSha);
        }
    };

    const published = await runReviewCycle({
        vcs,
        inputs: INPUTS,
        prNumber: 1,
        runId: 'run-1',
        execution: 'github-action',
        force: false,
        runIntelligence: (options) => {
            measurement.options = options;

            return Promise.resolve(fakeIntelligenceOutput(options));
        },
        createRuntime: ({ signal }) => {
            runtimeSignal.value = signal;

            return Promise.resolve(createMockRuntime());
        },
        publication: {
            triggerCommentId: 50,
            create: (_body, signal) => {
                operationSignals.push(signal);

                return Promise.resolve(101);
            },
            update: (_commentId, _body, signal) => {
                operationSignals.push(signal);

                return Promise.resolve();
            }
        }
    });

    expect(published.result.status).toBe('complete');
    expect(snapshotSignal.value).toBeDefined();
    expect(configSignal.value).toBe(snapshotSignal.value);
    expect(runtimeSignal.value).toBe(snapshotSignal.value);
    expect(measurement.options?.signal).toBe(snapshotSignal.value);
    expect(measurement.options?.baseSha).toBe(headSha);
    expect(measurement.options?.worktreeDir).toBe(process.cwd());
    expect(operationSignals).toHaveLength(3);
    expect(operationSignals.every((signal) => signal === snapshotSignal.value)).toBe(true);
});

test('publishes a terminal failure with a separate cleanup signal', async () => {
    const headSha = currentHeadSha();
    const controller = new AbortController();
    let configured = false;
    let cancelled = false;

    const deadline: DeadlineHandle = {
        signal: controller.signal,
        isExpired: () => controller.signal.aborted,
        configure: () => {
            configured = true;
        },
        cancel: () => {
            cancelled = true;
        }
    };

    const reviewSignals: AbortSignal[] = [];
    const cleanupSignals: AbortSignal[] = [];

    const vcs: VcsClient = {
        getPullRequestSnapshot: () => Promise.resolve(makeSnapshot(headSha)),
        materializeCoveragePatches: (files) => Promise.resolve([...files]),
        getFileContent: () => Promise.resolve(null),
        getCurrentHeadSha: () => Promise.resolve(headSha)
    };

    await withCapturedLogs(async (logs) => {
        await rejectionOf(
            runReviewCycle(
                {
                    vcs,
                    inputs: INPUTS,
                    prNumber: 1,
                    runId: 'run-1',
                    execution: 'github-action',
                    force: false,
                    runIntelligence: (options) => {
                        if (options.signal?.aborted === true) {
                            return Promise.reject(new CancelledError());
                        }

                        return Promise.resolve(fakeIntelligenceOutput(options));
                    },
                    createRuntime: () => Promise.resolve(createMockRuntime()),
                    publication: {
                        triggerCommentId: 50,
                        create: (_body, signal) => {
                            if (signal !== undefined) {
                                reviewSignals.push(signal);
                            }

                            controller.abort();

                            return Promise.resolve(101);
                        },
                        update: (_commentId, _body, signal) => {
                            if (signal !== undefined) {
                                cleanupSignals.push(signal);
                            }

                            return Promise.resolve();
                        }
                    }
                },
                deadline
            )
        );
        /* The failure is expected here; capturing the sink keeps its log out of
           the real Action annotation stream. */
        expect(logs.text()).toContain('Review cycle failed');
    });

    expect(reviewSignals).toHaveLength(1);
    expect(cleanupSignals).toHaveLength(1);
    expect(cleanupSignals[0]).not.toBe(reviewSignals[0]);
    expect(cleanupSignals[0]?.aborted).toBe(false);
    expect(configured).toBe(true);
    expect(cancelled).toBe(true);
});

test('aborts before any provider call when the configured budget cannot cover the diff', async () => {
    let runtimeCalls = 0;
    let intelligenceCalls = 0;

    const failure = await withCapturedLogs(async (logs) => {
        const rejected = await rejectionOf(
            runWithConfig('review:\n  diffBudgetChars: 20000\n', {
                createRuntime: () => {
                    runtimeCalls += 1;

                    return Promise.resolve(createMockRuntime());
                },
                runIntelligence: () => {
                    intelligenceCalls += 1;

                    return Promise.reject(new Error('the pre-pass must not run over budget'));
                }
            })
        );

        /* The budget abort is expected here; capturing the sink keeps its log
           out of the real Action annotation stream. */
        expect(logs.text()).toContain('Review cycle failed');

        return rejected;
    });

    expect(failure).toBeInstanceOf(DiffBudgetExceededError);
    // SAFETY: toBeInstanceOf above establishes the DiffBudgetExceededError shape before destructuring.
    const { report } = failure as DiffBudgetExceededError;
    expect(report.limitChars).toBe(20_000);
    expect(report.reviewableFiles).toBe(1);
    expect(report.completeFiles).toBe(0);
    expect(report.totalChars).toBeGreaterThan(report.limitChars);
    expect(report.coveredChars).toBeLessThan(report.totalChars);
    expect(failure.message).toContain('diff = ');
    expect(failure.message).toContain('limit = 20000');
    expect(runtimeCalls).toBe(0);
    expect(intelligenceCalls).toBe(0);
});

test('runs the full review when the same diff fits the default budget', async () => {
    const published = await runWithConfig(null);
    expect(published.result.status).toBe('complete');
});

test('a mock run without a configured model uses the shared placeholder', async () => {
    /* `uses: …` with mock_mode and no default_model must succeed exactly like
       `local --mock`: the placeholder model is owned by the review cycle. */
    const published = await runWithConfig(null, { inputs: { ...INPUTS, defaultModel: undefined } });
    expect(published.result.status).toBe('complete');
});

test('a forced over-budget run reviews the portion that fits and never completes', async () => {
    let runtimeCalls = 0;

    const published = await runWithConfig('review:\n  diffBudgetChars: 20000\n', {
        forceOverBudget: true,
        createRuntime: () => {
            runtimeCalls += 1;

            return Promise.resolve(createMockRuntime());
        }
    });

    expect(runtimeCalls).toBe(1);
    expect(published.result.status).toBe('incomplete');
    expect(published.result.verdict).toBeNull();

    if (published.result.status !== 'incomplete') {
        throw new Error('expected an incomplete review');
    }

    const coverageFailure = published.result.failures.find((failure) => failure.stage === 'coverage');
    expect(coverageFailure?.kind).toBe('runtime-failure');
    expect(coverageFailure?.message).toContain('src/large.js');
    expect(coverageFailure?.message).toContain('not fully reviewed');
});

test('an interactive confirmation forces the partial review and a refusal aborts', async () => {
    const confirmed = await runWithConfig('review:\n  diffBudgetChars: 20000\n', {
        confirmOverBudget: () => Promise.resolve(true)
    });

    expect(confirmed.result.status).toBe('incomplete');

    let runtimeCalls = 0;

    const refused = await withCapturedLogs(async (logs) => {
        const rejected = await rejectionOf(
            runWithConfig('review:\n  diffBudgetChars: 20000\n', {
                confirmOverBudget: () => Promise.resolve(false),
                createRuntime: () => {
                    runtimeCalls += 1;

                    return Promise.resolve(createMockRuntime());
                }
            })
        );

        /* The refusal is expected here; capturing the sink keeps its log out of
           the real Action annotation stream. */
        expect(logs.text()).toContain('Review cycle failed');

        return rejected;
    });

    expect(refused).toBeInstanceOf(DiffBudgetExceededError);
    expect(runtimeCalls).toBe(0);
});

function runWithConfig(
    configContent: string | null,
    overrides: {
        forceOverBudget?: boolean;
        confirmOverBudget?: () => Promise<boolean>;
        createRuntime?: () => Promise<ReturnType<typeof createMockRuntime>>;
        runIntelligence?: () => Promise<never>;
        inputs?: ActionInputs;
    } = {}
): Promise<PublishedResult> {
    const headSha = currentHeadSha();
    const patch = `@@ -1,1 +1,1700 @@\n${'+const value = 1;\n'.repeat(1700)}`;

    const changedFile: VcsChangedFile = {
        path: 'src/large.js',
        status: 'modified',
        additions: 1700,
        deletions: 0,
        patch: { state: 'retained', chars: patch.length, content: patch }
    };

    return runReviewCycle({
        vcs: {
            getPullRequestSnapshot: () => Promise.resolve({ ...makeSnapshot(headSha), changedFiles: [changedFile] }),
            materializeCoveragePatches: (files) => Promise.resolve([...files]),
            getFileContent: () => Promise.resolve(configContent),
            getCurrentHeadSha: () => Promise.resolve(headSha)
        },
        inputs: overrides.inputs ?? INPUTS,
        prNumber: 1,
        execution: 'github-action',
        force: false,
        forceOverBudget: overrides.forceOverBudget,
        confirmOverBudget: overrides.confirmOverBudget,
        runIntelligence: overrides.runIntelligence ?? fakeIntelligence(),
        createRuntime: overrides.createRuntime ?? (() => Promise.resolve(createMockRuntime()))
    });
}
