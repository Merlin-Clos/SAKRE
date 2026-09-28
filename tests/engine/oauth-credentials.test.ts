import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { Credential } from '@opencode/core/credential';
import { Integration } from '@opencode/schema/integration';
import { Effect, Schema } from 'effect';
import {
    listOAuthCredentials,
    persistentCredentialLayer,
    prepareOAuthCredentialStore,
    removeOAuthCredential,
    resolveOAuthCredentialSelection
} from '../../src/engine/oauth-credentials';
import { collectCredentialSecrets } from '../../src/engine/oauth-store-db';
import { rejectionOf } from '../helpers/rejection';

let root = '';

let databasePath = '';

beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'sakre-oauth-store-'));
    databasePath = path.join(root, 'private', 'credentials.db');
    await prepareOAuthCredentialStore(databasePath);
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

describe('persistent OAuth credentials', () => {
    test('stores OpenCode values privately and selects the credential created by login', async () => {
        const created = await createCredential('openai', 'account-a', oauth('access-a'), true);

        const selection = await resolveOAuthCredentialSelection({ path: databasePath, integrationID: 'openai' });
        expect(selection.kind).toBe('selected');

        if (selection.kind === 'selected') {
            expect(selection.credentialID).toBe(created.id);
            expect(selection.secrets).toContain('access-a');
            expect(selection.secrets).toContain('refresh-a');
        }

        const directoryStat = await stat(path.dirname(databasePath));
        const databaseStat = await stat(databasePath);
        const directoryMode = directoryStat.mode % 0o1000;
        const databaseMode = databaseStat.mode % 0o1000;
        expect(directoryMode).toBe(0o700);
        expect(databaseMode).toBe(0o600);
    });

    test('keeps activation host-local and updates only the selected credential', async () => {
        const credentialA = await createCredential('openai', 'account-a', oauth('access-a'), false);
        const credentialB = await createCredential('openai', 'account-b', oauth('access-b'), false);
        const serviceA = layerOptions('openai', credentialA.id);
        const serviceB = layerOptions('openai', credentialB.id);

        await Promise.all([
            withCredentialService(serviceA, (service) =>
                service.update(credentialA.id, { value: oauth('refreshed-a') })
            ),
            withCredentialService(serviceB, (service) => service.activate(credentialB.id))
        ]);

        const selectedA = await withCredentialService(serviceA, (service) => service.all());
        const selectedB = await withCredentialService(serviceB, (service) => service.all());
        expect(selectedA.map((credential) => credential.id)).toEqual([credentialA.id]);
        expect(selectedB.map((credential) => credential.id)).toEqual([credentialB.id]);
        expect(selectedA[0]?.value).toEqual(oauth('refreshed-a'));
        expect(selectedB[0]?.value).toEqual(oauth('access-b'));
    });

    test('a provider host cannot list or activate credentials from a different integration', async () => {
        const openai = await createCredential('openai', 'openai account', oauth('access-openai'), false);
        const copilot = await createCredential('github-copilot', 'copilot account', oauth('access-copilot'), false);
        const options = layerOptions('openai', openai.id);
        const visible = await withCredentialService(options, (service) => service.list(copilot.integrationID));
        expect(visible).toEqual([]);
        /* The positive leg: the host still sees exactly its own selection. */
        const own = await withCredentialService(options, (service) => service.list(openai.integrationID));
        expect(own.map((credential) => credential.id)).toEqual([openai.id]);
        const unselected = await withCredentialService(layerOptions('openai'), (service) => service.all());
        expect(unselected).toEqual([]);
        const failure = await rejectionOf(withCredentialService(options, (service) => service.activate(copilot.id)));
        expect(failure.message).toContain('another provider');
        expect(failure.message).not.toContain('access-copilot');
    });

    test('a provider host cannot update or remove credentials from a different integration', async () => {
        const openai = await createCredential('openai', 'openai account', oauth('access-openai'), false);
        const copilot = await createCredential('github-copilot', 'copilot account', oauth('access-copilot'), false);
        /* Stale pairing: this host selects a row owned by another provider. */
        const options = layerOptions('openai', copilot.id);

        const updateFailure = await rejectionOf(
            withCredentialService(options, (service) => service.update(copilot.id, { value: oauth('access-evil') }))
        );

        expect(updateFailure.message).toContain('another provider');

        const removeFailure = await rejectionOf(
            withCredentialService(options, (service) => service.remove(copilot.id))
        );

        expect(removeFailure.message).toContain('another provider');

        /* The foreign row is untouched and still owned by its provider. */
        const own = await withCredentialService(layerOptions('github-copilot', copilot.id), (service) => service.all());

        expect(own.map((credential) => credential.id)).toEqual([copilot.id]);
        expect(own[0]?.value).toEqual(oauth('access-copilot'));
        expect(openai.id).not.toBe(copilot.id);
    });

    test('engine secret collection includes stringified primitives from metadata', () => {
        const secrets = collectCredentialSecrets({
            type: 'key',
            key: 'api-key-value',
            metadata: { port: 8080, debug: true }
        });

        expect(secrets).toContain('api-key-value');
        expect(secrets).toContain('8080');
        expect(secrets).toContain('true');
    });

    test('serializes simultaneous writes to one credential without a partial value', async () => {
        const created = await createCredential('openai', 'shared', oauth('access-initial'), false);
        const options = layerOptions('openai', created.id);

        await Promise.all([
            withCredentialService(options, (service) => service.update(created.id, { value: oauth('access-first') })),
            withCredentialService(options, (service) => service.update(created.id, { value: oauth('access-second') }))
        ]);

        const [stored] = await withCredentialService(options, (service) => service.all());
        expect(stored?.value.type).toBe('oauth');

        if (stored?.value.type === 'oauth') {
            expect(['access-first', 'access-second']).toContain(stored.value.access);
            expect(stored.value.refresh).toBe(stored.value.access.replace('access', 'refresh'));
        }
    });

    test('keeps live SQLite sidecars private on Unix', async () => {
        if (process.platform === 'win32') {
            return;
        }

        const layer = persistentCredentialLayer({ path: databasePath, integrationID: 'openai' });

        const modes = await Effect.runPromise(
            Effect.gen(function* inspectSidecars() {
                const service = yield* Credential.Service;
                yield* service.create({
                    integrationID: Schema.decodeUnknownSync(Integration.ID)('openai'),
                    label: 'sidecars',
                    value: oauth('access-sidecar')
                });

                return yield* Effect.promise(async () => {
                    const wal = await stat(`${databasePath}-wal`);
                    const shm = await stat(`${databasePath}-shm`);

                    return { wal: wal.mode % 0o1000, shm: shm.mode % 0o1000 };
                });
            }).pipe(Effect.provide(layer))
        );

        expect(modes).toEqual({ wal: 0o600, shm: 0o600 });
    });

    test('restores a pre-existing credential directory to private mode when reading the store', async () => {
        if (process.platform === 'win32') {
            return;
        }

        const directory = path.dirname(databasePath);
        await chmod(directory, 0o755);
        expect(await listOAuthCredentials(databasePath)).toEqual([]);
        const directoryStat = await stat(directory);
        const mode = directoryStat.mode % 0o1000;
        expect(mode).toBe(0o700);
    });

    test('lists metadata without values and removes the selected credential', async () => {
        const created = await createCredential('github-copilot', 'work', oauth('copilot-access'), true);
        expect(await listOAuthCredentials(databasePath)).toEqual([
            {
                credentialID: created.id,
                integrationID: 'github-copilot',
                label: 'work',
                selected: true
            }
        ]);

        expect(await removeOAuthCredential(databasePath, created.id)).toBe(true);
        expect(await removeOAuthCredential(databasePath, created.id)).toBe(false);
        expect(await resolveOAuthCredentialSelection({ path: databasePath, integrationID: 'github-copilot' })).toEqual({
            kind: 'none'
        });
    });

    test('rejects API keys and malformed stored values without exposing their payloads', async () => {
        const keyFailure = await rejectionOf(
            withCredentialService(layerOptions('openai'), (service) =>
                service.create({
                    integrationID: Schema.decodeUnknownSync(Integration.ID)('openai'),
                    value: Credential.Key.make({ type: 'key', key: 'must-not-leak-api-key' })
                })
            )
        );

        expect(keyFailure.message).toContain('does not accept API-key credentials');
        expect(keyFailure.message).not.toContain('must-not-leak');

        const database = new Database(databasePath);
        database
            .query(
                'INSERT INTO credentials (id, integration_id, label, value, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)'
            )
            .run(
                'cred_invalid',
                'openai',
                'invalid',
                JSON.stringify({
                    type: 'oauth',
                    methodID: 'test',
                    access: 'must-not-leak-oauth-access',
                    refresh: 'must-not-leak-oauth-refresh',
                    expires: 'invalid'
                }),
                1,
                1
            );
        database.close();

        const storedFailure = await rejectionOf(
            resolveOAuthCredentialSelection({
                path: databasePath,
                integrationID: 'openai',
                credentialID: 'cred_invalid'
            })
        );

        expect(storedFailure.message).toContain('Stored OAuth credential');
        expect(storedFailure.message).not.toContain('must-not-leak');
    });

    test('a missing store fails closed without creating a phantom database', async () => {
        const missing = path.join(root, 'absent', 'credentials.db');

        const failure = await rejectionOf(
            resolveOAuthCredentialSelection({ path: missing, integrationID: 'openai', credentialID: 'ghost' })
        );

        expect(failure.message).toContain('does not exist');
        expect(await resolveOAuthCredentialSelection({ path: missing, integrationID: 'openai' })).toEqual({
            kind: 'none'
        });
        expect(await Bun.file(missing).exists()).toBe(false);
        expect(await removeOAuthCredential(missing, 'ghost')).toBe(false);
        expect(await Bun.file(missing).exists()).toBe(false);
    });

    test('restores a pre-existing credential file to private mode', async () => {
        if (process.platform === 'win32') {
            return;
        }

        await chmod(databasePath, 0o644);
        await prepareOAuthCredentialStore(databasePath);
        const databaseStat = await stat(databasePath);
        expect(databaseStat.mode % 0o1000).toBe(0o600);
    });

    test('flags exactly the persisted row as selected when several exist', async () => {
        const selected = await createCredential('openai', 'first', oauth('access-first'), true);
        const other = await createCredential('openai', 'second', oauth('access-second'), false);

        expect(await listOAuthCredentials(databasePath)).toEqual([
            { credentialID: selected.id, integrationID: 'openai', label: 'first', selected: true },
            { credentialID: other.id, integrationID: 'openai', label: 'second', selected: false }
        ]);
    });

    test('a persisted selection disambiguates several credentials', async () => {
        const selected = await createCredential('openai', 'first', oauth('access-first'), true);
        await createCredential('openai', 'second', oauth('access-second'), false);

        const resolution = await resolveOAuthCredentialSelection({ path: databasePath, integrationID: 'openai' });
        expect(resolution.kind).toBe('selected');

        if (resolution.kind === 'selected') {
            expect(resolution.credentialID).toBe(selected.id);
            expect(resolution.secrets).toContain('access-first');
        }
    });

    test('rejects updating a credential the host did not select', async () => {
        const credentialA = await createCredential('openai', 'account-a', oauth('access-a'), false);
        const credentialB = await createCredential('openai', 'account-b', oauth('access-b'), false);
        const serviceA = layerOptions('openai', credentialA.id);

        const failure = await rejectionOf(
            withCredentialService(serviceA, (service) =>
                service.update(credentialB.id, { value: oauth('access-evil') })
            )
        );

        expect(failure.message).toContain('did not select');

        const stored = await withCredentialService(serviceA, (service) => service.all());
        expect(stored.map((credential) => credential.id)).toEqual([credentialA.id]);
        expect(stored[0]?.value).toEqual(oauth('access-a'));
    });

    test('a selection pointing at another provider credential stays empty', async () => {
        await createCredential('openai', 'openai account', oauth('access-openai'), false);
        const copilot = await createCredential('github-copilot', 'copilot account', oauth('access-copilot'), false);
        const options = layerOptions('openai', copilot.id);

        expect(await withCredentialService(options, (service) => service.all())).toEqual([]);
        expect(await withCredentialService(options, (service) => service.get(copilot.id))).toBeUndefined();
    });

    test('rejects persisting a credential for another provider', async () => {
        const failure = await rejectionOf(
            withCredentialService(layerOptions('openai'), (service) =>
                service.create({
                    integrationID: Schema.decodeUnknownSync(Integration.ID)('github-copilot'),
                    label: 'cross',
                    value: oauth('access-cross')
                })
            )
        );

        expect(failure.message).toContain('another provider');

        const stored = await withCredentialService(layerOptions('openai'), (service) => service.all());
        expect(stored).toEqual([]);
    });

    test('rejects updating an unknown credential id', async () => {
        const missing = Credential.ID.create();

        const failure = await rejectionOf(
            withCredentialService(layerOptions('openai', missing), (service) =>
                service.update(missing, { label: 'renamed' })
            )
        );

        expect(failure.message).toContain('missing');
    });
});

function createCredential(
    integrationID: string,
    label: string,
    value: Credential.OAuth,
    persistCreatedSelection: boolean
): Promise<Credential.Info> {
    return withCredentialService({ ...layerOptions(integrationID), persistCreatedSelection }, (service) =>
        service.create({
            integrationID: Schema.decodeUnknownSync(Integration.ID)(integrationID),
            label,
            value
        })
    );
}

function withCredentialService<Value>(
    options: ReturnType<typeof layerOptions> & { persistCreatedSelection?: boolean },
    use: (service: Credential.Interface) => Effect.Effect<Value>
): Promise<Value> {
    const layer = persistentCredentialLayer(options);

    return Effect.runPromise(
        Effect.gen(function* useCredentialService() {
            const service = yield* Credential.Service;

            return yield* use(service);
        }).pipe(Effect.provide(layer))
    );
}

function layerOptions(
    integrationID: string,
    selectedCredentialID?: string
): { path: string; integrationID: string; selectedCredentialID?: string } {
    // eslint-disable-next-line anti-slop/no-known-value-widening -- credential-layer options fixture; annotation documents the contract
    return { path: databasePath, integrationID, selectedCredentialID };
}

function oauth(access: string): Credential.OAuth {
    return Credential.OAuth.make({
        type: 'oauth',
        methodID: Schema.decodeUnknownSync(Integration.MethodID)('offline-test'),
        access,
        refresh: access.replace('access', 'refresh'),
        expires: 0
    });
}
