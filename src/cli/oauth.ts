import { collectFormAnswer } from './oauth-form';
import { OAuthLoginError, requireInteractive } from './oauth-input';
import { isSafeAuthorizationUrl, openAuthorizationUrl } from './oauth-url';
import type {
    EngineFormAnswer,
    EngineHostClient,
    EngineIntegrationMethod,
    EngineOAuthAttempt,
    EngineOAuthAttemptStatus
} from '../engine/effect-client';

const OAUTH_POLL_INTERVAL_MS = 500;

export interface OAuthLoginInput {
    client: OAuthLoginClient;
    directory: string;
    providerID: string;
    methodID?: string;
    interactive: boolean;
    prompt: (message: string) => Promise<string>;
    stdout: NodeJS.WritableStream;
    signal?: AbortSignal;
    openUrl?: (url: string) => Promise<boolean>;
    sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
    now?: () => number;
}

export interface OAuthLoginClient {
    integration: Pick<EngineHostClient['integration'], 'list' | 'get' | 'oauth'>;
}

export async function runOAuthLogin(input: OAuthLoginInput): Promise<void> {
    const location = { directory: input.directory };
    await input.client.integration.list({ location });
    const { data: integration } = await input.client.integration.get({ integrationID: input.providerID, location });
    const method = await selectOAuthMethod(integration.methods, input);
    const answer = await collectFormAnswer(method.form ?? [], input);
    const attempt = await startAttempt(input, method, answer);
    await performAttempt(attempt, input);
}

async function performAttempt(attempt: EngineOAuthAttempt, input: OAuthLoginInput): Promise<void> {
    try {
        await presentAuthorization(attempt, input);

        if (attempt.mode === 'code') {
            await completeCodeAttempt(attempt, input);
        }

        await waitForCompletion(attempt, input);
    } catch (error) {
        await cancelAttempt(attempt, input);
        throw error;
    }
}

function selectOAuthMethod(
    methods: readonly EngineIntegrationMethod[],
    input: OAuthLoginInput
): Promise<EngineIntegrationMethod & { id: string }> {
    const oauth = methods.filter((method) => hasOAuthMethodID(method));

    if (oauth.length === 0) {
        throw new OAuthLoginError(`Provider "${input.providerID}" does not expose an OAuth login method.`);
    }

    if (input.methodID !== undefined) {
        return Promise.resolve(explicitMethod(oauth, input.methodID, input.providerID));
    }

    if (oauth.length === 1 && oauth[0] !== undefined) {
        return Promise.resolve(oauth[0]);
    }

    return chooseMethod(oauth, input);
}

function explicitMethod(
    methods: readonly (EngineIntegrationMethod & { id: string })[],
    methodID: string,
    providerID: string
): EngineIntegrationMethod & { id: string } {
    const selected = methods.find((method) => method.id === methodID);

    if (selected === undefined) {
        throw new OAuthLoginError(
            `Provider "${providerID}" does not expose OAuth method "${methodID}". Available methods: ${formatMethods(methods)}.`
        );
    }

    return selected;
}

async function chooseMethod(
    oauth: readonly (EngineIntegrationMethod & { id: string })[],
    input: OAuthLoginInput
): Promise<EngineIntegrationMethod & { id: string }> {
    requireInteractive(input, `Provider "${input.providerID}" offers multiple OAuth methods`);
    printMethods(oauth, input);
    const answer = await input.prompt('Choose an OAuth method: ');

    return chosenMethod(oauth, answer);
}

function printMethods(oauth: readonly (EngineIntegrationMethod & { id: string })[], input: OAuthLoginInput): void {
    input.stdout.write(`OAuth methods for ${input.providerID}:\n`);

    for (const [index, method] of oauth.entries()) {
        input.stdout.write(`  ${index + 1}. ${method.label ?? method.id} (${method.id})\n`);
    }
}

function chosenMethod(
    oauth: readonly (EngineIntegrationMethod & { id: string })[],
    answer: string
): EngineIntegrationMethod & { id: string } {
    const index = Number(answer) - 1;

    if (!Number.isInteger(index)) {
        throw new OAuthLoginError('The OAuth method selection is invalid.');
    }

    const selected = oauth[index];

    if (selected === undefined) {
        throw new OAuthLoginError('The OAuth method selection is invalid.');
    }

    return selected;
}

function hasOAuthMethodID(method: EngineIntegrationMethod): method is EngineIntegrationMethod & { id: string } {
    return method.type === 'oauth' && method.id !== undefined;
}

function formatMethods(methods: readonly (EngineIntegrationMethod & { id: string })[]): string {
    return methods.map((method) => method.id).join(', ');
}

async function startAttempt(
    input: OAuthLoginInput,
    method: EngineIntegrationMethod & { id: string },
    answer: EngineFormAnswer
): Promise<EngineOAuthAttempt> {
    try {
        const result = await input.client.integration.oauth.connect({
            integrationID: input.providerID,
            methodID: method.id,
            answer,
            location: { directory: input.directory }
        });

        return result.data;
    } catch {
        throw new OAuthLoginError(`OAuth method "${method.label ?? method.id}" could not start.`);
    }
}

async function presentAuthorization(attempt: EngineOAuthAttempt, input: OAuthLoginInput): Promise<void> {
    input.stdout.write(`${attempt.instructions}\n${attempt.url}\n`);
    let opened = false;

    if (isSafeAuthorizationUrl(attempt.url)) {
        opened = await (input.openUrl ?? openAuthorizationUrl)(attempt.url);
    }

    if (!opened) {
        input.stdout.write('Open the authorization URL in a browser to continue.\n');
    }
}

async function completeCodeAttempt(attempt: EngineOAuthAttempt, input: OAuthLoginInput): Promise<void> {
    requireInteractive(input, 'OAuth method requires an authorization code');
    const answer = await input.prompt('Authorization code: ');
    const code = answer.trim();

    if (code === '') {
        throw new OAuthLoginError('The OAuth authorization code is required.');
    }

    try {
        await input.client.integration.oauth.complete({
            integrationID: input.providerID,
            attemptID: attempt.attemptID,
            code,
            location: { directory: input.directory }
        });
    } catch {
        throw new OAuthLoginError(`OAuth authorization failed for provider "${input.providerID}".`);
    }
}

async function waitForCompletion(attempt: EngineOAuthAttempt, input: OAuthLoginInput): Promise<void> {
    const sleep = input.sleep ?? abortableSleep;
    const now = input.now ?? Date.now;

    // OpenCode decides the terminal state, not the loop condition.
    for (;;) {
        throwIfCancelled(input.signal);
        // eslint-disable-next-line no-await-in-loop -- OAuth polling must observe one state before scheduling the next.
        const status = await readStatus(attempt, input);

        if (terminalStatus(status, input.providerID, now())) {
            return;
        }

        // eslint-disable-next-line no-await-in-loop -- Wait between sequential status reads.
        await sleep(OAUTH_POLL_INTERVAL_MS, input.signal);
    }
}

function terminalStatus(status: EngineOAuthAttemptStatus, providerID: string, now: number): boolean {
    if (status.status === 'complete') {
        return true;
    }

    if (status.status === 'failed') {
        throw new OAuthLoginError(`OAuth authorization failed for provider "${providerID}".`);
    }

    if (status.status === 'expired' || now >= status.time.expires) {
        throw new OAuthLoginError(`OAuth authorization expired for provider "${providerID}".`);
    }

    return false;
}

async function readStatus(attempt: EngineOAuthAttempt, input: OAuthLoginInput): Promise<EngineOAuthAttemptStatus> {
    try {
        const result = await input.client.integration.oauth.status({
            integrationID: input.providerID,
            attemptID: attempt.attemptID,
            location: { directory: input.directory }
        });

        return result.data;
    } catch {
        throw new OAuthLoginError(`Cannot read OAuth status for provider "${input.providerID}".`);
    }
}

async function cancelAttempt(attempt: EngineOAuthAttempt, input: OAuthLoginInput): Promise<void> {
    try {
        await input.client.integration.oauth.cancel({
            integrationID: input.providerID,
            attemptID: attempt.attemptID,
            location: { directory: input.directory }
        });
    } catch {
        // The attempt may already be complete or expired.
    }
}

function throwIfCancelled(signal?: AbortSignal): void {
    if (signal?.aborted === true) {
        throw new OAuthLoginError('OAuth login was cancelled.');
    }
}

function abortableSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted === true) {
            reject(new OAuthLoginError('OAuth login was cancelled.'));

            return;
        }

        let timer: ReturnType<typeof setTimeout> | null = null;

        function onAbort(): void {
            if (timer !== null) {
                clearTimeout(timer);
            }

            reject(new OAuthLoginError('OAuth login was cancelled.'));
        }

        timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, milliseconds);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}
