import { createGitRunner, gitOutput } from './git-command';

const NUL = '\0';

const SYMLINK_MODE = '120000';

const BLOB_TYPE = 'blob';

const LONG_RECORD_PARTS = 4;

/* One tracked blob of a tree as returned by `git ls-tree -l`: the canonical
   input list for the measurement tools. Gitlinks and symlinks never enter it
   and are never followed. */
export interface TreeFile {
    path: string;
    /* Blob object id; equal ids mean byte-identical content, which the
       classification reuses to skip a second prefix read. */
    blobSha: string;
}

export interface TreeListing {
    files: TreeFile[];
}

/* Canonical, deterministic file list straight from the VCS layer. Sorted by
   path; symlinks are excluded and never followed. */
export async function listTreeFiles(options: {
    directory: string;
    sha: string;
    signal?: AbortSignal;
}): Promise<TreeListing> {
    const git = createGitRunner(options.directory);

    const output = await gitOutput({
        runner: git,
        operation: `ls-tree ${options.sha}`,
        args: ['ls-tree', '-r', '-l', '-z', options.sha],
        signal: options.signal
    });

    return parseTreeListing(output);
}

export function parseTreeListing(output: string): TreeListing {
    const files = output
        .split(NUL)
        .map((record) => parseTreeRecord(record))
        .filter((file): file is TreeFile => file !== undefined)
        .toSorted((left, right) => left.path.localeCompare(right.path));

    return { files };
}

/* `<mode> SP <type> SP <sha> SP <size> TAB <path>`; only blobs with a numeric
   size are retained, which excludes trees and gitlinks. Symlink is a blob and
   is dropped explicitly: its target must never enter an analysis tree. */
function parseTreeRecord(record: string): TreeFile | undefined {
    const tab = record.indexOf('\t');

    if (tab === -1) {
        return undefined;
    }

    /* `ls-tree -l` right-aligns the size with spaces, so the header must be
       split on runs of whitespace. */
    const fields = record.slice(0, tab).trim().split(/\s+/u);
    const filePath = record.slice(tab + 1);

    if (fields.length !== LONG_RECORD_PARTS || filePath === '') {
        return undefined;
    }

    return buildTreeFile(fields, filePath);
}

function buildTreeFile(fields: string[], filePath: string): TreeFile | undefined {
    const [mode = '', type = '', blobSha = '', sizeRaw = ''] = fields;
    const size = parseBlobSize(sizeRaw);

    if (type !== BLOB_TYPE || size === undefined || mode === SYMLINK_MODE || blobSha === '') {
        return undefined;
    }

    return { path: filePath, blobSha };
}

function parseBlobSize(raw: string): number | undefined {
    const size = Math.trunc(Number(raw));

    if (!Number.isFinite(size)) {
        return undefined;
    }

    return size;
}
