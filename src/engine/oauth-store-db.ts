import { Database } from 'bun:sqlite';
import { chmodSync, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { Credential } from '@opencode/core/credential';
import { Integration } from '@opencode/schema/integration';
import { Schema } from 'effect';
import { collectSecretStrings } from '../redaction';

export class OAuthCredentialError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = 'OAuthCredentialError';
    }
}

const PRIVATE_FILE_MODE = 0o600;

const PRIVATE_DIRECTORY_MODE = 0o700;

const SQLITE_BUSY_TIMEOUT_MS = 5000;

interface StoredCredentialRow {
    id: string;
    integration_id: string;
    label: string;
    value: string;
}

export function openCredentialDatabase(databasePath: string, platform: NodeJS.Platform): Database {
    if (platform !== 'win32') {
        chmodSync(path.dirname(databasePath), PRIVATE_DIRECTORY_MODE);
    }

    const database = new Database(databasePath, { create: true });
    database.run(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    database.run('PRAGMA journal_mode = WAL');
    database.run(`
        CREATE TABLE IF NOT EXISTS credentials (
            id TEXT PRIMARY KEY,
            integration_id TEXT NOT NULL,
            label TEXT NOT NULL,
            value TEXT NOT NULL,
            time_created INTEGER NOT NULL,
            time_updated INTEGER NOT NULL
        )
    `);
    database.run(
        'CREATE INDEX IF NOT EXISTS credentials_integration_idx ON credentials (integration_id, time_created, id)'
    );
    database.run(`CREATE TABLE IF NOT EXISTS selections (
            integration_id TEXT PRIMARY KEY,
            credential_id TEXT NOT NULL
        )
    `);
    secureDatabaseFiles(databasePath, platform);

    return database;
}

export function insertCredential(database: Database, credential: Credential.Info): void {
    const now = Date.now();
    database
        .query(
            'INSERT INTO credentials (id, integration_id, label, value, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)'
        )
        .run(credential.id, credential.integrationID, credential.label, JSON.stringify(credential.value), now, now);
}

export function removeStoredCredential(database: Database, credentialID: string): boolean {
    return database.transaction(() => {
        database.query('DELETE FROM selections WHERE credential_id = ?').run(credentialID);

        return database.query('DELETE FROM credentials WHERE id = ?').run(credentialID).changes > 0;
    })();
}

export function updateCredential(
    database: Database,
    credentialID: Credential.ID,
    updates: Partial<Pick<Credential.Info, 'label' | 'value'>>
): void {
    const current = readCredential(database, credentialID);

    if (current === undefined) {
        throw new OAuthCredentialError('Cannot update a missing OAuth credential.');
    }

    const label = updates.label ?? current.label;
    const value = updates.value ?? current.value;
    requireOAuthValue(value);
    database
        .query('UPDATE credentials SET label = ?, value = ?, time_updated = ? WHERE id = ?')
        .run(label, JSON.stringify(value), Date.now(), credentialID);
}

export function readCredential(database: Database, credentialID: string): Credential.Info | undefined {
    const row = database
        .query<StoredCredentialRow, [string]>('SELECT id, integration_id, label, value FROM credentials WHERE id = ?')
        .get(credentialID);

    if (row === null) {
        return undefined;
    }

    return decodeCredential(row);
}

export function readCredentials(database: Database, integrationID: string): Credential.Info[] {
    return database
        .query<StoredCredentialRow, [string]>(
            'SELECT id, integration_id, label, value FROM credentials WHERE integration_id = ? ORDER BY time_created, id'
        )
        .all(integrationID)
        .map((row) => decodeCredential(row));
}

export function readAllCredentials(database: Database): Credential.Info[] {
    return database
        .query<StoredCredentialRow, []>(
            'SELECT id, integration_id, label, value FROM credentials ORDER BY integration_id, time_created, id'
        )
        .all()
        .map((row) => decodeCredential(row));
}

export function countCredentials(database: Database, integrationID: string): number {
    const row = database
        .query<{ count: number }, [string]>('SELECT COUNT(*) AS count FROM credentials WHERE integration_id = ?')
        .get(integrationID);

    return row?.count ?? 0;
}

function decodeCredential(row: StoredCredentialRow): Credential.Info {
    try {
        const value = Schema.decodeUnknownSync(Credential.OAuth)(JSON.parse(row.value));

        return new Credential.Info({
            id: Schema.decodeUnknownSync(Credential.ID)(row.id),
            integrationID: decodeIntegrationID(row.integration_id),
            label: row.label,
            value
        });
    } catch {
        throw new OAuthCredentialError(`Stored OAuth credential "${row.id}" is invalid.`);
    }
}

export function decodeIntegrationID(value: string): Integration.ID {
    return Schema.decodeUnknownSync(Integration.ID)(value);
}

export function writeSelection(database: Database, integrationID: string, credentialID: string): void {
    database
        .query(
            'INSERT INTO selections (integration_id, credential_id) VALUES (?, ?) ON CONFLICT(integration_id) DO UPDATE SET credential_id = excluded.credential_id'
        )
        .run(integrationID, credentialID);
}

export function readSelectedID(database: Database, integrationID: string): string | undefined {
    const row = database
        .query<{ credential_id: string }, [string]>('SELECT credential_id FROM selections WHERE integration_id = ?')
        .get(integrationID);

    return row?.credential_id;
}

export function readSelections(database: Database): { integration_id: string; credential_id: string }[] {
    return database
        .query<{ integration_id: string; credential_id: string }, []>(
            'SELECT integration_id, credential_id FROM selections'
        )
        .all();
}

export function collectCredentialSecrets(value: Credential.Value): string[] {
    if (value.type === 'key') {
        return [value.key, ...collectSecretStrings(value.metadata), ...collectSecretStrings(value.configuration)];
    }

    return [value.access, value.refresh, ...collectSecretStrings(value.metadata)];
}

function requireOAuthValue(value: Credential.Value): asserts value is Credential.OAuth {
    if (value.type !== 'oauth') {
        throw new OAuthCredentialError('The persistent OAuth store does not accept API-key credentials.');
    }
}

export function secureDatabaseFiles(databasePath: string, platform: NodeJS.Platform): void {
    if (platform === 'win32') {
        return;
    }

    for (const filePath of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
        if (existsSync(filePath)) {
            chmodSync(filePath, PRIVATE_FILE_MODE);
        }
    }
}

export async function fileExists(filePath: string): Promise<boolean> {
    try {
        const info = await stat(filePath);

        return info.isFile();
    } catch (error) {
        if (isMissingFileError(error)) {
            return false;
        }

        throw error;
    }
}

// eslint-disable-next-line anti-slop/no-unknown-parameters -- fs rejection is untyped; narrowed to the ENOENT check below
function isMissingFileError(error: unknown): boolean {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
