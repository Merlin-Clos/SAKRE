import type { Command } from 'commander';
import { CLI_AUTH_COMMAND, PRODUCT_SLUG, PROVIDER_API_KEY_ENV } from '../identity';
import {
    type CliStreams,
    createCommand,
    failCommand,
    parseOptionValue,
    parseProviderValue,
    runCommand
} from './program';

export type AuthCommandOptions =
    | { command: 'login'; provider: string; key?: string; method?: string }
    | { command: 'list'; provider?: string }
    | { command: 'remove'; credentialID: string };

/* Credential subcommands. `--help` answers on stdout with exit zero; other
   failures report through injected streams and exit non-zero. */
export function parseAuthCliArgs(args: readonly string[], streams: CliStreams): AuthCommandOptions {
    const { program, login, list, remove } = createAuthProgram(streams);
    runCommand(program, args);

    if (args[0] === 'list') {
        return parseList(list);
    }

    if (args[0] === 'remove') {
        return parseRemove(program, remove);
    }

    if (args[0] === 'login') {
        return parseLogin(program, login);
    }

    return failCommand(program, "error: unknown option '--'", 'commander.unknownOption');
}

function createAuthProgram(streams: CliStreams): { program: Command; login: Command; list: Command; remove: Command } {
    const program = createCommand(streams)
        .name(`${PRODUCT_SLUG} ${CLI_AUTH_COMMAND}`)
        .usage('[options] <command>')
        .description('Manage provider credentials used by standalone reviews.')
        .showHelpAfterError();

    const login = program
        .command('login')
        .description('Store an API key or run an interactive OAuth method for one provider.')
        .argument('<provider>', 'Provider id to authenticate (for example openai).', parseProviderValue)
        .option(
            '--key <key>',
            `API key to store; defaults to the ${PROVIDER_API_KEY_ENV} environment variable.`,
            parseOptionValue
        )
        .option('--method <id>', 'OAuth method to run when the provider offers more than one.', parseOptionValue);

    const list = program
        .command('list')
        .description('List persistent OAuth credentials without displaying secrets.')
        .argument('[provider]', 'Optional provider id filter.', parseProviderValue);

    const remove = program
        .command('remove')
        .description('Remove one persistent OAuth credential by id.')
        .argument('<credential>', 'Credential id returned by auth list.', parseOptionValue);

    // eslint-disable-next-line anti-slop/no-known-value-widening -- declared return names the auth command contract
    return { program, login, list, remove };
}

function parseList(list: Command): AuthCommandOptions {
    const provider: unknown = list.processedArgs[0];

    // eslint-disable-next-line anti-slop/no-runtime-typeof -- narrows commander-parsed args before domain mapping
    if (typeof provider === 'string') {
        return { command: 'list', provider };
    }

    return { command: 'list' };
}

function parseRemove(program: Command, remove: Command): AuthCommandOptions {
    const credentialID: unknown = remove.processedArgs[0];

    // eslint-disable-next-line anti-slop/no-runtime-typeof -- narrows commander-parsed args before domain mapping
    if (typeof credentialID !== 'string') {
        failCommand(program, "error: missing required argument 'credential'", 'commander.missingArgument');
    }

    return { command: 'remove', credentialID };
}

function parseLogin(program: Command, login: Command): AuthCommandOptions {
    const options = login.opts<{ key?: string; method?: string }>();
    const provider: unknown = login.processedArgs[0];

    // eslint-disable-next-line anti-slop/no-runtime-typeof -- narrows commander-parsed args before domain mapping
    if (typeof provider !== 'string') {
        failCommand(program, "error: missing required argument 'provider'", 'commander.missingArgument');
    }

    return { command: 'login', provider, key: options.key, method: options.method };
}
