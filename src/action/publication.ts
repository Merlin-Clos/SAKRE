import { buildFailureComment } from './state';

const FAILURE_COMMENT_TIMEOUT_MILLISECONDS = 10_000;

/* One optional capability: caller provides both progress create and final update,
   or none. Local runs publish without a trigger comment, so the field stays
   absent instead of a sentinel id. */
export interface ReviewPublication {
    triggerCommentId?: number;
    create: (body: string, signal?: AbortSignal) => Promise<number>;
    update: (commentId: number, body: string, signal?: AbortSignal) => Promise<void>;
}

/* Progress must not stay "in progress" after failure, and a publish failure must
   never hide the review error. */
export async function replaceProgressWithFailure(input: {
    publication: ReviewPublication | undefined;
    commentId: number;
    headSha: string;
    runId: string | undefined;
}): Promise<void> {
    const update = input.publication?.update;

    if (update === undefined) {
        return;
    }

    try {
        await update(
            input.commentId,
            buildFailureComment(input.headSha, input.runId),
            globalThis.AbortSignal.timeout(FAILURE_COMMENT_TIMEOUT_MILLISECONDS)
        );
    } catch {
        // Preserve the original review error; publication failure is secondary.
    }
}

export async function publishFinal(input: {
    commentId: number | undefined;
    body: string;
    signal: AbortSignal | undefined;
    publication: ReviewPublication | undefined;
}): Promise<void> {
    if (input.commentId === undefined || input.publication === undefined) {
        return;
    }

    await input.publication.update(input.commentId, input.body, input.signal);
}
