import { expect, test } from 'bun:test';
import type { getOctokit } from '@actions/github';
import { configureLogRedaction } from '../../src/logger';
import { type CommentTarget, postComment, updateComment } from '../../src/action/publish';

test('comment publication redacts known credentials before sending the body', async () => {
    const bodies: string[] = [];

    /* SAFETY: the fake implements only createComment/updateComment, the two methods this redaction case exercises. */
    // eslint-disable-next-line anti-slop/no-chained-type-assertions -- fake implements only the exercised methods; the chain bridges the partial fake to the SDK type
    const octokit = {
        rest: {
            issues: {
                createComment: (input: { body: string }) => {
                    bodies.push(input.body);

                    return Promise.resolve({ data: { id: 101 } });
                },
                updateComment: (input: { body: string }) => {
                    bodies.push(input.body);

                    return Promise.resolve({ data: { id: 101 } });
                }
            }
        }
    } as unknown as ReturnType<typeof getOctokit>;

    const target: CommentTarget = { octokit, repository: { owner: 'acme', repo: 'demo' }, issueNumber: 1 };

    configureLogRedaction(['comment-secret-value']);

    try {
        await postComment(target, 'summary: comment-secret-value');
        await updateComment({ target, commentId: 101, body: 'final: comment-secret-value' });
    } finally {
        configureLogRedaction([]);
    }

    expect(bodies).toEqual(['summary: [redacted]', 'final: [redacted]']);
});
