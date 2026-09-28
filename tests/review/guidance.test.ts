import { describe, expect, test } from 'bun:test';
import {
    chooseTriggerGuidance,
    createLocalGuidance,
    guidanceBlockName,
    GuidanceError,
    guidanceSourceLabel,
    MAX_GUIDANCE_CHARS,
    reviewGuidanceProvenance
} from '../../src/review/guidance';

describe('local file guidance', () => {
    test('builds untrusted local-file guidance from non-empty content', () => {
        expect(createLocalGuidance('Focus on the migration path.')).toEqual({
            source: 'local-file',
            trust: 'untrusted-user-guidance',
            text: 'Focus on the migration path.'
        });
    });

    test('treats empty and whitespace-only files as no guidance', () => {
        expect(createLocalGuidance('')).toBeUndefined();
        expect(createLocalGuidance('  \n\t ')).toBeUndefined();
    });

    test('accepts the cap exactly and rejects one character above it', () => {
        const atCap = 'x'.repeat(MAX_GUIDANCE_CHARS);
        expect(createLocalGuidance(atCap)?.text).toHaveLength(MAX_GUIDANCE_CHARS);
        expect(() => createLocalGuidance(`${atCap}x`)).toThrow(GuidanceError);
        expect(() => createLocalGuidance(`${atCap}x`)).toThrow(String(MAX_GUIDANCE_CHARS));
    });
});

describe('trigger comment guidance', () => {
    test('treats empty and absent text as no guidance', () => {
        expect(chooseTriggerGuidance()).toEqual({ kind: 'none' });
        expect(chooseTriggerGuidance('   ')).toEqual({ kind: 'none' });
    });

    test('accepts guidance at the cap as untrusted trigger-comment content', () => {
        const choice = chooseTriggerGuidance('x'.repeat(MAX_GUIDANCE_CHARS));

        if (choice.kind !== 'accepted') {
            throw new Error(`Expected accepted guidance, got ${choice.kind}.`);
        }

        expect(choice.guidance.source).toBe('trigger-comment');
        expect(choice.guidance.trust).toBe('untrusted-user-guidance');
    });

    test('ignores over-cap guidance with an explicit warning instead of failing', () => {
        const choice = chooseTriggerGuidance('x'.repeat(MAX_GUIDANCE_CHARS + 1));

        if (choice.kind !== 'ignored') {
            throw new Error(`Expected ignored guidance, got ${choice.kind}.`);
        }

        expect(choice.warning).toContain('Ignoring review guidance');
        expect(choice.warning).toContain(String(MAX_GUIDANCE_CHARS + 1));
        expect(choice.warning).toContain('continues unchanged');
        /* The warning names the size only: the comment text is never echoed. */
        expect(choice.warning).not.toContain('xxxx');
    });
});

describe('guidance provenance labels', () => {
    test('keeps local files and trigger comments in distinct blocks', () => {
        expect(guidanceBlockName('local-file')).toBe('user-guidance:local-file');
        expect(guidanceBlockName('trigger-comment')).toBe('user-guidance:trigger-comment');
    });

    test('renders the human labels of the final report', () => {
        expect(guidanceSourceLabel()).toBe('none');
        expect(guidanceSourceLabel('local-file')).toBe('local file');
        expect(guidanceSourceLabel('trigger-comment')).toBe('trigger comment');
    });

    test('reduces guidance to engine-owned present/source metadata', () => {
        expect(reviewGuidanceProvenance()).toEqual({ present: false });
        expect(
            reviewGuidanceProvenance({ source: 'local-file', trust: 'untrusted-user-guidance', text: 'secret' })
        ).toEqual({ present: true, source: 'local-file' });
    });
});
