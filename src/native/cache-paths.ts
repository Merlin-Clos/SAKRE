import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CACHE_DIRECTORY, PRODUCT_SLUG } from '../identity';
import { createLogger } from '../logger';

const log = createLogger('native');

const HOURS_PER_DAY = 24;

const MINUTES_PER_HOUR = 60;

const SECONDS_PER_MINUTE = 60;

const MILLISECONDS_PER_SECOND = 1000;

const RUN_DATABASE_MAX_AGE_MILLISECONDS =
    HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND;

export interface NativeCacheEnvironment {
    platform: NodeJS.Platform;
    environment: NodeJS.ProcessEnv;
    home: string;
}

/* Platform-native cache root, resolved without touching the filesystem so each
   branch stays testable. Windows uses %LOCALAPPDATA%; macOS uses
   ~/Library/Caches; Linux follows XDG with a ~/.cache fallback. */
export function preferredCacheRoot(input: NativeCacheEnvironment): string | undefined {
    if (input.platform === 'win32') {
        return nonEmpty(input.environment.LOCALAPPDATA);
    }

    if (input.platform === 'darwin') {
        return homeDirectory(input.home, 'Library', 'Caches');
    }

    return nonEmpty(input.environment.XDG_CACHE_HOME) ?? homeDirectory(input.home, '.cache');
}

/* Writable root is required for materialization. When the preferred location
   cannot be created or written, a unique temporary directory keeps the
   executable working offline; the run reports the fallback explicitly. */
export async function resolveWritableCacheRoot(input: NativeCacheEnvironment): Promise<string> {
    const preferred = preferredCacheRoot(input);

    if (preferred !== undefined && (await isWritableDirectory(path.join(preferred, CACHE_DIRECTORY)))) {
        return preferred;
    }

    const fallback = path.join(tmpdir(), `${PRODUCT_SLUG}-cache-${process.pid}-${randomUUID()}`);
    await mkdir(fallback, { recursive: true });
    log.warn('Using a temporary native cache root because the platform cache location is not writable', {
        preferred: preferred ?? null,
        fallback
    });

    return fallback;
}

/* `<cache>/<product-base>/bin/<tool>/<version>-<binarySha256>/<binary>`. Binary
   hash is the identity: a rebuild with different bytes never reuses an
   existing entry. */
export interface NativeToolLocation {
    cacheRoot: string;
    tool: string;
    version: string;
    binarySha256: string;
}

export function nativeToolDirectory(input: NativeToolLocation): string {
    return path.join(nativeBaseDirectory(input.cacheRoot), 'bin', input.tool, `${input.version}-${input.binarySha256}`);
}

export function nativeBaseDirectory(cacheRoot: string): string {
    return path.join(cacheRoot, CACHE_DIRECTORY);
}

/* Engine-owned locations. Credential store is the only shared engine file:
   it holds API keys from `auth login` and little else. Sessions, diffs, and
   role prompts live in a per-run database deleted on close, so the shared
   cache cannot grow with reviewed content. */
export function enginePluginCacheRoot(cacheRoot: string): string {
    return path.join(nativeBaseDirectory(cacheRoot), 'engine', 'plugin');
}

export function engineCredentialPath(cacheRoot: string): string {
    return path.join(nativeBaseDirectory(cacheRoot), 'engine', 'credentials.json');
}

export function engineRunsDirectory(cacheRoot: string): string {
    return path.join(nativeBaseDirectory(cacheRoot), 'engine', 'runs');
}

export function engineRunDatabasePath(cacheRoot: string): string {
    return path.join(engineRunsDirectory(cacheRoot), randomUUID(), 'engine.db');
}

/* Crash can leave a run database behind. Directories older than the longest
   supported review deadline are unreachable by any live run and are removed
   best effort; the delete-on-close path bounds every normal run. */
export async function pruneStaleEngineRuns(cacheRoot: string, now = Date.now()): Promise<void> {
    const directory = engineRunsDirectory(cacheRoot);
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    await Promise.all(
        entries
            .filter((entry) => entry.isDirectory())
            .map(async (entry) => {
                const runDirectory = path.join(directory, entry.name);

                try {
                    const stats = await stat(runDirectory);

                    if (now - stats.mtimeMs > RUN_DATABASE_MAX_AGE_MILLISECONDS) {
                        await rm(runDirectory, { recursive: true, force: true });
                    }
                } catch {
                    // Best effort: a concurrent run may have just removed it.
                }
            })
    );
}

async function isWritableDirectory(directory: string): Promise<boolean> {
    const probe = path.join(directory, `.write-probe-${process.pid}-${randomUUID()}`);

    try {
        await mkdir(directory, { recursive: true });
        await writeFile(probe, '', 'utf8');

        return true;
    } catch {
        return false;
    } finally {
        /* Probe may live under a path that is not a directory; failed cleanup
           must not replace the writability answer. */
        await rm(probe, { force: true }).catch(ignoreCleanupFailure);
    }
}

function ignoreCleanupFailure(): void {
    // Best effort: the writability answer is already decided.
}

function nonEmpty(value: string | undefined): string | undefined {
    if (value === undefined || value.trim() === '') {
        return undefined;
    }

    return value;
}

function homeDirectory(home: string, ...segments: string[]): string | undefined {
    if (home === '') {
        return undefined;
    }

    return path.join(home, ...segments);
}
