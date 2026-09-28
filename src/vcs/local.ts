import { StringDecoder } from 'node:string_decoder';
import { mapWithConcurrency } from '../concurrency';
import { LocalGitError } from './errors';
import { createGitRunner, gitOutput, type GitRunner, gitStream, gitSucceeds } from './git-command';
import type {
    VcsChangedFile,
    VcsClient,
    VcsFilePatch,
    VcsPullRequest,
    VcsPullRequestSnapshot,
    VcsReviewComment
} from './types';

const HEAD_REF = 'HEAD';

const COMMIT_PEEL = '^{commit}';

const DEFAULT_BASE_CANDIDATES = ['origin/HEAD', 'main', 'master'] as const;

const NUL = '\0';

const LOG_FIELD_SEPARATOR = '\u001F';

const LOG_RECORD_SEPARATOR = '\u001E';

const MAX_COMMIT_LINES = 50;

/* A rename or copy name-status record carries status, source, and destination. */
const RENAME_RECORD_TOKENS = 3;

/* Read pass claims one `git diff` per allocated file, but never one child
   process per file at once: a formatting sweep or a vendored directory must not
   exhaust file descriptors or spawn hundreds of processes. */
const MAX_CONCURRENT_PATCH_READS = 8;

export interface LocalGitRefs {
    baseRef: string;
    headRef: string;
    baseSha: string;
    headSha: string;
}

/* Optional GitHub metadata for `--context github`: the Git input stays local
   (merge-base..head), only the title, body, author, PR number and review
   history come from the API. Review refs always come from the local clone;
   GitHub metadata cannot replace them. */
export interface LocalGitContext {
    owner?: string;
    repo?: string;
    number?: number;
    title?: string;
    body?: string;
    authorLogin?: string;
    comments?: VcsReviewComment[];
}

export interface LocalGitVcsOptions {
    repositoryDir: string;
    refs: LocalGitRefs;
    context?: LocalGitContext;
    git?: GitRunner;
}

export interface ResolveLocalRefsOptions {
    repositoryDir: string;
    baseRef?: string;
    headRef?: string;
    git?: GitRunner;
    signal?: AbortSignal;
}

/* Resolves the local review range once: the head commit, the base ref
   (`origin/HEAD` → `main` → `master` by default), and their merge base, which
   is the protected base the configuration is read from. */
export async function resolveLocalRefs(options: ResolveLocalRefsOptions): Promise<LocalGitRefs> {
    const git = options.git ?? createGitRunner(options.repositoryDir);
    const headRef = options.headRef ?? HEAD_REF;
    const headSha = await resolveCommit(git, headRef, options.signal);
    const baseRef = options.baseRef ?? (await detectBaseRef(git, options.signal));
    const baseSha = await resolveMergeBase({ git, baseRef, headRef, signal: options.signal });

    return { baseRef, headRef, baseSha, headSha };
}

async function resolveCommit(git: GitRunner, ref: string, signal?: AbortSignal): Promise<string> {
    const output = await gitOutput({
        runner: git,
        operation: `rev-parse ${ref}`,
        args: ['rev-parse', `${ref}${COMMIT_PEEL}`],
        signal
    });

    return output.trim();
}

async function detectBaseRef(git: GitRunner, signal?: AbortSignal): Promise<string> {
    for (const candidate of DEFAULT_BASE_CANDIDATES) {
        if (await gitSucceeds(git, ['rev-parse', '--verify', '--quiet', `${candidate}${COMMIT_PEEL}`], signal)) {
            return candidate;
        }
    }

    throw new LocalGitError(
        'resolve-base',
        `cannot determine a base ref; tried ${DEFAULT_BASE_CANDIDATES.join(', ')}. Pass --base <ref>.`
    );
}

async function resolveMergeBase(input: {
    git: GitRunner;
    baseRef: string;
    headRef: string;
    signal?: AbortSignal;
}): Promise<string> {
    const output = await gitOutput({
        runner: input.git,
        operation: 'merge-base',
        args: ['merge-base', input.baseRef, input.headRef],
        signal: input.signal
    });

    return output.trim();
}

/* Local Git adapter: maps Git plumbing output to the internal VCS contracts,
   exactly like the GitHub adapter maps Octokit responses. */
export class LocalGitVcs implements VcsClient {
    private readonly refs: LocalGitRefs;
    private readonly context: LocalGitContext;
    private readonly git: GitRunner;
    /* Range the last snapshot measured: the read pass must use the same
       commits the sizes came from, even when the head ref moved since. */
    private coverageRange: { baseSha: string; headSha: string } | undefined = undefined;

    public constructor(options: LocalGitVcsOptions) {
        this.refs = options.refs;
        this.context = options.context ?? {};
        this.git = options.git ?? createGitRunner(options.repositoryDir);
    }

    public async getPullRequestSnapshot(_number: number, signal?: AbortSignal): Promise<VcsPullRequestSnapshot> {
        const headSha = await this.getCurrentHeadSha(0, signal);
        this.coverageRange = { baseSha: this.refs.baseSha, headSha };

        const [changedFiles, pullRequest] = await Promise.all([
            this.listChangedFiles(this.refs.baseSha, headSha, signal),
            this.buildPullRequest(headSha, signal)
        ]);

        return { pullRequest, changedFiles, comments: this.context.comments ?? [] };
    }

    /* Head ref is re-resolved on every call so a local branch that moved
       during the review is reported as stale instead of silently accepted. */
    public getCurrentHeadSha(_number: number, signal?: AbortSignal): Promise<string> {
        return resolveCommit(this.git, this.refs.headRef, signal);
    }

    /* Reads the allocated slices in allocation order, so escalation-matched
       paths are claimed before neutral paths. File that yields no hunks is
       left measured: the coverage renderer treats it as truncated instead
       of silently complete. */
    public async materializeCoveragePatches(
        files: readonly VcsChangedFile[],
        allocations: ReadonlyMap<string, number>,
        signal?: AbortSignal
    ): Promise<VcsChangedFile[]> {
        const byPath = new Map(files.map((file) => [file.path, file]));
        const claims: { file: VcsChangedFile; chars: number; limit: number }[] = [];

        for (const [path, limit] of allocations) {
            const file = byPath.get(path);

            if (file?.patch.state !== 'measured' || limit <= 0) {
                continue;
            }

            claims.push({ file, chars: file.patch.chars, limit });
        }

        const retained = await mapWithConcurrency(claims, MAX_CONCURRENT_PATCH_READS, async (claim) => ({
            path: claim.file.path,
            patch: await this.readPatchSlice({ file: claim.file, chars: claim.chars, limit: claim.limit, signal })
        }));

        const replacements = new Map(retained.map((entry) => [entry.path, entry.patch]));

        return files.map((file) => {
            const patch = replacements.get(file.path);

            if (patch === undefined) {
                return file;
            }

            return { ...file, patch };
        });
    }

    public async getFileContent(filePath: string, ref: string, signal?: AbortSignal): Promise<string | null> {
        assertSafeRepositoryPath(filePath);
        const result = await this.git.run(['show', `${ref}:${filePath}`], signal);

        if (result.exitCode !== 0) {
            return null;
        }

        return result.stdout;
    }

    private async buildPullRequest(headSha: string, signal?: AbortSignal): Promise<VcsPullRequest> {
        const commits = await this.readCommitContext(headSha, signal);

        return {
            owner: this.context.owner ?? '',
            repo: this.context.repo ?? '',
            number: this.context.number ?? 0,
            title: this.context.title ?? commits.title,
            body: this.context.body ?? commits.body,
            authorLogin: this.context.authorLogin ?? commits.authorLogin,
            baseRef: this.refs.baseRef,
            baseSha: this.refs.baseSha,
            headRef: this.refs.headRef,
            headSha
        };
    }

    /* Git mode has no PR metadata: the commit range is the review context. */
    private async readCommitContext(
        headSha: string,
        signal?: AbortSignal
    ): Promise<{ title: string; body: string; authorLogin: string }> {
        const format = `--format=%s${LOG_FIELD_SEPARATOR}%an${LOG_RECORD_SEPARATOR}`;
        const range = `${this.refs.baseSha}..${headSha}`;

        const output = await gitOutput({
            runner: this.git,
            operation: 'log',
            args: ['log', format, range],
            signal
        });

        const parsed = parseCommitLog(output).slice(0, MAX_COMMIT_LINES);

        if (parsed.length === 0) {
            const title = await gitOutput({
                runner: this.git,
                operation: 'log-head',
                args: ['log', '-1', '--format=%s', headSha],
                signal
            });

            return { title: title.trim(), body: '', authorLogin: 'local' };
        }

        const [first] = parsed;
        let headSubject = 'Local review';

        if (first !== undefined) {
            const { subject } = first;

            if (subject !== '') {
                headSubject = subject;
            }
        }

        let title = headSubject;

        if (parsed.length > 1) {
            title = `${headSubject} (${parsed.length} commits)`;
        }

        const authors = [...new Set(parsed.map((commit) => commit.author))];
        const body = parsed.map((commit) => `- ${commit.subject} (${commit.author})`).join('\n');

        return { title, body, authorLogin: authors.join(', ') };
    }

    /* Changed files arrive measured, never read: one streaming bulk diff
       attributes the exact hunk size of every file without retaining content,
       so the coverage plan can decide what is worth reading before any patch
       is materialized. */
    private async listChangedFiles(baseSha: string, headSha: string, signal?: AbortSignal): Promise<VcsChangedFile[]> {
        const range = [baseSha, headSha];

        const [nameStatus, numStat, sections] = await Promise.all([
            gitOutput({
                runner: this.git,
                operation: 'diff-name-status',
                args: ['diff', '--name-status', '-z', '--find-renames', ...range],
                signal
            }),
            gitOutput({
                runner: this.git,
                operation: 'diff-numstat',
                args: ['diff', '--numstat', '-z', '--find-renames', ...range],
                signal
            }),
            this.measurePatches({ baseSha, headSha, signal })
        ]);

        const entries = parseNameStatus(nameStatus);
        const stats = parseNumStat(numStat);

        /* Both commands and the bulk diff stream the same diffcore result in the
           same order; a mismatch means the sizes cannot be attributed safely. */
        if (sections.length !== entries.length) {
            throw new LocalGitError(
                'measure-diff',
                `expected ${entries.length} diff sections, read ${sections.length}.`
            );
        }

        return entries.map((entry, index) => {
            const { path, status, previousPath: entryPreviousPath } = entry;
            const stat = stats.get(path);

            return {
                path,
                previousPath: renamedPreviousPath(status, entryPreviousPath),
                status,
                additions: stat?.additions ?? 0,
                deletions: stat?.deletions ?? 0,
                patch: measuredPatch(sections[index])
            };
        });
    }

    /* Streaming count pass: one bulk diff is decoded chunk by chunk and split
       at its `diff --git` boundaries, so the exact hunk size of every file is
       measured at constant memory with a single child process. */
    private async measurePatches(input: {
        baseSha: string;
        headSha: string;
        signal?: AbortSignal;
    }): Promise<(number | undefined)[]> {
        const stream = createDiffStream();
        await gitStream({
            runner: this.git,
            operation: 'diff-patch',
            args: ['diff', '--no-color', '--unified=3', '--find-renames', input.baseSha, input.headSha],
            signal: input.signal,
            onStdoutChunk: (chunk) => stream.push(chunk)
        });
        stream.finish();

        return stream.sections();
    }

    /* Budgeted read pass: retains only the allocated hunk characters and stops
       the diff once they are in hand, so retention follows the review budget
       instead of a fixed cap. */
    private async readPatchSlice(input: {
        file: VcsChangedFile;
        chars: number;
        limit: number;
        signal?: AbortSignal;
    }): Promise<VcsFilePatch> {
        const { file, chars, limit, signal } = input;
        const stream = createDiffStream(limit);
        const range = this.coverageRange ?? { baseSha: this.refs.baseSha, headSha: this.refs.headSha };
        await gitStream({
            runner: this.git,
            operation: 'diff-patch',
            args: patchArguments({ baseSha: range.baseSha, headSha: range.headSha, entry: file }),
            signal,
            onStdoutChunk: (chunk) => stream.push(chunk)
        });
        stream.finish();

        if (stream.sections()[0] === undefined) {
            return file.patch;
        }

        return { state: 'retained', chars, content: stream.content() };
    }
}

function measuredPatch(chars: number | undefined): VcsFilePatch {
    if (chars === undefined) {
        return { state: 'none' };
    }

    return { state: 'measured', chars };
}

/* Only a rename keeps the previous path in the coverage contract. */
function renamedPreviousPath(status: VcsChangedFile['status'], previousPath: string | undefined): string | undefined {
    if (status === 'renamed') {
        return previousPath;
    }

    return undefined;
}

interface NameStatusEntry {
    path: string;
    previousPath?: string;
    status: VcsChangedFile['status'];
}

function patchArguments(input: {
    baseSha: string;
    headSha: string;
    entry: { path: string; previousPath?: string };
}): string[] {
    const { entry } = input;
    let paths = [entry.path];

    if (entry.previousPath !== undefined) {
        paths = [entry.previousPath, entry.path];
    }

    return ['diff', '--no-color', '--unified=3', '--find-renames', input.baseSha, input.headSha, '--', ...paths];
}

/* Streaming diff reader: counts the hunk characters of every `diff --git`
   section and optionally retains a bounded prefix of the first one. Recognizes
   sections at line starts, so it still detects markers split across chunks;
   memory stays constant regardless of diff size, and a consumer returning
   `false` from `push` stops the underlying diff. */
interface DiffStream {
    push: (chunk: Buffer) => boolean;
    finish: () => void;
    /* Hunk characters per file section, in diff order. `undefined` marks a
       section without hunks: binary, mode-only, or a pure rename. */
    sections: () => (number | undefined)[];
    /* Retained hunk prefix of the first section, capped by `retainChars`. */
    content: () => string;
}

type LineKind = 'unknown' | 'boundary' | 'content';

interface DiffStreamState {
    retainChars: number | undefined;
    sections: (number | undefined)[];
    sectionIndex: number;
    counting: boolean;
    chars: number;
    content: string;
    kind: LineKind;
    probe: string;
    full: boolean;
}

const BOUNDARY_MARKER = 'diff --git ';

const HUNK_MARKER = '@@ ';

function createDiffStream(retainChars?: number): DiffStream {
    const decoder = new StringDecoder('utf8');

    const state: DiffStreamState = {
        retainChars,
        sections: [],
        sectionIndex: -1,
        counting: false,
        chars: 0,
        content: '',
        kind: 'unknown',
        probe: '',
        full: false
    };

    return {
        push: (chunk) => pushDiffText(state, decoder.write(chunk)),
        finish: () => {
            pushDiffText(state, decoder.end());

            if (state.kind === 'unknown' && state.probe !== '') {
                flushProbe(state);
            }

            finalizeSection(state);
        },
        sections: () => [...state.sections],
        content: () => state.content
    };
}

function pushDiffText(state: DiffStreamState, text: string): boolean {
    if (state.full) {
        return false;
    }

    let index = 0;

    while (index < text.length) {
        if (state.kind === 'unknown') {
            const keepGoing = consumeProbeChar(state, text[index] ?? '');
            index += 1;

            if (!keepGoing) {
                return false;
            }

            continue;
        }

        const newline = text.indexOf('\n', index);

        if (state.kind === 'boundary') {
            if (newline === -1) {
                return true;
            }

            index = newline + 1;
            endLine(state);
            continue;
        }

        if (newline === -1) {
            return appendLineText(state, text.slice(index));
        }

        const keepGoing = appendLineText(state, text.slice(index, newline + 1));
        index = newline + 1;
        endLine(state);

        if (!keepGoing) {
            return false;
        }
    }

    return true;
}

/* Line-start probe: a line is only a marker when the exact marker matched.
   Partial prefixes stay buffered, so a marker split across chunks resolves.
   Returns false once retention is full and the diff can stop. */
function consumeProbeChar(state: DiffStreamState, char: string): boolean {
    state.probe += char;

    if (BOUNDARY_MARKER.startsWith(state.probe)) {
        if (state.probe.length === BOUNDARY_MARKER.length) {
            startSection(state);
        }

        return true;
    }

    if (HUNK_MARKER.startsWith(state.probe)) {
        if (state.probe.length === HUNK_MARKER.length) {
            state.counting = true;

            return flushProbe(state);
        }

        return true;
    }

    return flushProbe(state);
}

/* Probe is not a marker: its characters belong to the current line. */
function flushProbe(state: DiffStreamState): boolean {
    const { probe } = state;
    state.kind = 'content';
    state.probe = '';

    return appendLineText(state, probe);
}

function startSection(state: DiffStreamState): void {
    finalizeSection(state);
    state.sectionIndex += 1;
    state.counting = false;
    state.chars = 0;
    state.kind = 'boundary';
    state.probe = '';
}

function finalizeSection(state: DiffStreamState): void {
    if (state.sectionIndex < 0) {
        return;
    }

    if (state.counting) {
        state.sections[state.sectionIndex] = state.chars;
    } else {
        state.sections[state.sectionIndex] = undefined;
    }
}

function endLine(state: DiffStreamState): void {
    state.kind = 'unknown';
    state.probe = '';
}

/* Counts and retains the line text of a section; returns false once retention
   is full and it can stop the underlying diff. */
function appendLineText(state: DiffStreamState, text: string): boolean {
    if (state.counting) {
        state.chars += text.length;
        retainHunkText(state, text);
    }

    return !state.full;
}

function retainHunkText(state: DiffStreamState, text: string): void {
    const { retainChars } = state;

    if (retainChars === undefined || state.sectionIndex !== 0) {
        return;
    }

    const missing = retainChars - state.content.length;

    if (missing <= 0) {
        return;
    }

    if (text.length <= missing) {
        state.content += text;
    } else {
        state.content += text.slice(0, missing);
    }

    if (state.content.length >= retainChars) {
        state.full = true;
    }
}

function parseNameStatus(output: string): NameStatusEntry[] {
    const tokens = output.split(NUL);
    const entries: NameStatusEntry[] = [];
    let index = 0;

    while (index < tokens.length) {
        const rawStatus = tokens[index];

        if (rawStatus === undefined || rawStatus === '') {
            index += 1;
            continue;
        }

        const kind = rawStatus[0] ?? 'M';

        if (kind === 'R' || kind === 'C') {
            const previousPath = tokens[index + 1];
            const path = tokens[index + 2];

            if (path === undefined) {
                break;
            }

            entries.push({ path, previousPath, status: mapStatus(kind) });
            index += RENAME_RECORD_TOKENS;
            continue;
        }

        const path = tokens[index + 1];

        if (path === undefined) {
            break;
        }

        entries.push({ path, status: mapStatus(kind) });
        index += 2;
    }

    return entries;
}

function mapStatus(kind: string): VcsChangedFile['status'] {
    if (kind === 'A' || kind === 'C') {
        return 'added';
    }

    if (kind === 'D') {
        return 'removed';
    }

    if (kind === 'R') {
        return 'renamed';
    }

    return 'modified';
}

function parseNumStat(output: string): Map<string, { additions: number; deletions: number }> {
    const stats = new Map<string, { additions: number; deletions: number }>();
    const tokens = output.split(NUL);
    let index = 0;

    while (index < tokens.length) {
        const header = tokens[index];

        if (header === undefined || header === '') {
            index += 1;
            continue;
        }

        index += 1;
        const [additionsRaw = '0', deletionsRaw = '0', headerPath = ''] = header.split('\t');
        let path = headerPath;

        if (path === '') {
            path = tokens[index + 1] ?? '';
            index += 2;
        }

        if (path !== '') {
            stats.set(path, { additions: toCount(additionsRaw), deletions: toCount(deletionsRaw) });
        }
    }

    return stats;
}

function toCount(value: string): number {
    const count = Number.parseInt(value, 10);

    if (Number.isNaN(count)) {
        return 0;
    }

    return count;
}

function parseCommitLog(output: string): { subject: string; author: string }[] {
    const records = output.split(LOG_RECORD_SEPARATOR);
    const commits: { subject: string; author: string }[] = [];

    for (const record of records) {
        const trimmed = record.trim();

        if (trimmed === '') {
            continue;
        }

        const [subject = '', author = ''] = trimmed.split(LOG_FIELD_SEPARATOR);
        commits.push({ subject, author });
    }

    return commits;
}

function assertSafeRepositoryPath(filePath: string): void {
    const invalid =
        filePath === '' ||
        filePath.startsWith('/') ||
        filePath.includes('\\') ||
        filePath.includes(NUL) ||
        filePath.split('/').includes('..');

    if (invalid) {
        throw new LocalGitError('read-file', `unsafe repository path "${filePath}".`);
    }
}

export { DEFAULT_BASE_CANDIDATES, HEAD_REF, MAX_CONCURRENT_PATCH_READS };
