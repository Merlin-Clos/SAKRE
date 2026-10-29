import { homedir } from 'node:os';
import { routeRootCli, writeCliError } from '../cli/root';
import { CLI_AUTH_COMMAND, CLI_LOCAL_COMMAND } from '../identity';

/* Parse before importing execution modules: help and invalid commands do not
   initialize the engine, native assets, or Action inputs. */
const route = routeRootCli(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr });

switch (route.command) {
    case 'exit': {
        process.exitCode = route.exitCode;
        break;
    }

    case CLI_LOCAL_COMMAND: {
        const { runLocalCli } = await import('../cli/local');
        process.exitCode = await runLocalCli(route.args);
        break;
    }

    case CLI_AUTH_COMMAND: {
        process.exitCode = await runAuthEntrypoint(route.args);
        break;
    }

    case 'action': {
        const { runActionEntrypoint } = await import('./main');
        await runActionEntrypoint();
        break;
    }

    default: {
        assertNever(route);
    }
}

async function runAuthEntrypoint(args: string[]): Promise<number> {
    try {
        const { runAuthCli } = await import('../cli/auth');

        return await runAuthCli(args, {
            native: async () => {
                const { resolveNativeRuntime } = await import('../native/runtime');

                return resolveNativeRuntime({
                    platform: process.platform,
                    architecture: process.arch,
                    environment: process.env,
                    home: homedir()
                });
            }
        });
    } catch (error) {
        writeCliError(process.stderr, error);

        return 1;
    }
}

function assertNever(unhandled: never): never {
    throw new Error(`Unhandled root CLI route: ${JSON.stringify(unhandled)}.`);
}
