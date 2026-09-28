import { type Command, CommanderError } from 'commander';
import { describeError } from '../errors';
import { CLI_AUTH_COMMAND, CLI_LOCAL_COMMAND, PRODUCT_NAME, PRODUCT_SLUG, PRODUCT_VERSION } from '../identity';
import { type CliStreams, createCommand } from './program';

/* Root dispatch runs before Action input, credential, repo, or tool setup:
   `--help`/`--version` answer at once, `local`/`auth` route out, and no args
   means the Action entrypoint. */
export type RootCliRoute =
    | { command: 'action' }
    | { command: typeof CLI_LOCAL_COMMAND; args: string[] }
    | { command: typeof CLI_AUTH_COMMAND; args: string[] }
    | { command: 'exit'; exitCode: 0 | 1 };

const ROOT_HELP_TOKENS = new Set(['--help', '-h']);

const ROOT_VERSION_TOKENS = new Set(['--version', '-v']);

const HELP_COMMAND = 'help';

export function routeRootCli(args: readonly string[], streams: CliStreams): RootCliRoute {
    const [first, ...rest] = args;

    if (first === undefined) {
        return { command: 'action' };
    }

    if (first === HELP_COMMAND) {
        return helpRoute(rest, streams);
    }

    if (ROOT_HELP_TOKENS.has(first) || ROOT_VERSION_TOKENS.has(first)) {
        return rootInfoRoute(streams, first);
    }

    return localOrAuthRoute(first, rest) ?? failRootCommand(streams, first);
}

/* `help` alone answers root help; `help <command>` reuses that command's
   `--help`, so each text keeps one owner. */
function helpRoute(rest: string[], streams: CliStreams): RootCliRoute {
    const [target = '', ...targetArgs] = rest;

    if (target === '') {
        createRootProgram(streams).outputHelp();

        return { command: 'exit', exitCode: 0 };
    }

    if (target === CLI_LOCAL_COMMAND) {
        return { command: CLI_LOCAL_COMMAND, args: [...targetArgs, '--help'] };
    }

    if (target === CLI_AUTH_COMMAND) {
        return { command: CLI_AUTH_COMMAND, args: [...targetArgs, '--help'] };
    }

    return failRootCommand(streams, target);
}

function localOrAuthRoute(first: string, rest: string[]): RootCliRoute | undefined {
    if (first === CLI_LOCAL_COMMAND) {
        return { command: CLI_LOCAL_COMMAND, args: rest };
    }

    if (first === CLI_AUTH_COMMAND) {
        return { command: CLI_AUTH_COMMAND, args: rest };
    }

    return undefined;
}

function rootInfoRoute(streams: CliStreams, token: string): RootCliRoute {
    if (ROOT_HELP_TOKENS.has(token)) {
        createRootProgram(streams).outputHelp();
    } else {
        streams.stdout.write(`${PRODUCT_NAME} ${PRODUCT_VERSION}\n`);
    }

    return { command: 'exit', exitCode: 0 };
}

/* Root help has one owner. Subcommands register for the list only; routing is
   decided here, not by Commander. */
function createRootProgram(streams: CliStreams): Command {
    const program = createCommand(streams)
        .name(PRODUCT_SLUG)
        .description(
            'Standalone review engine. Run a review, manage provider credentials, or start the GitHub Action entrypoint (no arguments).'
        )
        .version(`${PRODUCT_NAME} ${PRODUCT_VERSION}`, '-v, --version')
        .showHelpAfterError();

    program
        .command(CLI_LOCAL_COMMAND)
        .description('Run a review from this CLI with a Git or GitHub pull-request context.');
    program.command(CLI_AUTH_COMMAND).description('Manage the provider credentials used by standalone reviews.');

    return program;
}

interface RootFailure {
    message: string;
    code: string;
}

function rootFailure(token: string): RootFailure {
    if (token.startsWith('-')) {
        return { message: `error: unknown option '${token}'`, code: 'commander.unknownOption' };
    }

    return { message: `error: unknown command '${token}'`, code: 'commander.unknownCommand' };
}

/* Reports via streams and returns non-zero: a root failure is interactive, never
   the Action entrypoint. */
function failRootCommand(streams: CliStreams, token: string): RootCliRoute {
    const program = createRootProgram(streams);
    const { message, code } = rootFailure(token);

    try {
        program.error(message, { exitCode: 1, code });
    } catch (error) {
        if (!(error instanceof CommanderError)) {
            throw error;
        }
        /* Commander reports through the configured streams and throws because
           of exitOverride; the route carries the exit code to the caller. */
    }

    return { command: 'exit', exitCode: 1 };
}

/* CLI failures use `Error: ...`, never Action annotations. */
// eslint-disable-next-line anti-slop/no-unknown-parameters -- thrown CLI values cross this boundary as unknown
export function writeCliError(stream: NodeJS.WritableStream, error: unknown): void {
    stream.write(`Error: ${describeError(error)}\n`);
}
