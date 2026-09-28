import { chooseTriggerGuidance, type TriggerGuidanceChoice } from '../review/guidance';

const reviewCommandIds = ['review', 'review-force', 'review-force-over-budget', 'diagnostic'] as const;

type ReviewCommandId = (typeof reviewCommandIds)[number];

type ParsedCommand = { mode: ReviewCommandId; guidance?: string } | { mode: 'invalid' } | { mode: 'none' };

const DIAGNOSTIC_FLAG = '--diagnostic';

const FORCE_FLAG = '--force';

const FORCE_OVER_BUDGET_FLAG = '--force-over-budget';

/* Only the trigger command line is parsed for flags. Text after the first line
   break is untrusted guidance, never reparsed for flags. Commands must match
   exactly; near-misses get help, other comments are ignored. */
function parseReviewCommand(commentBody: string | undefined, triggerCommand: string): ParsedCommand {
    if (commentBody === undefined) {
        return { mode: 'none' };
    }

    const commandLine = firstLine(commentBody);
    const matched = exactCommands(triggerCommand).get(commandLine);

    if (matched === undefined) {
        if (looksLikeTrigger(commandLine, triggerCommand)) {
            return { mode: 'invalid' };
        }

        return { mode: 'none' };
    }

    return withGuidance(matched, commentBody);
}

function withGuidance(mode: ReviewCommandId, commentBody: string): ParsedCommand {
    const guidance = guidanceAfterCommandLine(commentBody);

    if (guidance === undefined) {
        return { mode };
    }

    return { mode, guidance };
}

function exactCommands(triggerCommand: string): Map<string, ReviewCommandId> {
    return new Map<string, ReviewCommandId>([
        [triggerCommand, 'review'],
        [`${triggerCommand} ${DIAGNOSTIC_FLAG}`, 'diagnostic'],
        [`${triggerCommand} ${FORCE_FLAG}`, 'review-force'],
        [`${triggerCommand} ${FORCE_OVER_BUDGET_FLAG}`, 'review-force-over-budget']
    ]);
}

function firstLine(commentBody: string): string {
    const lineEnd = commentBody.indexOf('\n');

    if (lineEnd === -1) {
        return commentBody.replace(/\r$/u, '');
    }

    return commentBody.slice(0, lineEnd).replace(/\r$/u, '');
}

function guidanceAfterCommandLine(commentBody: string): string | undefined {
    const lineEnd = commentBody.indexOf('\n');

    if (lineEnd === -1) {
        return undefined;
    }

    const text = commentBody
        .slice(lineEnd + 1)
        .replaceAll('\r\n', '\n')
        .trim();

    if (text === '') {
        return undefined;
    }

    return text;
}

/* Over-cap trigger guidance is ignored with a warning, never by aborting. */
function resolveTriggerGuidance(command: ParsedCommand): TriggerGuidanceChoice {
    if (command.mode === 'none' || command.mode === 'invalid') {
        return { kind: 'none' };
    }

    return chooseTriggerGuidance(command.guidance);
}

function looksLikeTrigger(commentBody: string, triggerCommand: string): boolean {
    return commentBody.trim().toLowerCase().startsWith(triggerCommand.toLowerCase());
}

function isAllowedAuthorAssociation(authorAssociation: string | undefined, allowedAssociations: string[]): boolean {
    if (authorAssociation === undefined) {
        return false;
    }

    const normalized = authorAssociation.toUpperCase();

    return allowedAssociations.some((allowed) => allowed.toUpperCase() === normalized);
}

export type { ParsedCommand, ReviewCommandId };

export { isAllowedAuthorAssociation, parseReviewCommand, resolveTriggerGuidance, reviewCommandIds };
