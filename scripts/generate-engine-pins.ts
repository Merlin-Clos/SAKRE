import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { nativeTargets, releaseCompressedArtifactName } from '../src/native/platform';

const DEFAULT_DIRECTORY = 'dist-release';

const DEFAULT_OUTPUT = 'engine-pins.json';

const RELEASE_TAG_PATTERN = /^v\d+\.\d+\.\d+$/u;

const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

const JSON_INDENT = 4;

/* The composite Action verifies each downloaded engine against this manifest with a line-oriented `sed` parse, so the shape
   below is the parsing contract: the tag on one line and each asset digest on one line. The release workflow regenerates
   the file from the verified artifacts after the artifact tests pass. */
export function enginePinsContent(tag: string, digests: ReadonlyMap<string, string>): string {
    if (!RELEASE_TAG_PATTERN.test(tag)) {
        throw new Error(`The release tag must look like v1.2.3, got "${tag}".`);
    }

    const assets = buildAssets(digests);

    if (Object.keys(assets).length === 0) {
        throw new Error('No engine artifacts were found to pin.');
    }

    return `${JSON.stringify({ tag, assets }, null, JSON_INDENT)}\n`;
}

/* The composite Action downloads the compressed asset, decompresses it and verifies the engine against this manifest, so the
   pinned digest is the digest of the standalone binary, not of the .gz wrapper. */
export async function hashEngineArtifacts(directory: string): Promise<Map<string, string>> {
    const names = nativeTargets.map((target) => releaseCompressedArtifactName(target));

    const entries = await Promise.all(
        names.map(async (name): Promise<[string, string] | undefined> => {
            const file = path.join(directory, name);

            if (!(await isFile(file))) {
                return undefined;
            }

            return [name, sha256(Bun.gunzipSync(await readFile(file)))];
        })
    );

    return new Map(entries.filter((entry): entry is [string, string] => entry !== undefined));
}

function buildAssets(digests: ReadonlyMap<string, string>): Record<string, string> {
    const names = nativeTargets
        .map((target) => releaseCompressedArtifactName(target))
        .filter((name) => digests.has(name));

    return Object.fromEntries(names.map((name) => [name, requireDigest(name, digests.get(name) ?? '')]));
}

function requireDigest(name: string, digest: string): string {
    if (!DIGEST_PATTERN.test(digest)) {
        throw new Error(`The SHA-256 pin for ${name} must be 64 lowercase hex characters.`);
    }

    return digest;
}

interface GenerateOptions {
    tag: string;
    directory: string;
    output: string;
}

async function isFile(file: string): Promise<boolean> {
    try {
        const fileStat = await stat(file);

        return fileStat.isFile();
    } catch {
        return false;
    }
}

function sha256(content: Uint8Array): string {
    return createHash('sha256').update(content).digest('hex');
}

function readOptionPairs(args: readonly string[]): Map<string, string> {
    const values = new Map<string, string>();

    for (let index = 0; index < args.length; index += 2) {
        const name = args[index] ?? '';
        const value = args[index + 1];

        if (!name.startsWith('--') || value === undefined) {
            throw new Error(`Unknown argument: ${name}`);
        }

        values.set(name.slice(2), value);
    }

    return values;
}

function parseArguments(args: readonly string[]): GenerateOptions {
    const values = readOptionPairs(args);
    const tag = values.get('tag') ?? '';

    if (tag === '') {
        throw new Error('--tag <vX.Y.Z> is required.');
    }

    return {
        tag,
        directory: values.get('directory') ?? DEFAULT_DIRECTORY,
        output: values.get('output') ?? DEFAULT_OUTPUT
    };
}

async function main(): Promise<void> {
    const options = parseArguments(process.argv.slice(2));
    const digests = await hashEngineArtifacts(options.directory);

    if (digests.size === 0) {
        throw new Error(`No engine artifacts found in ${options.directory}.`);
    }

    await writeFile(options.output, enginePinsContent(options.tag, digests), 'utf8');
    console.log(`Wrote ${options.output} for ${options.tag}: ${digests.size} target(s).`);
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
