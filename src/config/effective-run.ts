import type { ResolvedReviewConfig } from './load';
import { resolveOperationalProvider } from './providers';

export class EffectiveRunError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = 'EffectiveRunError';
    }
}

export interface EffectiveRun {
    provider: string;
    /* Global fallback model. Undefined is valid when every active (agent, tier)
       resolves through models.routing; the pipeline fails closed otherwise. */
    model?: string;
    apiKey?: string;
    baseURL?: string;
}

export interface ResolveEffectiveRunInput {
    config: ResolvedReviewConfig;
    apiKey?: string;
    baseURL?: string;
    isMockMode: boolean;
    /* Local runs accept native OpenCode providers outside the public families. */
    allowUnsupportedProvider?: boolean;
    /* A local OpenCode store entry is an alternative to an API key. */
    allowMissingCredential?: boolean;
}

/* Atomic check of provider + model + credential AFTER resolution and BEFORE
   any paid call. */
export function resolveEffectiveRun(input: ResolveEffectiveRunInput): EffectiveRun {
    const { config, apiKey, baseURL, isMockMode } = input;
    const providerId = resolveProviderId(config.provider, input.allowUnsupportedProvider === true);
    const model = resolveModel(config);
    assertCredential({
        providerId,
        apiKey,
        isMockMode,
        allowMissingCredential: input.allowMissingCredential === true
    });

    return { provider: providerId, model, apiKey, baseURL };
}

function resolveProviderId(configured: string, allowUnsupportedProvider: boolean): string {
    const resolved = resolveOperationalProvider(configured, allowUnsupportedProvider);

    if (resolved === undefined) {
        throw new EffectiveRunError(`Effective provider "${configured}" is not supported.`);
    }

    return resolved;
}

function resolveModel(config: ResolvedReviewConfig): string | undefined {
    if (config.model !== undefined) {
        return config.model;
    }

    /* Routing-only config is valid: the per-agent matrix supplies the model, and
       the pipeline fails closed for an unresolved pair. */
    if (Object.keys(config.models?.routing ?? {}).length > 0) {
        return undefined;
    }

    throw new EffectiveRunError(
        'No effective model configured: set "model", a models.routing entry, or the default_model input.'
    );
}

function assertCredential(input: {
    providerId: string;
    apiKey?: string;
    isMockMode: boolean;
    allowMissingCredential: boolean;
}): void {
    const missing = input.apiKey === undefined || input.apiKey === '';

    if (!input.isMockMode && missing && !input.allowMissingCredential) {
        throw new EffectiveRunError(
            `No credential for provider "${input.providerId}": set the provider_api_key input.`
        );
    }
}
