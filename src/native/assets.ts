import path from 'node:path';
import { z } from 'zod';
import { type NativeTarget, nativeTargets } from './platform';

export const nativeTools = ['rg', 'scc', 'cccc'] as const;

export type NativeTool = (typeof nativeTools)[number];

export type NativeArchiveFormat = 'tar.gz' | 'zip';

export class NativeAssetError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = 'NativeAssetError';
    }
}

export interface NativeAsset {
    tool: NativeTool;
    target: NativeTarget;
    version: string;
    url: string;
    assetName: string;
    archiveFormat: NativeArchiveFormat;
    archiveSha256: string;
    archiveSize: number;
    binaryPath: string;
    binarySha256: string;
    binarySize: number;
}

export interface NativeToolManifest {
    version: string;
    assets: ReadonlyMap<NativeTarget, NativeAsset>;
}

export interface NativeAssetManifest {
    tools: ReadonlyMap<NativeTool, NativeToolManifest>;
}

const sha256Pattern = /^[a-f0-9]{64}$/u;

const versionPattern = /^\d+\.\d+\.\d+$/u;

const releaseHost = 'github.com';

const nativeAssetSchema = z.strictObject({
    target: z.enum(nativeTargets),
    url: z.url(),
    archiveSha256: z.string().regex(sha256Pattern),
    archiveSize: z.int().positive(),
    archiveFormat: z.enum(['tar.gz', 'zip']),
    binaryPath: z.string().min(1),
    binarySha256: z.string().regex(sha256Pattern),
    binarySize: z.int().positive()
});

const nativeToolSchema = z.strictObject({
    version: z.string().regex(versionPattern),
    targets: z.array(nativeAssetSchema).min(1)
});

const manifestSchema = z.strictObject({
    schemaVersion: z.literal(1),
    tools: z.record(z.enum(nativeTools), nativeToolSchema)
});

/* Strict parse plus the invariants the release gates rely on: every tool pins
   all five targets exactly once, each archive comes from the official GitHub
   release of its declared version, and the binary path is a plain file name
   (never a traversal path from a hostile manifest). */
// eslint-disable-next-line anti-slop/no-unknown-parameters -- untrusted manifest entry parsed via Zod below
export function parseNativeAssetManifest(value: unknown): NativeAssetManifest {
    const parsed = manifestSchema.safeParse(value);

    if (!parsed.success) {
        throw new NativeAssetError(`Invalid native asset manifest: ${parsed.error.message}`);
    }

    const tools = new Map<NativeTool, NativeToolManifest>();

    for (const tool of nativeTools) {
        tools.set(tool, parseToolManifest(tool, parsed.data.tools[tool]));
    }

    return { tools };
}

function parseToolManifest(
    tool: NativeTool,
    entry: { version: string; targets: z.infer<typeof nativeAssetSchema>[] }
): NativeToolManifest {
    const assets = new Map<NativeTarget, NativeAsset>();

    for (const raw of entry.targets) {
        const asset = buildAsset(tool, entry.version, raw);

        if (assets.has(asset.target)) {
            throw new NativeAssetError(`Native asset manifest repeats ${tool}/${asset.target}.`);
        }

        assets.set(asset.target, asset);
    }

    for (const target of nativeTargets) {
        if (!assets.has(target)) {
            throw new NativeAssetError(`Native asset manifest is missing ${tool}/${target}.`);
        }
    }

    return { version: entry.version, assets };
}

function buildAsset(tool: NativeTool, version: string, raw: z.infer<typeof nativeAssetSchema>): NativeAsset {
    const url = new URL(raw.url);

    if (url.protocol !== 'https:' || url.hostname !== releaseHost) {
        throw new NativeAssetError(`Native asset ${tool}/${raw.target} does not come from ${releaseHost}.`);
    }

    const pathSegments = url.pathname.split('/');

    if (!pathSegments.includes(version) && !pathSegments.includes(`v${version}`)) {
        throw new NativeAssetError(`Native asset ${tool}/${raw.target} URL does not name version ${version}.`);
    }

    if (path.posix.basename(raw.binaryPath) !== raw.binaryPath) {
        throw new NativeAssetError(`Native asset ${tool}/${raw.target} binary path is not a file name.`);
    }

    return {
        tool,
        target: raw.target,
        version,
        url: raw.url,
        assetName: path.posix.basename(url.pathname),
        archiveFormat: raw.archiveFormat,
        archiveSha256: raw.archiveSha256,
        archiveSize: raw.archiveSize,
        binaryPath: raw.binaryPath,
        binarySha256: raw.binarySha256,
        binarySize: raw.binarySize
    };
}

/* Pinned version of one tool; used for the ReviewMap tool metadata. */
export function nativeToolVersion(manifest: NativeAssetManifest, tool: NativeTool): string {
    return manifest.tools.get(tool)?.version ?? 'unknown';
}

export function nativeAssetFor(manifest: NativeAssetManifest, tool: NativeTool, target: NativeTarget): NativeAsset {
    const asset = manifest.tools.get(tool)?.assets.get(target);

    if (asset === undefined) {
        throw new NativeAssetError(`Native asset manifest has no ${tool}/${target} entry.`);
    }

    return asset;
}

/* Reads an archive embedded with `bun build --compile --asset` by matching the
   manifest's archive name. Source runs and tests have no embedded files and
   get undefined, so the caller can inject a source instead. */
export type NativeAssetSource = (assetName: string) => Promise<Uint8Array | undefined>;

export function embeddedAssetSource(): NativeAssetSource {
    const files = embeddedFiles();

    return async (assetName) => {
        const blob = files.find(
            (candidate) => candidate.name === assetName || candidate.name.endsWith(`/${assetName}`)
        );

        if (blob === undefined) {
            // eslint-disable-next-line unicorn/no-useless-undefined -- undefined means "not embedded"
            return undefined;
        }

        return new Uint8Array(await blob.arrayBuffer());
    };
}

interface EmbeddedBlob {
    name: string;
    arrayBuffer: () => Promise<ArrayBuffer>;
}

function embeddedFiles(): EmbeddedBlob[] {
    // SAFETY: Bun-only global is optional here; absence yields an empty list via the Array.isArray guard below, and entries are re-validated by isEmbeddedBlob.
    const runtime = (globalThis as { Bun?: { embeddedFiles?: readonly unknown[] } }).Bun;
    const entries = runtime?.embeddedFiles;

    if (!Array.isArray(entries)) {
        return [];
    }

    return entries.filter((entry) => isEmbeddedBlob(entry));
}

function isEmbeddedBlob(value: unknown): value is EmbeddedBlob {
    return (
        typeof value === 'object' &&
        value !== null &&
        'name' in value &&
        typeof value.name === 'string' &&
        'arrayBuffer' in value &&
        typeof value.arrayBuffer === 'function'
    );
}
