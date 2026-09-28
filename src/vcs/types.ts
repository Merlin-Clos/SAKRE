/* Minimal VCS boundary: the review domain depends only on these operations,
   never on a particular VCS SDK. */
const changedFileStatuses = ['added', 'modified', 'removed', 'renamed'] as const;

interface VcsPullRequest {
    owner: string;
    repo: string;
    number: number;
    title: string;
    body: string;
    authorLogin: string;
    baseRef: string;
    baseSha: string;
    headSha: string;
    headRef: string;
}

/* Reviewable patch content of one changed file:
   - `none`: Git produces no hunks (binary, mode-only, or empty change);
   - `unavailable`: the provider omitted the patch for a text change, so its
     content is known to exist but cannot be read;
   - `measured`: the exact hunk size is known, content is not retained;
   - `retained`: content is available, possibly shortened to a coverage
     allocation; `chars` always remains the exact full size. */
type VcsFilePatch =
    | { state: 'none' }
    | { state: 'unavailable' }
    | { state: 'measured'; chars: number }
    | { state: 'retained'; chars: number; content: string };

interface VcsChangedFile {
    path: string;
    previousPath?: string;
    status: (typeof changedFileStatuses)[number];
    additions: number;
    deletions: number;
    patch: VcsFilePatch;
}

/* Rename or copy is identified by both its new and its previous path, so a
   rule that matches one must consider the other. */
function changedFilePaths(file: Pick<VcsChangedFile, 'path' | 'previousPath'>): string[] {
    if (file.previousPath === undefined) {
        return [file.path];
    }

    return [file.path, file.previousPath];
}

interface VcsReviewComment {
    id: number;
    body: string;
    createdAt: string;
    authorType: 'Bot' | 'User' | 'Unknown';
}

interface VcsPullRequestSnapshot {
    pullRequest: VcsPullRequest;
    changedFiles: VcsChangedFile[];
    comments: VcsReviewComment[];
}

/* Every protected read goes through an explicit ref: configuration is always
   read at the base SHA, never at the checkout head. */
interface VcsClient {
    getPullRequestSnapshot: (number: number, signal?: AbortSignal) => Promise<VcsPullRequestSnapshot>;
    /* Retains hunk content for a coverage allocation: at most `chars` hunk
       characters per path, claimed in allocation order (coverage priority
       first). Paths without an allocation stay measured instead of being read. */
    materializeCoveragePatches: (
        files: readonly VcsChangedFile[],
        allocations: ReadonlyMap<string, number>,
        signal?: AbortSignal
    ) => Promise<VcsChangedFile[]>;
    getFileContent: (path: string, ref: string, signal?: AbortSignal) => Promise<string | null>;
    getCurrentHeadSha: (number: number, signal?: AbortSignal) => Promise<string>;
}

export type { VcsChangedFile, VcsClient, VcsFilePatch, VcsPullRequest, VcsPullRequestSnapshot, VcsReviewComment };

export { changedFilePaths, changedFileStatuses };
