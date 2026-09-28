import { describe, expect, test } from 'bun:test';
import { classifyEngineError, engineErrorDetail } from '../../src/engine/failure';

/* Decision table ported from the deleted E1 runtime: the HTTP status is
   authoritative, the type/message heuristic only classifies errors that carry
   no status. */
describe('engine failure classification', () => {
    test('classifies by HTTP status before the error type', () => {
        expect(classifyEngineError({ type: 'forbidden_error', message: '', status: 401 })).toBe('provider-auth');
        expect(classifyEngineError({ type: 'forbidden_error', message: '', status: 403 })).toBe('provider-auth');
        expect(classifyEngineError({ type: 'overloaded_error', message: '', status: 429 })).toBe('rate-limit');
        expect(classifyEngineError({ type: 'api_error', message: '', status: 408 })).toBe('timeout');
        expect(classifyEngineError({ type: 'api_error', message: '', status: 504 })).toBe('timeout');
    });

    test('falls back to the type when no status is present', () => {
        expect(classifyEngineError({ type: 'authentication_error', message: '' })).toBe('provider-auth');
        expect(classifyEngineError({ type: 'rate_limit_error', message: '' })).toBe('rate-limit');
        expect(classifyEngineError({ type: 'request_timeout', message: '' })).toBe('timeout');
    });

    test('an unclassified error is a runtime failure', () => {
        expect(classifyEngineError({ type: 'unknown_error', message: '' })).toBe('runtime-failure');
        expect(classifyEngineError({ type: 'api_error', message: '', status: 500 })).toBe('runtime-failure');
    });

    test('builds a usable detail for status-only errors', () => {
        expect(engineErrorDetail({ type: 'api_error', message: 'boom', status: 500 })).toBe('boom');
        expect(engineErrorDetail({ type: 'api_error', message: '', status: 504 })).toBe(
            'Engine session failed with api_error (HTTP 504).'
        );
        expect(engineErrorDetail({ type: 'api_error', message: '' })).toBe('Engine session failed with api_error.');
    });

    test('preserves the upstream Zen Free authorization denial as provider auth, not missing local credentials', () => {
        const denial = { type: 'provider.auth', message: 'Free tier unavailable in this harness', status: 403 };
        expect(classifyEngineError(denial)).toBe('provider-auth');
        expect(engineErrorDetail(denial)).toBe(denial.message);
    });
});
