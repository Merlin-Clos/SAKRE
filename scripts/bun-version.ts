import { readFile } from 'node:fs/promises';

export const BUN_VERSION_FILE = '.bun-version';

/* A different Bun changes the emitted bundle, so a stale local toolchain must fail
   as a toolchain mismatch instead of a dist diff that looks like real drift. */
export async function assertPinnedBunVersion(versionFilePath: string = BUN_VERSION_FILE): Promise<void> {
    const content = await readFile(versionFilePath, 'utf8');
    const pinned = content.trim();

    if (pinned === '') {
        throw new Error(`${versionFilePath} does not pin a Bun version.`);
    }

    if (Bun.version !== pinned) {
        throw new Error(
            `Running Bun ${Bun.version} but ${versionFilePath} pins ${pinned}; ` +
                `install Bun ${pinned} before building or checking dist.`
        );
    }
}
