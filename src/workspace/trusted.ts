import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PRODUCT_SLUG } from '../identity';
import { createGitRunner, gitOutput, type GitRunner } from '../vcs/git-command';

const AGENTS_FILE_NAME = 'AGENTS.md';

const NUL = '\0';

export class TrustedWorkspaceError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = 'TrustedWorkspaceError';
    }
}

export interface TrustedWorkspaceOptions {
    repositoryDir: string;
    baseSha: string;
    headSha: string;
    signal?: AbortSignal;
    /* Tests pin the scratch parent; production uses the platform temp dir. */
    scratchRoot?: string;
}

export interface TrustedWorkspace {
    directory: string;
    close: () => Promise<void>;
}

export interface WorkspaceRequest {
    baseSha: string;
    headSha: string;
    signal?: AbortSignal;
}

export type WorkspaceFactory = (request: WorkspaceRequest) => Promise<TrustedWorkspace>;

/* Ephemeral review workspace with BASE instruction overlay. Analyzed diff
   still comes from the VCS client (base SHA..head SHA), so an AGENTS.md change
   stays visible and reviewable; only files the engine may read as
   instructions get their BASE version. User checkout is never modified. */
export async function createTrustedWorkspace(options: TrustedWorkspaceOptions): Promise<TrustedWorkspace> {
    const git = createGitRunner(options.repositoryDir);
    const root = await mkdtemp(path.join(options.scratchRoot ?? tmpdir(), `${PRODUCT_SLUG}-workspace-`));
    const directory = path.join(root, 'checkout');

    try {
        await addWorktree(git, directory, options);
        await overlayAgentsFiles(git, directory, options);

        return {
            directory,
            close: () => removeWorkspace(git, directory, root)
        };
    } catch (error) {
        await removeWorkspace(git, directory, root);
        throw error;
    }
}

async function addWorktree(git: GitRunner, directory: string, options: TrustedWorkspaceOptions): Promise<void> {
    const result = await git.run(['worktree', 'add', '--detach', directory, options.headSha], options.signal);

    if (result.exitCode !== 0) {
        throw new TrustedWorkspaceError(
            `Failed to create the review workspace for ${options.headSha}: ${firstLine(result.stderr)}`
        );
    }
}

/* Instruction files are matched case-insensitively: APFS (darwin targets) and
   NTFS (windows-x64) resolve `agents.md` to the same file as `AGENTS.md`, so a
   case variant at HEAD must get BASE content or be deleted like the
   exact-case name. */
function isAgentsFileName(filePath: string): boolean {
    return path.posix.basename(filePath).toLowerCase() === AGENTS_FILE_NAME.toLowerCase();
}

/* A path is overlaid through its HEAD spelling; BASE-only file is created at
   its BASE path. Multiple HEAD spellings of the same file (only possible on a
   case-sensitive filesystem) are all overlaid, so no variant keeps HEAD
   content on a case-insensitive target. */
interface AgentsFileGroup {
    headPaths: string[];
    basePath: string | undefined;
}

function groupAgentsFiles(headPaths: readonly string[], basePaths: readonly string[]): AgentsFileGroup[] {
    const groups = new Map<string, AgentsFileGroup>();

    function groupOf(filePath: string): AgentsFileGroup {
        const existing = groups.get(filePath.toLowerCase());

        if (existing !== undefined) {
            return existing;
        }

        const created: AgentsFileGroup = { headPaths: [], basePath: undefined };
        groups.set(filePath.toLowerCase(), created);

        return created;
    }

    for (const filePath of headPaths) {
        groupOf(filePath).headPaths.push(filePath);
    }

    for (const filePath of basePaths) {
        const group = groupOf(filePath);
        group.basePath ??= filePath;
    }

    return [...groups.values()];
}

/* Every instruction file at HEAD or BASE gets BASE content, or is deleted
   when absent at BASE. `git worktree add` checked out the HEAD tree, so files
   absent at HEAD are the only ones created here and no untracked AGENTS.md
   survives the overlay. */
async function overlayAgentsFiles(git: GitRunner, directory: string, options: TrustedWorkspaceOptions): Promise<void> {
    const headPaths = await listAgentsFiles(git, options.headSha, options.signal);
    const basePaths = await listAgentsFiles(git, options.baseSha, options.signal);

    for (const group of groupAgentsFiles(headPaths, basePaths)) {
        /* Sequential on purpose: a hostile repository could add many AGENTS.md
           files, and each base read is one git child process. */
        // eslint-disable-next-line no-await-in-loop -- bounded git fan-out
        await overlayAgentsGroup({ git, directory, group, options });
    }
}

interface OverlayGroupInput {
    git: GitRunner;
    directory: string;
    group: AgentsFileGroup;
    options: TrustedWorkspaceOptions;
}

async function overlayAgentsGroup(input: OverlayGroupInput): Promise<void> {
    const { group, directory } = input;

    if (group.basePath === undefined) {
        await removeAgentsFiles(directory, group.headPaths);

        return;
    }

    const content = await gitOutput({
        runner: input.git,
        operation: `show ${input.options.baseSha}:${group.basePath}`,
        args: ['show', `${input.options.baseSha}:${group.basePath}`],
        signal: input.options.signal
    });

    await writeAgentsFiles(directory, overlayTargets(group), content);
}

function overlayTargets(group: AgentsFileGroup): string[] {
    if (group.headPaths.length > 0) {
        return group.headPaths;
    }

    if (group.basePath !== undefined) {
        return [group.basePath];
    }

    return [];
}

async function removeAgentsFiles(directory: string, filePaths: readonly string[]): Promise<void> {
    await Promise.all(
        filePaths.map(async (filePath) => {
            const target = await prepareOverlayTarget(directory, filePath);
            await rm(target, { recursive: true, force: true });
        })
    );
}

async function writeAgentsFiles(directory: string, filePaths: readonly string[], content: string): Promise<void> {
    await Promise.all(
        filePaths.map(async (filePath) => {
            const target = await prepareOverlayTarget(directory, filePath);
            await writeFile(target, content, 'utf8');
        })
    );
}

/* Hostile HEAD can replace an AGENTS.md path component with a symlink or a
   directory. Writing or deleting through such an entry would reach outside the
   workspace, so every non-directory component and any non-regular target is
   removed first and rebuilt as a real directory or regular file. */
async function prepareOverlayTarget(directory: string, filePath: string): Promise<string> {
    const segments = filePath.split('/').filter((segment) => segment !== '');
    const fileName = segments.pop();

    if (fileName === undefined) {
        throw new TrustedWorkspaceError(`Invalid instruction file path: ${filePath}.`);
    }

    const parent = await prepareParentDirectory(directory, segments);
    const target = path.join(parent, fileName);
    const entry = await lstatOrUndefined(target);

    if (entry !== undefined && !entry.isFile()) {
        await rm(target, { recursive: true, force: true });
    }

    return target;
}

async function prepareParentDirectory(directory: string, segments: readonly string[]): Promise<string> {
    let current = directory;

    /* eslint-disable no-await-in-loop -- sequential path walk */
    for (const segment of segments) {
        current = path.join(current, segment);
        const entry = await lstatOrUndefined(current);

        if (entry === undefined) {
            await mkdir(current, { recursive: true });
        } else if (!entry.isDirectory()) {
            await rm(current, { recursive: true, force: true });
            await mkdir(current, { recursive: true });
        }
    }

    /* eslint-enable no-await-in-loop -- sequential path walk */
    return current;
}

async function lstatOrUndefined(filePath: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
    try {
        return await lstat(filePath);
    } catch {
        return undefined;
    }
}

async function listAgentsFiles(git: GitRunner, sha: string, signal?: AbortSignal): Promise<string[]> {
    const output = await gitOutput({
        runner: git,
        operation: `ls-tree ${sha}`,
        args: ['ls-tree', '-r', '--name-only', '-z', sha],
        signal
    });

    return output.split(NUL).filter((filePath) => filePath !== '' && isAgentsFileName(filePath));
}

async function removeWorkspace(git: GitRunner, directory: string, root: string): Promise<void> {
    const result = await git.run(['worktree', 'remove', '--force', directory]);

    if (result.exitCode !== 0) {
        /* Worktree may not have been registered (failed add): prune stale
           metadata and remove the directory either way. */
        await git.run(['worktree', 'prune']);
    }

    await rm(root, { recursive: true, force: true });
}

function firstLine(text: string): string {
    const [line = ''] = text.trim().split('\n');

    return line.trim();
}
