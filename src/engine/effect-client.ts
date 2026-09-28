import { Credential } from '@opencode/core/credential';
import { OpenCode } from '@opencode/sdk/effect';
import { Integration } from '@opencode/schema/integration';
import { Location } from '@opencode/schema/location';
import { Model } from '@opencode/schema/model';
import { Session } from '@opencode/schema/session';
import { Effect, Exit, Schema, Scope, Stream } from 'effect';
import {
    persistentCredentialLayer,
    type PersistentCredentialLayerOptions,
    prepareOAuthCredentialStore
} from './oauth-credentials';

import type { EngineHostClient, EngineIntegrationInfo } from './effect-client-types';

export type {
    EngineFormAnswer,
    EngineFormCondition,
    EngineFormField,
    EngineFormOption,
    EngineFormValue,
    EngineHostClient,
    EngineIntegrationConnection,
    EngineIntegrationInfo,
    EngineIntegrationMethod,
    EngineOAuthAttempt,
    EngineOAuthAttemptStatus
} from './effect-client-types';

export async function createEffectEngineClient(
    options: OpenCode.CreateOptions,
    credentials?: PersistentCredentialLayerOptions
): Promise<EngineHostClient> {
    if (credentials !== undefined) {
        await prepareOAuthCredentialStore(credentials.path, credentials.platform);
    }

    const scope = await Effect.runPromise(Scope.make());

    try {
        const overrides = credentialOverrides(credentials);
        const client = await Effect.runPromise(OpenCode.create(options, { overrides }).pipe(Scope.provide(scope)));

        return adaptEffectClient(client, scope);
    } catch (error) {
        await Effect.runPromise(Scope.close(scope, Exit.void));
        throw error;
    }
}

function adaptEffectClient(client: OpenCode.Interface, scope: Scope.Closeable): EngineHostClient {
    return {
        integration: adaptIntegration(client),
        credential: adaptCredential(client),
        provider: adaptProvider(client),
        model: adaptModel(client),
        sessions: adaptSessions(client),
        events: {
            subscribe: (options) => abortableEvents(Stream.toAsyncIterable(client.event.subscribe()), options.signal)
        },
        close: () => Effect.runPromise(Scope.close(scope, Exit.void))
    };
}

function credentialOverrides(
    credentials?: PersistentCredentialLayerOptions
): OpenCode.EmbedOptions['overrides'] | undefined {
    if (credentials === undefined) {
        return undefined;
    }

    return [Credential.node.replace(persistentCredentialLayer(credentials))];
}

function adaptIntegration(client: OpenCode.Interface): EngineHostClient['integration'] {
    return {
        list: async (input) => {
            const result = await runEffect(
                client.integration.list({ location: decodeLocation(input.location.directory) })
            );

            return { data: result.data.map((integration) => projectIntegration(integration)) };
        },
        get: async (input) => {
            const result = await runEffect(
                client.integration.get({
                    integrationID: decodeIntegrationID(input.integrationID),
                    location: decodeLocation(input.location.directory)
                })
            );

            return { data: projectIntegration(result.data) };
        },
        connect: {
            key: (input) =>
                runEffect(
                    client.integration.connect.key({
                        integrationID: decodeIntegrationID(input.integrationID),
                        key: input.key,
                        location: decodeLocation(input.location.directory)
                    })
                )
        },
        oauth: adaptOAuth(client)
    };
}

function adaptOAuth(client: OpenCode.Interface): EngineHostClient['integration']['oauth'] {
    return {
        connect: async (input) => {
            const data = await runEffect(
                client.integration.oauth.connect({
                    integrationID: decodeIntegrationID(input.integrationID),
                    methodID: decodeMethodID(input.methodID),
                    answer: input.answer,
                    location: decodeLocation(input.location.directory)
                })
            );

            return { data: data.data };
        },
        status: async (input) => {
            const data = await runEffect(
                client.integration.oauth.status({
                    integrationID: decodeIntegrationID(input.integrationID),
                    attemptID: decodeAttemptID(input.attemptID),
                    location: decodeLocation(input.location.directory)
                })
            );

            return { data: data.data };
        },
        complete: (input) =>
            runEffect(
                client.integration.oauth.complete({
                    integrationID: decodeIntegrationID(input.integrationID),
                    attemptID: decodeAttemptID(input.attemptID),
                    code: input.code,
                    location: decodeLocation(input.location.directory)
                })
            ),
        cancel: (input) =>
            runEffect(
                client.integration.oauth.cancel({
                    integrationID: decodeIntegrationID(input.integrationID),
                    attemptID: decodeAttemptID(input.attemptID),
                    location: decodeLocation(input.location.directory)
                })
            )
    };
}

function adaptCredential(client: OpenCode.Interface): EngineHostClient['credential'] {
    return {
        activate: (input) =>
            runEffect(
                client.credential.activate({
                    credentialID: Schema.decodeUnknownSync(Credential.ID)(input.credentialID)
                })
            )
    };
}

function adaptProvider(client: OpenCode.Interface): EngineHostClient['provider'] {
    return {
        list: async (input) => {
            const result = await runEffect(
                client.provider.list({ location: decodeLocation(input.location.directory) })
            );

            return { data: result.data.map((provider) => projectProvider(provider)) };
        }
    };
}

function projectProvider(provider: {
    readonly id: string;
    readonly activation: string;
    readonly settings?: unknown;
}): Awaited<ReturnType<EngineHostClient['provider']['list']>>['data'][number] {
    const projected = { id: provider.id, activation: provider.activation };

    // eslint-disable-next-line anti-slop/no-runtime-typeof -- intentional narrowing of external provider settings after isRecord
    if (!isRecord(provider.settings) || typeof provider.settings.apiKey !== 'string') {
        return projected;
    }

    return { ...projected, settings: { apiKey: provider.settings.apiKey } };
}

function adaptModel(client: OpenCode.Interface): EngineHostClient['model'] {
    return {
        list: async (input) => {
            const result = await runEffect(client.model.list({ location: decodeLocation(input.location.directory) }));

            return {
                data: result.data.map((model) => ({
                    id: model.id,
                    providerID: model.providerID,
                    modelID: model.modelID,
                    package: model.package,
                    enabled: model.enabled,
                    cost: model.cost.map((tier) => ({ input: tier.input, output: tier.output })),
                    variants: model.variants.map((variant) => ({ id: variant.id }))
                }))
            };
        }
    };
}

function adaptSessions(client: OpenCode.Interface): EngineHostClient['sessions'] {
    return {
        create: async (input) => {
            const session = await runEffect(
                client.session.create({
                    location: decodeLocation(input.location.directory),
                    title: input.title,
                    model: Schema.decodeUnknownSync(Model.Ref)(input.model)
                })
            );

            return { id: session.id };
        },
        prompt: (input) =>
            runEffect(client.session.prompt({ sessionID: decodeSessionID(input.sessionID), text: input.text })),
        context: (input) => runEffect(client.session.context({ sessionID: decodeSessionID(input.sessionID) })),
        wait: (input) => runEffect(client.session.wait({ sessionID: decodeSessionID(input.sessionID) })),
        interrupt: (input) => runEffect(client.session.interrupt({ sessionID: decodeSessionID(input.sessionID) })),
        remove: (input) => runEffect(client.session.remove({ sessionID: decodeSessionID(input.sessionID) })),
        instructions: { entry: { put: (input) => putInstruction(client, input) } }
    };
}

function putInstruction(
    client: OpenCode.Interface,
    input: { sessionID: string; key: string; value: string }
): Promise<void> {
    return runEffect(
        client.session.instructions.entry.put({
            sessionID: decodeSessionID(input.sessionID),
            key: input.key,
            value: input.value
        })
    );
}

function projectIntegration(integration: Integration.Info): EngineIntegrationInfo {
    return {
        id: integration.id,
        name: integration.name,
        methods: integration.methods,
        connections: integration.connections
    };
}

function decodeIntegrationID(value: string): Integration.ID {
    return Schema.decodeUnknownSync(Integration.ID)(value);
}

function decodeMethodID(value: string): Integration.MethodID {
    return Schema.decodeUnknownSync(Integration.MethodID)(value);
}

function decodeAttemptID(value: string): Integration.AttemptID {
    return Schema.decodeUnknownSync(Integration.AttemptID)(value);
}

function decodeSessionID(value: string): Session.ID {
    return Schema.decodeUnknownSync(Session.ID)(value);
}

function decodeLocation(directory: string): Location.PublicRef {
    return Schema.decodeUnknownSync(Location.PublicRef)({ directory });
}

// eslint-disable-next-line anti-slop/no-unsafe-dictionary-type -- external provider-settings guard; apiKey narrowed per-site below
function isRecord(value: unknown): value is Record<string, unknown> {
    // eslint-disable-next-line anti-slop/no-runtime-typeof -- intentional narrowing in type predicate
    return typeof value === 'object' && value !== null;
}

function runEffect<Value, Failure>(effect: Effect.Effect<Value, Failure>): Promise<Value> {
    return Effect.runPromise(effect);
}

async function* abortableEvents(events: AsyncIterable<unknown>, signal?: AbortSignal): AsyncIterable<unknown> {
    for await (const event of events) {
        if (signal?.aborted === true) {
            return;
        }

        yield event;
    }
}
