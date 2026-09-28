import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { AiError } from '../ai/runtime';
import { buildEngineConfigContent, type EngineConfigOptions } from './config';
import { classifyCredentialAvailability, missingCredentialMessage } from './credentials';
import { createEffectEngineClient, type EngineHostClient } from './effect-client';

export type { EngineHostClient } from './effect-client';

/* Host handle binds the SDK client to the directory its permission rules were
   built for. Sessions derive their working directory from the host, so none
   can open outside the authorized scope. */
export interface EngineHost {
    readonly client: EngineHostClient;
    readonly directory: string;
}

export interface SelectedOAuthCredential {
    path: string;
    credentialID: string;
}

/* Host adds its storage and cancellation to the inline configuration
   options; credentials, routing and workspace stay a single declaration. */
export type EngineHostOptions = EngineConfigOptions & {
    databasePath: string;
    signal?: AbortSignal;
    externalOAuth?: boolean;
    oauthCredential?: SelectedOAuthCredential;
};

/* One embedded host per review run. The provider catalogue is bundled
   (`fetch: false`), the engine database is product-owned, and credentials
    are resolved generically: `integration.list` runs first (otherwise the
    connection is dropped), then `integration.get` discovers methods and
    connections for the requested integration only. An API key is injected only
    for that integration; a stored credential is activated only for that
    integration; a public catalogue route proceeds without injection when the
    runtime reports it available. Never use one integration's credential for another. */
export async function createEngineHost(options: EngineHostOptions): Promise<EngineHost> {
    if (options.signal?.aborted === true) {
        throw new AiError('cancelled', 'Engine host creation was cancelled.');
    }

    /* Engine opens its database but never creates its parent directory. */
    await mkdir(path.dirname(options.databasePath), { recursive: true });
    const client = await createHost(options);

    try {
        await connectProvider(client, options);
    } catch (error) {
        await closeQuietly(client);
        throw error;
    }

    return { client, directory: options.checkoutDir };
}

function createHost(options: EngineHostOptions): Promise<EngineHostClient> {
    const content = buildEngineConfigContent(options);
    let credentials: { path: string; integrationID: string; selectedCredentialID: string } | undefined = undefined;

    if (options.oauthCredential !== undefined) {
        credentials = {
            path: options.oauthCredential.path,
            integrationID: options.providerID,
            selectedCredentialID: options.oauthCredential.credentialID
        };
    }

    return createEffectEngineClient(
        {
            config: {
                project: false,
                directory: options.checkoutDir,
                content: JSON.stringify(content)
            },
            models: { fetch: false },
            fs: { filewatcher: false, fff: false },
            database: { path: options.databasePath },
            events: { persist: false }
        },
        credentials
    );
}

async function connectProvider(client: EngineHostClient, options: EngineHostOptions): Promise<void> {
    await client.integration.list({ location: { directory: options.checkoutDir } });

    const { data: integration } = await client.integration.get({
        integrationID: options.providerID,
        location: { directory: options.checkoutDir }
    });

    const { apiKey } = options;

    if (apiKey !== undefined && apiKey !== '') {
        /* Only the requested integration ever receives the key. */
        await client.integration.connect.key({
            integrationID: options.providerID,
            key: apiKey,
            location: { directory: options.checkoutDir }
        });

        return;
    }

    const keylessUsable = await isKeylessUsable(client, options);
    const availability = classifyCredentialAvailability(integration, keylessUsable);
    await applyAvailability(client, options, availability);
}

async function applyAvailability(
    client: EngineHostClient,
    options: EngineHostOptions,
    availability: ReturnType<typeof classifyCredentialAvailability>
): Promise<void> {
    if (availability.kind === 'keyless' || availability.kind === 'env') {
        return;
    }

    if (availability.kind === 'activatable') {
        await client.credential.activate({ credentialID: availability.credentialID });

        return;
    }

    if (availability.kind === 'ambiguous') {
        throw new AiError(
            'provider-auth',
            `Provider "${options.providerID}" has ${availability.count} credentials in the review host; select one before running the review.`
        );
    }

    throw new AiError(
        'provider-auth',
        missingCredentialMessage(options.providerID, availability, options.externalOAuth === true)
    );
}

/* Embedded catalogue's public-key setting is the engine's keyless provider
   declaration. Activation alone is insufficient: a configured provider can be
   enabled without its API key. */
async function isKeylessUsable(client: EngineHostClient, options: EngineHostOptions): Promise<boolean> {
    const providers = await client.provider.list({ location: { directory: options.checkoutDir } });

    if (
        !providers.data.some(
            (provider) =>
                provider.id === options.providerID &&
                provider.activation === 'enabled' &&
                provider.settings?.apiKey === 'public'
        )
    ) {
        return false;
    }

    const models = await client.model.list({ location: { directory: options.checkoutDir } });

    return (
        options.modelIds.length > 0 &&
        options.modelIds.every((modelId) =>
            models.data.some(
                (model) =>
                    model.providerID === options.providerID &&
                    model.modelID === modelId &&
                    model.enabled &&
                    model.cost.length > 0 &&
                    model.cost.every((tier) => tier.input === 0 && tier.output === 0)
            )
        )
    );
}

/* Setup failed: release the host, but keep the original error. */
async function closeQuietly(client: EngineHostClient): Promise<void> {
    try {
        await client.close();
    } catch {
        // The host may already be unusable; the setup error is the cause.
    }
}
