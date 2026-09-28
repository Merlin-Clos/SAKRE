import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import manifestJson from '../../native-assets.json' with { type: 'json' };
import {
    embeddedAssetSource,
    nativeAssetFor,
    type NativeTool,
    type NativeToolManifest,
    nativeToolVersion,
    parseNativeAssetManifest
} from '../../src/native/assets';
import {
    engineRunDatabasePath,
    preferredCacheRoot,
    pruneStaleEngineRuns,
    resolveWritableCacheRoot
} from '../../src/native/cache-paths';
import { engineOAuthCredentialPath, preferredDataRoot } from '../../src/native/data-paths';
import { nativeTargetFor } from '../../src/native/platform';
import { pinnedNativeAssetManifest, resolveNativeRuntime } from '../../src/native/runtime';
import { withCapturedLogs } from '../helpers/log-sink';

interface RawTarget {
    target: string;
    url: string;
    archiveSha256: string;
    archiveSize: number;
    archiveFormat: string;
    binaryPath: string;
    binarySha256: string;
    binarySize: number;
}

interface RawManifest {
    schemaVersion: number;
    tools: Record<'rg' | 'scc' | 'cccc', { version: string; targets: RawTarget[] }>;
}

function cloneManifest(): RawManifest {
    return structuredClone(manifestJson);
}

function firstTarget(manifest: RawManifest, tool: 'rg' | 'scc' | 'cccc'): RawTarget {
    const [target] = manifest.tools[tool].targets;

    if (target === undefined) {
        throw new Error(`The ${tool} fixture has no targets.`);
    }

    return target;
}

describe('native cache roots', () => {
    test('resolves the platform-native location', () => {
        expect(
            preferredCacheRoot({ platform: 'linux', environment: { XDG_CACHE_HOME: '/xdg/cache' }, home: '/home/u' })
        ).toBe('/xdg/cache');
        expect(preferredCacheRoot({ platform: 'linux', environment: {}, home: '/home/u' })).toBe('/home/u/.cache');
        expect(preferredCacheRoot({ platform: 'darwin', environment: {}, home: '/Users/u' })).toBe(
            '/Users/u/Library/Caches'
        );
        const windowsCache = String.raw`C:\Users\u\AppData\Local`;
        expect(preferredCacheRoot({ platform: 'win32', environment: { LOCALAPPDATA: windowsCache }, home: '' })).toBe(
            windowsCache
        );
        expect(preferredCacheRoot({ platform: 'linux', environment: {}, home: '' })).toBeUndefined();
    });

    test('falls back to a unique temporary root when the platform location is not writable', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'sakre-cache-test-'));

        try {
            const blockingFile = path.join(root, 'not-a-directory');
            await writeFile(blockingFile, '', 'utf8');

            /* The unwritable cache root is expected here; capturing the sink
               keeps its warning out of the real Action annotation stream. */
            const resolved = await withCapturedLogs(async (logs) => {
                const fallback = await resolveWritableCacheRoot({
                    platform: 'linux',
                    environment: { XDG_CACHE_HOME: blockingFile },
                    home: '/home/u'
                });

                expect(logs.text()).toContain('Using a temporary native cache root');

                return fallback;
            });

            expect(resolved).not.toContain('not-a-directory');
            expect(resolved.startsWith(tmpdir())).toBe(true);
            await rm(resolved, { recursive: true, force: true });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});

describe('persistent data roots', () => {
    test('resolves the platform data directory and OAuth database path', () => {
        expect(
            preferredDataRoot({ platform: 'linux', environment: { XDG_DATA_HOME: '/xdg/data' }, home: '/home/u' })
        ).toBe('/xdg/data');
        expect(preferredDataRoot({ platform: 'darwin', environment: {}, home: '/Users/u' })).toBe(
            '/Users/u/Library/Application Support'
        );
        expect(
            preferredDataRoot({
                platform: 'win32',
                environment: { APPDATA: String.raw`C:\Users\u\AppData\Roaming` },
                home: ''
            })
        ).toBe(String.raw`C:\Users\u\AppData\Roaming`);
        expect(
            engineOAuthCredentialPath({
                platform: 'linux',
                environment: { XDG_DATA_HOME: '/xdg/data' },
                home: '/home/u'
            })
        ).toBe('/xdg/data/sakre/engine/credentials.db');
    });

    test('does not place credentials under a relative data root inside the reviewed checkout', () => {
        expect(
            preferredDataRoot({ platform: 'linux', environment: { XDG_DATA_HOME: 'checkout/data' }, home: '/home/u' })
        ).toBe('/home/u/.local/share');
        expect(
            preferredDataRoot({ platform: 'linux', environment: { XDG_DATA_HOME: 'checkout/data' }, home: '' })
        ).toBeUndefined();
        expect(
            preferredDataRoot({
                platform: 'win32',
                environment: { APPDATA: 'checkout\\data', LOCALAPPDATA: String.raw`C:\Users\u\AppData\Local` },
                home: ''
            })
        ).toBe(String.raw`C:\Users\u\AppData\Local`);
    });
});

describe('native asset manifest', () => {
    test('parses the pinned repository manifest for all five targets', () => {
        for (const tool of ['rg', 'scc', 'cccc'] as const) {
            expect(pinnedNativeAssetManifest.tools.get(tool)?.assets.size).toBe(5);
        }
    });

    test('pins the CCCC 1.6.0 unified binary for every supported target', () => {
        const cccc = pinnedNativeAssetManifest.tools.get('cccc');
        // eslint-disable-next-line anti-slop/no-known-value-widening -- pin-manifest assertion input; Partial keeps unspecified targets open
        const windowsBinaryPaths: Partial<Record<string, string>> = { 'windows-x64': 'cccc.exe' };
        expect(cccc?.version).toBe('1.6.0');

        for (const asset of cccc?.assets.values() ?? []) {
            expect(asset.url).toContain('https://github.com/moznion/cccc/releases/download/v1.6.0/');
            expect(asset.binaryPath).toBe(windowsBinaryPaths[asset.target] ?? 'cccc');
        }
    });

    test('rejects a manifest that repeats a target or leaks a traversal binary path', () => {
        const repeated = cloneManifest();
        repeated.tools.rg.targets.push(structuredClone(firstTarget(repeated, 'rg')));
        expect(() => parseNativeAssetManifest(repeated)).toThrow('repeats rg/linux-x64');

        const traversal = cloneManifest();
        firstTarget(traversal, 'scc').binaryPath = '../scc';
        expect(() => parseNativeAssetManifest(traversal)).toThrow('is not a file name');
    });

    test('rejects an asset hosted outside the official GitHub release', () => {
        const foreign = cloneManifest();
        firstTarget(foreign, 'rg').url = 'https://example.com/rg.tar.gz';
        expect(() => parseNativeAssetManifest(foreign)).toThrow('does not come from github.com');

        const wrongVersion = cloneManifest();
        firstTarget(wrongVersion, 'scc').url = 'https://github.com/boyter/scc/releases/download/v9.9.9/scc.tar.gz';
        expect(() => parseNativeAssetManifest(wrongVersion)).toThrow('does not name version');
    });

    test('resolves pinned tool versions with an unknown fallback', () => {
        const manifest = parseNativeAssetManifest(cloneManifest());
        expect(nativeToolVersion(manifest, 'rg')).toBe(manifest.tools.get('rg')?.version ?? '0.0.0');
        expect(nativeToolVersion({ tools: new Map() }, 'rg')).toBe('unknown');
    });

    test('rejects lookups for entries absent from the manifest', () => {
        const manifest = parseNativeAssetManifest(cloneManifest());
        expect(() => nativeAssetFor({ tools: new Map() }, 'rg', 'linux-x64')).toThrow('has no');
        const version = manifest.tools.get('rg')?.version ?? '0.0.0';

        const tools = new Map<NativeTool, NativeToolManifest>([
            ...manifest.tools,
            ['rg', { version, assets: new Map() }]
        ]);

        expect(() => nativeAssetFor({ tools }, 'rg', 'linux-x64')).toThrow('has no');
    });

    test('resolves embedded archives by file name', async () => {
        /* Source runs and tests ship no embedded files, so an unknown name
           resolves to undefined instead of throwing. Suffix and non-blob
           filtering require a compiled binary with embedded files and stay
           uncovered here. */
        expect(await embeddedAssetSource()('rg.tar.gz')).toBeUndefined();
        expect(await embeddedAssetSource()('unknown.tar.gz')).toBeUndefined();
    });
});

describe('native runtime resolution', () => {
    test('materializes the plugin directory and locates the engine database', async () => {
        const target = nativeTargetFor(process.platform, process.arch);

        if (target === undefined) {
            return;
        }

        const root = await mkdtemp(path.join(tmpdir(), 'sakre-runtime-'));

        try {
            const runtime = await resolveNativeRuntime({
                platform: process.platform,
                architecture: process.arch,
                environment: { XDG_CACHE_HOME: root },
                home: root
            });

            expect(runtime.target).toBe(target);

            const pluginDirectory = await runtime.materializeEnginePlugin();
            expect(await readFile(path.join(pluginDirectory, 'index.js'), 'utf8')).toContain('submit_findings');
            expect(runtime.engineDatabasePath.startsWith(root)).toBe(true);
            expect(runtime.engineDatabaseDirectory).toBe(path.dirname(runtime.engineDatabasePath));
            expect(runtime.engineCredentialPath.startsWith(root)).toBe(true);
            expect(runtime.engineOAuthCredentialPath.startsWith(root)).toBe(true);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test('a per-run database path is unique and stale run directories are pruned', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'sakre-runs-'));

        try {
            const first = engineRunDatabasePath(root);
            const second = engineRunDatabasePath(root);
            expect(first).not.toBe(second);

            const stale = path.dirname(first);
            await mkdir(stale, { recursive: true });
            const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
            await utimes(stale, old, old);
            const fresh = path.dirname(second);
            await mkdir(fresh, { recursive: true });

            await pruneStaleEngineRuns(root);

            expect(await pathExists(stale)).toBe(false);
            expect(await pathExists(fresh)).toBe(true);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});

async function pathExists(target: string): Promise<boolean> {
    try {
        await stat(target);

        return true;
    } catch {
        return false;
    }
}
