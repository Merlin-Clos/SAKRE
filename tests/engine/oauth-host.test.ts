import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { Credential } from '@opencode/core/credential';
import { Integration } from '@opencode/schema/integration';
import { Effect, Schema } from 'effect';
import { createEngineHost, type EngineHost } from '../../src/engine/host';
import {
    persistentCredentialLayer,
    prepareOAuthCredentialStore,
    resolveOAuthCredentialSelection
} from '../../src/engine/oauth-credentials';
import { materializeEnginePlugin } from '../../src/engine/plugin-source';

let root: string | null = null;

const hosts: EngineHost[] = [];

afterEach(async () => {
    for (const host of hosts.splice(0)) {
        await host.client.close();
    }

    if (root !== null) {
        await rm(root, { recursive: true, force: true });
        root = null;
    }
});

test('production hosts keep same-provider activation and resolver refresh local to each selected account', async () => {
    const workingRoot = await mkdtemp(path.join(tmpdir(), 'sakre-oauth-host-refresh-'));
    root = workingRoot;
    const workspace = path.join(workingRoot, 'workspace');
    await mkdir(workspace);
    const credentialPath = path.join(workingRoot, 'data', 'credentials.db');
    await prepareOAuthCredentialStore(credentialPath);
    const first = await seedCredential(credentialPath, 'first', 0);
    const second = await seedCredential(credentialPath, 'second');
    const pluginDir = path.join(workingRoot, 'offline-plugin');
    await mkdir(pluginDir);
    const resultPath = path.join(workingRoot, 'resolved.txt');
    await writeFile(
        path.join(pluginDir, 'index.js'),
        `
import { Credential } from ${JSON.stringify(import.meta.resolve('@opencode/core/credential'))};
import { writeFile } from 'node:fs/promises';
export default {
    id: 'offline-production-host-refresh',
    async setup(context) {
        await context.integration.transform((editor) => {
            editor.method.update({
                integrationID: 'openai',
                method: { type: 'oauth', id: 'offline-test', label: 'Offline test' },
                authorize: () => Promise.reject(new Error('No authorization request expected.')),
                refresh: (credential) => Promise.resolve(Credential.OAuth.make({
                    type: 'oauth', methodID: credential.methodID,
                    access: 'fake-first-refreshed', refresh: 'fake-first-refresh',
                    expires: Date.now() + 3600000
                }))
            });
        });
        const result = await context.integration.connection.resolve({
            type: 'credential', id: ${JSON.stringify(first)}, label: 'first', method: 'oauth'
        });
        await writeFile(${JSON.stringify(resultPath)}, result?.type === 'oauth' ? result.access : 'missing');
    }
};
`
    );
    const normalPluginDir = await materializeEnginePlugin(path.join(workingRoot, 'plugin-cache'));

    function create(name: string, credentialID: string, plugin = normalPluginDir): Promise<EngineHost> {
        return createEngineHost({
            providerID: 'openai',
            providerFamily: 'native',
            modelIds: [],
            checkoutDir: workspace,
            pluginDir: plugin,
            databasePath: path.join(workingRoot, `${name}.db`),
            oauthCredential: { path: credentialPath, credentialID }
        });
    }

    const [hostA, hostB] = await Promise.all([create('a', first, pluginDir), create('b', second)]);
    hosts.push(hostA, hostB);
    await hostA.client.credential.activate({ credentialID: first });
    await hostB.client.credential.activate({ credentialID: second });
    await hostA.client.credential.activate({ credentialID: second });
    const before = await hostB.client.integration.get({ integrationID: 'openai', location: { directory: workspace } });
    expect(
        before.data.connections
            .filter((connection) => connection.type === 'credential')
            .map((connection) => connection.id)
    ).toEqual([second]);
    await hostA.client.credential.activate({ credentialID: first });

    const hostASelection = await hostA.client.integration.get({
        integrationID: 'openai',
        location: { directory: workspace }
    });

    expect(
        hostASelection.data.connections
            .filter((connection) => connection.type === 'credential')
            .map((connection) => connection.id)
    ).toEqual([first]);
    expect(await readFile(resultPath, 'utf8')).toBe('fake-first-refreshed');

    const firstSelection = await resolveOAuthCredentialSelection({
        path: credentialPath,
        integrationID: 'openai',
        credentialID: first
    });

    const secondSelection = await resolveOAuthCredentialSelection({
        path: credentialPath,
        integrationID: 'openai',
        credentialID: second
    });

    expect(firstSelection.kind === 'selected' && firstSelection.secrets.includes('fake-first-refreshed')).toBe(true);
    expect(secondSelection.kind === 'selected' && secondSelection.secrets.includes('fake-second-access')).toBe(true);
    expect(secondSelection.kind === 'selected' && secondSelection.secrets.includes('fake-first-refreshed')).toBe(false);
    const after = await hostB.client.integration.get({ integrationID: 'openai', location: { directory: workspace } });
    expect(
        after.data.connections
            .filter((connection) => connection.type === 'credential')
            .map((connection) => connection.id)
    ).toEqual([second]);
    const hostC = await create('c', first, pluginDir);
    hosts.push(hostC);
    expect(await readFile(resultPath, 'utf8')).toBe('fake-first-refreshed');
});

test('production hosts select separate OAuth accounts without writing sessions to the credential store', async () => {
    const workingRoot = await mkdtemp(path.join(tmpdir(), 'sakre-oauth-host-'));
    root = workingRoot;
    const workspace = path.join(workingRoot, 'workspace');
    await mkdir(workspace);
    const credentialPath = path.join(workingRoot, 'data', 'engine', 'credentials.db');
    await prepareOAuthCredentialStore(credentialPath);
    const first = await seedCredential(credentialPath, 'first');
    const second = await seedCredential(credentialPath, 'second');
    const pluginDir = await materializeEnginePlugin(path.join(workingRoot, 'plugin-cache'));

    function create(name: string, credentialID: string): Promise<EngineHost> {
        return createEngineHost({
            providerID: 'openai',
            providerFamily: 'native',
            modelIds: [],
            checkoutDir: workspace,
            pluginDir,
            databasePath: path.join(workingRoot, `${name}.db`),
            oauthCredential: { path: credentialPath, credentialID }
        });
    }

    const [hostA, hostB] = await Promise.all([create('review-a', first), create('review-b', second)]);
    hosts.push(hostA, hostB);

    for (const [host, expected] of [
        [hostA, first],
        [hostB, second]
    ] as const) {
        const result = await host.client.integration.get({
            integrationID: 'openai',
            location: { directory: workspace }
        });

        const connections = result.data.connections.filter((connection) => connection.type === 'credential');
        expect(connections.map((connection) => connection.id)).toEqual([expected]);
        await host.client.sessions.create({
            location: { directory: workspace },
            title: expected,
            model: { providerID: 'openai', id: 'gpt-5' }
        });
    }

    for (const [name, own, other] of [
        ['review-a', first, second],
        ['review-b', second, first]
    ] as const) {
        const db = new Database(path.join(workingRoot, `${name}.db`));

        try {
            const titles = db
                .query<{ title: string }, []>('SELECT title FROM session_v2')
                .all()
                .map((row) => row.title);

            expect(titles).toEqual([own]);
            expect(titles).not.toContain(other);
        } finally {
            db.close();
        }
    }

    const db = new Database(credentialPath);

    try {
        const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all();
        expect(tables.map((table) => table.name)).not.toContain('session_v2');
    } finally {
        db.close();
    }
});

async function seedCredential(databasePath: string, label: string, expires = Date.now() + 3_600_000): Promise<string> {
    const layer = persistentCredentialLayer({ path: databasePath, integrationID: 'openai' });

    const credential = await Effect.runPromise(
        Effect.gen(function* storeCredential() {
            const service = yield* Credential.Service;

            return yield* service.create({
                integrationID: Schema.decodeUnknownSync(Integration.ID)('openai'),
                label,
                value: Credential.OAuth.make({
                    type: 'oauth',
                    methodID: Schema.decodeUnknownSync(Integration.MethodID)('offline-test'),
                    access: `fake-${label}-access`,
                    refresh: `fake-${label}-refresh`,
                    expires
                })
            });
        }).pipe(Effect.provide(layer))
    );

    return credential.id;
}
