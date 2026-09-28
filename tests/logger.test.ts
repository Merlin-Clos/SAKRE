import { describe, expect, test } from 'bun:test';
import {
    configureLogRedaction,
    configureLogSink,
    createLogger,
    createStreamLogSink,
    formatData,
    formatMessage,
    resetLogSink
} from '../src/logger';

describe('log redaction', () => {
    test('redacts explicitly configured secrets from messages and data', () => {
        configureLogRedaction(['super-secret-value-42']);

        const formatted = formatMessage('api', 'token is super-secret-value-42 ok', {
            nested: 'super-secret-value-42'
        });

        expect(formatted).not.toContain('super-secret-value-42');
        expect(formatted).toContain('[redacted]');
    });

    test('redacts well-known secret patterns without configuration', () => {
        configureLogRedaction([]);
        const formatted = formatMessage(undefined, 'github token ghp_Abcdefghijklmnopqrst leaked');
        expect(formatted).not.toContain('ghp_Abcdefghijklmnopqrst');
        expect(formatted).toContain('[redacted]');
    });

    test('redaction applies to error messages carried in log data', () => {
        configureLogRedaction([]);
        const formatted = formatData({ error: new Error('failed with sk-abcdefghijklmnop1234') });
        expect(formatted).not.toContain('sk-abcdefghijklmnop1234');
    });

    test('secrets are redacted even when the payload is truncated afterwards', () => {
        configureLogRedaction(['known-credential-value-777']);
        // eslint-disable-next-line anti-slop/no-known-value-widening -- mirrors the logger data contract; annotation keeps the payload open for padding fields
        const longData: Record<string, unknown> = { secret: 'known-credential-value-777' };

        for (let index = 0; index < 12; index += 1) {
            longData[`padding-field-${index}`] = 'x'.repeat(400);
        }

        const formatted = formatData(longData);
        expect(formatted.length).toBeLessThanOrEqual(2100);
        expect(formatted).not.toContain('known-credential-value-777');
        expect(formatted).toContain('[redacted]');
    });

    test('only secrets of at least eight characters are explicit credentials', () => {
        configureLogRedaction(['1234567', '12345678', '123456789']);
        expect(formatMessage(undefined, 'seven 1234567 end')).toContain('1234567');
        expect(formatMessage(undefined, 'seven 1234567 end')).not.toContain('[redacted]');
        expect(formatMessage(undefined, 'eight 12345678 end')).not.toContain('12345678');
        expect(formatMessage(undefined, 'eight 12345678 end')).toContain('[redacted]');
        expect(formatMessage(undefined, 'nine 123456789 end')).not.toContain('123456789');
    });
});

describe('logger formatMessage', () => {
    test('prefixes message with scope when provided', () => {
        const formatted = formatMessage('api', 'request started');
        expect(formatted).toBe('[api] request started');
    });

    test('returns message without scope when scope is undefined', () => {
        const formatted = formatMessage(undefined, 'bare message');
        expect(formatted).toBe('bare message');
    });

    test('appends JSON data suffix when data is provided', () => {
        const formatted = formatMessage('test', 'action', { count: 3 });
        expect(formatted).toBe('[test] action {"count":3}');
    });

    test('omits the suffix when data is absent or empty', () => {
        const payloads: (Record<string, unknown> | undefined)[] = [undefined, {}];

        for (const data of payloads) {
            expect(formatMessage('test', 'action', data)).toBe('[test] action');
        }
    });
});

describe('logger formatData', () => {
    test('returns an empty suffix for absent or empty data', () => {
        const payloads: (Record<string, unknown> | undefined)[] = [undefined, {}];

        for (const data of payloads) {
            expect(formatData(data)).toBe('');
        }
    });

    test('truncates strings longer than 500 characters', () => {
        const longString = 'a'.repeat(600);
        const result = formatData({ value: longString });
        expect(result).toContain('"value":"aaaa');
        expect(result).toContain('... [truncated 100 chars]"');
        expect(result).not.toContain('a'.repeat(600));
    });

    test('does not truncate strings shorter than 500 characters', () => {
        const shortString = 'a'.repeat(400);
        const result = formatData({ value: shortString });
        expect(result).toContain(shortString);
    });

    test('serializes Error objects with name, message, and stack', () => {
        const error = new Error('something broke');
        error.name = 'CustomError';
        const result = formatData({ error });
        expect(result).toContain('"name":"CustomError"');
        expect(result).toContain('"message":"something broke"');
        expect(result).toContain('"stack"');
    });

    test('truncates entire serialized output when exceeding 2000 characters', () => {
        const data: Record<string, unknown> = {};

        for (let index = 0; index < 100; index += 1) {
            data[`key${index}`] = 'x'.repeat(100);
        }

        const result = formatData(data);
        expect(result.length).toBeLessThan(2100);
        expect(result).toContain('... [truncated ');
    });

    test('handles circular reference gracefully by returning fallback', () => {
        // eslint-disable-next-line anti-slop/no-known-value-widening -- mirrors the logger data contract; annotation keeps the payload open for the self link
        const circular: Record<string, unknown> = { name: 'parent' };
        circular.self = circular;
        const result = formatData(circular);
        expect(result).toBe('{"logData":"[unserializable]"}');
    });
});

describe('logger formatData boundary cases', () => {
    test('keeps 500 characters intact and truncates only the excess at 501', () => {
        const exact = 'a'.repeat(500);
        // SAFETY: formatData serializes the { value } payload just built; JSON.parse inverts the helper's own output.
        const exactResult = JSON.parse(formatData({ value: exact })) as { value: string };
        expect(exactResult.value).toBe(exact);

        const suffix = '... [truncated 1 chars]';
        // SAFETY: formatData serializes the { value } payload just built; JSON.parse inverts the helper's own output.
        const overResult = JSON.parse(formatData({ value: `${exact}b` })) as { value: string };
        expect(overResult.value).toHaveLength(exact.length + suffix.length);
        expect(overResult.value.slice(0, exact.length)).toBe(exact);
        expect(overResult.value.slice(exact.length)).toBe(suffix);
    });
});

describe('default Action sink', () => {
    test('still emits a real GitHub error annotation for a production failure', () => {
        resetLogSink();
        const chunks: string[] = [];
        const originalWrite = process.stdout.write.bind(process.stdout);
        process.stdout.write = (chunk: string | Uint8Array): boolean => {
            // eslint-disable-next-line anti-slop/no-runtime-typeof -- stdout.write receives string|Uint8Array; narrows before capturing
            if (typeof chunk === 'string') {
                chunks.push(chunk);
            } else {
                chunks.push(Buffer.from(chunk).toString('utf8'));
            }

            return true;
        };

        try {
            createLogger('review').error('Review cycle failed');
        } finally {
            process.stdout.write = originalWrite;
        }

        const output = chunks.join('');
        expect(output).toContain('::error::');
        expect(output).toContain('Review cycle failed');
    });
});

describe('logger raw sink', () => {
    test('writes a payload larger than the data cap unchanged through the raw sink', () => {
        const chunks: string[] = [];

        // SAFETY: the raw sink only calls write; the fake captures chunks for the size assertion below.
        // eslint-disable-next-line anti-slop/no-chained-type-assertions -- sink fake implements only write; the chain bridges it to WritableStream
        const stream = {
            write: (chunk: string): boolean => {
                chunks.push(chunk);

                return true;
            }
        } as unknown as NodeJS.WritableStream;

        configureLogSink(createStreamLogSink(stream));
        const payload = `review-map:${'x'.repeat(6000)}`;

        try {
            createLogger('cli').raw(payload);
        } finally {
            resetLogSink();
        }

        const output = chunks.join('');
        expect(output).toContain(payload);
        expect(output).not.toContain('[truncated');
    });
});
