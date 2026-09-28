import { describeError } from '../errors';
import { createLogger } from '../logger';
import { type EngineSessionErrorInfo, type EngineSessionFailureEvent, readSessionFailureEvent } from './session';

const log = createLogger('engine');

/* Host client subset this class consumes, so tests can drive the subscription deterministically without a host. */
export interface EngineEventStream {
    subscribe: (options: { signal?: AbortSignal }) => AsyncIterable<unknown>;
}

/* The engine publishes the terminal failure of a session as a durable event,
   and the session message surface carries a provider error only on an assistant
   message. A request rejected before provider dispatch (unknown model, missing
   provider configuration) therefore leaves only the idle outcome, and the event
   is the sole carrier of the cause. One subscription per runtime records the
   first error per session. The stream is volatile by contract, so a stream that
   ends or drops the frame keeps the existing generic failure message. */
export class EngineFailureEvents {
    private readonly events: EngineEventStream;
    private readonly errors = new Map<string, EngineSessionErrorInfo>();
    private readonly waiters = new Map<string, (error: EngineSessionErrorInfo | undefined) => void>();
    private readonly abort = new AbortController();
    private broken = false;

    public constructor(events: EngineEventStream) {
        this.events = events;
        // eslint-disable-next-line anti-slop/no-unknown-parameters -- promise rejection is untyped; described via describeError below
        this.consume().catch((error: unknown) => {
            if (!this.abort.signal.aborted) {
                log.warn('Engine failure event stream ended; session error detail may be unavailable', {
                    error: describeError(error)
                });
            }
        });
    }

    /* Waits for the session failure event after the session settled. A recorded
       error resolves immediately; a broken stream never waits. */
    public waitFor(sessionId: string, timeoutMs: number): Promise<EngineSessionErrorInfo | undefined> {
        const recorded = this.errors.get(sessionId);

        if (recorded !== undefined || this.broken) {
            return Promise.resolve(recorded);
        }

        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.finishWaiter(sessionId, resolve);
            }, timeoutMs);

            this.waiters.set(sessionId, (error) => {
                clearTimeout(timer);
                resolve(error);
            });
        });
    }

    /* Session is gone: settle any waiter instead of leaving it on timeout,
       then drop its error so the map cannot grow. */
    public release(sessionId: string): void {
        const waiter = this.waiters.get(sessionId);
        this.errors.delete(sessionId);

        if (waiter !== undefined) {
            this.finishWaiter(sessionId, waiter);
        }
    }

    public stop(): void {
        this.abort.abort();
    }

    private finishWaiter(sessionId: string, waiter: (error: EngineSessionErrorInfo | undefined) => void): void {
        this.waiters.delete(sessionId);
        waiter(this.errors.get(sessionId));
    }

    private record(failure: EngineSessionFailureEvent): void {
        /* First error wins: the runtime never continues a session after a
           failure, so the first event is the terminal cause. */
        if (this.errors.has(failure.sessionID)) {
            return;
        }

        this.errors.set(failure.sessionID, failure.error);
        const waiter = this.waiters.get(failure.sessionID);

        if (waiter !== undefined) {
            this.finishWaiter(failure.sessionID, waiter);
        }
    }

    private async consume(): Promise<void> {
        try {
            for await (const event of this.events.subscribe({ signal: this.abort.signal })) {
                const failure = readSessionFailureEvent(event);

                if (failure !== undefined) {
                    this.record(failure);
                }
            }
        } finally {
            this.broken = true;

            for (const [sessionId, waiter] of this.waiters) {
                this.finishWaiter(sessionId, waiter);
            }
        }
    }
}
