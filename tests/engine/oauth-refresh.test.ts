import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Credential } from '@opencode/core/credential';
import { Plugin } from '@opencode/plugin/effect';
import { OpenCode } from '@opencode/sdk/effect';
import { Integration } from '@opencode/schema/integration';
import { Effect, Exit, Schema, Scope } from 'effect';
import {
    persistentCredentialLayer,
    prepareOAuthCredentialStore,
    resolveOAuthCredentialSelection
} from '../../src/engine/oauth-credentials';

let root: string | null = null;

afterEach(async () => {
    if (root !== null) {
        await rm(root, { recursive: true, force: true });
        root = null;
    }
});

test('the embedded resolver persists an offline refresh through the production credential layer', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'sakre-oauth-refresh-'));
    root = directory;
    const workspace = path.join(directory, 'workspace');
    await mkdir(workspace);
    const credentialPath = path.join(directory, 'data', 'credentials.db');
    await prepareOAuthCredentialStore(credentialPath);
    const credentialID = await seedExpiredCredential(credentialPath);
    const otherID = await seedExpiredCredential(credentialPath, false);

    const options: OpenCode.CreateOptions = {
        config: { project: false, directory: workspace, content: '{}' },
        models: { fetch: false },
        fs: { filewatcher: false, fff: false },
        events: { persist: false },
        database: { path: path.join(directory, 'review.db') }
    };

    const scope = await Effect.runPromise(Scope.make());
    const otherScope = await Effect.runPromise(Scope.make());

    try {
        const credentials = persistentCredentialLayer({
            path: credentialPath,
            integrationID: 'openai',
            selectedCredentialID: credentialID
        });

        const host = await Effect.runPromise(
            OpenCode.create(options, {
                overrides: [Credential.node.replace(credentials)]
            }).pipe(Scope.provide(scope))
        );

        const otherCredentials = persistentCredentialLayer({
            path: credentialPath,
            integrationID: 'openai',
            selectedCredentialID: otherID
        });

        const otherHost = await Effect.runPromise(
            OpenCode.create(
                { ...options, database: { path: path.join(directory, 'review-b.db') } },
                { overrides: [Credential.node.replace(otherCredentials)] }
            ).pipe(Scope.provide(otherScope))
        );

        let resolvedAccess = '';

        const plugin = Plugin.define({
            id: 'offline-refresh-proof',
            effect: (context) =>
                Effect.gen(function* proveRefresh() {
                    yield* context.integration.transform((editor) => {
                        editor.method.update({
                            integrationID: 'openai',
                            method: { type: 'oauth', id: 'offline-test', label: 'Offline test' },
                            authorize: () => Effect.die(new Error('No authorization request expected.')),
                            refresh: (credential) =>
                                Effect.succeed(
                                    Credential.OAuth.make({
                                        type: 'oauth',
                                        methodID: credential.methodID,
                                        access: 'fake-refreshed-access',
                                        refresh: 'fake-refreshed-refresh',
                                        expires: Date.now() + 3_600_000
                                    })
                                )
                        });
                    });

                    const result = yield* context.integration.connection
                        .resolve({
                            type: 'credential',
                            id: credentialID,
                            label: 'offline account',
                            method: 'oauth'
                        })
                        .pipe(Effect.orDie);

                    if (result?.type !== 'oauth') {
                        throw new Error('The fake OAuth credential was not resolved.');
                    }

                    resolvedAccess = result.access;
                })
        });

        await Effect.runPromise(host.plugin(plugin));
        let otherAccess = '';
        await Effect.runPromise(
            otherHost.plugin(
                Plugin.define({
                    id: 'offline-other-account',
                    effect: (context) =>
                        Effect.gen(function* resolveOther() {
                            yield* context.integration.transform((editor) => {
                                editor.method.update({
                                    integrationID: 'openai',
                                    method: { type: 'oauth', id: 'offline-test', label: 'Offline test' },
                                    authorize: () => Effect.die(new Error('No authorization request expected.')),
                                    refresh: () =>
                                        Effect.die(new Error('The unexpired other account must not refresh.'))
                                });
                            });

                            const result = yield* context.integration.connection
                                .resolve({
                                    type: 'credential',
                                    id: otherID,
                                    label: 'other account',
                                    method: 'oauth'
                                })
                                .pipe(Effect.orDie);

                            if (result?.type !== 'oauth') {
                                throw new Error('The other credential was not resolved.');
                            }

                            otherAccess = result.access;
                        })
                })
            )
        );
        await Effect.runPromise(host.integration.list({ location: { directory: workspace } }));
        expect(resolvedAccess).toBe('fake-refreshed-access');
        const other = await Effect.runPromise(otherHost.integration.list({ location: { directory: workspace } }));
        expect(otherAccess).toBe('fake-original-access');
        expect(
            other.data
                .find((item) => item.id === 'openai')
                ?.connections.filter((item) => item.type === 'credential')
                .map((item) => String(item.id))
        ).toEqual([otherID]);
    } finally {
        await Effect.runPromise(Scope.close(scope, Exit.void));
        await Effect.runPromise(Scope.close(otherScope, Exit.void));
    }

    const selection = await resolveOAuthCredentialSelection({
        path: credentialPath,
        integrationID: 'openai',
        credentialID
    });

    expect(selection.kind).toBe('selected');

    if (selection.kind === 'selected') {
        expect(selection.credentialID).toBe(credentialID);
        expect(selection.secrets).toContain('fake-refreshed-access');
        expect(selection.secrets).toContain('fake-refreshed-refresh');
        expect(selection.secrets).not.toContain('fake-original-access');
    }

    const otherSelection = await resolveOAuthCredentialSelection({
        path: credentialPath,
        integrationID: 'openai',
        credentialID: otherID
    });

    expect(otherSelection).toMatchObject({ kind: 'selected', credentialID: otherID });

    if (otherSelection.kind === 'selected') {
        expect(otherSelection.secrets).toContain('fake-original-access');
        expect(otherSelection.secrets).not.toContain('fake-refreshed-access');
    }

    const newScope = await Effect.runPromise(Scope.make());

    try {
        const persistedLayer = persistentCredentialLayer({
            path: credentialPath,
            integrationID: 'openai',
            selectedCredentialID: credentialID
        });

        const hostC = await Effect.runPromise(
            OpenCode.create(
                { ...options, database: { path: path.join(directory, 'review-c.db') } },
                { overrides: [Credential.node.replace(persistedLayer)] }
            ).pipe(Scope.provide(newScope))
        );

        let reopenedAccess = '';
        await Effect.runPromise(
            hostC.plugin(
                Plugin.define({
                    id: 'offline-restart-proof',
                    effect: (context) =>
                        Effect.gen(function* resolvePersisted() {
                            yield* context.integration.transform((editor) => {
                                editor.method.update({
                                    integrationID: 'openai',
                                    method: { type: 'oauth', id: 'offline-test', label: 'Offline test' },
                                    authorize: () => Effect.die(new Error('No authorization request expected.')),
                                    refresh: () =>
                                        Effect.die(new Error('The refreshed account must not refresh twice.'))
                                });
                            });

                            const result = yield* context.integration.connection
                                .resolve({
                                    type: 'credential',
                                    id: credentialID,
                                    label: 'offline account',
                                    method: 'oauth'
                                })
                                .pipe(Effect.orDie);

                            if (result?.type !== 'oauth') {
                                throw new Error('The restarted host did not resolve the credential.');
                            }

                            reopenedAccess = result.access;
                        })
                })
            )
        );
        await Effect.runPromise(hostC.integration.list({ location: { directory: workspace } }));
        expect(reopenedAccess).toBe('fake-refreshed-access');
    } finally {
        await Effect.runPromise(Scope.close(newScope, Exit.void));
    }
});

async function seedExpiredCredential(databasePath: string, expired = true): Promise<string> {
    let expires = Date.now() + 3_600_000;

    if (expired) {
        expires = 0;
    }

    const layer = persistentCredentialLayer({
        path: databasePath,
        integrationID: 'openai',
        persistCreatedSelection: true
    });

    const credential = await Effect.runPromise(
        Effect.gen(function* seed() {
            const service = yield* Credential.Service;

            return yield* service.create({
                integrationID: Schema.decodeUnknownSync(Integration.ID)('openai'),
                label: 'offline account',
                value: Credential.OAuth.make({
                    type: 'oauth',
                    methodID: Schema.decodeUnknownSync(Integration.MethodID)('offline-test'),
                    access: 'fake-original-access',
                    refresh: 'fake-original-refresh',
                    expires
                })
            });
        }).pipe(Effect.provide(layer))
    );

    return credential.id;
}
