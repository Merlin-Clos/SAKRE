import type { GitRunner } from '../vcs/git-command';

export class PrerequisiteError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = 'PrerequisiteError';
    }
}

export async function ensureGitAvailable(git: GitRunner, signal?: AbortSignal): Promise<void> {
    const result = await git.run(['--version'], signal);

    if (result.exitCode !== 0) {
        throw new PrerequisiteError('git is required to review a local repository.');
    }
}

export async function resolveRepositoryRoot(git: GitRunner, signal?: AbortSignal): Promise<string> {
    const result = await git.run(['rev-parse', '--show-toplevel'], signal);
    const root = result.stdout.trim();

    if (result.exitCode !== 0 || root === '') {
        throw new PrerequisiteError('The review target is not inside a Git repository.');
    }

    return root;
}

export async function readRemote(git: GitRunner, name: string, signal?: AbortSignal): Promise<string | undefined> {
    const result = await git.run(['remote', 'get-url', name], signal);

    if (result.exitCode !== 0) {
        return undefined;
    }

    const url = result.stdout.trim();

    if (url === '') {
        return undefined;
    }

    return url;
}

export async function readCurrentBranch(git: GitRunner, signal?: AbortSignal): Promise<string | undefined> {
    const result = await git.run(['rev-parse', '--abbrev-ref', 'HEAD'], signal);

    if (result.exitCode !== 0) {
        return undefined;
    }

    const branch = result.stdout.trim();

    if (branch === '' || branch === 'HEAD') {
        return undefined;
    }

    return branch;
}
