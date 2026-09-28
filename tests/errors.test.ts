import { describe, expect, test } from 'bun:test';
import { asError, describeError } from '../src/errors';

describe('describeError', () => {
    test('returns the message of an Error or of a plain tagged error object', () => {
        expect(describeError(new Error('boom'))).toBe('boom');
        expect(describeError({ _tag: 'InstructionEntryValueTooLargeError', message: 'too large' })).toBe('too large');
    });

    test('stringifies values without a message', () => {
        const missing: unknown = undefined;
        expect(describeError('plain')).toBe('plain');
        expect(describeError(missing)).toBe('undefined');
        expect(describeError({ message: 42 })).toBe('[object Object]');
    });

    test('asError wraps non-Error values with the same message policy', () => {
        const original = new Error('kept');
        expect(asError(original)).toBe(original);
        expect(asError({ message: 'wrapped' }).message).toBe('wrapped');
    });
});
