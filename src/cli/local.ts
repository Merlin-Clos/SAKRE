import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { AiRuntime } from '../ai/runtime';
import { postComment, updateComment } from '../action/publish';
import { DiffBudgetExceededError } from '../action/errors';
import { runReviewCycle } from '../action/run';
import { type ActionRuntimeInput, createActionRuntime } from '../action/runtime-factory';
import type { ReviewExecution, ReviewReportProvenance } from '../action/state';
import { type CoverageBudgetSummary, formatBudgetReport } from '../analysis/budget';
import { reviewMapLogPayload } from '../intelligence/log';
import { createNativeIntelligenceRun } from '../intelligence/native-run';
import type { EffectiveRun } from '../config/effective-run';
import { describeError } from '../errors';
import { PRODUCT_NAME, PROVIDER_API_KEY_ENV } from '../identity';
import { configureLogRedaction, configureLogSink, createLogger, createStreamLogSink, resetLogSink } from '../logger';
import { type NativeRuntime, resolveNativeRuntime } from '../native/runtime';
import type { SelectedOAuthCredential } from '../engine/host';
import {
    type OAuthCredentialSelection,
    readOAuthCredentialSecrets,
    resolveOAuthCredentialSelection
} from '../engine/oauth-credentials';
import { createLocalGuidance, GuidanceError, MAX_GUIDANCE_CHARS, type ReviewGuidance } from '../review/guidance';
import { createGitRunner, type GitRunner } from '../vcs/git-command';
import { type LocalGitContext, LocalGitVcs, resolveLocalRefs } from '../vcs/local';
import { createTrustedWorkspace, type TrustedWorkspace } from '../workspace/trusted';
import { CliExitError, type LocalCliOptions, parseLocalCliArgs } from './program';
import { writeCliError } from './root';
import {
    type AuthStore,
    authStoreSecretValues,
    type EngineCredentialStore,
    readContext7ApiKey,
    readProviderBaseURL,
    resolveAuthSelection
} from './credentials';
import {
    createGitHubClient,
    fetchGitHubContext,
    findOpenPullRequest,
    type GitHubClient,
    type GitHubClientDependencies,
    type GitHubRemote,
    isGitHubRemote,
    parseRemote,
    resolveGitHubToken
} from './forge';
import { renderReviewResult, writeOutputFile, writeTerminal } from './output';
import { confirmOverBudget, type OverBudgetPromptEnvironment } from './prompt';
import {
    ensureGitAvailable,
    PrerequisiteError,
    readCurrentBranch,
    readRemote,
    resolveRepositoryRoot
} from './prerequisites';

/* Only boundary tests must replace: runs the cycle without starting the engine. */
export type LocalRuntimeFactory = (input: ActionRuntimeInput) => Promise<AiRuntime>;

export interface LocalCliEnvironment {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
    /* Interactive confirmation: injected stdin and TTY state; defaults to the
       process stdin and its own TTY state. */
    stdin?: NodeJS.ReadableStream;
    isTty?: boolean;
    signal?: AbortSignal;
    authStorePath?: string;
    githubClientDependencies?: GitHubClientDependencies;
    /* Native assets resolved from the embedded runtime; tests inject a fake to
       avoid downloading or embedding archives. */
    native?: NativeRuntime;
    createRuntime?: LocalRuntimeFactory;
}

interface ResolvedReviewContext {
    github?: GitHubClient;
    token?: string;
    pullRequestNumber?: number;
    context?: LocalGitContext;
}

const log = createLogger('cli');

/* Local entrypoint states execution provenance once; comment and terminal/file
   copies render from the same value. */
const LOCAL_EXECUTION: ReviewExecution = 'local-cli';

/* Runs `local`: parse, execute, and map every failure to a clean stderr message
   with non-zero exit. */
export async function runLocalCli(args: string[], environment: LocalCliEnvironment = {}): Promise<number> {
    const stdout = environment.stdout ?? process.stdout;
    const stderr = environment.stderr ?? process.stderr;
    configureLogSink(createStreamLogSink(stderr));

    try {
        const options = parseLocalCliArgs(args, { stdout, stderr });

        return await executeLocalReview(options, environment, stdout);
    } catch (error) {
        if (error instanceof CliExitError) {
            return error.exitCode;
        }

        if (error instanceof DiffBudgetExceededError) {
            stderr.write(`${budgetAbortMessage(error.report)}\n`);

            return 1;
        }

        writeCliError(stderr, error);

        return 1;
    } finally {
        resetLogSink();
        configureLogRedaction([]);
    }
}

/* Abort message: exact numbers plus the per-run flag for a partial review. */
function budgetAbortMessage(report: CoverageBudgetSummary): string {
    return [
        `Error: Diff exceeds the review budget: ${formatBudgetReport(report)}.`,
        'Re-run with --force-over-budget to review only the portion that fits the budget. Coverage will be partial.'
    ].join('\n');
}

/* Guidance file reads only with `--instructions`: no discovery, no default. A
   bad or over-cap file fails before the review starts. */
async function readLocalGuidance(
    options: LocalCliOptions,
    environment: LocalCliEnvironment
): Promise<ReviewGuidance | undefined> {
    const { instructionsPath } = options;

    if (instructionsPath === undefined) {
        return undefined;
    }

    const { cwd } = environment;
    const resolved = path.resolve(cwd ?? process.cwd(), instructionsPath);
    const content = await readGuidanceFile(resolved);

    return createLocalGuidance(content);
}

/* One char takes at most four UTF-8 bytes, so a full buffer already exceeds the
   cap; the file is never fully read. */
const MAX_UTF8_BYTES_PER_CHARACTER = 4;

const MAX_GUIDANCE_READ_BYTES = MAX_GUIDANCE_CHARS * MAX_UTF8_BYTES_PER_CHARACTER + 1;

async function readGuidanceFile(filePath: string): Promise<string> {
    try {
        const handle = await open(filePath, 'r');

        try {
            const buffer = Buffer.alloc(MAX_GUIDANCE_READ_BYTES);
            const { bytesRead } = await handle.read(buffer, 0, MAX_GUIDANCE_READ_BYTES, 0);

            if (bytesRead === MAX_GUIDANCE_READ_BYTES) {
                throw new GuidanceError(
                    `The --instructions file exceeds the ${MAX_GUIDANCE_CHARS}-character review guidance limit.`
                );
            }

            return buffer.subarray(0, bytesRead).toString('utf8');
        } finally {
            await handle.close();
        }
    } catch (error) {
        if (error instanceof GuidanceError) {
            throw error;
        }

        throw new GuidanceError(`Cannot read the --instructions file: ${describeError(error)}`);
    }
}

async function executeLocalReview(
    options: LocalCliOptions,
    environment: LocalCliEnvironment,
    stdout: NodeJS.WritableStream
): Promise<number> {
    const guidance = await readLocalGuidance(options, environment);
    warnAboutGuidance(guidance, environment);
    const env = environment.env ?? process.env;

    const promptEnvironment: OverBudgetPromptEnvironment = {
        stdin: environment.stdin ?? process.stdin,
        stderr: environment.stderr ?? process.stderr,
        stdinIsTty: environment.isTty ?? process.stdin.isTTY
    };

    const invocationDirectory = options.repositoryDir ?? environment.cwd ?? process.cwd();
    const invocationGit = createGitRunner(invocationDirectory);
    await ensureGitAvailable(invocationGit, environment.signal);
    const repositoryDir = await resolveRepositoryRoot(invocationGit, environment.signal);
    const git = createGitRunner(repositoryDir);

    const refs = await resolveLocalRefs({
        repositoryDir,
        baseRef: options.baseRef,
        headRef: options.headRef,
        git,
        signal: environment.signal
    });

    const context7ApiKey = readContext7ApiKey(env);
    const providerBaseURL = readProviderBaseURL(env);
    const native = environment.native ?? (await resolveNativeEnvironment(env, environment.signal));
    const authSelection = await resolveCredentials({ options, environment, env, native });
    const oauthSecrets = await oauthSecretsForRun(options, native);
    const selectedEnvironmentCredential = authSelection.kind === 'env' ? authSelection : undefined;

    const credentialSecrets = [
        selectedEnvironmentCredential?.apiKey ?? '',
        context7ApiKey ?? '',
        ...authSelection.storeSecrets,
        ...oauthSecrets
    ];

    configureLogRedaction(credentialSecrets);

    const reviewContext = await resolveReviewContext({
        options,
        environment,
        env,
        git,
        repositoryDir
    });

    configureLogRedaction([...credentialSecrets, reviewContext.token ?? '']);
    const publishTarget = buildPublishTarget(options, reviewContext);
    const vcs = new LocalGitVcs({ repositoryDir, refs, context: reviewContext.context, git });

    const published = await runReviewCycle({
        vcs,
        inputs: {
            provider: options.provider,
            defaultModel: options.model,
            configPath: options.configPath,
            localConfigPath: options.localConfigPath,
            isMockMode: options.isMockMode,
            credentials: { apiKey: selectedEnvironmentCredential?.apiKey, baseURL: providerBaseURL },
            allowNativeProvider: true,
            allowMissingCredential: !options.isMockMode && authSelection.kind !== 'env'
        },
        prNumber: reviewContext.pullRequestNumber ?? 0,
        execution: LOCAL_EXECUTION,
        guidance,
        force: true,
        forceOverBudget: options.forceOverBudget,
        confirmOverBudget: (report) => confirmOverBudget(report, promptEnvironment),
        worktreeDir: repositoryDir,
        /* SCC waits until a step needs it, so over-budget aborts skip it. */
        runIntelligence: createNativeIntelligenceRun(native),
        /* CLI logs the full map to stderr; stdout stays Markdown. Raw sink skips
           the string cap while the payload keeps its 256 KB cap. */
        logIntelligence: (map) => {
            log.raw(reviewMapLogPayload(map));
        },
        /* Explicit --base may bring an untrusted AGENTS.md, so the engine reads
           the BASE overlay; without --base the checkout is trusted. */
        createWorkspace:
            options.baseRef === undefined
                ? undefined
                : (request): Promise<TrustedWorkspace> => createTrustedWorkspace({ repositoryDir, ...request }),
        createRuntime: async ({ effective, config, signal, worktreeDir }): Promise<AiRuntime> => {
            const runtimeAuth = await resolveRuntimeAuthentication({
                effective,
                options,
                authSelection,
                native,
                environment,
                env
            });

            configureLogRedaction([
                ...credentialSecrets,
                reviewContext.token ?? '',
                ...runtimeAuth.authSelection.storeSecrets
            ]);

            const runtimeInput = {
                effective: runtimeAuth.effective,
                config,
                isMockMode: options.isMockMode,
                native,
                signal,
                checkoutDir: worktreeDir,
                context7ApiKey,
                oauthCredential: runtimeAuth.oauthCredential,
                externalOAuth:
                    runtimeAuth.oauthCredential === undefined &&
                    runtimeAuth.authSelection.kind === 'store' &&
                    runtimeAuth.authSelection.store.entries[effective.provider]?.type === 'oauth'
            };

            if (environment.createRuntime !== undefined) {
                return environment.createRuntime(runtimeInput);
            }

            return createActionRuntime(runtimeInput);
        },
        publication:
            publishTarget === undefined
                ? undefined
                : {
                      create: (body, signal): Promise<number> => postComment(publishTarget, body, signal),
                      update: (commentId, body, signal): Promise<void> =>
                          updateComment({ target: publishTarget, commentId, body, signal })
                  }
    });

    /* One provenance value for every report: published comment and
       terminal/file copy cannot disagree. */
    await emitReview({
        options,
        result: published.result,
        pullRequestNumber: reviewContext.pullRequestNumber,
        provenance: localProvenance(refs.baseSha, guidance, published.models),
        stdout
    });

    if (published.result.status === 'incomplete') {
        log.error('Review ended incomplete; inspect the diagnostics above.', { status: published.result.status });

        return 1;
    }

    return 0;
}

function warnAboutGuidance(guidance: ReviewGuidance | undefined, environment: LocalCliEnvironment): void {
    if (guidance === undefined) {
        return;
    }

    const stderr = environment.stderr ?? process.stderr;
    stderr.write(
        'Warning: this guidance will be included in the Markdown review result. If you publish the result on a pull request, the guidance will be visible there. Do not put secrets in review guidance.\n'
    );
}

function oauthSecretsForRun(options: LocalCliOptions, native: NativeRuntime): Promise<string[]> {
    if (options.auth !== 'auto' || options.isMockMode) {
        return Promise.resolve([]);
    }

    return readOAuthCredentialSecrets(native.engineOAuthCredentialPath);
}

/* Owns local report provenance: execution, revisions, used guidance, and actual
   invocations. */
function localProvenance(
    baseSha: string,
    guidance: ReviewGuidance | undefined,
    models: ReviewReportProvenance['models']
): ReviewReportProvenance {
    if (guidance === undefined) {
        return { execution: LOCAL_EXECUTION, baseSha, models };
    }

    return {
        execution: LOCAL_EXECUTION,
        baseSha,
        guidance: guidance.source,
        guidanceText: guidance.text,
        models
    };
}

type ResolvedAuthState =
    | { kind: 'none'; storeSecrets: string[] }
    | { kind: 'env'; apiKey: string; baseURL?: string; storeSecrets: string[] }
    | { kind: 'store'; store: AuthStore; storeSecrets: string[] }
    | { kind: 'engine'; store: EngineCredentialStore; storeSecrets: string[] };

interface ResolveCredentialsInput {
    options: LocalCliOptions;
    environment: LocalCliEnvironment;
    env: NodeJS.ProcessEnv;
    native: NativeRuntime;
}

async function resolveCredentials(input: ResolveCredentialsInput): Promise<ResolvedAuthState> {
    const { options, environment, env, native } = input;

    if (options.isMockMode) {
        return { kind: 'none', storeSecrets: [] };
    }

    if (options.auth === 'auto' && (env[PROVIDER_API_KEY_ENV] ?? '').trim() === '') {
        return { kind: 'none', storeSecrets: [] };
    }

    const selection = await resolveAuthSelection({
        mode: options.auth,
        environment: env,
        authStorePath: environment.authStorePath,
        engineCredentialPath: native.engineCredentialPath
    });

    return authStateFromSelection(selection);
}

function authStateFromSelection(selection: Awaited<ReturnType<typeof resolveAuthSelection>>): ResolvedAuthState {
    if (selection.kind === 'env') {
        return { ...selection, storeSecrets: [] };
    }

    if (selection.kind === 'none') {
        return { ...selection, storeSecrets: [] };
    }

    const storeSecrets = Object.values(selection.store.entries).flatMap((entry) => authStoreSecretValues(entry));

    return { ...selection, storeSecrets };
}

/* Stored entries without a key are skipped. The host decides keyless use; broken
   external OAuth is reported as-is for that integration. */
function runtimeCredentials(effective: EffectiveRun, auth: ResolvedAuthState): EffectiveRun {
    if (effective.apiKey !== undefined && effective.apiKey !== '') {
        return effective;
    }

    if (auth.kind === 'engine') {
        const key = auth.store.entries[effective.provider]?.key;

        // eslint-disable-next-line anti-slop/no-runtime-typeof -- validates decoded credential-store values
        if (typeof key === 'string' && key !== '') {
            return { ...effective, apiKey: key };
        }

        return effective;
    }

    if (auth.kind === 'store') {
        const stored = auth.store.entries[effective.provider];
        const key = stored?.key;

        // eslint-disable-next-line anti-slop/no-runtime-typeof -- validates decoded credential-store values
        if (typeof key === 'string' && key !== '') {
            return { ...effective, apiKey: key };
        }

        /* OAuth or missing key passes through, so the host reports the state for
           this integration only. */
        return effective;
    }

    return effective;
}

interface RuntimeAuthenticationInput {
    effective: EffectiveRun;
    options: LocalCliOptions;
    authSelection: ResolvedAuthState;
    native: NativeRuntime;
    environment: LocalCliEnvironment;
    env: NodeJS.ProcessEnv;
}

interface RuntimeAuthentication {
    effective: EffectiveRun;
    authSelection: ResolvedAuthState;
    oauthCredential?: SelectedOAuthCredential;
}

async function resolveRuntimeAuthentication(input: RuntimeAuthenticationInput): Promise<RuntimeAuthentication> {
    if (input.options.auth !== 'auto' && input.options.credential !== undefined) {
        throw new Error('--credential requires --auth auto.');
    }

    if (input.options.isMockMode) {
        return {
            effective: runtimeCredentials(input.effective, input.authSelection),
            authSelection: input.authSelection
        };
    }

    if (input.options.auth !== 'auto') {
        return {
            effective: runtimeCredentials(input.effective, input.authSelection),
            authSelection: input.authSelection
        };
    }

    const selection = await resolveOAuthCredentialSelection({
        path: input.native.engineOAuthCredentialPath,
        integrationID: input.effective.provider,
        credentialID: input.options.credential
    });

    return authenticationFromOAuthSelection(input, selection);
}

async function authenticationFromOAuthSelection(
    input: RuntimeAuthenticationInput,
    selection: OAuthCredentialSelection
): Promise<RuntimeAuthentication> {
    if (selection.kind === 'ambiguous') {
        throw new Error(
            `Provider "${input.effective.provider}" has ${selection.count} persistent OAuth credentials but none is selected; pass --credential <id>.`
        );
    }

    if (selection.kind === 'selected') {
        return {
            effective: { ...input.effective, apiKey: undefined },
            authSelection: input.authSelection,
            oauthCredential: { path: input.native.engineOAuthCredentialPath, credentialID: selection.credentialID }
        };
    }

    const fallback = await fallbackCredentials(input);

    return { effective: runtimeCredentials(input.effective, fallback), authSelection: fallback };
}

async function fallbackCredentials(input: RuntimeAuthenticationInput): Promise<ResolvedAuthState> {
    if (input.authSelection.kind !== 'none' || input.options.isMockMode) {
        return input.authSelection;
    }

    const selection = await resolveAuthSelection({
        mode: 'auto',
        environment: input.env,
        authStorePath: input.environment.authStorePath,
        engineCredentialPath: input.native.engineCredentialPath
    });

    return authStateFromSelection(selection);
}

function resolveNativeEnvironment(env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<NativeRuntime> {
    return resolveNativeRuntime({
        platform: process.platform,
        architecture: process.arch,
        environment: env,
        home: homedir(),
        signal
    });
}

interface ReviewContextInput {
    options: LocalCliOptions;
    environment: LocalCliEnvironment;
    env: NodeJS.ProcessEnv;
    git: GitRunner;
    repositoryDir: string;
}

/* GitHub stays opt-in per remote and credential: non-GitHub remotes never call
   the API, and `auto` falls back to Git context with a log. */
async function resolveReviewContext(input: ReviewContextInput): Promise<ResolvedReviewContext> {
    const { options, environment, env, git } = input;
    const requiresGitHub = options.context === 'github' || options.output === 'github-pr';

    if (options.context === 'git' && !requiresGitHub) {
        return {};
    }

    const remotes = await resolveGitHubRemotes({ git, env, signal: environment.signal });

    if (remotes === undefined) {
        if (requiresGitHub) {
            throw new PrerequisiteError('GitHub context requires a GitHub origin or upstream remote.');
        }

        log.info('Skipping GitHub context: the origin and upstream remotes are not GitHub.');

        return {};
    }

    const { repository, headOwner } = remotes;
    const token = await resolveGitHubToken(env);

    if (token === undefined) {
        if (requiresGitHub) {
            throw new PrerequisiteError(
                'GitHub context requires a token: set GITHUB_TOKEN, GH_TOKEN, or run "gh auth login".'
            );
        }

        log.info('Skipping GitHub context: no GitHub token available.');

        return {};
    }

    const client = createGitHubClient({
        remote: repository,
        token,
        environment: env,
        dependencies: environment.githubClientDependencies
    });

    try {
        const branch = await readCurrentBranch(git, environment.signal);

        const number =
            options.prNumber ?? (await findOpenPullRequest(client, { headOwner, branch }, environment.signal));

        if (number === undefined) {
            /* Fork PRs without upstream are unreachable from the base repo, so the
               error and the fallback both point at --pr. */
            const branchDescription = branch === undefined ? 'the detached HEAD checkout' : `branch "${branch}"`;

            if (requiresGitHub) {
                throw new PrerequisiteError(
                    `No open pull request for ${branchDescription} in ${client.repository.owner}/${client.repository.repo}. Pass --pr <number> for a fork pull request without an upstream remote.`
                );
            }

            log.info(
                `Skipping GitHub context: no open pull request for ${branchDescription}; pass --pr <number> for a fork pull request without an upstream remote.`
            );

            return { github: client, token };
        }

        if (options.context === 'git') {
            return { github: client, token, pullRequestNumber: number };
        }

        const context = await fetchGitHubContext(client, number, environment.signal);

        return { github: client, token, pullRequestNumber: number, context };
    } catch (error) {
        if (requiresGitHub) {
            throw error;
        }

        log.warn('GitHub context unavailable; falling back to the Git context.', { error: describeError(error) });

        return { github: client, token };
    }
}

interface ResolvedGitHubRemotes {
    repository: GitHubRemote;
    headOwner: string;
}

/* PRs live in the base repo. In a fork clone upstream is the API repo when
   eligible. */
async function resolveGitHubRemotes(input: {
    git: GitRunner;
    env: NodeJS.ProcessEnv;
    signal?: AbortSignal;
}): Promise<ResolvedGitHubRemotes | undefined> {
    const [originUrl, upstreamUrl] = await Promise.all([
        readRemote(input.git, 'origin', input.signal),
        readRemote(input.git, 'upstream', input.signal)
    ]);

    const origin = originUrl === undefined ? undefined : parseRemote(originUrl);
    const upstream = upstreamUrl === undefined ? undefined : parseRemote(upstreamUrl);
    const repository = eligibleGitHubRemote(upstream, input.env) ?? eligibleGitHubRemote(origin, input.env);

    if (repository === undefined) {
        return undefined;
    }

    const headOwner = origin !== undefined && origin.owner !== repository.owner ? origin.owner : repository.owner;

    return { repository, headOwner };
}

function eligibleGitHubRemote(remote: GitHubRemote | undefined, env: NodeJS.ProcessEnv): GitHubRemote | undefined {
    if (remote === undefined || !isGitHubRemote(remote, env)) {
        return undefined;
    }

    return remote;
}

function buildPublishTarget(
    options: LocalCliOptions,
    context: ResolvedReviewContext
): { octokit: GitHubClient['octokit']; repository: GitHubClient['repository']; issueNumber: number } | undefined {
    if (options.output !== 'github-pr') {
        return undefined;
    }

    if (context.github === undefined || context.pullRequestNumber === undefined) {
        throw new PrerequisiteError('Publishing to a pull request requires GitHub context and a pull request number.');
    }

    return {
        octokit: context.github.octokit,
        repository: context.github.repository,
        issueNumber: context.pullRequestNumber
    };
}

async function emitReview(input: {
    options: LocalCliOptions;
    result: Parameters<typeof renderReviewResult>[0];
    pullRequestNumber: number | undefined;
    provenance: ReviewReportProvenance;
    stdout: NodeJS.WritableStream;
}): Promise<void> {
    const { options, result, pullRequestNumber, provenance, stdout } = input;
    const markdown = renderReviewResult(result, provenance);

    /* `--output-file` adds a file sink in either mode; `--output` picks stdout
       or the pull request. */
    if (options.outputFile !== undefined) {
        await writeOutputFile(options.outputFile, markdown);
        log.info(`Wrote ${PRODUCT_NAME} review output`, { path: options.outputFile });
    }

    if (options.output === 'terminal') {
        writeTerminal(stdout, markdown);
    }

    if (options.output === 'github-pr') {
        log.info('Published the review to the pull request.', { prNumber: pullRequestNumber ?? null });
    }
}
