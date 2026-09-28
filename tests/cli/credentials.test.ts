import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    authStoreSecretValues,
    CredentialResolutionError,
    loadAuthStore,
    loadEngineCredentialStore,
    requireAuthStoreEntry,
    requireEngineCredential,
    resolveAuthSelection,
    resolveAuthStorePath,
    writeEngineCredential
} from '../../src/cli/credentials';
import { PROVIDER_API_KEY_ENV, PROVIDER_BASE_URL_ENV } from '../../src/identity';
import { rejectionOf } from '../helpers/rejection';

let root = '';

let storePath = '';

beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'sakre-credentials-'));
    storePath = path.join(root, 'auth.json');
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

describe('OpenCode credential store', () => {
    test('resolves the store path from HOME or XDG_DATA_HOME', () => {
        expect(resolveAuthStorePath({ home: '/home/user' })).toBe('/home/user/.local/share/opencode/auth.json');
        expect(resolveAuthStorePath({ home: '/home/user', xdgDataHome: '/data' })).toBe('/data/opencode/auth.json');
    });

    test('returns undefined for a missing store and rejects invalid JSON', async () => {
        expect(await loadAuthStore(storePath)).toBeUndefined();
        await writeFile(storePath, 'not-json');
        expect(await rejectionOf(loadAuthStore(storePath))).toBeInstanceOf(CredentialResolutionError);
    });

    test('keeps only object entries and selects only the requested provider', async () => {
        await writeFile(
            storePath,
            JSON.stringify({
                anthropic: { type: 'api', key: 'anthropic-key' },
                openai: { type: 'oauth', access: 'access-token' },
                broken: 'not-an-object'
            })
        );
        const store = await loadAuthStore(storePath);

        if (store === undefined) {
            throw new Error('Expected the credential store to load.');
        }

        expect(store.entries.broken).toBeUndefined();
        const entry = requireAuthStoreEntry(store, 'openai');
        expect(entry).toEqual({ providerID: 'openai', entry: { type: 'oauth', access: 'access-token' } });

        const failure = captureFailure(() => {
            requireAuthStoreEntry(store, 'missing');
        });

        expect(failure.message).toContain('auth login');
        expect(failure.message).toContain(PROVIDER_API_KEY_ENV);
    });

    test('collects nested secret values for log redaction', () => {
        const secrets = authStoreSecretValues({
            type: 'oauth',
            access: 'access-value',
            refresh: 'refresh-value',
            account: { id: 'account-id' },
            expires: 123,
            flag: true
        });

        expect(secrets).toContain('access-value');
        expect(secrets).toContain('refresh-value');
        expect(secrets).toContain('account-id');
        expect(secrets).toContain('123');
        expect(secrets).toContain('true');
    });
});

describe('credential selection', () => {
    test('env mode requires the provider API key', async () => {
        const failure = await rejectionOf(
            resolveAuthSelection({ mode: 'env', environment: {}, authStorePath: storePath })
        );

        expect(failure.message).toContain(PROVIDER_API_KEY_ENV);

        const selection = await resolveAuthSelection({
            mode: 'env',
            environment: { [PROVIDER_API_KEY_ENV]: 'key-1', [PROVIDER_BASE_URL_ENV]: 'https://gateway.example/v1' },
            authStorePath: storePath
        });

        expect(selection).toEqual({ kind: 'env', apiKey: 'key-1', baseURL: 'https://gateway.example/v1' });
    });

    test('auto prefers the environment key over the store', async () => {
        await writeFile(storePath, JSON.stringify({ openai: { type: 'oauth', access: 'token' } }));

        const selection = await resolveAuthSelection({
            mode: 'auto',
            environment: { [PROVIDER_API_KEY_ENV]: 'key-1' },
            authStorePath: storePath
        });

        if (selection.kind !== 'env') {
            throw new Error(`Expected an env selection, received ${selection.kind}.`);
        }

        expect(selection.apiKey).toBe('key-1');
    });

    test('auto and opencode fall back to the store, or leave keyless admission to the host', async () => {
        await writeFile(storePath, JSON.stringify({ openai: { type: 'oauth', access: 'token' } }));
        const fromStore = await resolveAuthSelection({ mode: 'auto', environment: {}, authStorePath: storePath });

        if (fromStore.kind !== 'store') {
            throw new Error(`Expected a store selection, received ${fromStore.kind}.`);
        }

        expect(fromStore.store.entries.openai).toEqual({ type: 'oauth', access: 'token' });

        const missingStore = path.join(root, 'absent.json');
        expect(await resolveAuthSelection({ mode: 'opencode', environment: {}, authStorePath: missingStore })).toEqual({
            kind: 'none'
        });
        expect(await resolveAuthSelection({ mode: 'auto', environment: {}, authStorePath: missingStore })).toEqual({
            kind: 'none'
        });
    });

    test('auto falls back to the SAKRE credential store written by auth login', async () => {
        const credentialPath = path.join(root, 'engine', 'credentials.json');
        expect(await loadEngineCredentialStore(credentialPath)).toBeUndefined();

        await writeEngineCredential({ path: credentialPath, providerID: 'anthropic', apiKey: 'sk-ant-login' });

        const selection = await resolveAuthSelection({
            mode: 'auto',
            environment: {},
            authStorePath: path.join(root, 'absent.json'),
            engineCredentialPath: credentialPath
        });

        if (selection.kind !== 'engine') {
            throw new Error(`Expected an engine selection, received ${selection.kind}.`);
        }

        expect(requireEngineCredential(selection.store, 'anthropic')).toBe('sk-ant-login');

        const missingProvider = captureFailure(() => {
            requireEngineCredential(selection.store, 'openai');
        });

        expect(missingProvider.message).toContain('auth login openai');
        expect(missingProvider.message).toContain(PROVIDER_API_KEY_ENV);
    });

    test('a written SAKRE credential survives a second write for another provider', async () => {
        const credentialPath = path.join(root, 'engine', 'credentials.json');
        await writeEngineCredential({ path: credentialPath, providerID: 'anthropic', apiKey: 'key-a' });
        await writeEngineCredential({ path: credentialPath, providerID: 'openai', apiKey: 'key-b' });

        const store = await loadEngineCredentialStore(credentialPath);

        if (store === undefined) {
            throw new Error('Expected the SAKRE credential store to load.');
        }

        expect(requireEngineCredential(store, 'anthropic')).toBe('key-a');
        expect(requireEngineCredential(store, 'openai')).toBe('key-b');
    });

    test('derives the store path from the caller environment, not the process HOME', async () => {
        const dataHome = path.join(root, 'xdg-data');
        await mkdir(path.join(dataHome, 'opencode'), { recursive: true });
        await writeFile(
            path.join(dataHome, 'opencode', 'auth.json'),
            JSON.stringify({ openai: { type: 'oauth', access: 'xdg-token' } })
        );

        const fromXdg = await resolveAuthSelection({
            mode: 'opencode',
            environment: { HOME: path.join(root, 'absent-home'), XDG_DATA_HOME: dataHome }
        });

        if (fromXdg.kind !== 'store') {
            throw new Error(`Expected a store selection, received ${fromXdg.kind}.`);
        }

        expect(fromXdg.store.path).toBe(path.join(dataHome, 'opencode', 'auth.json'));

        const home = path.join(root, 'home');
        await mkdir(path.join(home, '.local', 'share', 'opencode'), { recursive: true });
        await writeFile(
            path.join(home, '.local', 'share', 'opencode', 'auth.json'),
            JSON.stringify({ anthropic: { type: 'api', key: 'home-key' } })
        );
        const fromHome = await resolveAuthSelection({ mode: 'opencode', environment: { HOME: home } });

        if (fromHome.kind !== 'store') {
            throw new Error(`Expected a store selection, received ${fromHome.kind}.`);
        }

        expect(fromHome.store.path).toBe(path.join(home, '.local', 'share', 'opencode', 'auth.json'));
    });
});

function captureFailure(run: () => void): Error {
    try {
        run();
    } catch (error) {
        if (error instanceof Error) {
            return error;
        }

        return new Error(String(error));
    }

    throw new Error('Expected the operation to fail.');
}
