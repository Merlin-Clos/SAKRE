import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { extractArchiveBinary } from '../src/native/materialize';
import { type NativeArchiveFormat, type NativeTool, parseNativeAssetManifest } from '../src/native/assets';
import { type NativeTarget, nativeTargets } from '../src/native/platform';

/* Regenerates native-assets.json from the official releases. Version bumps are
   manual, reviewed changes: run this script with the new versions, then run
   `bun run verify:native --target <target>` and rebuild the artifacts. */
const MANIFEST_PATH = 'native-assets.json';

const JSON_INDENT = 4;

const RG_HOST = 'https://github.com/BurntSushi/ripgrep/releases/download';

const SCC_HOST = 'https://github.com/boyter/scc/releases/download';

const CCCC_HOST = 'https://github.com/moznion/cccc/releases/download';

const RG_TAG_PREFIX = '';

const SCC_TAG_PREFIX = 'v';

const CCCC_TAG_PREFIX = 'v';

const RG_ASSETS: Record<NativeTarget, { name: (version: string) => string; binaryPath: string }> = {
    'linux-x64': { name: (version) => `ripgrep-${version}-x86_64-unknown-linux-musl.tar.gz`, binaryPath: 'rg' },
    'linux-arm64': { name: (version) => `ripgrep-${version}-aarch64-unknown-linux-gnu.tar.gz`, binaryPath: 'rg' },
    'darwin-x64': { name: (version) => `ripgrep-${version}-x86_64-apple-darwin.tar.gz`, binaryPath: 'rg' },
    'darwin-arm64': { name: (version) => `ripgrep-${version}-aarch64-apple-darwin.tar.gz`, binaryPath: 'rg' },
    'windows-x64': { name: (version) => `ripgrep-${version}-x86_64-pc-windows-msvc.zip`, binaryPath: 'rg.exe' }
};

const SCC_ASSETS: Record<NativeTarget, { name: (version: string) => string; binaryPath: string }> = {
    'linux-x64': { name: () => 'scc_Linux_x86_64.tar.gz', binaryPath: 'scc' },
    'linux-arm64': { name: () => 'scc_Linux_arm64.tar.gz', binaryPath: 'scc' },
    'darwin-x64': { name: () => 'scc_Darwin_x86_64.tar.gz', binaryPath: 'scc' },
    'darwin-arm64': { name: () => 'scc_Darwin_arm64.tar.gz', binaryPath: 'scc' },
    'windows-x64': { name: () => 'scc_Windows_x86_64.zip', binaryPath: 'scc.exe' }
};

/* CCCC release asset names embed the version with its tag prefix. */
const CCCC_ASSETS: Record<NativeTarget, { name: (version: string) => string; binaryPath: string }> = {
    'linux-x64': { name: (version) => `cccc-v${version}-x86_64-unknown-linux-musl.tar.gz`, binaryPath: 'cccc' },
    'linux-arm64': { name: (version) => `cccc-v${version}-aarch64-unknown-linux-musl.tar.gz`, binaryPath: 'cccc' },
    'darwin-x64': { name: (version) => `cccc-v${version}-x86_64-apple-darwin.tar.gz`, binaryPath: 'cccc' },
    'darwin-arm64': { name: (version) => `cccc-v${version}-aarch64-apple-darwin.tar.gz`, binaryPath: 'cccc' },
    'windows-x64': { name: (version) => `cccc-v${version}-x86_64-pc-windows-msvc.zip`, binaryPath: 'cccc.exe' }
};

interface RawTargetEntry {
    target: NativeTarget;
    url: string;
    archiveSha256: string;
    archiveSize: number;
    archiveFormat: NativeArchiveFormat;
    binaryPath: string;
    binarySha256: string;
    binarySize: number;
}

interface RawToolEntry {
    version: string;
    targets: RawTargetEntry[];
}

const toolVersionSchema = z.object({ version: z.string() });

const currentManifestSchema = z.object({
    tools: z.record(z.string(), toolVersionSchema)
});

interface ToolVersions {
    rg: string;
    scc: string;
    cccc: string;
}

async function main(): Promise<void> {
    const current = currentManifestSchema.parse(JSON.parse(await readFile(MANIFEST_PATH, 'utf8')));
    const versions = resolveVersions(current);
    const manifest = await buildManifest(versions);
    parseNativeAssetManifest(manifest);
    await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, undefined, JSON_INDENT)}\n`, 'utf8');
    console.log(`Updated ${MANIFEST_PATH}: rg ${versions.rg}, scc ${versions.scc}, cccc ${versions.cccc}.`);
}

function resolveVersions(current: z.infer<typeof currentManifestSchema>): ToolVersions {
    const rg = argument('--rg') ?? current.tools.rg?.version;
    const scc = argument('--scc') ?? current.tools.scc?.version;
    const cccc = argument('--cccc') ?? current.tools.cccc?.version;

    if (rg === undefined || scc === undefined || cccc === undefined) {
        throw new Error('Each tool needs a version from the current manifest or an explicit --<tool> argument.');
    }

    return { rg, scc, cccc };
}

/* All three tools are pinned from the same run so the manifest always describes
   one consistent release set. */
async function buildManifest(versions: ToolVersions): Promise<{
    schemaVersion: 1;
    tools: { rg: RawToolEntry; scc: RawToolEntry; cccc: RawToolEntry };
}> {
    const [rg, scc, cccc] = await Promise.all([
        buildTool({ tool: 'rg', version: versions.rg, host: RG_HOST, tagPrefix: RG_TAG_PREFIX, assets: RG_ASSETS }),
        buildTool({
            tool: 'scc',
            version: versions.scc,
            host: SCC_HOST,
            tagPrefix: SCC_TAG_PREFIX,
            assets: SCC_ASSETS
        }),
        buildTool({
            tool: 'cccc',
            version: versions.cccc,
            host: CCCC_HOST,
            tagPrefix: CCCC_TAG_PREFIX,
            assets: CCCC_ASSETS
        })
    ]);

    return { schemaVersion: 1, tools: { rg, scc, cccc } };
}

interface BuildToolInput {
    tool: NativeTool;
    version: string;
    host: string;
    tagPrefix: string;
    assets: Record<NativeTarget, { name: (version: string) => string; binaryPath: string }>;
}

async function buildTool(input: BuildToolInput): Promise<RawToolEntry> {
    const { tool, version, host, tagPrefix, assets } = input;

    const entries = await Promise.all(
        nativeTargets.map(async (target) => {
            const spec = assets[target];
            const assetName = spec.name(version);
            const url = `${host}/${tagPrefix}${version}/${assetName}`;
            const archive = await download(url);
            let archiveFormat: NativeArchiveFormat = 'tar.gz';

            if (assetName.endsWith('.zip')) {
                archiveFormat = 'zip';
            }

            const binary = await extractArchiveBinary(
                {
                    tool,
                    target,
                    version,
                    url,
                    assetName,
                    archiveFormat,
                    archiveSha256: sha256(archive),
                    archiveSize: archive.byteLength,
                    binaryPath: spec.binaryPath,
                    binarySha256: '',
                    binarySize: 0
                },
                archive
            );

            console.log(`${tool}/${target}: archive ${archive.byteLength} B, binary ${binary.byteLength} B.`);

            return {
                target,
                url,
                archiveSha256: sha256(archive),
                archiveSize: archive.byteLength,
                archiveFormat,
                binaryPath: spec.binaryPath,
                binarySha256: sha256(binary),
                binarySize: binary.byteLength
            } satisfies RawTargetEntry;
        })
    );

    return { version, targets: [...entries] };
}

async function download(url: string): Promise<Uint8Array> {
    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(`Failed to download ${url}: HTTP ${response.status}.`);
    }

    return new Uint8Array(await response.arrayBuffer());
}

function argument(name: string): string | undefined {
    const index = process.argv.indexOf(name);

    if (index === -1) {
        return undefined;
    }

    const value = process.argv[index + 1];

    if (value === undefined || value === '') {
        throw new Error(`${name} requires a value.`);
    }

    return value;
}

function sha256(content: Uint8Array): string {
    return createHash('sha256').update(content).digest('hex');
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
