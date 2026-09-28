import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { toFailure } from '../../src/review/step-failure';

describe('review step failure summaries', () => {
    test('summarizes repeated unsupported finding fields without serializing the Zod payload', () => {
        const findingSchema = z.strictObject({ title: z.string() });
        const schema = z.strictObject({ findings: z.array(findingSchema) });

        const error = schema.safeParse({
            findings: Array.from({ length: 7 }, (_unused, indexValue) => ({
                title: `Finding ${String(indexValue)}`,
                sourceIds: ['large-payload']
            }))
        });

        if (error.success) {
            throw new Error('Expected the fixture to fail validation.');
        }

        const failure = toFailure('conventions', error.error);
        expect(failure).toEqual({
            stage: 'conventions',
            kind: 'invalid-output',
            message: '7 returned finding(s) contained unsupported field(s): "sourceIds".'
        });
        expect(failure.message).not.toContain('large-payload');
        expect(failure.message.length).toBeLessThan(120);
    });

    test('summarizes other schema failures with their field path', () => {
        const error = z.object({ title: z.string() }).safeParse({ title: 42 });

        if (error.success) {
            throw new Error('Expected the fixture to fail validation.');
        }

        expect(toFailure('coordinator', error.error).message).toContain('title (invalid_type)');
    });
});
