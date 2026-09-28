/* eslint-disable max-lines -- Auth CLI fixtures and lifecycle tests share one isolated store. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { Credential } from '@opencode/core/credential';
import { Integration } from '@opencode/schema/integration';
import { Effect, Schema } from 'effect';
import { type OAuthAuthClient, runAuthCli } from '../../src/cli/auth';
import { loadEngineCredentialStore, requireEngineCredential } from '../../src/cli/credentials';
import { persistentCredentialLayer, prepareOAuthCredentialStore } from '../../src/engine/oauth-credentials';
import { materializeEnginePlugin } from '../../src/engine/plugin-source';
import { PROVIDER_API_KEY_ENV } from '../../src/identity';
import type { NativeRuntime } from '../../src/native/runtime';

let root = '';

beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'sakre-auth-'));
});

afterAll(async () => {
    await rm(root, { recursive: true, force: true });
});

describe('auth command', () => {
    test('stores an API key in the SAKRE credential store', async () => {
        const stdout = captureStream();
        const stderr = captureStream();

        const exitCode = await runAuthCli(['login', 'anthropic', '--key', 'sk-ant-native'], {
            native: fakeNativeResolver(),
            env: {},
            stdout: stdout.stream,
            stderr: stderr.stream
        });

        expect(exitCode).toBe(0);
        expect(stdout.read()).toContain('anthropic');
        expect(stderr.read()).toBe('');
        const store = await loadEngineCredentialStore(path.join(root, 'engine', 'credentials.json'));

        if (store === undefined) {
            throw new Error('Expected the credential store to be written.');
        }

        expect(requireEngineCredential(store, 'anthropic')).toBe('sk-ant-native');
    });

    test('falls back to the provider API key environment variable', async () => {
        const exitCode = await runAuthCli(['login', 'anthropic'], {
            native: fakeNativeResolver(),
            env: { [PROVIDER_API_KEY_ENV]: 'sk-ant-from-env' },
            stderr: captureStream().stream
        });

        expect(exitCode).toBe(0);
        const store = await loadEngineCredentialStore(path.join(root, 'engine', 'credentials.json'));

        if (store === undefined) {
            throw new Error('Expected the credential store to be written.');
        }

        expect(requireEngineCredential(store, 'anthropic')).toBe('sk-ant-from-env');
    });

    test('runs an embedded OAuth method and reports the persisted selection', async () => {
        const stdout = captureStream();
        const stderr = captureStream();
        let stored = false;

        const exitCode = await runAuthCli(['login', 'openai', '--method', 'test-oauth'], {
            native: fakeNativeResolver(),
            env: {},
            isTty: false,
            stdout: stdout.stream,
            stderr: stderr.stream,
            openUrl: () => Promise.resolve(false),
            sleep: () => Promise.resolve(),
            createOAuthClient: ({ native }) => {
                const client: OAuthAuthClient = {
                    integration: {
                        list: () => Promise.resolve({ data: [] }),
                        get: () =>
                            Promise.resolve({
                                data: {
                                    id: 'openai',
                                    name: 'OpenAI',
                                    methods: [{ id: 'test-oauth', type: 'oauth', label: 'Test OAuth' }],
                                    connections: []
                                }
                            }),
                        oauth: {
                            connect: () =>
                                Promise.resolve({
                                    data: {
                                        attemptID: 'attempt-1',
                                        url: 'https://auth.example/',
                                        instructions: 'Authorize the test account.',
                                        mode: 'auto',
                                        time: { created: 1, expires: Date.now() + 1000 }
                                    }
                                }),
                            status: async () => {
                                if (!stored) {
                                    stored = true;
                                    await seedOAuthCredential(native.engineOAuthCredentialPath, 'openai');
                                }

                                return {
                                    data: { status: 'complete', time: { created: 1, expires: Date.now() + 1000 } }
                                };
                            },
                            complete: () => Promise.resolve(),
                            cancel: () => Promise.resolve()
                        }
                    },
                    close: () => Promise.resolve()
                };

                return Promise.resolve(client);
            }
        });

        expect(exitCode).toBe(0);
        expect(stderr.read()).toBe('');
        expect(stdout.read()).toContain('Stored and selected OAuth credential');
        expect(stdout.read()).not.toContain('oauth-access');
    });

    test('does not report a pre-existing credential as a newly completed OAuth login', async () => {
        const native = fakeNative();
        const existingID = await seedOAuthCredential(native.engineOAuthCredentialPath, 'openai');
        const stdout = captureStream();
        const stderr = captureStream();

        const exitCode = await runAuthCli(['login', 'openai', '--method', 'test-oauth'], {
            native: () => Promise.resolve(native),
            env: {},
            isTty: false,
            stdout: stdout.stream,
            stderr: stderr.stream,
            openUrl: () => Promise.resolve(false),
            createOAuthClient: () =>
                Promise.resolve({
                    integration: {
                        list: () => Promise.resolve({ data: [] }),
                        get: () =>
                            Promise.resolve({
                                data: {
                                    id: 'openai',
                                    name: 'OpenAI',
                                    methods: [{ id: 'test-oauth', type: 'oauth' }],
                                    connections: []
                                }
                            }),
                        oauth: {
                            connect: () =>
                                Promise.resolve({
                                    data: {
                                        attemptID: 'fake',
                                        url: 'https://auth.example/',
                                        instructions: 'Authorize',
                                        mode: 'auto',
                                        time: { created: 1, expires: Date.now() + 1000 }
                                    }
                                }),
                            status: () =>
                                Promise.resolve({
                                    data: {
                                        status: 'complete',
                                        time: { created: 1, expires: Date.now() + 1000 }
                                    }
                                }),
                            complete: () => Promise.resolve(),
                            cancel: () => Promise.resolve()
                        }
                    },
                    close: () => Promise.resolve()
                })
        });

        expect(exitCode).toBe(1);
        expect(stderr.read()).toContain('without a stored credential');
        expect(stdout.read()).not.toContain(`Stored and selected OAuth credential ${existingID}`);
    });

    test('rejects conflicting explicit API key and OAuth method without changing the key store', async () => {
        const stderr = captureStream();

        const result = await runAuthCli(['login', 'openai', '--key', 'new-secret', '--method', 'test-oauth'], {
            native: throwingNative,
            env: {},
            stderr: stderr.stream
        });

        expect(result).toBe(1);
        expect(stderr.read()).toContain('either --key or --method');
        expect(stderr.read()).not.toContain('new-secret');
    });

    test('lists only OAuth metadata, filters providers, and removes exactly the requested credential', async () => {
        const native = { ...fakeNative(), engineOAuthCredentialPath: path.join(root, 'lifecycle', 'credentials.db') };
        const first = await seedOAuthCredential(native.engineOAuthCredentialPath, 'openai');
        const second = await seedOAuthCredential(native.engineOAuthCredentialPath, 'github-copilot');
        const environment = { native: (): Promise<NativeRuntime> => Promise.resolve(native), env: {} };
        const stdout = captureStream();
        expect(await runAuthCli(['list', 'openai'], { ...environment, stdout: stdout.stream })).toBe(0);
        expect(stdout.read()).toContain(first);
        expect(stdout.read()).not.toContain(second);
        expect(stdout.read()).not.toContain('oauth-access');
        expect(stdout.read()).not.toContain('oauth-refresh');
        const removed = captureStream();
        expect(await runAuthCli(['remove', first], { ...environment, stdout: removed.stream })).toBe(0);
        expect(removed.read()).toContain(first);
        const missing = captureStream();
        expect(await runAuthCli(['remove', first], { ...environment, stderr: missing.stream })).toBe(1);
        expect(missing.read()).toContain('was not found');
        const remaining = captureStream();
        expect(await runAuthCli(['list'], { ...environment, stdout: remaining.stream })).toBe(0);
        expect(remaining.read()).not.toContain(first);
        expect(remaining.read()).toContain(second);
        expect(await runAuthCli(['remove', second], environment)).toBe(0);
        const empty = captureStream();
        expect(await runAuthCli(['list'], { ...environment, stdout: empty.stream })).toBe(0);
        expect(empty.read()).toContain('No persistent OAuth credentials found');
    });

    test('reports when the selected provider exposes no OAuth method', async () => {
        const stderr = captureStream();

        const exitCode = await runAuthCli(['login', 'anthropic'], {
            native: fakeNativeResolver(),
            env: {},
            stderr: stderr.stream
        });

        expect(exitCode).toBe(1);
        expect(stderr.read()).toContain('does not expose an OAuth login method');
    });

    test('answers the command and login help without touching the credential store', async () => {
        for (const args of [['--help'], ['login', '--help']]) {
            const stdout = captureStream();
            const stderr = captureStream();

            const exitCode = await runAuthCli(args, {
                native: fakeNativeResolver(),
                env: {},
                stdout: stdout.stream,
                stderr: stderr.stream
            });

            expect(exitCode).toBe(0);
            expect(stdout.read()).toContain('Usage: sakre auth');
            expect(stderr.read()).toBe('');
        }

        const login = captureStream();
        expect(
            await runAuthCli(['login', '--help'], {
                native: fakeNativeResolver(),
                env: {},
                stdout: login.stream,
                stderr: captureStream().stream
            })
        ).toBe(0);
        expect(login.read()).toContain('--key');
    });

    test('rejects an unknown auth subcommand and a leading separator', async () => {
        for (const args of [['logout'], ['--', 'login']]) {
            const stderr = captureStream();

            const exitCode = await runAuthCli(args, {
                native: fakeNativeResolver(),
                env: {},
                stderr: stderr.stream
            });

            expect(exitCode).toBe(1);
            expect(stderr.read()).toContain('Usage: sakre auth');
        }
    });

    test('rejects a login without a provider', async () => {
        const stderr = captureStream();

        const exitCode = await runAuthCli(['login'], {
            native: fakeNativeResolver(),
            env: {},
            stderr: stderr.stream
        });

        expect(exitCode).toBe(1);
        expect(stderr.read()).toContain('auth login');
    });

    test('answers help without resolving native state', async () => {
        for (const args of [['--help'], ['login', '--help']]) {
            const stdout = captureStream();
            const stderr = captureStream();

            const exitCode = await runAuthCli(args, {
                native: throwingNative,
                env: {},
                stdout: stdout.stream,
                stderr: stderr.stream
            });

            expect(exitCode).toBe(0);
            expect(stdout.read()).toContain('Usage: sakre auth');
            expect(stderr.read()).toBe('');
        }
    });
});

function throwingNative(): Promise<NativeRuntime> {
    throw new Error('native resolution must not run for a read-only command');
}

function fakeNativeResolver(): () => Promise<NativeRuntime> {
    return () => Promise.resolve(fakeNative());
}

function fakeNative(): NativeRuntime {
    return {
        target: 'linux-x64',
        cacheRoot: root,
        materializeRipgrep: () => Promise.resolve(path.join(root, 'rg')),
        materializeScc: () => Promise.resolve(path.join(root, 'scc')),
        materializeCccc: () => Promise.resolve(path.join(root, 'cccc')),
        materializeEnginePlugin: () => materializeEnginePlugin(path.join(root, 'plugin-cache')),
        engineCredentialPath: path.join(root, 'engine', 'credentials.json'),
        engineOAuthCredentialPath: path.join(root, 'data', 'engine', 'credentials.db'),
        engineDatabasePath: path.join(root, 'engine', 'runs', 'fixture', 'engine.db'),
        engineDatabaseDirectory: path.join(root, 'engine', 'runs', 'fixture')
    };
}

function captureStream(): { stream: NodeJS.WritableStream; read: () => string } {
    let text = '';

    const stream = new Writable({
        write(chunk: Buffer, _encoding, callback): void {
            text += chunk.toString('utf8');
            callback();
        }
    });

    // eslint-disable-next-line anti-slop/no-known-value-widening -- stream-capture helper; annotation documents the readable pair
    return { stream, read: () => text };
}

async function seedOAuthCredential(databasePath: string, integrationID: string): Promise<string> {
    await prepareOAuthCredentialStore(databasePath);
    const layer = persistentCredentialLayer({ path: databasePath, integrationID, persistCreatedSelection: true });

    const credential = await Effect.runPromise(
        Effect.gen(function* createTestCredential() {
            const service = yield* Credential.Service;

            return yield* service.create({
                integrationID: Schema.decodeUnknownSync(Integration.ID)(integrationID),
                value: Credential.OAuth.make({
                    type: 'oauth',
                    methodID: Schema.decodeUnknownSync(Integration.MethodID)('test-oauth'),
                    access: 'oauth-access',
                    refresh: 'oauth-refresh',
                    expires: 0
                })
            });
        }).pipe(Effect.provide(layer))
    );

    return credential.id;
}
