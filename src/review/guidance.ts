/* User guidance is untrusted intent: it focuses work but carries no authority.
   CLI and trigger parser build values here; prompt assembly serializes them. */

export const MAX_GUIDANCE_CHARS = 8000;

export type ReviewGuidanceSource = 'local-file' | 'trigger-comment';

export interface ReviewGuidance {
    source: ReviewGuidanceSource;
    trust: 'untrusted-user-guidance';
    text: string;
}

/* Provenance for prompts that must not receive raw text: coordinator and
   verifier learn only whether guidance existed and where it came from. */
export type ReviewGuidanceProvenance = { present: false } | { present: true; source: ReviewGuidanceSource };

export class GuidanceError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = 'GuidanceError';
    }
}

/* The `--instructions` file is user input: never trusted, and over-cap content
   errors instead of truncating silently. */
export function createLocalGuidance(content: string): ReviewGuidance | undefined {
    const text = content.trim();

    if (text === '') {
        return undefined;
    }

    if (text.length > MAX_GUIDANCE_CHARS) {
        throw new GuidanceError(
            `The --instructions file is ${text.length} characters, above the ${MAX_GUIDANCE_CHARS}-character review guidance limit.`
        );
    }

    return { source: 'local-file', trust: 'untrusted-user-guidance', text };
}

/* Trigger text is user input. Over-cap guidance is ignored with a warning so
   the review continues unchanged. */
export type TriggerGuidanceChoice =
    | { kind: 'none' }
    | { kind: 'accepted'; guidance: ReviewGuidance }
    | { kind: 'ignored'; warning: string };

export function chooseTriggerGuidance(text?: string): TriggerGuidanceChoice {
    const guidanceText = text?.trim() ?? '';

    if (guidanceText === '') {
        return { kind: 'none' };
    }

    if (guidanceText.length > MAX_GUIDANCE_CHARS) {
        return {
            kind: 'ignored',
            warning: `Ignoring review guidance from the trigger comment: it is ${guidanceText.length} characters, above the ${MAX_GUIDANCE_CHARS}-character limit. The review continues unchanged.`
        };
    }

    return {
        kind: 'accepted',
        guidance: { source: 'trigger-comment', trust: 'untrusted-user-guidance', text: guidanceText }
    };
}

/* Block name for a guidance source; stays distinct from the PR body and other
   untrusted blocks. */
export function guidanceBlockName(source: ReviewGuidanceSource): string {
    return `user-guidance:${source}`;
}

/* Human label for the final report: `none | local file | trigger comment`. */
export function guidanceSourceLabel(source?: ReviewGuidanceSource): string {
    if (source === 'local-file') {
        return 'local file';
    }

    if (source === 'trigger-comment') {
        return 'trigger comment';
    }

    return 'none';
}

export function reviewGuidanceProvenance(guidance?: ReviewGuidance): ReviewGuidanceProvenance {
    if (guidance === undefined) {
        return { present: false };
    }

    return { present: true, source: guidance.source };
}
