import { PRODUCT_NAME, PRODUCT_SLUG } from '../identity';

/* Five release targets. A target is design/buildable from the start; it is
   published only after its artifact passed on a native runner. */
export const nativeTargets = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'windows-x64'] as const;

export type NativeTarget = (typeof nativeTargets)[number];

// eslint-disable-next-line anti-slop/no-known-value-widening -- open platform lookup; unknown combos yield undefined
const TARGET_BY_PLATFORM: Record<string, NativeTarget | undefined> = {
    'linux:x64': 'linux-x64',
    'linux:arm64': 'linux-arm64',
    'darwin:x64': 'darwin-x64',
    'darwin:arm64': 'darwin-arm64',
    'win32:x64': 'windows-x64'
};

export function nativeTargetFor(platform: NodeJS.Platform, architecture: string): NativeTarget | undefined {
    return TARGET_BY_PLATFORM[`${platform}:${architecture}`];
}

/* Bun compile target for the executable embedding the target's assets. Target
   ids are exactly the Bun compile target suffixes; the union is declared
   locally so the platform layer stays free of Bun type dependencies. */
export type BunCompileTarget =
    | 'bun-linux-x64'
    | 'bun-linux-arm64'
    | 'bun-darwin-x64'
    | 'bun-darwin-arm64'
    | 'bun-windows-x64';

export function bunCompileTarget(target: NativeTarget): BunCompileTarget {
    return `bun-${target}`;
}

/* Release asset name for the target's standalone engine executable. Composite
   Action resolver downloads the compressed form and verifies the decompressed
   binary against the committed pin. */
export function releaseArtifactName(target: NativeTarget): string {
    if (target === 'windows-x64') {
        return `${PRODUCT_SLUG}-${target}.exe`;
    }

    return `${PRODUCT_SLUG}-${target}`;
}

export function releaseCompressedArtifactName(target: NativeTarget): string {
    return `${releaseArtifactName(target)}.gz`;
}

export class UnsupportedTargetError extends Error {
    public constructor(platform: NodeJS.Platform, architecture: string) {
        super(`No ${PRODUCT_NAME} engine target exists for ${platform}/${architecture}.`);
        this.name = 'UnsupportedTargetError';
    }
}

export function requireNativeTarget(platform: NodeJS.Platform, architecture: string): NativeTarget {
    const target = nativeTargetFor(platform, architecture);

    if (target === undefined) {
        throw new UnsupportedTargetError(platform, architecture);
    }

    return target;
}
