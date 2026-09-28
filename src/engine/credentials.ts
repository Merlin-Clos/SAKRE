import { PRODUCT_SLUG, PROVIDER_API_KEY_ENV } from '../identity';
import type { EngineHostClient } from './host';

type Integration = Pick<Awaited<ReturnType<EngineHostClient['integration']['get']>>['data'], 'connections' | 'methods'>;

/* Only connections for the selected integration in this isolated database
   may be activated. An advertised method does not mean its credential is in
   this database. */
export type CredentialAvailability =
    | { kind: 'keyless' }
    | { kind: 'env' }
    | { kind: 'activatable'; credentialID: string }
    | { kind: 'ambiguous'; count: number }
    | { kind: 'oauth-unavailable' }
    | { kind: 'missing' };

export function classifyCredentialAvailability(
    integration: Integration,
    keylessUsable: boolean
): CredentialAvailability {
    if (integration.connections.some((connection) => connection.type === 'env')) {
        return { kind: 'env' };
    }

    return classifyStored(integration, keylessUsable);
}

function classifyStored(integration: Integration, keylessUsable: boolean): CredentialAvailability {
    const stored = integration.connections.filter((connection) => connection.type === 'credential');

    if (stored.length === 1 && stored[0] !== undefined) {
        return { kind: 'activatable', credentialID: stored[0].id };
    }

    if (stored.length > 1) {
        return { kind: 'ambiguous', count: stored.length };
    }

    if (keylessUsable) {
        return { kind: 'keyless' };
    }

    if (integration.methods.some((method) => method.type === 'oauth')) {
        return { kind: 'oauth-unavailable' };
    }

    return { kind: 'missing' };
}

export function missingCredentialMessage(
    providerID: string,
    availability: CredentialAvailability,
    externalOAuth: boolean
): string {
    const alternative = `Use "${PRODUCT_SLUG} auth login ${providerID}", pass --key <key>, or set ${PROVIDER_API_KEY_ENV}.`;

    if (externalOAuth) {
        return `The OpenCode OAuth credential for provider "${providerID}" is in a separate store and cannot be used by this isolated review host. OpenCode does not expose a credential read/import bridge for a fresh database; OAuth reuse is deferred. ${alternative}`;
    }

    if (availability.kind === 'oauth-unavailable') {
        return `Provider "${providerID}" offers OAuth, but no persistent OAuth credential is selected. ${alternative}`;
    }

    return `No usable credential for provider "${providerID}" in the isolated review host. ${alternative}`;
}
