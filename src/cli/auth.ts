import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { createInterface, type Interface as ReadLineInterface } from 'node:readline/promises';
import { createEffectEngineClient, type EngineHostClient } from '../engine/effect-client';
import {
    listOAuthCredentials,
    removeOAuthCredential,
    resolveOAuthCredentialSelection
} from '../engine/oauth-credentials';
import { PRODUCT_NAME, PROVIDER_API_KEY_ENV } from '../identity';
import type { NativeRuntime } from '../native/runtime';
import { writeEngineCredential } from './credentials';
import { type OAuthLoginClient, runOAuthLogin } from './oauth';
import { openAuthorizationUrl } from './oauth-url';
import { parseAuthCliArgs } from './auth-program';
import { CliExitError } from './program';
import { writeCliError } from './root';

export interface AuthCliEnvironment {
    /* Resolved for an auth command, never for help or version. */
    native: () => Promise<NativeRuntime>;
    env?: NodeJS.ProcessEnv;
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
    stdin?: NodeJS.ReadableStream;
    isTty?: boolean;
    cwd?: string;
    signal?: AbortSignal;
    openUrl?: (url: string) => Promise<boolean>;
    sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
    createOAuthClient?: (input: OAuthClientInput) => Promise<OAuthAuthClient>;
}

export interface OAuthClientInput {
    native: NativeRuntime;
    providerID: string;
    directory: string;
}

export interface OAuthAuthClient extends OAuthLoginClient {
    close: EngineHostClient['close'];
}

/* A key keeps the JSON-store path. Without one, the host runs the provider's
   OAuth method against the separate persistent store. */
export async function runAuthCli(args: string[], environment: AuthCliEnvironment): Promise<number> {
    const stdout = environment.stdout ?? process.stdout;
    const stderr = environment.stderr ?? process.stderr;

    try {
        return await executeAuthCli({ args, environment, stdout, stderr });
    } catch (error) {
        if (error instanceof CliExitError) {
            return error.exitCode;
        }

        writeCliError(stderr, error);

        return 1;
    }
}

interface AuthRequest {
    args: string[];
    environment: AuthCliEnvironment;
    stdout: NodeJS.WritableStream;
    stderr: NodeJS.WritableStream;
}

function executeAuthCli(request: AuthRequest): Promise<number> {
    const command = parseAuthCliArgs(request.args, { stdout: request.stdout, stderr: request.stderr });

    if (command.command === 'list') {
        return listCredentials(command.provider, request);
    }

    if (command.command === 'remove') {
        return removeCredential(command.credentialID, request);
    }

    return login(request, command);
}

function login(request: AuthRequest, command: { provider: string; key?: string; method?: string }): Promise<number> {
    if (command.key !== undefined && command.method !== undefined) {
        throw new Error('Choose either --key or --method for auth login, not both.');
    }

    let apiKey = command.key;

    if (apiKey === undefined && command.method === undefined) {
        apiKey = keyFromEnvironment(request.environment.env ?? process.env);
    }

    if (apiKey === undefined) {
        return loginWithOAuth(command.provider, command.method, request);
    }

    return storeApiKey(request, command.provider, apiKey);
}

async function storeApiKey(request: AuthRequest, providerID: string, apiKey: string): Promise<number> {
    const native = await request.environment.native();
    await writeEngineCredential({
        path: native.engineCredentialPath,
        providerID,
        apiKey
    });
    request.stdout.write(`Stored the ${providerID} credential in the ${PRODUCT_NAME} credential store.\n`);

    return 0;
}

function keyFromEnvironment(env: NodeJS.ProcessEnv): string | undefined {
    const value = env[PROVIDER_API_KEY_ENV];

    if (value === undefined || value.trim() === '') {
        return undefined;
    }

    return value;
}

async function listCredentials(provider: string | undefined, request: AuthRequest): Promise<number> {
    const native = await request.environment.native();
    const available = await listOAuthCredentials(native.engineOAuthCredentialPath);

    const credentials = available.filter(
        (credential) => provider === undefined || credential.integrationID === provider
    );

    if (credentials.length === 0) {
        request.stdout.write('No persistent OAuth credentials found.\n');

        return 0;
    }

    for (const credential of credentials) {
        request.stdout.write(credentialLine(credential));
    }

    return 0;
}

function credentialLine(credential: {
    selected: boolean;
    credentialID: string;
    integrationID: string;
    label: string;
}): string {
    let selected = ' ';

    if (credential.selected) {
        selected = '*';
    }

    return `${selected} ${credential.credentialID}  ${credential.integrationID}  ${credential.label}\n`;
}

async function removeCredential(credentialID: string, request: AuthRequest): Promise<number> {
    const native = await request.environment.native();
    const removed = await removeOAuthCredential(native.engineOAuthCredentialPath, credentialID);

    if (!removed) {
        request.stderr.write(`OAuth credential "${credentialID}" was not found.\n`);

        return 1;
    }

    request.stdout.write(`Removed OAuth credential ${credentialID}.\n`);

    return 0;
}

async function loginWithOAuth(providerID: string, methodID: string | undefined, request: AuthRequest): Promise<number> {
    const native = await request.environment.native();
    const directory = path.resolve(request.environment.cwd ?? process.cwd());
    await mkdir(native.engineDatabaseDirectory, { recursive: true });
    const prompt = createPrompt(request);
    let client: OAuthAuthClient | undefined = undefined;

    try {
        client = await createOAuthClient({ native, providerID, directory }, request.environment);
        await authorizeAndReport({ client, directory, providerID, methodID, request, native, prompt });

        return 0;
    } finally {
        await closeOAuthLogin(prompt, client, native);
    }
}

async function closeOAuthLogin(
    prompt: PromptHandle,
    client: OAuthAuthClient | undefined,
    native: NativeRuntime
): Promise<void> {
    prompt.close();

    try {
        await client?.close();
    } finally {
        await rm(native.engineDatabaseDirectory, { recursive: true, force: true });
    }
}

async function authorizeAndReport(input: {
    client: OAuthAuthClient;
    directory: string;
    providerID: string;
    methodID?: string;
    request: AuthRequest;
    native: NativeRuntime;
    prompt: PromptHandle;
}): Promise<void> {
    const { client, directory, providerID, methodID, request, native, prompt } = input;
    const credentials = await listOAuthCredentials(native.engineOAuthCredentialPath);
    const existing = new Set(credentials.map((credential) => credential.credentialID));
    await runOAuthLogin({
        client,
        directory,
        providerID,
        methodID,
        interactive: request.environment.isTty ?? process.stdin.isTTY,
        prompt: prompt.ask,
        stdout: request.stdout,
        signal: request.environment.signal,
        openUrl: request.environment.openUrl ?? openAuthorizationUrl,
        sleep: request.environment.sleep
    });

    const selection = await resolveOAuthCredentialSelection({
        path: native.engineOAuthCredentialPath,
        integrationID: providerID
    });

    if (selection.kind !== 'selected' || existing.has(selection.credentialID)) {
        throw new Error(`OAuth login for provider "${providerID}" completed without a stored credential.`);
    }

    request.stdout.write(`Stored and selected OAuth credential ${selection.credentialID} for ${providerID}.\n`);
}

function createOAuthClient(input: OAuthClientInput, environment: AuthCliEnvironment): Promise<OAuthAuthClient> {
    if (environment.createOAuthClient !== undefined) {
        return environment.createOAuthClient(input);
    }

    return createEffectEngineClient(
        {
            config: { project: false, directory: input.directory, content: '{}' },
            models: { fetch: false },
            fs: { filewatcher: false, fff: false },
            database: { path: input.native.engineDatabasePath },
            events: { persist: false }
        },
        {
            path: input.native.engineOAuthCredentialPath,
            integrationID: input.providerID,
            persistCreatedSelection: true
        }
    );
}

interface PromptHandle {
    ask: (message: string) => Promise<string>;
    close: () => void;
}

function createPrompt(request: AuthRequest): PromptHandle {
    let lines: ReadLineInterface | undefined = undefined;
    let iterator: AsyncIterator<string> | undefined = undefined;

    return {
        ask: async (message) => {
            request.stderr.write(message);

            if (lines === undefined) {
                lines = createInterface({ input: request.environment.stdin ?? process.stdin, terminal: false });
                iterator = lines[Symbol.asyncIterator]();
            }

            const answer = await iterator?.next();

            if (answer === undefined) {
                return '';
            }

            if (answer.done === true) {
                return '';
            }

            return answer.value;
        },
        close: () => {
            lines?.close();
        }
    };
}
