/* Local Git failure: the message names the failed operation but never a
   credential value; refs and paths are safe to include. */
export class LocalGitError extends Error {
    public constructor(operation: string, message: string) {
        super(`Git operation "${operation}" failed: ${message}`);
        this.name = 'LocalGitError';
    }
}

/* Normalized API error: no Octokit error may cross the VCS boundary without
   being mapped. */
export class VcsApiError extends Error {
    public constructor(operation: string, status: number | undefined, cause: unknown) {
        let message = `VCS operation "${operation}" failed.`;

        if (status !== undefined) {
            message = `VCS operation "${operation}" failed with status ${status}.`;
        }

        super(message);
        this.name = 'VcsApiError';
        this.cause = cause;
    }
}

// eslint-disable-next-line anti-slop/no-unknown-parameters -- Octokit failures cross this boundary as unknown
export function wrapVcsError(operation: string, error: unknown): VcsApiError {
    if (error instanceof VcsApiError) {
        return error;
    }

    let status: number | undefined = undefined;

    // eslint-disable-next-line anti-slop/no-runtime-typeof -- object guard before probing the status field
    if (typeof error === 'object' && error !== null && 'status' in error) {
        // SAFETY: `status` key presence was checked above on a non-null object, so reading it is sound.
        const candidate = (error as { status?: unknown }).status;

        // eslint-disable-next-line anti-slop/no-runtime-typeof -- narrows the decoded status probe
        if (typeof candidate === 'number') {
            status = candidate;
        }
    }

    return new VcsApiError(operation, status, error);
}
