import type { EngineHostClient } from '../engine/effect-client';
import type { NativeRuntime } from '../native/runtime';
import type { OAuthLoginClient } from './oauth';
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

/* Credential and engine modules load only after the command parser accepts an
   operation; every help form keeps the same parser and output owner. */
export async function runAuthCli(args: string[], environment: AuthCliEnvironment): Promise<number> {
    const stdout = environment.stdout ?? process.stdout;
    const stderr = environment.stderr ?? process.stderr;

    try {
        const command = parseAuthCliArgs(args, { stdout, stderr });
        const { executeAuthCli } = await import('./auth-commands');

        return await executeAuthCli(command, { environment, stdout, stderr });
    } catch (error) {
        if (error instanceof CliExitError) {
            return error.exitCode;
        }

        writeCliError(stderr, error);

        return 1;
    }
}
