import { describe, expect, test } from 'bun:test';
import { readSessionFailureEvent } from '../../src/engine/session';

/* The failure event is external data: the reader accepts only the two session
   failure types and narrows every field instead of casting. */
describe('engine session failure events', () => {
    test('reads the error from execution and step failure events', () => {
        expect(
            readSessionFailureEvent({
                type: 'session.execution.failed',
                data: { sessionID: 'ses_1', error: { type: 'provider.no-route', message: 'Model unavailable: x/y' } }
            })
        ).toEqual({ sessionID: 'ses_1', error: { type: 'provider.no-route', message: 'Model unavailable: x/y' } });

        expect(
            readSessionFailureEvent({
                type: 'session.step.failed',
                data: { sessionID: 'ses_2', error: { type: 'provider.auth', message: 'bad key', status: 401 } }
            })
        ).toEqual({ sessionID: 'ses_2', error: { type: 'provider.auth', message: 'bad key', status: 401 } });
    });

    test('defaults a missing message and keeps a numeric status', () => {
        expect(
            readSessionFailureEvent({
                type: 'session.execution.failed',
                data: { sessionID: 'ses', error: { type: 'provider.internal', status: 503 } }
            })
        ).toEqual({ sessionID: 'ses', error: { type: 'provider.internal', message: '', status: 503 } });
    });

    test('ignores unrelated and malformed events', () => {
        const missing: unknown = undefined;
        expect(readSessionFailureEvent(missing)).toBeUndefined();
        expect(readSessionFailureEvent('event')).toBeUndefined();
        expect(
            readSessionFailureEvent({ type: 'session.execution.succeeded', data: { sessionID: 'ses' } })
        ).toBeUndefined();
        expect(readSessionFailureEvent({ type: 'session.execution.failed' })).toBeUndefined();
        expect(readSessionFailureEvent({ type: 'session.execution.failed', data: {} })).toBeUndefined();
        expect(
            readSessionFailureEvent({
                type: 'session.execution.failed',
                data: { sessionID: 7, error: { type: 'x', message: '' } }
            })
        ).toBeUndefined();
        expect(
            readSessionFailureEvent({
                type: 'session.execution.failed',
                data: { sessionID: 'ses', error: { message: 'no type' } }
            })
        ).toBeUndefined();
        expect(
            readSessionFailureEvent({
                type: 'session.execution.failed',
                data: { sessionID: 'ses', error: { type: 7, message: 'no type' } }
            })
        ).toBeUndefined();
    });
});
