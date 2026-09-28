import { describe, expect, test } from 'bun:test';
import {
    engineSubmitToolNames,
    engineSubmitToolSpecs,
    readSubmission,
    submitToolForAgent
} from '../../src/engine/submit';

const FINDINGS = { summary: 'One review summary.', findings: [], usedContext7: false, context7Topics: [] };

// eslint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- tool input is an opaque payload stored in the fixture state; the message is stored opaquely in the list
function assistantWithTool(name: string, status: string, input: unknown): unknown {
    // eslint-disable-next-line anti-slop/no-known-value-widening -- assistant-message fixture; unknown return matches the message list
    return { type: 'assistant', content: [{ type: 'tool', name, state: { status, input } }] };
}

describe('engine submit tools', () => {
    test('maps agent ids to their role submit tool', () => {
        expect(submitToolForAgent('coordinator')).toBe(engineSubmitToolNames.coordination);
        expect(submitToolForAgent('verifier')).toBe(engineSubmitToolNames.verdict);
        expect(submitToolForAgent('correctness')).toBe(engineSubmitToolNames.findings);
        expect(submitToolForAgent('custom-role')).toBe(engineSubmitToolNames.findings);
    });

    test('builds one JSON Schema per role from the review contracts', () => {
        const specs = engineSubmitToolSpecs();

        expect(specs.map((spec) => spec.name)).toEqual([
            engineSubmitToolNames.findings,
            engineSubmitToolNames.coordination,
            engineSubmitToolNames.verdict
        ]);

        for (const spec of specs) {
            expect(spec.input.type).toBe('object');
            expect(spec.input.required).toBeDefined();
            expect(spec.description.length).toBeGreaterThan(0);
        }

        expect(specs[0]?.input.required).toContain('summary');
        expect(specs[1]?.input.required).toContain('findings');
        expect(specs[2]?.input.required).toContain('findingId');
    });

    test('returns the first completed submission for the expected tool', () => {
        const second = { ...FINDINGS, summary: 'Second.' };

        const messages = [
            assistantWithTool(engineSubmitToolNames.findings, 'completed', FINDINGS),
            assistantWithTool(engineSubmitToolNames.findings, 'completed', second)
        ];

        expect(readSubmission(messages, engineSubmitToolNames.findings)).toEqual(FINDINGS);
    });

    test('ignores failed calls, other tools and unknown shapes', () => {
        const messages = [
            assistantWithTool(engineSubmitToolNames.findings, 'error', { bad: true }),
            assistantWithTool(engineSubmitToolNames.coordination, 'completed', { summary: 'other tool' }),
            { type: 'assistant', content: [{ type: 'text', text: 'no tool here' }] },
            { type: 'user', text: 'not a message shape' },
            assistantWithTool(engineSubmitToolNames.findings, 'completed', FINDINGS)
        ];

        expect(readSubmission(messages, engineSubmitToolNames.findings)).toEqual(FINDINGS);
        expect(readSubmission(messages, engineSubmitToolNames.verdict)).toBeUndefined();
    });
});
