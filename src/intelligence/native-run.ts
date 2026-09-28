import { nativeToolVersion } from '../native/assets';
import { type NativeRuntime, pinnedNativeAssetManifest } from '../native/runtime';
import { type IntelligenceOutput, type IntelligenceRunOptions, runIntelligencePrePass } from './pre-pass';

/* Factory for Action and CLI pre-pass wiring; binaries materialize lazily and versions come from the pinned manifest. */
export function createNativeIntelligenceRun(
    native: NativeRuntime
): (options: IntelligenceRunOptions) => Promise<IntelligenceOutput> {
    return async (options) => {
        const [sccBinaryPath, ccccBinaryPath] = await Promise.all([native.materializeScc(), native.materializeCccc()]);

        return runIntelligencePrePass({
            ...options,
            sccBinaryPath,
            ccccBinaryPath,
            sccVersion: nativeToolVersion(pinnedNativeAssetManifest, 'scc'),
            ccccVersion: nativeToolVersion(pinnedNativeAssetManifest, 'cccc')
        });
    };
}
