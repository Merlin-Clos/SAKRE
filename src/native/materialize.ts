import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { CancelledError } from '../analysis/cancellation';
import { describeError } from '../errors';
import { type NativeAsset, NativeAssetError, type NativeAssetSource } from './assets';
import { nativeToolDirectory } from './cache-paths';

const EXECUTABLE_MODE = 0o755;

export interface MaterializeNativeAssetOptions {
    asset: NativeAsset;
    cacheRoot: string;
    source: NativeAssetSource;
    signal?: AbortSignal;
}

/* Materializes one embedded asset into the platform cache: verify archive,
   extract the pinned binary, verify the binary, then install it atomically. An
   existing entry is reused only when its bytes still match the manifest, so a
   tampered or truncated entry is rebuilt from the embedded archive without
   network access. */
export async function materializeNativeAsset(options: MaterializeNativeAssetOptions): Promise<string> {
    throwIfAborted(options.signal);

    const directory = nativeToolDirectory({
        cacheRoot: options.cacheRoot,
        tool: options.asset.tool,
        version: options.asset.version,
        binarySha256: options.asset.binarySha256
    });

    const destination = path.join(directory, options.asset.binaryPath);

    if (await matchesDestination(destination, options.asset)) {
        await ensureExecutable(destination);

        return destination;
    }

    await installFromArchive(options, destination);

    return destination;
}

async function installFromArchive(options: MaterializeNativeAssetOptions, destination: string): Promise<void> {
    const binary = await readBinaryFromArchive(options);
    await installExecutable(destination, binary);
}

async function readBinaryFromArchive(options: MaterializeNativeAssetOptions): Promise<Uint8Array> {
    const bytes = await options.source(options.asset.assetName);

    if (bytes === undefined) {
        throw new NativeAssetError(
            `The embedded ${options.asset.tool} archive (${options.asset.assetName}) is unavailable; this executable was built without native assets.`
        );
    }

    throwIfAborted(options.signal);

    return verifyNativeAssetArchive(options.asset, bytes);
}

/* Build-time and runtime share one verification path: archive hash and size
   first, then the extracted binary hash and size. */
export async function verifyNativeAssetArchive(asset: NativeAsset, archive: Uint8Array): Promise<Uint8Array> {
    assertContent({
        content: archive,
        expectedSha256: asset.archiveSha256,
        expectedSize: asset.archiveSize,
        label: `${asset.tool} archive`
    });
    const binary = await extractBinary(asset, archive);
    assertContent({
        content: binary,
        expectedSha256: asset.binarySha256,
        expectedSize: asset.binarySize,
        label: `${asset.tool} binary`
    });

    return binary;
}

/* Extraction without a pinned hash: the manifest regeneration script computes
   new hashes from the official archives, then the result is parsed and pinned. */
export function extractArchiveBinary(asset: NativeAsset, archive: Uint8Array): Promise<Uint8Array> {
    return extractBinary(asset, archive);
}

function extractBinary(asset: NativeAsset, archive: Uint8Array): Promise<Uint8Array> {
    if (asset.archiveFormat === 'zip') {
        return Promise.resolve(extractFromZip(asset, archive));
    }

    return extractFromTar(asset, archive);
}

async function extractFromTar(asset: NativeAsset, archive: Uint8Array): Promise<Uint8Array> {
    const entries = await new Bun.Archive(archive).files();
    const matches = [...entries.entries()].filter(([name]) => path.posix.basename(name) === asset.binaryPath);
    const match = singleMatch(asset, matches);

    return new Uint8Array(await match[1].arrayBuffer());
}

function extractFromZip(asset: NativeAsset, archive: Uint8Array): Uint8Array {
    const entries = unzipSync(archive);
    const matches = Object.entries(entries).filter(([name]) => path.posix.basename(name) === asset.binaryPath);
    const match = singleMatch(asset, matches);

    return match[1];
}

/* Manifest pins exactly one binary per archive; anything else is a build
   or manifest error, never a choice to make at runtime. */
function singleMatch<Entry>(asset: NativeAsset, matches: readonly [string, Entry][]): [string, Entry] {
    const [match] = matches;

    if (match === undefined) {
        throw missingBinaryError(asset);
    }

    if (matches.length > 1) {
        throw repeatedBinaryError(asset);
    }

    return match;
}

function repeatedBinaryError(asset: NativeAsset): NativeAssetError {
    return new NativeAssetError(`The ${asset.tool} archive contains more than one ${asset.binaryPath}.`);
}

function missingBinaryError(asset: NativeAsset): NativeAssetError {
    return new NativeAssetError(`The ${asset.tool} archive does not contain ${asset.binaryPath}.`);
}

interface ExpectedContent {
    content: Uint8Array;
    expectedSha256: string;
    expectedSize: number;
    label: string;
}

function assertContent(input: ExpectedContent): void {
    if (input.content.byteLength !== input.expectedSize) {
        throw new NativeAssetError(`${input.label} size does not match the manifest.`);
    }

    const actual = createHash('sha256').update(input.content).digest('hex');

    if (actual !== input.expectedSha256) {
        throw new NativeAssetError(`${input.label} SHA-256 does not match the manifest.`);
    }
}

async function matchesDestination(filePath: string, asset: NativeAsset): Promise<boolean> {
    try {
        const content = await readFile(filePath);

        return content.byteLength === asset.binarySize && digestOf(content) === asset.binarySha256;
    } catch {
        return false;
    }
}

function digestOf(content: Uint8Array): string {
    return createHash('sha256').update(content).digest('hex');
}

/* Atomic install: a concurrent process writes the same verified payload to a
   unique temporary file and the last rename wins without exposing a partial
   binary. */
async function installExecutable(destination: string, binary: Uint8Array): Promise<void> {
    await mkdir(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;

    try {
        await writeFile(temporary, binary, { mode: EXECUTABLE_MODE });
        await ensureExecutable(temporary);
        await rename(temporary, destination);
    } catch (error) {
        await rm(temporary, { force: true });
        throw new NativeAssetError(`Failed to install the native binary: ${describeError(error)}`);
    }
}

async function ensureExecutable(filePath: string): Promise<void> {
    if (process.platform === 'win32') {
        return;
    }

    await chmod(filePath, EXECUTABLE_MODE);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted === true) {
        throw new CancelledError();
    }
}
