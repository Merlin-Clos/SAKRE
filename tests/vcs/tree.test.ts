import { expect, test } from 'bun:test';
import { parseTreeListing } from '../../src/vcs/tree';

const NUL = '\0';

const BLOB_SHA = 'a'.repeat(40);

function record(path: string, options: { mode?: string; size?: string; type?: string } = {}): string {
    const mode = options.mode ?? '100644';
    const size = options.size ?? '3';
    const type = options.type ?? 'blob';

    return `${mode} ${type} ${BLOB_SHA} ${size}\t${path}${NUL}`;
}

test('parses a long ls-tree listing with deterministic path order', () => {
    const output = [
        record('src/z.ts', { size: '12' }),
        record('scripts/run.sh', { mode: '100755', size: '7' }),
        record('README.md')
    ].join('');

    const listing = parseTreeListing(output);
    expect(listing.files).toEqual([
        { path: 'README.md', blobSha: BLOB_SHA },
        { path: 'scripts/run.sh', blobSha: BLOB_SHA },
        { path: 'src/z.ts', blobSha: BLOB_SHA }
    ]);
});

test('excludes symlinks and gitlinks instead of following them', () => {
    const output = [
        record('links/escape', { mode: '120000', size: '11' }),
        record('vendor/submodule', { mode: '160000', size: '-', type: 'commit' }),
        record('src/app.ts', { size: '5' })
    ].join('');

    const listing = parseTreeListing(output);
    expect(listing.files).toEqual([{ path: 'src/app.ts', blobSha: BLOB_SHA }]);
});

test('ignores malformed records without inventing entries', () => {
    const output = ['garbage', record('src/app.ts', { size: 'oops' }), ''].join(NUL);
    const listing = parseTreeListing(output);
    expect(listing.files).toEqual([]);
});
