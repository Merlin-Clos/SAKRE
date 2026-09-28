/* Single provider policy: public families, local allowance, and runtime mapping.
   All consumers read this module, so a new family is a one-place change. */
const ACTION_PROVIDER_FAMILIES = ['anthropic', 'openai-compatible'] as const;

type ActionProviderFamily = (typeof ACTION_PROVIDER_FAMILIES)[number];

/* Families the engine can build. The Action accepts the two API-key families; a
   local run may also use a native provider from the user store. */
export type ProviderFamily = 'anthropic' | 'openai-compatible' | 'native';

function actionProviderFamily(provider: string): ActionProviderFamily | undefined {
    return ACTION_PROVIDER_FAMILIES.find((family) => family === provider);
}

/* A public family always passes; any other non-empty id passes only for local
   native runs, so an unknown Action provider fails instead of misclassifying. */
function resolveOperationalProvider(provider: string, allowNative: boolean): string | undefined {
    const trimmed = provider.trim();

    if (trimmed === '') {
        return undefined;
    }

    if (actionProviderFamily(trimmed) !== undefined) {
        return trimmed;
    }

    if (allowNative) {
        return trimmed;
    }

    return undefined;
}

/* Resolved family: every non-empty id outside the public families is native. */
function runtimeProviderFamily(provider: string): ProviderFamily {
    return actionProviderFamily(provider) ?? 'native';
}

export { ACTION_PROVIDER_FAMILIES, runtimeProviderFamily, resolveOperationalProvider };

export type { ActionProviderFamily };
