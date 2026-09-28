import { chmod, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { Credential } from '@opencode/core/credential';
import { Effect, Layer } from 'effect';
import type { Database } from 'bun:sqlite';
import {
    collectCredentialSecrets,
    countCredentials,
    decodeIntegrationID,
    fileExists,
    insertCredential,
    OAuthCredentialError,
    openCredentialDatabase,
    readAllCredentials,
    readCredential,
    readCredentials,
    readSelectedID,
    readSelections,
    removeStoredCredential,
    secureDatabaseFiles,
    updateCredential,
    writeSelection
} from './oauth-store-db';

export { OAuthCredentialError } from './oauth-store-db';

const PRIVATE_DIRECTORY_MODE = 0o700;

const PRIVATE_FILE_MODE = 0o600;

export interface PersistentCredentialLayerOptions {
    path: string;
    integrationID: string;
    selectedCredentialID?: string;
    persistCreatedSelection?: boolean;
    platform?: NodeJS.Platform;
}

export interface OAuthCredentialSummary {
    credentialID: string;
    integrationID: string;
    label: string;
    selected: boolean;
}

export type OAuthCredentialSelection =
    | { kind: 'none' }
    | { kind: 'ambiguous'; count: number }
    | { kind: 'selected'; credentialID: string; secrets: string[] };

export async function prepareOAuthCredentialStore(
    databasePath: string,
    platform: NodeJS.Platform = process.platform
): Promise<void> {
    const directory = path.dirname(databasePath);
    await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });

    if (platform !== 'win32') {
        await chmod(directory, PRIVATE_DIRECTORY_MODE);
    }

    const handle = await open(databasePath, 'a', PRIVATE_FILE_MODE);
    await handle.close();

    if (platform !== 'win32') {
        await chmod(databasePath, PRIVATE_FILE_MODE);
    }

    const database = openCredentialDatabase(databasePath, platform);
    database.close();
}

export function persistentCredentialLayer(options: PersistentCredentialLayerOptions): Layer.Layer<Credential.Service> {
    return Layer.effect(
        Credential.Service,
        Effect.acquireRelease(
            Effect.sync(() => openCredentialService(options)),
            (opened) => Effect.sync(opened.close)
        ).pipe(Effect.map((opened) => opened.service))
    );
}

export async function resolveOAuthCredentialSelection(input: {
    path: string;
    integrationID: string;
    credentialID?: string;
}): Promise<OAuthCredentialSelection> {
    if (!(await fileExists(input.path))) {
        if (input.credentialID !== undefined) {
            throw new OAuthCredentialError(`OAuth credential "${input.credentialID}" does not exist.`);
        }

        return { kind: 'none' };
    }

    const database = openCredentialDatabase(input.path, process.platform);

    try {
        return selectedFromDatabase(database, input);
    } finally {
        database.close();
    }
}

function selectedFromDatabase(
    database: Database,
    input: { integrationID: string; credentialID?: string }
): OAuthCredentialSelection {
    const selectedID = input.credentialID ?? readSelectedID(database, input.integrationID);

    if (selectedID !== undefined) {
        const credential = readCredential(database, selectedID);

        if (credential === undefined || credential.integrationID !== input.integrationID) {
            throw new OAuthCredentialError(
                `OAuth credential "${selectedID}" does not belong to provider "${input.integrationID}".`
            );
        }

        return selectedCredential(credential);
    }

    const count = countCredentials(database, input.integrationID);

    if (count > 1) {
        return { kind: 'ambiguous', count };
    }

    return singleOrNone(database, input.integrationID);
}

function singleOrNone(database: Database, integrationID: string): OAuthCredentialSelection {
    const [credential] = readCredentials(database, integrationID);

    if (credential === undefined) {
        return { kind: 'none' };
    }

    return selectedCredential(credential);
}

function selectedCredential(credential: Credential.Info): OAuthCredentialSelection {
    return { kind: 'selected', credentialID: credential.id, secrets: collectCredentialSecrets(credential.value) };
}

export async function listOAuthCredentials(databasePath: string): Promise<OAuthCredentialSummary[]> {
    if (!(await fileExists(databasePath))) {
        return [];
    }

    const database = openCredentialDatabase(databasePath, process.platform);

    try {
        const selected = new Map(readSelections(database).map((row) => [row.integration_id, row.credential_id]));

        return readAllCredentials(database).map((credential) => ({
            credentialID: credential.id,
            integrationID: credential.integrationID,
            label: credential.label,
            selected: selected.get(credential.integrationID) === credential.id
        }));
    } finally {
        database.close();
    }
}

export async function readOAuthCredentialSecrets(databasePath: string): Promise<string[]> {
    if (!(await fileExists(databasePath))) {
        return [];
    }

    const database = openCredentialDatabase(databasePath, process.platform);

    try {
        return readAllCredentials(database).flatMap((credential) => collectCredentialSecrets(credential.value));
    } finally {
        database.close();
    }
}

export async function removeOAuthCredential(databasePath: string, credentialID: string): Promise<boolean> {
    if (!(await fileExists(databasePath))) {
        return false;
    }

    const database = openCredentialDatabase(databasePath, process.platform);

    try {
        const result = removeStoredCredential(database, credentialID);
        secureDatabaseFiles(databasePath, process.platform);

        return result;
    } finally {
        database.close();
    }
}

interface OpenedCredentialService {
    service: Credential.Interface;
    close: () => void;
}

function openCredentialService(options: PersistentCredentialLayerOptions): OpenedCredentialService {
    const platform = options.platform ?? process.platform;
    const database = openCredentialDatabase(options.path, platform);

    return {
        service: createCredentialService(database, options, platform),
        close: () => {
            database.close();
        }
    };
}

function createCredentialService(
    database: Database,
    options: PersistentCredentialLayerOptions,
    platform: NodeJS.Platform
): Credential.Interface {
    const state: CredentialServiceState = { database, options, platform, selectedID: options.selectedCredentialID };
    const integrationID = decodeIntegrationID(options.integrationID);

    return Credential.Service.of({
        all: () => Effect.sync(() => selectedCredentials(state)),
        list: (requestedIntegrationID) =>
            Effect.sync(() => {
                if (requestedIntegrationID !== integrationID) {
                    return [];
                }

                return selectedCredentials(state);
            }),
        get: (credentialID) =>
            Effect.sync(() => selectedCredentials(state).find((credential) => credential.id === credentialID)),
        create: (input) => Effect.sync(() => createSelectedCredential(state, input)),
        activate: (credentialID) =>
            Effect.sync(() => {
                const credential = readCredential(database, credentialID);

                if (credential === undefined || credential.integrationID !== integrationID) {
                    throw new OAuthCredentialError('Cannot activate an OAuth credential for another provider.');
                }

                state.selectedID = credentialID;
            }),
        update: (credentialID, updates) =>
            Effect.sync(() => {
                if (credentialID !== state.selectedID) {
                    throw new OAuthCredentialError('Cannot update an OAuth credential that this host did not select.');
                }

                assertSelectedIntegration(state, credentialID, 'update');
                updateCredential(database, credentialID, updates);
                secureDatabaseFiles(options.path, platform);
            }),
        remove: (credentialID) =>
            Effect.sync(() => {
                removeSelectedCredential(state, credentialID);
            })
    });
}

interface CredentialServiceState {
    database: Database;
    options: PersistentCredentialLayerOptions;
    platform: NodeJS.Platform;
    selectedID?: string;
}

/* Reads stay filtered by selection, but a stale or mismatched selection can
   still pair this host with another provider's row (see createHost): writes
   must re-check the row's integration like activate does. */
function assertSelectedIntegration(
    state: CredentialServiceState,
    credentialID: Credential.ID,
    action: 'update' | 'remove'
): void {
    const credential = readCredential(state.database, credentialID);
    const integrationID = decodeIntegrationID(state.options.integrationID);

    if (credential !== undefined && credential.integrationID !== integrationID) {
        throw new OAuthCredentialError(`Cannot ${action} an OAuth credential for another provider.`);
    }
}

function selectedCredentials(state: CredentialServiceState): Credential.Info[] {
    if (state.selectedID === undefined) {
        return [];
    }

    const credential = readCredential(state.database, state.selectedID);

    if (credential === undefined || credential.integrationID !== state.options.integrationID) {
        return [];
    }

    return [credential];
}

function createSelectedCredential(
    state: CredentialServiceState,
    input: Parameters<Credential.Interface['create']>[0]
): Credential.Info {
    const credential = createStoredCredential(state.database, state.options, input);
    state.selectedID = credential.id;
    secureDatabaseFiles(state.options.path, state.platform);

    return credential;
}

function removeSelectedCredential(state: CredentialServiceState, credentialID: Credential.ID): void {
    if (credentialID !== state.selectedID) {
        return;
    }

    assertSelectedIntegration(state, credentialID, 'remove');
    removeStoredCredential(state.database, credentialID);
    state.selectedID = undefined;
    secureDatabaseFiles(state.options.path, state.platform);
}

function createStoredCredential(
    database: Database,
    options: PersistentCredentialLayerOptions,
    input: { integrationID: Credential.Info['integrationID']; label?: string; value: Credential.Value }
): Credential.Info {
    if (input.integrationID !== options.integrationID) {
        throw new OAuthCredentialError('The OAuth host tried to persist a credential for another provider.');
    }

    if (input.value.type !== 'oauth') {
        throw new OAuthCredentialError('The persistent OAuth store does not accept API-key credentials.');
    }

    const credential = new Credential.Info({
        id: Credential.ID.create(),
        integrationID: input.integrationID,
        label: input.label ?? options.integrationID,
        value: input.value
    });

    database.transaction(() => {
        insertCredential(database, credential);

        if (options.persistCreatedSelection === true) {
            writeSelection(database, credential.integrationID, credential.id);
        }
    })();

    return credential;
}
