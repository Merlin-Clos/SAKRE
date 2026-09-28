import path from 'node:path';
import { createMockRuntime } from '../ai/mock-runtime';
import type { AiRuntime } from '../ai/runtime';
import type { EffectiveRun } from '../config/effective-run';
import type { ResolvedReviewConfig } from '../config/load';
import { runtimeProviderFamily } from '../config/providers';
import { createEmbeddedEngineRuntime, type EngineRuntimeOptions } from '../engine/runtime';
import type { SelectedOAuthCredential } from '../engine/host';
import type { NativeRuntime } from '../native/runtime';
import { collectRoutedModelIds } from '../review/agents';

/* Cycle input: resolved run plus the trusted workspace the engine may read. */
export interface RuntimeRequest {
    effective: EffectiveRun;
    config: ResolvedReviewConfig;
    signal?: AbortSignal;
    worktreeDir: string;
}

export interface ActionRuntimeInput {
    effective: EffectiveRun;
    config: ResolvedReviewConfig;
    isMockMode: boolean;
    native: NativeRuntime;
    signal?: AbortSignal;
    /* Local runs and the trusted workspace override the engine working
       directory; the Action uses the workflow checkout. */
    checkoutDir?: string;
    context7ApiKey?: string;
    externalOAuth?: boolean;
    oauthCredential?: SelectedOAuthCredential;
}

export interface ActionRuntimeDependencies {
    createEngineRuntime: (options: EngineRuntimeOptions) => Promise<AiRuntime>;
}

const defaultDependencies: ActionRuntimeDependencies = { createEngineRuntime: createEmbeddedEngineRuntime };

/* Builds the runtime from resolved config. Catalogue and pipeline route from
   the same object, so a routed model is never missing. rg ships embedded on
   PATH so file tools never download. */
export function createActionRuntime(
    input: ActionRuntimeInput,
    dependencies: ActionRuntimeDependencies = defaultDependencies
): Promise<AiRuntime> {
    if (input.isMockMode) {
        return Promise.resolve(createMockRuntime());
    }

    return createEngine(input, dependencies);
}

async function createEngine(input: ActionRuntimeInput, dependencies: ActionRuntimeDependencies): Promise<AiRuntime> {
    const [ripgrepPath, pluginDir] = await Promise.all([
        input.native.materializeRipgrep(),
        input.native.materializeEnginePlugin()
    ]);

    prependToPath(path.dirname(ripgrepPath));

    return dependencies.createEngineRuntime({
        providerID: input.effective.provider,
        providerFamily: runtimeProviderFamily(input.effective.provider),
        modelIds: collectRoutedModelIds(input.config),
        apiKey: input.effective.apiKey,
        externalOAuth: input.externalOAuth,
        oauthCredential: input.oauthCredential,
        baseURL: input.effective.baseURL,
        checkoutDir: input.checkoutDir ?? process.cwd(),
        pluginDir,
        databasePath: input.native.engineDatabasePath,
        databaseDirectory: input.native.engineDatabaseDirectory,
        context7Url: enabledUrl(input.config.tools.context7),
        context7ApiKey: input.context7ApiKey,
        webEnabled: input.config.tools.web.enabled,
        signal: input.signal
    });
}

function prependToPath(directory: string): void {
    const current = process.env.PATH;

    if (current === undefined || current === '') {
        process.env.PATH = directory;

        return;
    }

    process.env.PATH = `${directory}${path.delimiter}${current}`;
}

function enabledUrl(tool: { enabled: boolean; url?: string }): string | undefined {
    if (tool.enabled) {
        return tool.url;
    }

    return undefined;
}
