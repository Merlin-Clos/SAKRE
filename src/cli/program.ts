import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import { CLI_LOCAL_COMMAND, DEFAULT_CONFIG_PATH, PRODUCT_SLUG, PROVIDER_API_KEY_ENV } from '../identity';
import { MAX_GUIDANCE_CHARS } from '../review/guidance';

const contextModes = ['auto', 'git', 'github'] as const;

const authModes = ['auto', 'env', 'opencode'] as const;

const outputModes = ['terminal', 'github-pr'] as const;

export type ContextMode = (typeof contextModes)[number];

export type AuthMode = (typeof authModes)[number];

export type OutputMode = (typeof outputModes)[number];

export interface LocalCliOptions {
    repositoryDir?: string;
    baseRef?: string;
    headRef?: string;
    context: ContextMode;
    auth: AuthMode;
    provider?: string;
    model?: string;
    credential?: string;
    /* Repository config path, read at the resolved base SHA by default. */
    configPath: string;
    /* Explicit `--config <path>`: trusted-local file, read from disk. */
    localConfigPath?: string;
    /* Explicit `--instructions <path>`: untrusted review guidance read from
       disk, never discovered from the repository. */
    instructionsPath?: string;
    output: OutputMode;
    outputFile?: string;
    prNumber?: number;
    isMockMode: boolean;
    forceOverBudget: boolean;
}

export interface CliStreams {
    stdout: NodeJS.WritableStream;
    stderr: NodeJS.WritableStream;
}

/* Parse-time exit already reported via streams: caller returns the code as-is. */
export class CliExitError extends Error {
    public readonly exitCode: number;

    public constructor(exitCode: number) {
        super(`Command line parsing exited with code ${exitCode}.`);
        this.name = 'CliExitError';
        this.exitCode = exitCode;
    }
}

/* Commander option values after its defaults and choices are applied. */
interface LocalProgramOptions {
    repo?: string;
    base?: string;
    head?: string;
    context: ContextMode;
    auth: AuthMode;
    provider?: string;
    model?: string;
    credential?: string;
    config?: string;
    instructions?: string;
    output: OutputMode;
    outputFile?: string;
    pr?: number;
    mock?: boolean;
    forceOverBudget?: boolean;
}

const DEFAULT_CONTEXT_MODE: ContextMode = 'auto';

const DEFAULT_AUTH_MODE: AuthMode = 'auto';

const DEFAULT_OUTPUT_MODE: OutputMode = 'terminal';

/* Local options. Unknown flags, bad values, positionals, and bad enums fail via
   Commander on stderr; help goes to stdout with exit zero. */
export function parseLocalCliArgs(args: readonly string[], streams: CliStreams): LocalCliOptions {
    const program = createCommand(streams)
        .name(`${PRODUCT_SLUG} ${CLI_LOCAL_COMMAND}`)
        .description('Review a local Git range with the same engine as the GitHub Action.');

    registerLocalOptions(program);

    /* Commander keeps args after literal `--`; the base CLI rejects it instead. */
    if (args.includes('--')) {
        failCommand(program, "error: unknown option '--'", 'commander.unknownOption');
    }

    runCommand(program, args);
    /* SAFETY: Commander applied the declared defaults and validated every choice. */
    const parsed = program.opts<LocalProgramOptions>();

    return {
        repositoryDir: parsed.repo,
        baseRef: parsed.base,
        headRef: parsed.head,
        context: parsed.context,
        auth: parsed.auth,
        provider: parsed.provider,
        model: parsed.model,
        credential: parsed.credential,
        configPath: parsed.config ?? DEFAULT_CONFIG_PATH,
        localConfigPath: parsed.config,
        instructionsPath: parsed.instructions,
        output: parsed.output,
        outputFile: parsed.outputFile,
        prNumber: parsed.pr,
        isMockMode: parsed.mock === true,
        forceOverBudget: parsed.forceOverBudget === true
    };
}

function registerLocalOptions(program: Command): void {
    program
        .option('--repo <path>', 'Repository to review (default: current directory).', parseOptionValue)
        .option('--base <ref>', 'Base ref (default: origin/HEAD, then main, then master).', parseOptionValue)
        .option('--head <ref>', 'Head ref (default: HEAD).', parseOptionValue)
        .addOption(
            new Option('--context <mode>', 'Review context source: Git only, GitHub pull request, or auto.')
                .choices(contextModes)
                .default(DEFAULT_CONTEXT_MODE)
        )
        .addOption(
            new Option('--auth <mode>', 'Provider credential source: environment, OpenCode store, or auto.')
                .choices(authModes)
                .default(DEFAULT_AUTH_MODE)
        )
        .option('--provider <id>', 'Provider override (Action family or native OpenCode id).', parseOptionValue)
        .option('--credential <id>', 'Explicit persistent OAuth credential for this review.', parseOptionValue)
        .option(
            '--model <id>',
            'Global fallback model; models.routing cells and agent defaults take precedence.',
            parseOptionValue
        )
        .option(
            '--config <path>',
            'Trusted local config file; replaces the repository config at the base commit.',
            parseOptionValue
        )
        .option(
            '--instructions <path>',
            `Untrusted review guidance file (max ${MAX_GUIDANCE_CHARS} characters); focuses investigation without changing the review contract.`,
            parseOptionValue
        )
        .addOption(
            new Option('--output <mode>', 'Primary destination: terminal stdout or a pull-request comment.')
                .choices(outputModes)
                .default(DEFAULT_OUTPUT_MODE)
        )
        .option('--output-file <path>', 'Also write the Markdown report to this file.', parseOptionValue)
        .option(
            '--pr <number>',
            'Pull request for GitHub context or publication; skips auto-detection.',
            parsePullRequestNumber
        )
        .option('--mock', 'Run without calling an AI provider.')
        .option('--force-over-budget', 'Review a diff above the configured budget; coverage becomes partial.')
        .addHelpText('after', localHelpNotes());
}

/* `--help` contract: same rules the README states, no hidden fallback chain. */
function localHelpNotes(): string {
    return [
        '',
        'Context and output:',
        '  --context git       Reads Git history only; GitHub is contacted only when',
        '                      --output github-pr publishes to a pull request.',
        '  --context github    Requires a GitHub origin or upstream remote, a GitHub token and a',
        '                      pull request; --pr <number> is required when auto-detection cannot',
        '                      find one (detached HEAD or a fork without an upstream remote).',
        '  --context auto      Uses the GitHub pull request when an open PR for the checked-out',
        '                      branch is found; otherwise synthesizes the Git context.',
        '  --output terminal   Prints the Markdown report to stdout.',
        '  --output github-pr  Publishes the report to the pull request (requires GitHub context).',
        '  --output-file <path>  Also writes the report to the file in either output mode.',
        '',
        'Review guidance:',
        `  --instructions <path>  Reads untrusted guidance from the file (max ${MAX_GUIDANCE_CHARS} characters).`,
        '                      It focuses investigation only: provider, model routing,',
        '                      permissions, the review contract and the verdict are unaffected,',
        '                      and the file is read only when this option is passed.',
        '',
        `Provider credentials: --auth env reads ${PROVIDER_API_KEY_ENV}; \`auth login\` stores an API key or runs an embedded OAuth method.`,
        'GitHub credentials (context and publication only): GITHUB_TOKEN, GH_TOKEN, then the',
        'optional `gh auth token`. `--context git --output terminal` needs no GitHub credential.'
    ].join('\n');
}

export function parseProviderValue(value: string): string {
    if (value === '' || value.startsWith('-')) {
        throw new InvalidArgumentError('Must not be empty or start with "-".');
    }

    return value;
}

export function createCommand(streams: CliStreams): Command {
    return new Command().exitOverride().configureOutput({
        writeOut: (text) => {
            streams.stdout.write(text);
        },
        writeErr: (text) => {
            streams.stderr.write(text);
        }
    });
}

/* Commander takes the next token as a value even when it is another option, and
   takes empty inline values; both stay rejected to keep the CLI contract. */
export function parseOptionValue(value: string): string {
    if (value === '' || value.startsWith('--')) {
        throw new InvalidArgumentError('Must not be empty or start with "--".');
    }

    return value;
}

/* Positive integers are our own rule: Commander has no integer parser. Padded
   values pass, like the base CLI. */
function parsePullRequestNumber(value: string): number {
    const number = Number(value);

    if (!/^\d+$/u.test(value) || number < 1) {
        throw new InvalidArgumentError('Must be a positive integer.');
    }

    return number;
}

export function runCommand(program: Command, args: readonly string[]): void {
    try {
        program.parse(args, { from: 'user' });
    } catch (error) {
        throw toCliExitError(error);
    }
}

/* Reports an error through the configured streams and exits non-zero. */
export function failCommand(program: Command, message: string, code: string): never {
    try {
        program.error(message, { exitCode: 1, code });
    } catch (error) {
        throw toCliExitError(error);
    }
}

// eslint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- passes through non-commander thrown values unchanged
function toCliExitError(error: unknown): unknown {
    if (error instanceof CommanderError) {
        // eslint-disable-next-line anti-slop/no-known-value-widening -- narrowed commander error maps to the exit contract
        return new CliExitError(error.exitCode);
    }

    return error;
}
