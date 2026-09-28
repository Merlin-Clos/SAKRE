import { describe, expect, test } from 'bun:test';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { zipSync } from 'fflate';
import { type NativeAsset, NativeAssetError, type NativeAssetSource } from '../../src/native/assets';
import { CancelledError } from '../../src/analysis/cancellation';
import { materializeNativeAsset } from '../../src/native/materialize';
import { rejectionOf } from '../helpers/rejection';

const PAYLOAD = Buffer.from('fake-native-binary-payload-with-enough-bytes');

function sha256(content: Uint8Array): string {
    return createHash('sha256').update(content).digest('hex');
}

function assetOf(format: 'tar.gz' | 'zip', archive: Uint8Array, binary: Uint8Array): NativeAsset {
    let binaryPath = 'rg';
    let assetName = 'rg.tar.gz';

    if (format === 'zip') {
        binaryPath = 'rg.exe';
        assetName = 'rg.zip';
    }

    return {
        tool: 'rg',
        target: 'linux-x64',
        version: '1.2.3',
        url: `https://github.com/example/releases/download/1.2.3/${assetName}`,
        assetName,
        archiveFormat: format,
        archiveSha256: sha256(archive),
        archiveSize: archive.byteLength,
        binaryPath,
        binarySha256: sha256(binary),
        binarySize: binary.byteLength
    };
}

function tarArchive(binaryPath: string, binary: Uint8Array): Promise<Uint8Array> {
    return new Bun.Archive(
        {
            [`ripgrep-1.2.3/${binaryPath}`]: binary,
            'ripgrep-1.2.3/README.md': Buffer.from('release notes'),
            'ripgrep-1.2.3/doc/man': Buffer.from('manual')
        },
        { compress: 'gzip' }
    ).bytes();
}

function zipArchive(binaryPath: string, binary: Uint8Array): Uint8Array {
    return zipSync({
        [`ripgrep-1.2.3/${binaryPath}`]: binary,
        'ripgrep-1.2.3/README.md': Buffer.from('release notes'),
        'ripgrep-1.2.3/nested/dir/notes.txt': Buffer.from('notes')
    });
}

function sourceFor(asset: NativeAsset, archive: Uint8Array): NativeAssetSource {
    const archives = new Map([[asset.assetName, archive]]);

    return (assetName) => Promise.resolve(archives.get(assetName));
}

function missingSource(): NativeAssetSource {
    const archives = new Map<string, Uint8Array>();

    return (assetName) => Promise.resolve(archives.get(assetName));
}

async function withScratch(run: (root: string) => Promise<void>): Promise<void> {
    const root = await mkdtemp(path.join(tmpdir(), 'sakre-native-'));

    try {
        await run(root);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

describe('native asset materialization', () => {
    test('extracts a tar.gz binary, verifies it and reuses the verified entry', async () => {
        await withScratch(async (root) => {
            const archive = await tarArchive('rg', PAYLOAD);
            const asset = assetOf('tar.gz', archive, PAYLOAD);
            const source = sourceFor(asset, archive);

            const binaryPath = await materializeNativeAsset({ asset, cacheRoot: root, source });
            expect(await readFile(binaryPath)).toEqual(Buffer.from(PAYLOAD));
            expect(binaryPath).toContain(path.join('bin', 'rg', '1.2.3-'));

            const first = await stat(binaryPath);
            const reused = await materializeNativeAsset({ asset, cacheRoot: root, source });
            const second = await stat(binaryPath);
            expect(reused).toBe(binaryPath);
            expect(second.mtimeMs).toBe(first.mtimeMs);
        });
    });

    test('rebuilds a corrupted cache entry from the embedded archive', async () => {
        await withScratch(async (root) => {
            const archive = await tarArchive('rg', PAYLOAD);
            const asset = assetOf('tar.gz', archive, PAYLOAD);
            const source = sourceFor(asset, archive);

            const binaryPath = await materializeNativeAsset({ asset, cacheRoot: root, source });
            await writeFile(binaryPath, 'tampered');
            const rebuilt = await materializeNativeAsset({ asset, cacheRoot: root, source });
            expect(await readFile(rebuilt)).toEqual(Buffer.from(PAYLOAD));
        });
    });

    test('extracts a zip binary for the Windows archive format', async () => {
        await withScratch(async (root) => {
            const archive = zipArchive('rg.exe', PAYLOAD);
            const asset = assetOf('zip', archive, PAYLOAD);
            const source = sourceFor(asset, archive);

            const binaryPath = await materializeNativeAsset({ asset, cacheRoot: root, source });
            expect(path.basename(binaryPath)).toBe('rg.exe');
            expect(await readFile(binaryPath)).toEqual(Buffer.from(PAYLOAD));
        });
    });

    test('rejects an archive whose bytes do not match the manifest', async () => {
        await withScratch(async (root) => {
            const archive = await tarArchive('rg', PAYLOAD);
            const asset: NativeAsset = { ...assetOf('tar.gz', archive, PAYLOAD), archiveSha256: '0'.repeat(64) };
            const source = sourceFor(asset, archive);

            const failure = await rejectionOf(materializeNativeAsset({ asset, cacheRoot: root, source }));
            expect(failure).toBeInstanceOf(NativeAssetError);
            expect(failure.message).toContain('rg archive');
        });
    });

    test('rejects an extracted binary whose hash does not match the manifest', async () => {
        await withScratch(async (root) => {
            const archive = await tarArchive('rg', PAYLOAD);
            const asset: NativeAsset = { ...assetOf('tar.gz', archive, PAYLOAD), binarySha256: '0'.repeat(64) };
            const source = sourceFor(asset, archive);

            const failure = await rejectionOf(materializeNativeAsset({ asset, cacheRoot: root, source }));
            expect(failure).toBeInstanceOf(NativeAssetError);
            expect(failure.message).toContain('binary SHA-256 does not match the manifest');
        });
    });

    test('rejects an extracted binary whose size does not match the manifest', async () => {
        await withScratch(async (root) => {
            const archive = await tarArchive('rg', PAYLOAD);
            const asset: NativeAsset = { ...assetOf('tar.gz', archive, PAYLOAD), binarySize: PAYLOAD.byteLength + 1 };
            const source = sourceFor(asset, archive);

            const failure = await rejectionOf(materializeNativeAsset({ asset, cacheRoot: root, source }));
            expect(failure).toBeInstanceOf(NativeAssetError);
            expect(failure.message).toContain('binary size does not match the manifest');
        });
    });

    test('fails clearly when the executable was built without native assets', async () => {
        await withScratch(async (root) => {
            const archive = await tarArchive('rg', PAYLOAD);
            const asset = assetOf('tar.gz', archive, PAYLOAD);

            const failure = await rejectionOf(
                materializeNativeAsset({ asset, cacheRoot: root, source: missingSource() })
            );

            expect(failure.message).toContain('built without native assets');
        });
    });

    test('rejects archives with zero or several same-name binaries', async () => {
        await withScratch(async (root) => {
            const emptyTar = await new Bun.Archive(
                { 'ripgrep-1.2.3/README.md': Buffer.from('release notes') },
                { compress: 'gzip' }
            ).bytes();

            const emptyAsset = assetOf('tar.gz', emptyTar, PAYLOAD);

            const emptyFailure = await rejectionOf(
                materializeNativeAsset({ asset: emptyAsset, cacheRoot: root, source: sourceFor(emptyAsset, emptyTar) })
            );

            expect(emptyFailure).toBeInstanceOf(NativeAssetError);
            expect(emptyFailure.message).toContain('does not contain');

            const duplicateTar = await new Bun.Archive(
                {
                    'a/rg': PAYLOAD,
                    'b/rg': PAYLOAD,
                    'README.md': Buffer.from('release notes')
                },
                { compress: 'gzip' }
            ).bytes();

            const duplicateAsset = assetOf('tar.gz', duplicateTar, PAYLOAD);

            const duplicateFailure = await rejectionOf(
                materializeNativeAsset({
                    asset: duplicateAsset,
                    cacheRoot: root,
                    source: sourceFor(duplicateAsset, duplicateTar)
                })
            );

            expect(duplicateFailure).toBeInstanceOf(NativeAssetError);
            expect(duplicateFailure.message).toContain('more than one');

            const duplicateZip = zipSync({
                'a/rg.exe': PAYLOAD,
                'b/rg.exe': PAYLOAD,
                'README.md': Buffer.from('release notes')
            });

            const duplicateZipAsset = assetOf('zip', duplicateZip, PAYLOAD);

            const duplicateZipFailure = await rejectionOf(
                materializeNativeAsset({
                    asset: duplicateZipAsset,
                    cacheRoot: root,
                    source: sourceFor(duplicateZipAsset, duplicateZip)
                })
            );

            expect(duplicateZipFailure).toBeInstanceOf(NativeAssetError);
            expect(duplicateZipFailure.message).toContain('more than one');
        });
    });

    test('rebuilds a same-size tampered cache entry', async () => {
        await withScratch(async (root) => {
            const archive = await tarArchive('rg', PAYLOAD);
            const asset = assetOf('tar.gz', archive, PAYLOAD);
            const source = sourceFor(asset, archive);

            const binaryPath = await materializeNativeAsset({ asset, cacheRoot: root, source });
            const tampered = Buffer.from(PAYLOAD);

            if (tampered[0] === 0) {
                tampered[0] = 1;
            } else {
                tampered[0] = 0;
            }

            expect(tampered.byteLength).toBe(PAYLOAD.byteLength);
            await writeFile(binaryPath, tampered);
            const rebuilt = await materializeNativeAsset({ asset, cacheRoot: root, source });
            expect(await readFile(rebuilt)).toEqual(Buffer.from(PAYLOAD));
        });
    });

    test('fails fast on an aborted signal', async () => {
        await withScratch(async (root) => {
            const archive = await tarArchive('rg', PAYLOAD);
            const asset = assetOf('tar.gz', archive, PAYLOAD);
            const source = sourceFor(asset, archive);

            const aborted = await rejectionOf(
                materializeNativeAsset({ asset, cacheRoot: root, source, signal: AbortSignal.abort() })
            );

            expect(aborted).toBeInstanceOf(CancelledError);

            const healthy = await materializeNativeAsset({
                asset,
                cacheRoot: root,
                source,
                signal: new AbortController().signal
            });

            expect(await readFile(healthy)).toEqual(Buffer.from(PAYLOAD));
        });
    });

    test('restores the executable mode on reuse', async () => {
        await withScratch(async (root) => {
            const archive = await tarArchive('rg', PAYLOAD);
            const asset = assetOf('tar.gz', archive, PAYLOAD);
            const source = sourceFor(asset, archive);

            const binaryPath = await materializeNativeAsset({ asset, cacheRoot: root, source });
            await chmod(binaryPath, 0o644);
            const reused = await materializeNativeAsset({ asset, cacheRoot: root, source });

            if (process.platform !== 'win32') {
                const stats = await stat(reused);
                // eslint-disable-next-line no-bitwise -- executable bits are a bitmask
                expect(stats.mode & 0o111).not.toBe(0);
            }
        });
    });
});
