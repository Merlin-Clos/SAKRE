import { describe, expect, test } from 'bun:test';
import { parseOptions } from '../../scripts/benchmark-intelligence';

/* A mistyped benchmark invocation must fail instead of printing a
   plausible-looking report with empty statistics, and a valued option must
   never swallow the next option token. */
describe('benchmark option parser', () => {
    test('applies the documented defaults', () => {
        const options = parseOptions([]);
        expect(options.runs).toBe(5);
        expect(options.syntheticRuns).toBe(3);
        expect(options.synthetic).toEqual([200, 2000, 10_000]);
    });

    test('accepts positive counts and synthetic sizes', () => {
        const options = parseOptions(['--runs', '2', '--synthetic-runs', '1', '--synthetic', '10,200']);
        expect(options.runs).toBe(2);
        expect(options.syntheticRuns).toBe(1);
        expect(options.synthetic).toEqual([10, 200]);
    });

    test('disables the synthetic section only on --no-synthetic', () => {
        expect(parseOptions(['--no-synthetic']).synthetic).toEqual([]);
    });

    test('rejects invalid counts, option-like values and unknown options', () => {
        const invalid = [
            ['--runs', 'nope'],
            ['--runs', '0'],
            ['--runs', '1.5'],
            ['--runs'],
            ['--runs', '--synthetic'],
            ['--synthetic-runs', 'two'],
            ['--synthetic', '--no-synthetic'],
            ['--synthetic', '100,nope'],
            ['--frobnicate', 'x']
        ];

        for (const args of invalid) {
            expect(() => parseOptions(args)).toThrow();
        }

        expect(() => parseOptions(['--runs', 'nope'])).toThrow('--runs must be a positive integer');
        expect(() => parseOptions(['--synthetic', '--no-synthetic'])).toThrow('--synthetic requires a value');
    });
});
