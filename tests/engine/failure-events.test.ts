import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from 'bun:test';
import { Writable } from 'node:stream';
import { type EngineEventStream, EngineFailureEvents } from '../../src/engine/failure-events';
import { configureLogSink, createStreamLogSink, resetLogSink } from '../../src/logger';

/* Deterministic event stream: the test decides exactly when an event, the end
   of the stream, or a stream failure reaches the subscription, so no case
   depends on the production one-second grace wait. */
interface ControlledEventStream extends EngineEventStream {
    // eslint-disable-next-line anti-slop/no-unknown-parameters -- fake stream ingests engine events of any shape; cases push known fixtures
    push: (event: unknown) => Promise<void>;
    end: () => void;
    fail: (error: Error) => void;
}

function controlledEventStream(): ControlledEventStream {
    const queue: { event: unknown; processed: () => void }[] = [];
    let acknowledge: (() => void) | undefined = undefined;
    let resolveNext: ((result: IteratorResult<unknown>) => void) | undefined = undefined;
    let rejectNext: ((error: Error) => void) | undefined = undefined;
    let finished = false;
    let streamError: Error | undefined = undefined;

    function settle(): void {
        const resolve = resolveNext;

        if (resolve === undefined || (streamError === undefined && queue.length === 0 && !finished)) {
            return;
        }

        const reject = rejectNext;
        resolveNext = undefined;
        rejectNext = undefined;

        if (streamError !== undefined) {
            reject?.(streamError);

            return;
        }

        const next = queue.shift();

        if (next !== undefined) {
            acknowledge = next.processed;
            resolve({ value: next.event, done: false });

            return;
        }

        if (finished) {
            resolve({ value: undefined, done: true });
        }
    }

    const stream: ControlledEventStream = {
        push: (event) =>
            new Promise((resolve) => {
                queue.push({ event, processed: resolve });
                settle();
            }),
        end: () => {
            finished = true;
            settle();
        },
        fail: (error) => {
            streamError = error;
            finished = true;
            settle();
        },
        subscribe: (options) => {
            options.signal?.addEventListener(
                'abort',
                () => {
                    finished = true;
                    settle();
                },
                { once: true }
            );

            return {
                [Symbol.asyncIterator]() {
                    return {
                        next: () => {
                            /* Asking for the next event proves the previous one
                               has passed through the consumer's loop body. */
                            acknowledge?.();
                            acknowledge = undefined;

                            return new Promise<IteratorResult<unknown>>((resolve, reject) => {
                                resolveNext = resolve;
                                rejectNext = reject;
                                settle();
                            });
                        }
                    };
                }
            };
        }
    };

    return stream;
}

// eslint-disable-next-line anti-slop/no-unknown-returns -- failure payload matches the fake stream's untyped intake
function failureEvent(sessionID: string, type: string, message: string): unknown {
    // eslint-disable-next-line anti-slop/no-known-value-widening -- failure-event fixture; unknown return matches the fake stream intake
    return { type: 'session.execution.failed', data: { sessionID, error: { type, message } } };
}

const subscriptions: EngineFailureEvents[] = [];

interface FailureEventsHarness {
    stream: ControlledEventStream;
    events: EngineFailureEvents;
}

function startFailureEvents(): FailureEventsHarness {
    const stream = controlledEventStream();
    const events = new EngineFailureEvents(stream);
    subscriptions.push(events);

    return { stream, events };
}

async function expectTimeout(stream: ControlledEventStream, events: EngineFailureEvents): Promise<void> {
    let settled = false;

    const pending = events.waitFor('ses_1', 5000).then((error) => {
        settled = true;

        return error;
    });

    jest.advanceTimersByTime(4999);
    await stream.push({ type: 'unrelated-event' });
    expect(settled).toBe(false);
    jest.advanceTimersByTime(1);
    expect(await pending).toBeUndefined();
}

describe('engine failure events', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        for (const events of subscriptions.splice(0)) {
            events.stop();
        }

        jest.clearAllTimers();
        jest.useRealTimers();
    });

    beforeAll(() => {
        /* A stream failure legitimately logs a warning; keep it out of the test
           output so a green run emits no workflow annotation. */
        configureLogSink(
            createStreamLogSink(
                new Writable({
                    write: (_chunk, _encoding, callback): void => {
                        callback();
                    }
                })
            )
        );
    });

    afterAll(() => {
        resetLogSink();
    });

    test('returns an error recorded before waitFor', async () => {
        const { stream, events } = startFailureEvents();
        await stream.push(failureEvent('ses_1', 'provider.no-route', 'Model unavailable: a/b'));

        expect(await events.waitFor('ses_1', 5000)).toEqual({
            type: 'provider.no-route',
            message: 'Model unavailable: a/b'
        });
    });

    test('resolves each waiter with its own session failure', async () => {
        const { stream, events } = startFailureEvents();
        let firstSettled = false;

        const first = events.waitFor('ses_1', 5000).then((error) => {
            firstSettled = true;

            return error;
        });

        const second = events.waitFor('ses_2', 5000);

        await stream.push(failureEvent('ses_2', 'provider.no-route', 'second'));
        expect(await second).toMatchObject({ message: 'second' });
        expect(firstSettled).toBe(false);

        await stream.push(failureEvent('ses_1', 'provider.no-route', 'first'));
        expect(await first).toMatchObject({ message: 'first' });
    });

    test('times out with undefined when no failure event arrives', async () => {
        const { stream, events } = startFailureEvents();
        await expectTimeout(stream, events);
    });

    test('resolves pending waiters when the stream ends, without the timeout', async () => {
        const { stream, events } = startFailureEvents();
        const pending = events.waitFor('ses_1', 5000);

        stream.end();

        expect(await pending).toBeUndefined();
        expect(jest.getTimerCount()).toBe(0);
    });

    test('resolves pending waiters when the stream fails', async () => {
        const { stream, events } = startFailureEvents();
        const pending = events.waitFor('ses_1', 5000);

        stream.fail(new Error('stream closed'));

        expect(await pending).toBeUndefined();
    });

    test('release settles a pending waiter without the timeout', async () => {
        const { events } = startFailureEvents();
        const pending = events.waitFor('ses_1', 5000);

        events.release('ses_1');

        expect(await pending).toBeUndefined();
        expect(jest.getTimerCount()).toBe(0);
    });

    test('release clears the recorded session error', async () => {
        const { stream, events } = startFailureEvents();
        await stream.push(failureEvent('ses_1', 'provider.no-route', 'released'));

        events.release('ses_1');

        await expectTimeout(stream, events);
    });

    test('keeps the first error for a session', async () => {
        const { stream, events } = startFailureEvents();
        await stream.push(failureEvent('ses_1', 'provider.first', 'first'));
        await stream.push(failureEvent('ses_1', 'provider.second', 'second'));

        expect(await events.waitFor('ses_1', 5000)).toMatchObject({ type: 'provider.first' });
    });
});
