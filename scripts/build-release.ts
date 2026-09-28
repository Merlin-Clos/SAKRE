import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertPinnedBunVersion } from './bun-version';
import { downloadVerifiedArchives, requestedTargets } from './verify-native-assets';
import { bunCompileTarget, type NativeTarget, releaseArtifactName } from '../src/native/platform';

const DEFAULT_OUTPUT_DIRECTORY = 'dist-release';

export interface BuildReleaseInput {
    target: NativeTarget;
    outputDirectory: string;
}

/* Builds one standalone engine executable: verified native archives are
   downloaded in trusted CI, embedded with `--asset`, and the Bun compile target
   matches the platform. The composite Action resolver downloads the same
   artifact name. */
export async function buildReleaseArtifact(input: BuildReleaseInput): Promise<string> {
    const assetsDirectory = await mkdtemp(path.join(tmpdir(), 'sakre-release-assets-'));

    try {
        return await buildWithAssets(input, assetsDirectory);
    } finally {
        await rm(assetsDirectory, { recursive: true, force: true });
    }
}

async function buildWithAssets(input: BuildReleaseInput, assetsDirectory: string): Promise<string> {
    await downloadVerifiedArchives({ target: input.target, directory: assetsDirectory });
    await mkdir(input.outputDirectory, { recursive: true });
    const outfile = path.join(input.outputDirectory, releaseArtifactName(input.target));
    await compileArtifact({ target: input.target, assetsDirectory, outfile });
    /* The release asset is gzip-compressed: downloads dominate the per-invocation cost. The raw binary stays
       because the artifact tests execute it directly. */
    const compressed = await compressArtifact(outfile);
    console.log(`Built ${outfile} and ${compressed}.`);

    return outfile;
}

async function compressArtifact(binaryPath: string): Promise<string> {
    const content = await readFile(binaryPath);
    const compressed = Bun.gzipSync(content, { level: 9 });
    const outputPath = `${binaryPath}.gz`;
    await writeFile(outputPath, compressed);

    return outputPath;
}

interface CompileInput {
    target: NativeTarget;
    assetsDirectory: string;
    outfile: string;
}

async function compileArtifact(input: CompileInput): Promise<void> {
    const result = await Bun.build({
        entrypoints: ['src/action/entry.ts'],
        plugins: [persistentPtyStub()],
        compile: {
            target: bunCompileTarget(input.target),
            outfile: input.outfile,
            assets: [input.assetsDirectory]
        }
    });

    if (!result.success) {
        throw new AggregateError(result.logs, `bun build --compile failed for ${input.target}.`);
    }
}

/* The SDK resolves its persistent-PTY package with a dynamic require that cannot exist in a standalone executable. SAKRE
   exposes no shell or PTY tool (permissions allow only read/grep/glob and the submit tools), so the binding is stubbed
   to `undefined` at build time instead of a second native dependency. */
function persistentPtyStub(): Bun.BunPlugin {
    return {
        name: 'sakre-pty-stub',
        setup(build) {
            build.onResolve({ filter: /^@opencode-ai\/pty$/u }, () => ({
                path: 'sakre-pty-stub',
                namespace: 'sakre-stub'
            }));
            build.onLoad({ filter: /.*/u, namespace: 'sakre-stub' }, () => ({
                contents: 'export const binaryPath = undefined;\n',
                loader: 'js'
            }));
        }
    };
}

async function main(): Promise<void> {
    await assertPinnedBunVersion();
    const targets = requestedTargets(process.argv.slice(2));

    for (const target of targets) {
        /* Cross-compilation is memory-heavy; targets build sequentially so a
           four-target CI job does not exhaust the runner. */
        // eslint-disable-next-line no-await-in-loop -- deliberate sequential builds
        await buildReleaseArtifact({ target, outputDirectory: DEFAULT_OUTPUT_DIRECTORY });
    }
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
