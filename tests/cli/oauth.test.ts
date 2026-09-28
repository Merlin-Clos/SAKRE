/* eslint-disable max-lines -- The OAuth state-machine harness stays beside its transition tests. */
import { describe, expect, test } from 'bun:test';
import { Writable } from 'node:stream';
import { type OAuthLoginClient, runOAuthLogin } from '../../src/cli/oauth';
import { isSafeAuthorizationUrl, openAuthorizationUrl } from '../../src/cli/oauth-url';
import type {
    EngineIntegrationMethod,
    EngineOAuthAttempt,
    EngineOAuthAttemptStatus
} from '../../src/engine/effect-client';
import { rejectionOf } from '../helpers/rejection';

const ATTEMPT: EngineOAuthAttempt = {
    attemptID: 'attempt-1',
    url: 'https://auth.example/device',
    instructions: 'Enter the displayed device code.',
    mode: 'auto',
    time: { created: 1, expires: 10_000 }
};

describe('OAuth login orchestration', () => {
    test('discovers a method, answers its form and waits for automatic completion', async () => {
        const harness = oauthHarness({
            methods: [
                { id: 'browser', type: 'oauth', label: 'Browser' },
                {
                    id: 'device',
                    type: 'oauth',
                    label: 'Device',
                    form: [
                        {
                            type: 'string',
                            key: 'deployment',
                            title: 'Deployment',
                            required: true,
                            options: [
                                { value: 'public', label: 'Public' },
                                { value: 'enterprise', label: 'Enterprise' }
                            ]
                        },
                        {
                            type: 'string',
                            key: 'domain',
                            title: 'Domain',
                            required: true,
                            when: [{ key: 'deployment', op: 'eq', value: 'enterprise' }]
                        }
                    ]
                }
            ],
            statuses: [pending(), complete()]
        });

        const answers = answerQueue(['2', '2', 'company.example']);

        await runOAuthLogin({
            client: harness.client,
            directory: '/workspace',
            providerID: 'github-copilot',
            interactive: true,
            prompt: answers,
            stdout: harness.stdout.stream,
            openUrl: harness.openUrl,
            sleep: () => Promise.resolve(),
            now: () => 2
        });

        expect(harness.connectInput?.methodID).toBe('device');
        expect(harness.connectInput?.answer).toEqual({ deployment: 'enterprise', domain: 'company.example' });
        expect(harness.openedUrls).toEqual([ATTEMPT.url]);
        expect(harness.stdout.read()).toContain(ATTEMPT.instructions);
        expect(harness.cancelled).toBe(0);
    });

    test('completes a code method with the entered authorization code', async () => {
        const harness = oauthHarness({
            methods: [{ id: 'code', type: 'oauth', label: 'Code' }],
            attempt: { ...ATTEMPT, mode: 'code' },
            statuses: [complete()]
        });

        await runOAuthLogin({
            client: harness.client,
            directory: '/workspace',
            providerID: 'provider',
            methodID: 'code',
            interactive: true,
            prompt: answerQueue(['authorization-code']),
            stdout: harness.stdout.stream,
            openUrl: harness.openUrl,
            sleep: () => Promise.resolve(),
            now: () => 2
        });

        expect(harness.completedCode).toBe('authorization-code');
    });

    test('code methods fail without an interactive terminal before prompting or completing', async () => {
        const harness = oauthHarness({
            methods: [{ id: 'code', type: 'oauth' }],
            attempt: { ...ATTEMPT, mode: 'code' },
            statuses: [complete()]
        });

        const failure = await rejectionOf(
            runOAuthLogin({
                client: harness.client,
                directory: '/workspace',
                providerID: 'provider',
                interactive: false,
                prompt: () => {
                    throw new Error('Must not prompt.');
                },
                stdout: harness.stdout.stream,
                openUrl: harness.openUrl
            })
        );

        expect(failure.message).toContain('interactive terminal');
        expect(harness.completedCode).toBeUndefined();
        expect(harness.cancelled).toBe(1);
    });

    test('cancels a failed attempt without exposing the provider payload', async () => {
        const harness = oauthHarness({
            methods: [{ id: 'device', type: 'oauth', label: 'Device' }],
            statuses: [{ ...failed(), message: 'token=must-not-escape' }]
        });

        const failure = await rejectionOf(
            runOAuthLogin({
                client: harness.client,
                directory: '/workspace',
                providerID: 'provider',
                interactive: false,
                prompt: answerQueue([]),
                stdout: harness.stdout.stream,
                openUrl: harness.openUrl,
                sleep: () => Promise.resolve(),
                now: () => 2
            })
        );

        expect(failure.message).toContain('OAuth authorization failed');
        expect(failure.message).not.toContain('must-not-escape');
        expect(harness.cancelled).toBe(1);
    });

    test('requires an explicit method outside an interactive terminal', async () => {
        const harness = oauthHarness({
            methods: [
                { id: 'browser', type: 'oauth', label: 'Browser' },
                { id: 'device', type: 'oauth', label: 'Device' }
            ],
            statuses: [complete()]
        });

        const failure = await rejectionOf(
            runOAuthLogin({
                client: harness.client,
                directory: '/workspace',
                providerID: 'provider',
                interactive: false,
                prompt: answerQueue([]),
                stdout: harness.stdout.stream
            })
        );

        expect(failure.message).toContain('--method');
    });

    test('expires and cancels a pending attempt', async () => {
        const harness = oauthHarness({
            methods: [{ id: 'device', type: 'oauth', label: 'Device' }],
            statuses: [pending()]
        });

        const failure = await rejectionOf(
            runOAuthLogin({
                client: harness.client,
                directory: '/workspace',
                providerID: 'provider',
                interactive: false,
                prompt: answerQueue([]),
                stdout: harness.stdout.stream,
                openUrl: harness.openUrl,
                sleep: () => Promise.resolve(),
                now: () => ATTEMPT.time.expires
            })
        );

        expect(failure.message).toContain('expired');
        expect(harness.cancelled).toBe(1);
    });

    test('explicit expired state cancels immediately without polling again', async () => {
        const harness = oauthHarness({
            methods: [{ id: 'device', type: 'oauth' }],
            statuses: [{ status: 'expired', time: ATTEMPT.time }]
        });

        const failure = await rejectionOf(
            runOAuthLogin({
                client: harness.client,
                directory: '/workspace',
                providerID: 'provider',
                interactive: false,
                prompt: answerQueue([]),
                stdout: harness.stdout.stream,
                openUrl: harness.openUrl,
                sleep: () => {
                    throw new Error('Expired state must not sleep.');
                },
                now: () => 2
            })
        );

        expect(failure.message).toContain('expired');
        expect(harness.cancelled).toBe(1);
    });

    test('connect, complete, and status errors are sanitized; started attempts are cancelled', async () => {
        for (const failedAt of ['connect', 'complete', 'status'] as const) {
            let mode: EngineOAuthAttempt['mode'] = 'auto';

            if (failedAt === 'complete') {
                mode = 'code';
            }

            const harness = oauthHarness({
                methods: [{ id: 'device', type: 'oauth' }],
                attempt: { ...ATTEMPT, mode },
                statuses: [complete()],
                failedAt
            });

            const failure = await rejectionOf(
                runOAuthLogin({
                    client: harness.client,
                    directory: '/workspace',
                    providerID: 'provider',
                    interactive: true,
                    prompt: answerQueue(['code']),
                    stdout: harness.stdout.stream,
                    openUrl: harness.openUrl,
                    now: () => 2
                })
            );

            expect(failure.message).not.toContain('must-not-escape');
            expect(failure.message).toMatch(/could not start|authorization failed|Cannot read OAuth status/u);

            if (failedAt === 'connect') {
                expect(harness.cancelled).toBe(0);
            } else {
                expect(harness.cancelled).toBe(1);
            }
        }
    });

    test('prints manual-open guidance when the browser cannot open or the URL is unsafe', async () => {
        const harness = oauthHarness({ methods: [{ id: 'browser', type: 'oauth' }], statuses: [complete()] });
        await runOAuthLogin({
            client: harness.client,
            directory: '/workspace',
            providerID: 'provider',
            interactive: false,
            prompt: answerQueue([]),
            stdout: harness.stdout.stream,
            openUrl: () => Promise.resolve(false),
            now: () => 2
        });
        expect(harness.stdout.read()).toContain('Open the authorization URL in a browser');

        const unsafe = oauthHarness({
            methods: [{ id: 'browser', type: 'oauth' }],
            attempt: { ...ATTEMPT, url: 'file:///etc/passwd' },
            statuses: [complete()]
        });

        await runOAuthLogin({
            client: unsafe.client,
            directory: '/workspace',
            providerID: 'provider',
            interactive: false,
            prompt: answerQueue([]),
            stdout: unsafe.stdout.stream,
            openUrl: unsafe.openUrl,
            now: () => 2
        });
        expect(unsafe.openedUrls).toEqual([]);
        expect(unsafe.stdout.read()).toContain('Open the authorization URL in a browser');
    });

    test('browser dispatch accepts web URLs only, with HTTP limited to loopback', async () => {
        for (const url of [
            '--help',
            'file:///etc/passwd',
            ['java', 'script:alert(1)'].join(''),
            'https://user:pass@example.test/',
            'http://user:pass@127.0.0.1:3000/auth',
            'http://example.test/'
        ]) {
            expect(isSafeAuthorizationUrl(url)).toBe(false);
            expect(await openAuthorizationUrl(url)).toBe(false);
        }

        expect(isSafeAuthorizationUrl('https://example.test/')).toBe(true);
        expect(isSafeAuthorizationUrl('http://127.0.0.1:3000/auth')).toBe(true);
    });

    test('cancels a pending attempt when the caller aborts', async () => {
        const abort = new AbortController();

        const harness = oauthHarness({
            methods: [{ id: 'device', type: 'oauth', label: 'Device' }],
            statuses: [pending()]
        });

        const failure = await rejectionOf(
            runOAuthLogin({
                client: harness.client,
                directory: '/workspace',
                providerID: 'provider',
                interactive: false,
                prompt: answerQueue([]),
                stdout: harness.stdout.stream,
                signal: abort.signal,
                openUrl: harness.openUrl,
                sleep: () => {
                    abort.abort();

                    return Promise.resolve();
                },
                now: () => 2
            })
        );

        expect(failure.message).toContain('cancelled');
        expect(harness.cancelled).toBe(1);
    });
});

interface HarnessOptions {
    methods: readonly EngineIntegrationMethod[];
    statuses: EngineOAuthAttemptStatus[];
    attempt?: EngineOAuthAttempt;
    failedAt?: 'connect' | 'complete' | 'status';
}

interface OAuthHarness {
    client: OAuthLoginClient;
    stdout: ReturnType<typeof captureStream>;
    openedUrls: string[];
    readonly connectInput: { methodID: string; answer?: Readonly<Record<string, unknown>> } | undefined;
    readonly completedCode: string | undefined;
    readonly cancelled: number;
    openUrl: (url: string) => Promise<boolean>;
}

function oauthHarness(options: HarnessOptions): OAuthHarness {
    const stdout = captureStream();
    const openedUrls: string[] = [];
    let connectInput: { methodID: string; answer?: Readonly<Record<string, unknown>> } | undefined = undefined;
    let completedCode: string | undefined = undefined;
    let cancelled = 0;
    let statusIndex = 0;

    const client: OAuthLoginClient = {
        integration: {
            list: () => Promise.resolve({ data: [] }),
            get: () =>
                Promise.resolve({
                    data: { id: 'provider', name: 'Provider', methods: options.methods, connections: [] }
                }),
            oauth: {
                connect: (input: { methodID: string; answer?: Readonly<Record<string, unknown>> }) => {
                    if (options.failedAt === 'connect') {
                        return Promise.reject(new Error('token=must-not-escape'));
                    }

                    connectInput = input;

                    return Promise.resolve({ data: options.attempt ?? ATTEMPT });
                },
                status: () => {
                    if (options.failedAt === 'status') {
                        return Promise.reject(new Error('token=must-not-escape'));
                    }

                    const status = options.statuses[Math.min(statusIndex, options.statuses.length - 1)];
                    statusIndex += 1;

                    if (status === undefined) {
                        throw new Error('The OAuth status fixture is empty.');
                    }

                    return Promise.resolve({ data: status });
                },
                complete: (input: { code?: string }) => {
                    if (options.failedAt === 'complete') {
                        return Promise.reject(new Error('token=must-not-escape'));
                    }

                    completedCode = input.code;

                    return Promise.resolve();
                },
                cancel: () => {
                    cancelled += 1;

                    return Promise.resolve();
                }
            }
        }
    };

    return {
        client,
        stdout,
        openedUrls,
        get connectInput(): OAuthHarness['connectInput'] {
            return connectInput;
        },
        get completedCode(): OAuthHarness['completedCode'] {
            return completedCode;
        },
        get cancelled(): number {
            return cancelled;
        },
        openUrl: (url: string): Promise<boolean> => {
            openedUrls.push(url);

            return Promise.resolve(true);
        }
    };
}

function answerQueue(answers: string[]): (message: string) => Promise<string> {
    return () => Promise.resolve(answers.shift() ?? '');
}

function pending(): EngineOAuthAttemptStatus {
    return { status: 'pending', time: ATTEMPT.time };
}

function complete(): EngineOAuthAttemptStatus {
    return { status: 'complete', time: ATTEMPT.time };
}

function failed(): EngineOAuthAttemptStatus & { status: 'failed' } {
    return { status: 'failed', message: 'failed', time: ATTEMPT.time };
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
