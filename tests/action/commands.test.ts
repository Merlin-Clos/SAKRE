import { describe, expect, test } from 'bun:test';
import { isAllowedAuthorAssociation, parseReviewCommand, resolveTriggerGuidance } from '../../src/action/commands';
import { MAX_GUIDANCE_CHARS } from '../../src/review/guidance';

const TRIGGER = '@sakre';

describe('review command parsing', () => {
    test('parses each exact supported command', () => {
        const commands = [
            [TRIGGER, 'review'],
            [`${TRIGGER} --diagnostic`, 'diagnostic'],
            [`${TRIGGER} --force`, 'review-force'],
            [`${TRIGGER} --force-over-budget`, 'review-force-over-budget']
        ] as const;

        for (const [comment, mode] of commands) {
            expect(parseReviewCommand(comment, TRIGGER)).toEqual({ mode });
        }
    });

    test('rejects lookalike commands while ignoring unrelated comments', () => {
        for (const comment of [`${TRIGGER} --unknown`, `${TRIGGER} extra`, `  ${TRIGGER}`, TRIGGER.toUpperCase()]) {
            expect(parseReviewCommand(comment, TRIGGER)).toEqual({ mode: 'invalid' });
        }

        for (const comment of ['/other-command', undefined]) {
            expect(parseReviewCommand(comment, TRIGGER)).toEqual({ mode: 'none' });
        }
    });

    test('retired triggers no longer start a review', () => {
        expect(parseReviewCommand('@sakre-review', TRIGGER)).toEqual({ mode: 'invalid' });
        expect(parseReviewCommand('@sakre-review --force', TRIGGER)).toEqual({ mode: 'invalid' });
        expect(parseReviewCommand('@klod-review', TRIGGER)).toEqual({ mode: 'none' });
        expect(parseReviewCommand('@klod-review --force', TRIGGER)).toEqual({ mode: 'none' });
    });

    test('keeps a bare command unchanged', () => {
        expect(parseReviewCommand(TRIGGER, TRIGGER)).toEqual({ mode: 'review' });
        expect(parseReviewCommand(`${TRIGGER} --force`, TRIGGER)).toEqual({ mode: 'review-force' });
        expect(parseReviewCommand(`${TRIGGER}\n`, TRIGGER)).toEqual({ mode: 'review' });
        expect(parseReviewCommand(`${TRIGGER}\r\n`, TRIGGER)).toEqual({ mode: 'review' });
    });

    test('turns text after the command line into trigger guidance', () => {
        expect(parseReviewCommand(`${TRIGGER}\nFocus on the migration path.`, TRIGGER)).toEqual({
            mode: 'review',
            guidance: 'Focus on the migration path.'
        });
        expect(parseReviewCommand(`${TRIGGER} --force\r\nCheck the rollback.`, TRIGGER)).toEqual({
            mode: 'review-force',
            guidance: 'Check the rollback.'
        });
    });

    test('parses flags only before the guidance boundary', () => {
        /* The first line is the command line: the flags after it are plain
           guidance text and can never change the run options. */
        const comment = `${TRIGGER} --force\n--force-over-budget\n--diagnostic\n--future-flag`;
        expect(parseReviewCommand(comment, TRIGGER)).toEqual({
            mode: 'review-force',
            guidance: '--force-over-budget\n--diagnostic\n--future-flag'
        });
    });

    test('keeps a flag-like first line without the exact command invalid', () => {
        expect(parseReviewCommand(`${TRIGGER} --force --diagnostic\nFocus.`, TRIGGER)).toEqual({
            mode: 'invalid'
        });
        expect(parseReviewCommand(`${TRIGGER} --force\nMore\n\nText.`, TRIGGER)).toEqual({
            mode: 'review-force',
            guidance: 'More\n\nText.'
        });
    });

    test('never extracts guidance from a comment that does not start with the trigger', () => {
        expect(parseReviewCommand(`Please review\n${TRIGGER}`, TRIGGER)).toEqual({ mode: 'none' });
        expect(parseReviewCommand(`Prefix ${TRIGGER}\nGuidance`, TRIGGER)).toEqual({ mode: 'none' });
    });
});

describe('author association checks', () => {
    test('allows only configured associations, case-insensitively', () => {
        const cases: [string | undefined, string[], boolean][] = [
            ['OWNER', ['owner'], true],
            ['contributor', ['COLLABORATOR'], false],
            [undefined, ['OWNER'], false],
            ['NONE', ['OWNER', 'MEMBER'], false]
        ];

        for (const [association, allowed, expected] of cases) {
            expect(isAllowedAuthorAssociation(association, allowed)).toBe(expected);
        }
    });
});

describe('trigger guidance policy', () => {
    test('accepts guidance on a review command', () => {
        const resolved = resolveTriggerGuidance(
            parseReviewCommand(`${TRIGGER} --force\nFocus on the migration.`, TRIGGER)
        );

        expect(resolved).toEqual({
            kind: 'accepted',
            guidance: {
                source: 'trigger-comment',
                trust: 'untrusted-user-guidance',
                text: 'Focus on the migration.'
            }
        });
    });

    test('ignores over-cap guidance with a warning instead of failing the command', () => {
        const resolved = resolveTriggerGuidance(
            parseReviewCommand(`${TRIGGER}\n${'x'.repeat(MAX_GUIDANCE_CHARS + 1)}`, TRIGGER)
        );

        if (resolved.kind !== 'ignored') {
            throw new Error(`Expected ignored guidance, got ${resolved.kind}.`);
        }

        expect(resolved.warning).toContain('Ignoring review guidance');
        expect(resolved.warning).toContain(String(MAX_GUIDANCE_CHARS + 1));
    });

    test('resolves no guidance for invalid, unrelated and bare commands', () => {
        expect(resolveTriggerGuidance(parseReviewCommand('unrelated', TRIGGER))).toEqual({ kind: 'none' });
        expect(resolveTriggerGuidance(parseReviewCommand(`${TRIGGER} --unknown`, TRIGGER))).toEqual({ kind: 'none' });
        expect(resolveTriggerGuidance(parseReviewCommand(TRIGGER, TRIGGER))).toEqual({ kind: 'none' });
    });
});
