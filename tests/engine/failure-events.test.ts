import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Writable } from 'node:stream';
import { type EngineEventStream, EngineFailureEvents } from '../../src/engine/failure-events';
import { configureLogSink, createStreamLogSink, resetLogSink } from '../../src/logger';

/* Deterministic event stream: the test decides exactly when an event, the end
   of the stream, or a stream failure reaches the subscription, so no case
   depends on the production one-second grace wait. */
interface ControlledEventStream extends EngineEventStream {
    // eslint-disable-next-line anti-slop/no-unknown-parameters -- fake stream ingests engine events of any shape; cases push known fixtures
    push: (event: unknown) => void;
    end: () => void;
    fail: (error: Error) => void;
}

function controlledEventStream(): ControlledEventStream {
    const queue: unknown[] = [];
    let resolveNext: ((result: IteratorResult<unknown>) => void) | undefined = undefined;
    let rejectNext: ((error: Error) => void) | undefined = undefined;
    let finished = false;
    let streamError: Error | undefined = undefined;

    function settle(): void {
        const resolve = resolveNext;
        const reject = rejectNext;
        resolveNext = undefined;
        rejectNext = undefined;

        if (streamError !== undefined) {
            reject?.(streamError);

            return;
        }

        if (queue.length > 0) {
            resolve?.({ value: queue.shift(), done: false });

            return;
        }

        if (finished) {
            resolve?.({ value: undefined, done: true });
        }
    }

    const stream: ControlledEventStream = {
        push: (event) => {
            queue.push(event);
            settle();
        },
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
                            if (queue.length > 0) {
                                return Promise.resolve({ value: queue.shift(), done: false });
                            }

                            if (streamError !== undefined) {
                                return Promise.reject(streamError);
                            }

                            if (finished) {
                                return Promise.resolve({ value: undefined, done: true });
                            }

                            return new Promise<IteratorResult<unknown>>((resolve, reject) => {
                                resolveNext = resolve;
                                rejectNext = reject;
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

function flush(): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, 0);
    });
}

describe('engine failure events', () => {
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
        const stream = controlledEventStream();
        const events = new EngineFailureEvents(stream);
        stream.push(failureEvent('ses_1', 'provider.no-route', 'Model unavailable: a/b'));
        await flush();

        expect(await events.waitFor('ses_1', 5000)).toEqual({
            type: 'provider.no-route',
            message: 'Model unavailable: a/b'
        });
        events.stop();
    });

    test('resolves each waiter with its own session failure', async () => {
        const stream = controlledEventStream();
        const events = new EngineFailureEvents(stream);
        const first = events.waitFor('ses_1', 5000);
        const second = events.waitFor('ses_2', 5000);

        stream.push(failureEvent('ses_2', 'provider.no-route', 'second'));
        expect(await second).toMatchObject({ message: 'second' });

        let firstSettled = false;
        first
            .then(() => {
                firstSettled = true;
            })
            .catch(() => {
                // The rejection is asserted below.
            });
        await flush();
        expect(firstSettled).toBe(false);

        stream.push(failureEvent('ses_1', 'provider.no-route', 'first'));
        expect(await first).toMatchObject({ message: 'first' });
        events.stop();
    });

    test('times out with undefined when no failure event arrives', async () => {
        const stream = controlledEventStream();
        const events = new EngineFailureEvents(stream);
        expect(await events.waitFor('ses_1', 20)).toBeUndefined();
        events.stop();
    });

    test('resolves pending waiters when the stream ends, without the timeout', async () => {
        const stream = controlledEventStream();
        const events = new EngineFailureEvents(stream);
        const started = Date.now();
        const pending = events.waitFor('ses_1', 5000);

        stream.end();

        expect(await pending).toBeUndefined();
        expect(Date.now() - started).toBeLessThan(1000);
    });

    test('resolves pending waiters when the stream fails', async () => {
        const stream = controlledEventStream();
        const events = new EngineFailureEvents(stream);
        const pending = events.waitFor('ses_1', 5000);

        stream.fail(new Error('stream closed'));

        expect(await pending).toBeUndefined();
    });

    test('release settles a pending waiter without the timeout', async () => {
        const stream = controlledEventStream();
        const events = new EngineFailureEvents(stream);
        const started = Date.now();
        const pending = events.waitFor('ses_1', 5000);

        events.release('ses_1');

        expect(await pending).toBeUndefined();
        expect(Date.now() - started).toBeLessThan(1000);
        events.stop();
    });

    test('release clears the recorded session error', async () => {
        const stream = controlledEventStream();
        const events = new EngineFailureEvents(stream);
        stream.push(failureEvent('ses_1', 'provider.no-route', 'released'));
        await flush();

        events.release('ses_1');

        expect(await events.waitFor('ses_1', 20)).toBeUndefined();
        events.stop();
    });

    test('keeps the first error for a session', async () => {
        const stream = controlledEventStream();
        const events = new EngineFailureEvents(stream);
        stream.push(failureEvent('ses_1', 'provider.first', 'first'));
        stream.push(failureEvent('ses_1', 'provider.second', 'second'));
        await flush();

        expect(await events.waitFor('ses_1', 5000)).toMatchObject({ type: 'provider.first' });
        events.stop();
    });
});
