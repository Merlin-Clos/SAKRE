import path from 'node:path';
import manifestJson from '../../native-assets.json' with { type: 'json' };
import { materializeEnginePlugin } from '../engine/plugin-source';
import {
    embeddedAssetSource,
    nativeAssetFor,
    type NativeAssetManifest,
    type NativeAssetSource,
    parseNativeAssetManifest
} from './assets';
import {
    engineCredentialPath,
    enginePluginCacheRoot,
    engineRunDatabasePath,
    pruneStaleEngineRuns,
    resolveWritableCacheRoot
} from './cache-paths';
import { materializeNativeAsset } from './materialize';
import { engineOAuthCredentialPath } from './data-paths';
import { type NativeTarget, requireNativeTarget } from './platform';

/* Repository manifest is parsed at module load: a stale or malformed pin
   fails before any cache or engine work starts. */
export const pinnedNativeAssetManifest: NativeAssetManifest = parseNativeAssetManifest(manifestJson);

export interface NativeRuntimeOptions {
    platform: NodeJS.Platform;
    architecture: string;
    environment: NodeJS.ProcessEnv;
    home: string;
    manifest?: NativeAssetManifest;
    source?: NativeAssetSource;
    signal?: AbortSignal;
}

/* Tool binaries (rg, SCC, cccc) materialize lazily so an over-budget abort never pays for
   extraction; the plugin directory is shared and content-addressed, while
   every run gets its own engine database so no reviewed content outlives the
   run. */
export interface NativeRuntime {
    target: NativeTarget;
    cacheRoot: string;
    materializeRipgrep: () => Promise<string>;
    materializeScc: () => Promise<string>;
    materializeCccc: () => Promise<string>;
    materializeEnginePlugin: () => Promise<string>;
    engineCredentialPath: string;
    engineOAuthCredentialPath: string;
    engineDatabasePath: string;
    engineDatabaseDirectory: string;
}

export async function resolveNativeRuntime(options: NativeRuntimeOptions): Promise<NativeRuntime> {
    const target = requireNativeTarget(options.platform, options.architecture);
    const manifest = options.manifest ?? pinnedNativeAssetManifest;
    const source = options.source ?? embeddedAssetSource();

    const cacheRoot = await resolveWritableCacheRoot({
        platform: options.platform,
        environment: options.environment,
        home: options.home
    });

    await pruneStaleEngineRuns(cacheRoot);
    const engineDatabasePath = engineRunDatabasePath(cacheRoot);
    const ripgrep = nativeAssetFor(manifest, 'rg', target);
    const scc = nativeAssetFor(manifest, 'scc', target);
    const cccc = nativeAssetFor(manifest, 'cccc', target);

    return {
        target,
        cacheRoot,
        materializeRipgrep: () => materializeNativeAsset({ asset: ripgrep, cacheRoot, source, signal: options.signal }),
        materializeScc: () => materializeNativeAsset({ asset: scc, cacheRoot, source, signal: options.signal }),
        materializeCccc: () => materializeNativeAsset({ asset: cccc, cacheRoot, source, signal: options.signal }),
        materializeEnginePlugin: () => materializeEnginePlugin(enginePluginCacheRoot(cacheRoot)),
        engineCredentialPath: engineCredentialPath(cacheRoot),
        engineOAuthCredentialPath: engineOAuthCredentialPath(options),
        engineDatabasePath,
        engineDatabaseDirectory: path.dirname(engineDatabasePath)
    };
}
