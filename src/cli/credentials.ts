import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import {
    CONTEXT7_API_KEY_ENV,
    PRODUCT_NAME,
    PRODUCT_SLUG,
    PROVIDER_API_KEY_ENV,
    PROVIDER_BASE_URL_ENV
} from '../identity';
import { collectSecretStrings } from '../redaction';
import type { AuthMode } from './program';

const JSON_INDENT = 4;

export class CredentialResolutionError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = 'CredentialResolutionError';
    }
}

export interface AuthStoreEntry {
    providerID: string;
    entry: Record<string, unknown>;
}

export interface AuthStore {
    path: string;
    entries: Record<string, Record<string, unknown>>;
}

/* Product store written by `auth login`: one API-key entry per provider; the
   engine database stays per-run. */
export interface EngineCredentialStore {
    path: string;
    entries: Record<string, Record<string, unknown>>;
}

export type AuthSelection =
    | { kind: 'none' }
    | { kind: 'env'; apiKey: string; baseURL?: string }
    | { kind: 'store'; store: AuthStore }
    | { kind: 'engine'; store: EngineCredentialStore };

export interface ResolveAuthSelectionInput {
    mode: AuthMode;
    environment: NodeJS.ProcessEnv;
    authStorePath?: string;
    engineCredentialPath?: string;
}

/* OpenCode resolves its credential store as
   `$XDG_DATA_HOME/opencode/auth.json` or `$HOME/.local/share/opencode/auth.json`
   on every platform. */
export function resolveAuthStorePath(input: { home?: string; xdgDataHome?: string } = {}): string {
    const home = optional(input.home) ?? homedir();
    const dataHome = optional(input.xdgDataHome) ?? path.join(home, '.local', 'share');

    return path.join(dataHome, 'opencode', 'auth.json');
}

export function readContext7ApiKey(environment: NodeJS.ProcessEnv): string | undefined {
    return optional(environment[CONTEXT7_API_KEY_ENV]);
}

/* Base URL is independent of credential source: gateways need it whatever store
   held the key. */
export function readProviderBaseURL(environment: NodeJS.ProcessEnv): string | undefined {
    return optional(environment[PROVIDER_BASE_URL_ENV]);
}

/* Selection order: allowed environment first, then product store, then OpenCode
   store. Mock runs need no credential. */
export async function resolveAuthSelection(input: ResolveAuthSelectionInput): Promise<AuthSelection> {
    const apiKey = optional(input.environment[PROVIDER_API_KEY_ENV]);
    const baseURL = optional(input.environment[PROVIDER_BASE_URL_ENV]);

    if (input.mode === 'env') {
        if (apiKey === undefined) {
            throw new CredentialResolutionError(`No API key in the environment: set ${PROVIDER_API_KEY_ENV}.`);
        }

        return { kind: 'env', apiKey, baseURL };
    }

    if (input.mode === 'auto' && apiKey !== undefined) {
        return { kind: 'env', apiKey, baseURL };
    }

    const selection = await resolveNonEnvironmentSelection(input);

    return selection;
}

async function resolveNonEnvironmentSelection(input: ResolveAuthSelectionInput): Promise<AuthSelection> {
    if (input.mode === 'auto' && input.engineCredentialPath !== undefined) {
        const engineStore = await loadEngineCredentialStore(input.engineCredentialPath);

        if (engineStore !== undefined) {
            return { kind: 'engine', store: engineStore };
        }
    }

    const authStorePath =
        input.authStorePath ??
        resolveAuthStorePath({
            home: input.environment.HOME,
            xdgDataHome: input.environment.XDG_DATA_HOME
        });

    const store = await loadAuthStore(authStorePath);

    if (store !== undefined) {
        return { kind: 'store', store };
    }

    /* A missing store proves nothing about key need. The isolated host decides
       from integration and catalogue. */
    return { kind: 'none' };
}

export async function loadAuthStore(authStorePath: string): Promise<AuthStore | undefined> {
    const content = await readStoreContent(authStorePath);

    if (content === undefined) {
        return undefined;
    }

    const parsed = parseStoreJson(content, authStorePath);

    return { path: authStorePath, entries: parseStoreEntries(parsed, authStorePath, 'OpenCode credential store') };
}

export async function loadEngineCredentialStore(credentialPath: string): Promise<EngineCredentialStore | undefined> {
    const content = await readStoreContent(credentialPath);

    if (content === undefined) {
        return undefined;
    }

    const parsed = parseEngineStoreJson(content, credentialPath);

    return {
        path: credentialPath,
        entries: parseStoreEntries(parsed, credentialPath, `${PRODUCT_NAME} credential store`)
    };
}

/* Atomic write: unique temp file renamed over the store, so readers see old or
   new complete file. User-only mode where platforms honour it. */
export async function writeEngineCredential(input: {
    path: string;
    providerID: string;
    apiKey: string;
}): Promise<void> {
    const existing = await loadEngineCredentialStore(input.path);
    const entries = { ...existing?.entries, [input.providerID]: { type: 'api', key: input.apiKey } };
    const content = `${JSON.stringify({ version: 1, providers: entries }, undefined, JSON_INDENT)}\n`;
    await mkdir(path.dirname(input.path), { recursive: true });
    const temporary = `${input.path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, input.path);
}

/* Only the API-key entry for the requested provider may cross this boundary. */
export function requireEngineCredential(store: EngineCredentialStore, providerID: string): string {
    const entry = store.entries[providerID];
    const key = entry?.key;

    if (typeof key !== 'string' || key === '') {
        throw new CredentialResolutionError(
            `No API-key credential for provider "${providerID}" in the ${PRODUCT_NAME} credential store (${store.path}): run "${PRODUCT_SLUG} auth login ${providerID} --key <key>" or set ${PROVIDER_API_KEY_ENV}.`
        );
    }

    return key;
}

async function readStoreContent(storePath: string): Promise<string | undefined> {
    try {
        return await readFile(storePath, 'utf8');
    } catch {
        return undefined;
    }
}

// eslint-disable-next-line anti-slop/no-unknown-returns -- JSON.parse yields unknown until entry-validated
function parseStoreJson(content: string, authStorePath: string): unknown {
    try {
        return JSON.parse(content);
    } catch {
        throw new CredentialResolutionError(`OpenCode credential store at ${authStorePath} is not valid JSON.`);
    }
}

// eslint-disable-next-line anti-slop/no-unknown-returns -- JSON.parse yields unknown until entry-validated
function parseEngineStoreJson(content: string, credentialPath: string): unknown {
    try {
        const parsed: unknown = JSON.parse(content);

        if (isRecord(parsed)) {
            const { providers } = parsed;

            if (providers === undefined || isRecord(providers)) {
                return providers ?? {};
            }
        }

        throw new CredentialResolutionError(
            `${PRODUCT_NAME} credential store at ${credentialPath} is not a provider map.`
        );
    } catch (error) {
        if (error instanceof CredentialResolutionError) {
            throw error;
        }

        throw new CredentialResolutionError(`${PRODUCT_NAME} credential store at ${credentialPath} is not valid JSON.`);
    }
}

/* Only the entry for the requested provider may ever cross this boundary. */
export function requireAuthStoreEntry(store: AuthStore, providerID: string): AuthStoreEntry {
    const entry = store.entries[providerID];

    if (entry === undefined) {
        throw missingCredentialError(providerID);
    }

    return { providerID, entry };
}

/* Every string in the entry counts as a secret for redaction: keys and account
   ids never reach a log. */
export function authStoreSecretValues(entry: Record<string, unknown>): string[] {
    return collectSecretStrings(entry);
}

// eslint-disable-next-line anti-slop/no-unknown-parameters -- validates decoded store JSON into provider entries
function parseStoreEntries(value: unknown, storePath: string, label: string): Record<string, Record<string, unknown>> {
    if (!isRecord(value)) {
        throw new CredentialResolutionError(`${label} at ${storePath} is not an object.`);
    }

    const entries: Record<string, Record<string, unknown>> = {};

    for (const [providerID, entry] of Object.entries(value)) {
        if (isRecord(entry)) {
            entries[providerID] = entry;
        }
    }

    // eslint-disable-next-line anti-slop/no-known-value-widening -- validated entries returned as the store contract
    return entries;
}

function missingCredentialError(providerID?: string): CredentialResolutionError {
    let provider = '';

    if (providerID !== undefined) {
        provider = ` for provider "${providerID}"`;
    }

    return new CredentialResolutionError(
        `No credential${provider}: run "${PRODUCT_SLUG} auth login <provider> --key <key>" or set ${PROVIDER_API_KEY_ENV}.`
    );
}

function optional(value: string | undefined): string | undefined {
    if (value === undefined || value.trim() === '') {
        return undefined;
    }

    return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
