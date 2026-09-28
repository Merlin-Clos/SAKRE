import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type NativeAsset, nativeAssetFor, nativeTools } from '../src/native/assets';
import { verifyNativeAssetArchive } from '../src/native/materialize';
import { type NativeTarget, nativeTargets } from '../src/native/platform';
import { pinnedNativeAssetManifest } from '../src/native/runtime';

export interface VerifiedNativeArchive {
    asset: NativeAsset;
    path: string;
}

/* Downloads the pinned release archives for one target, verifies archive and
   binary hashes through the same path the runtime uses, and writes the
   verified archives into `directory` for embedding. */
export function downloadVerifiedArchives(input: {
    target: NativeTarget;
    directory: string;
    /* When set, the verified binaries are also written there for tools (such as
       the intelligence benchmark) that run the tools directly. */
    binaryDirectory?: string;
}): Promise<VerifiedNativeArchive[]> {
    return Promise.all(
        nativeTools.map(async (tool) => {
            const asset = nativeAssetFor(pinnedNativeAssetManifest, tool, input.target);
            const archive = await fetchArchive(asset.url);
            const binary = await verifyNativeAssetArchive(asset, archive);
            const filePath = path.join(input.directory, asset.assetName);
            await writeFile(filePath, archive);

            if (input.binaryDirectory !== undefined) {
                await mkdir(input.binaryDirectory, { recursive: true });
                await writeFile(path.join(input.binaryDirectory, asset.binaryPath), binary, { mode: 0o755 });
            }

            console.log(
                `Verified ${tool} ${asset.version} for ${input.target}: archive ${archive.byteLength} B, binary ${binary.byteLength} B.`
            );

            return { asset, path: filePath };
        })
    );
}

const EXPOSE_DIR_TOKENS = 2;

export interface VerifyArguments {
    targets: NativeTarget[];
    exposeDirectory?: string;
}

export function parseVerifyArguments(args: readonly string[]): VerifyArguments {
    const parsed = parseAllArguments(args);
    let targets = [...nativeTargets];

    if (parsed.requested.length > 0) {
        targets = [...new Set(parsed.requested)];
    }

    if (parsed.exposeDirectory === undefined) {
        return { targets };
    }

    return { targets, exposeDirectory: parsed.exposeDirectory };
}

interface ParsedAllArguments {
    requested: NativeTarget[];
    exposeDirectory?: string;
}

function parseAllArguments(args: readonly string[]): ParsedAllArguments {
    const requested: NativeTarget[] = [];
    const state: { exposeDirectory?: string } = {};
    let index = 0;

    while (index < args.length) {
        const parsed = parseArgument(args, index);
        applyParsedArgument(parsed, requested, state);
        index = parsed.nextIndex;
    }

    return { requested, exposeDirectory: state.exposeDirectory };
}

function applyParsedArgument(
    parsed: ParsedArgument,
    requested: NativeTarget[],
    state: { exposeDirectory?: string }
): void {
    if (parsed.requestedTarget !== undefined) {
        requested.push(parsed.requestedTarget);
    }

    if (parsed.exposeDirectory !== undefined) {
        state.exposeDirectory = parsed.exposeDirectory;
    }
}

interface ParsedArgument {
    requestedTarget?: NativeTarget;
    exposeDirectory?: string;
    nextIndex: number;
}

function parseArgument(args: readonly string[], index: number): ParsedArgument {
    const argument = args[index] ?? '';

    if (argument === '--expose-dir' || argument.startsWith('--expose-dir=')) {
        const parsed = parseExposeDirectory(args, index, argument);

        return { exposeDirectory: parsed.directory, nextIndex: index + parsed.consumed };
    }

    const target = parseTargetArgument(args, index);

    return { requestedTarget: target.target, nextIndex: target.nextIndex };
}

function parseExposeDirectory(
    args: readonly string[],
    index: number,
    argument: string
): { directory: string; consumed: number } {
    if (argument.startsWith('--expose-dir=')) {
        const directory = argument.slice('--expose-dir='.length);

        if (directory === '') {
            throw new Error('--expose-dir requires a value.');
        }

        return { directory, consumed: 1 };
    }

    const value = args[index + 1];

    /* An option token is never a directory: consuming it would silently change
       the verification scope of the following flag. */
    if (value === undefined || value === '' || value.startsWith('--')) {
        throw new Error('--expose-dir requires a value.');
    }

    return { directory: value, consumed: EXPOSE_DIR_TOKENS };
}

export function requestedTargets(args: readonly string[]): NativeTarget[] {
    return parseVerifyArguments(args).targets;
}

function parseTargetArgument(args: readonly string[], index: number): { target: NativeTarget; nextIndex: number } {
    const argument = args[index] ?? '';

    if (argument === '--target') {
        const value = args[index + 1];

        if (value === undefined) {
            throw new Error('--target requires a value.');
        }

        return { target: requireTarget(value), nextIndex: index + 2 };
    }

    if (argument.startsWith('--target=')) {
        return { target: requireTarget(argument.slice('--target='.length)), nextIndex: index + 1 };
    }

    throw new Error(`Unknown argument: ${argument}`);
}

function requireTarget(value: string): NativeTarget {
    const target = nativeTargets.find((candidate) => candidate === value);

    if (target === undefined) {
        throw new Error(`Unknown native target "${value}". Expected one of: ${nativeTargets.join(', ')}.`);
    }

    return target;
}

async function fetchArchive(url: string): Promise<Uint8Array> {
    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(`Failed to download ${url}: HTTP ${response.status}.`);
    }

    return new Uint8Array(await response.arrayBuffer());
}

async function main(): Promise<void> {
    const { targets, exposeDirectory } = parseVerifyArguments(process.argv.slice(2));
    const root = await mkdtemp(path.join(tmpdir(), 'sakre-native-verify-'));

    try {
        await Promise.all(
            targets.map(async (target) => {
                const directory = path.join(root, target);
                await mkdir(directory, { recursive: true });
                await downloadVerifiedArchives({ target, directory, binaryDirectory: exposeDirectory });
            })
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }

    console.log(`Verified native assets for: ${targets.join(', ')}.`);
}

// eslint-disable-next-line anti-slop/no-unknown-parameters -- catch-path normalizer; narrows with instanceof before use
function describeError(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }

    return String(error);
}

if (import.meta.main) {
    try {
        await main();
    } catch (error) {
        console.error(describeError(error));
        process.exit(1);
    }
}
