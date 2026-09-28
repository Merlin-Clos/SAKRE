import { describe, expect, test } from 'bun:test';
import type { getOctokit } from '@actions/github';
import { GitHubVcs, selectReviewComments } from '../../src/vcs/github';
import { METADATA_COMMENT_MARKER, REVIEW_COMMENT_MARKER } from '../../src/identity';
import { rejectionOf } from '../helpers/rejection';

interface FakeContentEntry {
    readonly content?: string;
    readonly type?: string;
    readonly error?: true;
    readonly reject?: unknown;
    readonly raw?: unknown;
}

interface FakePullOverride {
    readonly body?: string | null;
    readonly user?: { login?: string | null } | null;
}

interface FakeOctokitState {
    readonly files: readonly Readonly<Record<string, readonly unknown[]>>[];
    readonly comments: readonly Readonly<Record<string, unknown>>[];
    readonly contents: Readonly<Record<string, FakeContentEntry>>;
    readonly onGetContent?: (params: Readonly<Record<string, unknown>>) => void;
    readonly pull?: FakePullOverride;
}

function notFoundError(): Error {
    const error = new Error('Not Found');
    Object.assign(error, { status: 404 });

    return error;
}

function pullBody(state: Readonly<FakeOctokitState>): string | null {
    if (state.pull !== undefined && 'body' in state.pull) {
        // SAFETY: the 'body' in state.pull check above establishes the field before reading.
        return state.pull.body as string | null;
    }

    return 'Implements auth.';
}

function pullUser(state: Readonly<FakeOctokitState>): { login?: string | null } | null {
    if (state.pull !== undefined && 'user' in state.pull && state.pull.user !== undefined) {
        return state.pull.user;
    }

    return { login: 'alice' };
}

function createOctokit(state: Readonly<FakeOctokitState>): ReturnType<typeof getOctokit> {
    const octokit = {
        rest: {
            pulls: {
                get: (params: Readonly<Record<string, unknown>>): Promise<{ data: Record<string, unknown> }> =>
                    Promise.resolve({
                        data: {
                            number: params.pull_number,
                            title: 'Add login endpoint',
                            body: pullBody(state),
                            user: pullUser(state),
                            base: { ref: 'main', sha: 'a'.repeat(40) },
                            head: { ref: 'feature', sha: 'f'.repeat(40) }
                        }
                    }),
                listFiles: (params: Readonly<Record<string, unknown>>): Promise<{ data: unknown[] }> =>
                    Promise.resolve({ data: [], params })
            },
            issues: {
                listComments: (params: Readonly<Record<string, unknown>>): Promise<{ data: unknown[] }> =>
                    Promise.resolve({ data: [], params }),
                createComment: (params: Readonly<Record<string, unknown>>): Promise<{ data: unknown }> =>
                    Promise.resolve({ data: {}, params })
            },
            repos: {
                getContent: (params: Readonly<Record<string, unknown>>): Promise<{ data: unknown }> => {
                    state.onGetContent?.(params);
                    const key = String(params.path);
                    const entry = state.contents[key];

                    if (entry === undefined) {
                        return Promise.reject(notFoundError());
                    }

                    if (entry.reject !== undefined) {
                        /* The fake mirrors a hostile API: string, null and
                           status-less rejections must surface as wrapped
                           errors, never as silent absence. */
                        // eslint-disable-next-line typescript/prefer-promise-reject-errors -- hostile API shape under test
                        return Promise.reject(entry.reject);
                    }

                    if (entry.error === true) {
                        return Promise.reject(notFoundError());
                    }

                    if (entry.raw !== undefined) {
                        return Promise.resolve({ data: entry.raw });
                    }

                    return Promise.resolve({ data: { type: entry.type, content: entry.content } });
                }
            }
        },
        // eslint-disable-next-line anti-slop/no-unknown-parameters -- fake paginate receives the SDK method reference and compares it by identity; parameters recorded per call
        paginate: (method: unknown, params: Readonly<Record<string, unknown>>): Promise<readonly unknown[]> => {
            if (method === octokit.rest.pulls.listFiles) {
                return Promise.resolve(
                    state.files.flatMap(
                        (page: Readonly<Record<string, readonly unknown[]>>) => page[String(params.pull_number)] ?? []
                    )
                );
            }

            if (method === octokit.rest.issues.listComments) {
                return Promise.resolve(state.comments);
            }

            return Promise.resolve([]);
        }
    };

    // SAFETY: the fake implements the pulls/issues/repos/paginate calls this suite exercises; paginate dispatches on the recorded method.
    // eslint-disable-next-line anti-slop/no-chained-type-assertions -- fake implements only the exercised methods; the chain bridges the partial fake to the SDK type
    return octokit as unknown as ReturnType<typeof getOctokit>;
}

const REPOSITORY = { owner: 'acme', repo: 'widget' };

describe('GitHub VCS adapter mapping', () => {
    test('maps pull request, paginated files and trusted comments to internal contracts', async () => {
        const state: FakeOctokitState = {
            files: [
                {
                    7: [
                        {
                            filename: 'src/new.ts',
                            status: 'added',
                            additions: 10,
                            deletions: 0,
                            patch: '@@ -0,0 +1 @@'
                        },
                        {
                            filename: 'src/renamed.ts',
                            previous_filename: 'src/old.ts',
                            status: 'renamed',
                            additions: 2,
                            deletions: 2
                        }
                    ]
                },
                { 7: [{ filename: 'docs/readme.md', status: 'modified', additions: 1, deletions: 1 }] }
            ],
            comments: [
                { id: 2, body: 'user noise', created_at: '2026-09-02T10:00:00Z', user: { type: 'User' } },
                {
                    id: 3,
                    body: '<!-- sakre-review --> <!-- sakre-metadata {} -->',
                    created_at: '2026-09-01T10:00:00Z',
                    user: { type: 'Bot', login: 'github-actions[bot]' }
                },
                {
                    id: 4,
                    body: '<!-- sakre-review --> <!-- sakre-metadata {} -->',
                    created_at: '2026-09-02T09:00:00Z',
                    user: { type: 'Bot', login: 'github-actions[bot]' }
                },
                {
                    id: 5,
                    body: '<!-- sakre-review --> <!-- sakre-metadata {} -->',
                    created_at: '2026-09-03T09:00:00Z',
                    user: { type: 'Bot', login: 'another-automation[bot]' }
                }
            ],
            contents: {}
        };

        const vcs = new GitHubVcs({ octokit: createOctokit(state), repository: REPOSITORY });
        const snapshot = await vcs.getPullRequestSnapshot(7);

        expect(snapshot.pullRequest.title).toBe('Add login endpoint');
        expect(snapshot.pullRequest.baseSha).toBe('a'.repeat(40));
        expect(snapshot.pullRequest.body).toBe('Implements auth.');
        expect(snapshot.pullRequest.authorLogin).toBe('alice');
        expect(snapshot.changedFiles).toHaveLength(3);
        expect(snapshot.changedFiles[0]).toMatchObject({ path: 'src/new.ts', status: 'added', additions: 10 });
        expect(snapshot.changedFiles[1]).toMatchObject({ path: 'src/renamed.ts', previousPath: 'src/old.ts' });
        expect(snapshot.comments).toHaveLength(2);
        expect(snapshot.comments[0]?.id).toBe(4);
        expect(snapshot.comments[0]?.authorType).toBe('Bot');
        expect(snapshot.comments[0]?.body).toContain(REVIEW_COMMENT_MARKER);
        expect(snapshot.comments[0]?.body).toContain(METADATA_COMMENT_MARKER);
    });

    test('defaults a missing pull request body and author to empty and unknown', async () => {
        const state: FakeOctokitState = {
            files: [],
            comments: [],
            contents: {},
            pull: { body: null, user: null }
        };

        const vcs = new GitHubVcs({ octokit: createOctokit(state), repository: REPOSITORY });
        const snapshot = await vcs.getPullRequestSnapshot(7);
        expect(snapshot.pullRequest.body).toBe('');
        expect(snapshot.pullRequest.authorLogin).toBe('unknown');
    });

    test('maps every known file status and falls back to modified', async () => {
        const state: FakeOctokitState = {
            files: [
                {
                    7: [
                        { filename: 'src/a.ts', status: 'added', additions: 1, deletions: 0 },
                        { filename: 'src/m.ts', status: 'modified', additions: 1, deletions: 1 },
                        { filename: 'src/r.ts', status: 'removed', additions: 0, deletions: 1 },
                        { filename: 'src/n.ts', status: 'renamed', additions: 1, deletions: 1 },
                        { filename: 'src/bogus.ts', status: 'bogus', additions: 1, deletions: 0 }
                    ]
                }
            ],
            comments: [],
            contents: {}
        };

        const vcs = new GitHubVcs({ octokit: createOctokit(state), repository: REPOSITORY });
        const snapshot = await vcs.getPullRequestSnapshot(7);
        const byPath = new Map(snapshot.changedFiles.map((file) => [file.path, file.status]));
        expect(byPath.get('src/a.ts')).toBe('added');
        expect(byPath.get('src/m.ts')).toBe('modified');
        expect(byPath.get('src/r.ts')).toBe('removed');
        expect(byPath.get('src/n.ts')).toBe('renamed');
        expect(byPath.get('src/bogus.ts')).toBe('modified');
    });

    test('honors a custom expected bot login', () => {
        const botBody = `<!-- ${REVIEW_COMMENT_MARKER} --> <!-- ${METADATA_COMMENT_MARKER} {} -->`;

        const comments = [
            {
                id: 20,
                body: botBody,
                created_at: '2026-09-03T10:00:00Z',
                user: { type: 'Bot', login: 'github-actions[bot]' }
            },
            {
                id: 21,
                body: botBody,
                created_at: '2026-09-03T11:00:00Z',
                user: { type: 'Bot', login: 'other-bot[bot]' }
            }
        ];

        expect(selectReviewComments(comments, 'other-bot[bot]').map((comment) => comment.id)).toEqual([21]);
    });

    test('caps review history at the ten newest comments', () => {
        const botBody = `<!-- ${REVIEW_COMMENT_MARKER} --> <!-- ${METADATA_COMMENT_MARKER} {} -->`;

        const comments = Array.from({ length: 12 }, (_unused, index) => ({
            id: 100 + index,
            body: botBody,
            created_at: `2026-09-${String(index + 1).padStart(2, '0')}T10:00:00Z`,
            user: { type: 'Bot', login: 'github-actions[bot]' }
        }));

        const selected = selectReviewComments(comments, 'github-actions[bot]');
        expect(selected).toHaveLength(10);
        expect(selected[0]?.id).toBe(111);
        expect(selected[9]?.id).toBe(102);
    });

    test('maps the patch union for present, API-omitted and binary files', async () => {
        const patch = '@@ -0,0 +1 @@';

        const state: FakeOctokitState = {
            files: [
                {
                    7: [
                        { filename: 'src/new.ts', status: 'added', additions: 10, deletions: 0, patch },
                        /* GitHub omits `patch` for a text diff too large to inline:
                           the line counts prove reviewable content exists. */
                        { filename: 'src/large.ts', status: 'modified', additions: 5000, deletions: 2 },
                        { filename: 'src/shrunk.ts', status: 'modified', additions: 2, deletions: 5000 },
                        { filename: 'assets/logo.png', status: 'added', additions: 0, deletions: 0 }
                    ]
                }
            ],
            comments: [],
            contents: {}
        };

        const vcs = new GitHubVcs({ octokit: createOctokit(state), repository: REPOSITORY });
        const snapshot = await vcs.getPullRequestSnapshot(7);
        const byPath = new Map(snapshot.changedFiles.map((file) => [file.path, file]));

        expect(byPath.get('src/new.ts')?.patch).toEqual({ state: 'retained', chars: patch.length, content: patch });
        expect(byPath.get('src/large.ts')?.patch).toEqual({ state: 'unavailable' });
        expect(byPath.get('src/shrunk.ts')?.patch).toEqual({ state: 'unavailable' });
        expect(byPath.get('assets/logo.png')?.patch).toEqual({ state: 'none' });

        const materialized = await vcs.materializeCoveragePatches(snapshot.changedFiles, new Map());
        expect(materialized).toEqual(snapshot.changedFiles);
    });

    test('reads protected files at the requested ref and decodes base64 content', async () => {
        const encoded = Buffer.from('provider: anthropic\n', 'utf8').toString('base64');
        const requests: Readonly<Record<string, unknown>>[] = [];

        const state: FakeOctokitState = {
            files: [],
            comments: [],
            contents: { '.github/sakre.yml': { type: 'file', content: encoded } },
            onGetContent: (params) => {
                requests.push(params);
            }
        };

        const vcs = new GitHubVcs({ octokit: createOctokit(state), repository: REPOSITORY });
        const ref = 'a'.repeat(40);
        const content = await vcs.getFileContent('.github/sakre.yml', ref);
        expect(content).toBe('provider: anthropic\n');
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({ path: '.github/sakre.yml', ref });
    });

    test('treats a missing protected file as absent without failing', async () => {
        const state: FakeOctokitState = {
            files: [],
            comments: [],
            contents: { '.github/sakre.yml': { error: true } }
        };

        const vcs = new GitHubVcs({ octokit: createOctokit(state), repository: REPOSITORY });
        expect(await vcs.getFileContent('.github/sakre.yml', 'a'.repeat(40))).toBeNull();
    });

    test('rejects non-file protected responses without decoding', async () => {
        const encoded = Buffer.from('provider: anthropic\n', 'utf8').toString('base64');
        const ref = 'a'.repeat(40);

        const directory: FakeOctokitState = {
            files: [],
            comments: [],
            contents: { '.github/sakre.yml': { raw: { type: 'dir' } } }
        };

        expect(
            await new GitHubVcs({ octokit: createOctokit(directory), repository: REPOSITORY }).getFileContent(
                '.github/sakre.yml',
                ref
            )
        ).toBeNull();

        const listing: FakeOctokitState = {
            files: [],
            comments: [],
            contents: { '.github/sakre.yml': { raw: [{ type: 'file' }] } }
        };

        expect(
            await new GitHubVcs({ octokit: createOctokit(listing), repository: REPOSITORY }).getFileContent(
                '.github/sakre.yml',
                ref
            )
        ).toBeNull();

        const missingContent: FakeOctokitState = {
            files: [],
            comments: [],
            contents: { '.github/sakre.yml': { raw: { type: 'file' } } }
        };

        expect(
            await new GitHubVcs({ octokit: createOctokit(missingContent), repository: REPOSITORY }).getFileContent(
                '.github/sakre.yml',
                ref
            )
        ).toBeNull();

        const valid: FakeOctokitState = {
            files: [],
            comments: [],
            contents: { '.github/sakre.yml': { type: 'file', content: encoded } }
        };

        expect(
            await new GitHubVcs({ octokit: createOctokit(valid), repository: REPOSITORY }).getFileContent(
                '.github/sakre.yml',
                ref
            )
        ).toBe('provider: anthropic\n');
    });

    test('rejects review comments that forge only part of the trust tuple', () => {
        const both = `<!-- ${REVIEW_COMMENT_MARKER} --> <!-- ${METADATA_COMMENT_MARKER} {} -->`;
        const reviewOnly = `<!-- ${REVIEW_COMMENT_MARKER} -->`;
        const metadataOnly = `<!-- ${METADATA_COMMENT_MARKER} -->`;

        const trusted = {
            id: 10,
            body: both,
            created_at: '2026-09-03T10:00:00Z',
            user: { type: 'Bot', login: 'github-actions[bot]' }
        };

        const forged = [
            /* Wrong author type with both markers and the expected login. */
            {
                id: 11,
                body: both,
                created_at: '2026-09-03T11:00:00Z',
                user: { type: 'User', login: 'github-actions[bot]' }
            },
            /* Single-marker comments from the expected bot. */
            {
                id: 12,
                body: reviewOnly,
                created_at: '2026-09-03T12:00:00Z',
                user: { type: 'Bot', login: 'github-actions[bot]' }
            },
            {
                id: 13,
                body: metadataOnly,
                created_at: '2026-09-03T13:00:00Z',
                user: { type: 'Bot', login: 'github-actions[bot]' }
            },
            { id: 14, body: both, created_at: '2026-09-03T14:00:00Z', user: null },
            {
                id: 15,
                body: null,
                created_at: '2026-09-03T15:00:00Z',
                user: { type: 'Bot', login: 'github-actions[bot]' }
            }
        ];

        const selected = selectReviewComments([trusted, ...forged], 'github-actions[bot]');
        expect(selected.map((comment) => comment.id)).toEqual([10]);
    });

    test('only a 404 status means an absent protected file', async () => {
        const path = '.github/sakre.yml';
        const ref = 'a'.repeat(40);
        const serverError = new Error('Internal Server Error');
        Object.assign(serverError, { status: 500 });

        const rejects: unknown[] = [serverError, 'boom', null, { message: 'network down' }];

        for (const reject of rejects) {
            const state: FakeOctokitState = { files: [], comments: [], contents: { [path]: { reject } } };
            const vcs = new GitHubVcs({ octokit: createOctokit(state), repository: REPOSITORY });
            const failure = await rejectionOf(vcs.getFileContent(path, ref));
            expect(failure.message).toMatch(/repos\.getContent/u);
        }

        const missing: FakeOctokitState = { files: [], comments: [], contents: { [path]: { error: true } } };
        const missingVcs = new GitHubVcs({ octokit: createOctokit(missing), repository: REPOSITORY });
        expect(await missingVcs.getFileContent(path, ref)).toBeNull();
    });
});
