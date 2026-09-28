import { spawn } from 'node:child_process';
import { listTreeFiles, type TreeListing } from '../vcs/tree';
import { runProcess, runProcessCapture } from './run-process';
import { removeTree, withTempTree } from './temp-tree';

const GIT_BINARY = 'git';

const TAR_BINARY = 'tar';

export interface GitTreeSnapshot {
    sha: string;
    directory: string;
    listing: TreeListing;
    close: () => Promise<void>;
}

export class SnapshotError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = 'SnapshotError';
    }
}

/* BASE tree is extracted once and shared by every measurement tool; the canonical file list comes from `git ls-tree`. */
export function materializeGitTree(options: {
    worktreeDir: string;
    sha: string;
    signal?: AbortSignal;
}): Promise<GitTreeSnapshot> {
    return withTempTree(
        {
            label: 'tree',
            cancellationMessage: 'The tree extraction was cancelled.',
            signal: options.signal
        },
        async (directory) => {
            await verifyCommitRef(options.worktreeDir, options.sha, options.signal);
            await extractTree(options, directory);

            const listing = await listTreeFiles({
                directory: options.worktreeDir,
                sha: options.sha,
                signal: options.signal
            });

            return { sha: options.sha, directory, listing, close: () => removeTree(directory) };
        }
    );
}

/* Merge base of two commits, or undefined when unresolvable or equal to base. Recorded only when it differs from base. */
export async function resolveMergeBaseSha(options: {
    directory: string;
    baseSha: string;
    headSha: string;
    signal?: AbortSignal;
}): Promise<string | undefined> {
    if (options.baseSha === options.headSha) {
        return undefined;
    }

    const result = await runProcessCapture({
        command: GIT_BINARY,
        args: ['-C', options.directory, 'merge-base', options.baseSha, options.headSha],
        signal: options.signal
    });

    if (result.exitCode !== 0) {
        return undefined;
    }

    const sha = result.stdout.trim();

    if (sha === '' || sha === options.baseSha) {
        return undefined;
    }

    return sha;
}

export async function verifyCommitRef(directory: string, sha: string, signal?: AbortSignal): Promise<void> {
    /* A missing commit is an exit code, not a spawn rejection, so SnapshotError always reaches the caller. */
    const result = await runProcessCapture({
        command: GIT_BINARY,
        args: ['-C', directory, 'rev-parse', '--verify', `${sha}^{commit}`],
        signal
    });

    if (result.exitCode !== 0) {
        throw new SnapshotError(`Commit ${sha} is not available in the checkout worktree.`);
    }
}

async function extractTree(
    options: { worktreeDir: string; sha: string; signal?: AbortSignal },
    directory: string
): Promise<void> {
    const result = await runProcess({
        command: GIT_BINARY,
        args: ['-C', options.worktreeDir, 'archive', '--format=tar', options.sha],
        signal: options.signal,
        pipeStdout: (archive) => extractTar(directory, archive, options.signal)
    });

    if (result.exitCode !== 0) {
        throw new SnapshotError(`git archive failed for ${options.sha} with exit code ${result.exitCode}.`);
    }
}

function extractTar(extractDir: string, archive: NodeJS.ReadableStream, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const tar = spawn(TAR_BINARY, ['-x', '-C', extractDir], { signal });
        archive.pipe(tar.stdin);
        tar.on('error', reject);
        tar.on('close', (code) => {
            if (code === 0) {
                resolve();

                return;
            }

            reject(new SnapshotError(`tar extraction failed with exit code ${code ?? -1}.`));
        });
    });
}
