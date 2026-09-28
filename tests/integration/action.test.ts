import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { nativeTargetFor, releaseArtifactName } from '../../src/native/platform';
import { parseResolverPhases } from '../helpers/action-resolver';

const REPOSITORY_ROOT = path.resolve(import.meta.dir, '..', '..');

const target = nativeTargetFor(process.platform, process.arch);

let artifactPath = process.env.SAKRE_ENGINE_BINARY ?? '';

if (artifactPath === '' && target !== undefined) {
    artifactPath = path.resolve('dist-release', releaseArtifactName(target));
}

const artifactAvailable = artifactPath !== '' && (await fileExists(artifactPath));

/* The delivery path a workflow actually uses: the composite Action runs the
   bash or pwsh resolver from its own tree, which resolves the pin, verifies the
   binary and executes it. */
// eslint-disable-next-line anti-slop/no-known-value-widening -- platform lookup table; misses fall back with ??
const RUNNER_OS_BY_PLATFORM: Record<string, string> = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' };

// eslint-disable-next-line anti-slop/no-known-value-widening -- platform lookup table; misses fall back with ??
const RUNNER_ARCH_BY_PROCESS: Record<string, string> = { arm64: 'ARM64', x64: 'X64' };

const RUNNER_OS = RUNNER_OS_BY_PLATFORM[process.platform] ?? 'Linux';

const RUNNER_ARCH = RUNNER_ARCH_BY_PROCESS[process.arch] ?? 'X64';

let compositeDelivery = {
    command: 'bash',
    arguments: [path.join(REPOSITORY_ROOT, 'action', 'resolve-engine.sh')]
};

if (process.platform === 'win32') {
    compositeDelivery = {
        command: 'pwsh',
        arguments: ['-NoProfile', '-File', path.join(REPOSITORY_ROOT, 'action', 'resolve-engine.ps1')]
    };
}

/* Each test starts a fixture server and a standalone engine process, so the
   5,000 ms per-test default leaves too little margin on a slow runner. */
setDefaultTimeout(120_000);

interface GitHubFixture {
    baseSha: string;
    headSha: string;
    progressBodies: string[];
    finalBodies: string[];
    largePatch?: boolean;
}

describe.skipIf(!artifactAvailable)('standalone Action engine', () => {
    test('runs a mock review end-to-end without provider traffic or source checkouts', async () => {
        const harness = await startFixture({ mockMode: true });

        try {
            const result = await harness.run();

            if (result.exitCode !== 0) {
                process.stderr.write(`Action engine failed: ${JSON.stringify(result)}\n`);
            }

            expect(result.exitCode).toBe(0);
            expect(result.stderr).not.toContain('::error::');
            expect(harness.fixture.progressBodies).toHaveLength(1);
            expect(harness.fixture.progressBodies[0]).toContain('review in progress');
            expect(harness.fixture.finalBodies).toHaveLength(1);
            expect(harness.fixture.finalBodies[0]).toContain('"status":"complete"');
            expect(harness.fixture.finalBodies[0]).toContain('"verdict":"clean"');
        } finally {
            await harness.close();
        }
    });

    test('aborts an over-budget diff with a published explanation and a failed step', async () => {
        const harness = await startFixture({ mockMode: true, largePatch: true });

        try {
            const result = await harness.run();

            expect(result.exitCode).toBe(1);
            expect(result.stdout).toContain('::error::');
            expect(harness.fixture.progressBodies).toHaveLength(1);
            expect(harness.fixture.progressBodies[0]).toContain('review aborted, diff over budget');
            expect(harness.fixture.progressBodies[0]).toContain('force_over_budget');
            expect(harness.fixture.finalBodies).toHaveLength(0);
            /* The abort happens before runtime assembly, so no engine database
               or native materialization was paid for. */
            expect(await fileExists(path.join(harness.runnerTemp, 'sakre'))).toBe(false);
        } finally {
            await harness.close();
        }
    });

    test('reviews an over-budget diff through the force_over_budget input and stays incomplete', async () => {
        const harness = await startFixture({ mockMode: true, largePatch: true, forceOverBudget: true });

        try {
            const result = await harness.run();

            expect(result.exitCode).toBe(1);
            expect(harness.fixture.finalBodies).toHaveLength(1);
            expect(harness.fixture.finalBodies[0]).toContain('"status":"incomplete"');
            expect(harness.fixture.finalBodies[0]).toContain('Diff coverage is incomplete');
        } finally {
            await harness.close();
        }
    });

    test('skips a head that was already reviewed without forcing', async () => {
        const harness = await startFixture({ mockMode: true, alreadyReviewed: true, force: false });

        try {
            const result = await harness.run();

            expect(result.exitCode).toBe(0);
            expect(harness.fixture.progressBodies).toHaveLength(0);
            expect(harness.fixture.finalBodies).toHaveLength(0);
            expect(`${result.stdout}${result.stderr}`).toContain('already complete');
        } finally {
            await harness.close();
        }
    });

    test('skips a comment whose author association is not allowed without calling the API', async () => {
        const harness = await startFixture({ mockMode: true, authorAssociation: 'NONE' });

        try {
            const result = await harness.run();

            expect(result.exitCode).toBe(0);
            expect(result.stdout).toContain('author association is not allowed');
            expect(harness.fixture.progressBodies).toHaveLength(0);
        } finally {
            await harness.close();
        }
    });

    test('answers an invalid command with usage help', async () => {
        const harness = await startFixture({ mockMode: true, commentBody: '@sakre unknown' });

        try {
            const result = await harness.run();

            expect(result.exitCode).toBe(0);
            expect(harness.fixture.finalBodies).toHaveLength(0);
            expect(harness.fixture.progressBodies).toHaveLength(1);
            expect(harness.fixture.progressBodies[0]).toContain('Invalid command');
        } finally {
            await harness.close();
        }
    });

    test('accepts trigger comment guidance as untrusted review intent', async () => {
        const guidanceText = 'TRIGGER GUIDANCE MARKER: focus on the migration path.';
        const harness = await startFixture({ mockMode: true, commentBody: `@sakre\n${guidanceText}` });

        try {
            const result = await harness.run();

            expect(result.exitCode).toBe(0);
            expect(harness.fixture.finalBodies).toHaveLength(1);
            expect(harness.fixture.finalBodies[0]).toContain('"status":"complete"');
            expect(harness.fixture.finalBodies[0]).toContain('"guidance":"trigger-comment"');
            expect(harness.fixture.finalBodies[0]).toContain('User guidance: provided (trigger comment)');
            expect(harness.fixture.finalBodies[0]).toContain('Execution: GitHub Action');
            expect(harness.fixture.finalBodies[0]).toContain('<summary>User guidance used</summary>');
            expect(harness.fixture.finalBodies[0]).toContain(guidanceText);
        } finally {
            await harness.close();
        }
    });

    test('does not reparse flag-like guidance text after the command line', async () => {
        /* A forced review would ignore the already-complete review; the
           `--force` on the second line must stay plain guidance text. */
        const harness = await startFixture({
            mockMode: true,
            alreadyReviewed: true,
            force: false,
            commentBody: '@sakre\n--force'
        });

        try {
            const result = await harness.run();

            expect(result.exitCode).toBe(0);
            expect(harness.fixture.progressBodies).toHaveLength(0);
            expect(harness.fixture.finalBodies).toHaveLength(0);
            expect(`${result.stdout}${result.stderr}`).toContain('already complete');
        } finally {
            await harness.close();
        }
    });

    test('ignores over-cap trigger guidance with a warning and continues the review', async () => {
        const harness = await startFixture({
            mockMode: true,
            commentBody: `@sakre\n${'x'.repeat(8001)}`
        });

        try {
            const result = await harness.run();

            expect(result.exitCode).toBe(0);
            expect(`${result.stdout}${result.stderr}`).toContain('Ignoring review guidance');
            expect(harness.fixture.finalBodies).toHaveLength(1);
            expect(harness.fixture.finalBodies[0]).toContain('"status":"complete"');
            expect(harness.fixture.finalBodies[0]).toContain('"guidance":"none"');
        } finally {
            await harness.close();
        }
    });
});

describe.skipIf(!artifactAvailable)('composite Action delivery', () => {
    test('executes the injected engine binary and posts the review', async () => {
        const summaryRoot = await mkdtemp(path.join(tmpdir(), 'sakre-action-summary-'));
        const summaryPath = path.join(summaryRoot, 'summary.md');

        const harness = await startFixture({
            mockMode: true,
            command: compositeDelivery.command,
            argumentsPrefix: compositeDelivery.arguments,
            extraEnv: {
                GITHUB_ACTION_PATH: REPOSITORY_ROOT,
                GITHUB_STEP_SUMMARY: summaryPath,
                SAKRE_ENGINE_BINARY: artifactPath,
                RUNNER_ARCH,
                RUNNER_OS
            }
        });

        try {
            const result = await harness.run();

            if (result.exitCode !== 0) {
                process.stderr.write(`Composite Action delivery failed: ${JSON.stringify(result)}\n`);
            }

            expect(result.exitCode).toBe(0);
            const phases = parseResolverPhases(result.stderr);
            expect(phases.source).toBe('override');
            /* The override path skips the delivery phases, but the engine run
               itself must still be timed or the instrumentation is broken. */
            expect(phases.execute_ms).toBeGreaterThan(0);
            expect(phases.total_ms).toBeGreaterThanOrEqual(phases.execute_ms);
            expect(harness.fixture.finalBodies).toHaveLength(1);
            expect(harness.fixture.finalBodies[0]).toContain('"status":"complete"');
            const summary = await Bun.file(summaryPath).text();
            expect(summary).toContain('| bootstrap before spawn, excluding download |');
            expect(summary).toContain('source: `override`');
        } finally {
            await harness.close();
            await rm(summaryRoot, { recursive: true, force: true });
        }
    });

    test('fails the step with an actionable error when no engine is pinned or preinstalled', async () => {
        const unpinnedRoot = await mkdtemp(path.join(tmpdir(), 'sakre-action-unpinned-'));
        /* The failed resolver writes its delivery summary too. It must land in
           this test's file instead of the workflow step summary, and its zero
           phases are legitimate: the delivery aborts before any phase runs. */
        const summaryRoot = await mkdtemp(path.join(tmpdir(), 'sakre-action-summary-'));
        const summaryPath = path.join(summaryRoot, 'summary.md');
        await writeFile(path.join(unpinnedRoot, 'engine-pins.json'), '{\n    "tag": null,\n    "assets": {}\n}\n');

        const harness = await startFixture({
            mockMode: true,
            command: compositeDelivery.command,
            argumentsPrefix: compositeDelivery.arguments,
            extraEnv: {
                GITHUB_ACTION_PATH: unpinnedRoot,
                GITHUB_STEP_SUMMARY: summaryPath,
                SAKRE_ENGINE_BINARY: '',
                RUNNER_ARCH,
                RUNNER_OS
            }
        });

        try {
            const result = await harness.run();
            expect(result.exitCode).not.toBe(0);
            expect(result.stderr).toContain('does not pin an engine release yet');
            const phases = parseResolverPhases(result.stderr);
            expect(phases.source).toBe('download');
            expect(phases.execute_ms).toBe(0);
            const summary = await Bun.file(summaryPath).text();
            expect(summary).toContain('source: `download`');
        } finally {
            await harness.close();
            await rm(unpinnedRoot, { recursive: true, force: true });
            await rm(summaryRoot, { recursive: true, force: true });
        }
    });
});

interface FixtureOptions {
    mockMode?: boolean;
    largePatch?: boolean;
    forceOverBudget?: boolean;
    alreadyReviewed?: boolean;
    force?: boolean;
    authorAssociation?: string;
    commentBody?: string;
    command?: string;
    argumentsPrefix?: string[];
    extraEnv?: Record<string, string>;
}

interface FixtureHarness {
    fixture: GitHubFixture;
    runnerTemp: string;
    run: () => Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
    close: () => Promise<void>;
}

async function startFixture(options: FixtureOptions): Promise<FixtureHarness> {
    const root = await mkdtemp(path.join(tmpdir(), 'sakre-action-engine-'));
    const workspace = path.join(root, 'workspace');
    const runnerTemp = path.join(root, 'runner-temp');
    await Promise.all([mkdir(workspace), mkdir(runnerTemp)]);
    const revisions = await createRepository(workspace);

    const fixture: GitHubFixture = {
        baseSha: revisions.baseSha,
        headSha: revisions.headSha,
        progressBodies: [],
        finalBodies: [],
        largePatch: options.largePatch ?? false
    };

    const server = createServer((request, response) => {
        handleGitHub({ request, response, fixture, alreadyReviewed: options.alreadyReviewed === true }).catch(
            // eslint-disable-next-line anti-slop/no-unknown-parameters -- fixture-server error path stringifies the failure
            (error: unknown) => {
                sendJson(response, 500, { message: String(error) });
            }
        );
    });

    const apiUrl = await listen(server);
    let commentBody = options.commentBody ?? '@sakre --force';

    if (options.commentBody === undefined && options.force === false) {
        commentBody = '@sakre';
    }

    const eventPath = await writeEvent(root, commentBody, options.authorAssociation ?? 'OWNER');

    return {
        fixture,
        runnerTemp,
        run: () =>
            runAction({
                workspace,
                runnerTemp,
                eventPath,
                apiUrl,
                command: options.command ?? artifactPath,
                argumentsPrefix: options.argumentsPrefix ?? [],
                extraEnv: options.extraEnv ?? {},
                mockMode: options.mockMode ?? true,
                forceOverBudget: options.forceOverBudget ?? false
            }),
        close: async () => {
            await closeServer(server);
            await rm(root, { recursive: true, force: true });
        }
    };
}

async function runAction(input: {
    workspace: string;
    runnerTemp: string;
    eventPath: string;
    apiUrl: string;
    command: string;
    argumentsPrefix: string[];
    extraEnv: Record<string, string>;
    mockMode: boolean;
    forceOverBudget: boolean;
}): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    const child = spawn(input.command, [...input.argumentsPrefix], {
        cwd: input.workspace,
        env: {
            ...process.env,
            ...input.extraEnv,
            HOME: input.runnerTemp,
            GITHUB_WORKSPACE: input.workspace,
            GITHUB_EVENT_NAME: 'issue_comment',
            GITHUB_EVENT_PATH: input.eventPath,
            GITHUB_REPOSITORY: 'acme/demo',
            GITHUB_API_URL: input.apiUrl,
            GITHUB_SERVER_URL: input.apiUrl,
            GITHUB_GRAPHQL_URL: `${input.apiUrl}/graphql`,
            GITHUB_RUN_ID: '123',
            RUNNER_TEMP: input.runnerTemp,
            INPUT_GITHUB_TOKEN: 'fake-token',
            INPUT_PROVIDER: 'anthropic',
            INPUT_PROVIDER_API_KEY: 'fake-provider-key',
            INPUT_DEFAULT_MODEL: 'fake-model',
            INPUT_AGENT_NAME: 'sakre',
            INPUT_ALLOWED_AUTHOR_ASSOCIATIONS: 'OWNER',
            INPUT_CONFIG_PATH: '.github/sakre.yml',
            INPUT_MOCK_MODE: booleanInput(input.mockMode),
            INPUT_FORCE_OVER_BUDGET: booleanInput(input.forceOverBudget),
            NO_PROXY: '127.0.0.1,localhost'
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
    });

    const exitCode = await new Promise<number | null>((resolve, reject) => {
        child.on('error', reject);
        child.on('close', resolve);
    });

    return { exitCode, stdout, stderr };
}

async function createRepository(workspace: string): Promise<{ baseSha: string; headSha: string }> {
    run('git', ['init', '-q', '-b', 'main'], workspace);
    await mkdir(path.join(workspace, 'src'));
    const lines = Array.from({ length: 20 }, (_unused, index) => `export const value${index} = ${index};`).join('\n');
    await Promise.all(
        Array.from({ length: 10 }, (_unused, fileIndex) =>
            writeFile(path.join(workspace, 'src', `file-${fileIndex}.js`), `${lines}\n`)
        )
    );
    run('git', ['add', '.'], workspace);
    run('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base'], workspace);
    const baseSha = run('git', ['rev-parse', 'HEAD'], workspace);
    await writeFile(path.join(workspace, 'src', 'file-0.js'), `${lines}\nexport const changed = true;\n`);
    run('git', ['add', '.'], workspace);
    run('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'head'], workspace);

    return { baseSha, headSha: run('git', ['rev-parse', 'HEAD'], workspace) };
}

interface GitHubHandlerInput {
    request: IncomingMessage;
    response: ServerResponse;
    fixture: GitHubFixture;
    alreadyReviewed: boolean;
}

async function handleGitHub(input: GitHubHandlerInput): Promise<void> {
    const { request, response, fixture } = input;
    const url = new URL(request.url ?? '/', 'http://localhost');

    if (request.headers.authorization !== 'token fake-token') {
        sendJson(response, 401, { message: 'Bad credentials' });

        return;
    }

    if (request.method === 'GET' && url.pathname === '/repos/acme/demo/pulls/1') {
        sendJson(response, 200, pullResponse(fixture));

        return;
    }

    if (request.method === 'GET' && url.pathname === '/repos/acme/demo/pulls/1/files') {
        sendJson(response, 200, changedFilesResponse(fixture.largePatch === true));

        return;
    }

    if (request.method === 'GET' && url.pathname === '/repos/acme/demo/issues/1/comments') {
        let comments: Record<string, unknown>[] = [];

        if (input.alreadyReviewed) {
            comments = [metadataComment(fixture.headSha)];
        }

        sendJson(response, 200, comments);

        return;
    }

    if (request.method === 'GET' && url.pathname.includes('/contents/')) {
        sendJson(response, 404, { message: 'Not Found' });

        return;
    }

    if (request.method === 'POST' && url.pathname === '/repos/acme/demo/issues/1/comments') {
        fixture.progressBodies.push(await readJsonBody(request, 'body'));
        sendJson(response, 201, { id: 101 });

        return;
    }

    if (request.method === 'PATCH' && url.pathname === '/repos/acme/demo/issues/comments/101') {
        fixture.finalBodies.push(await readJsonBody(request, 'body'));
        sendJson(response, 200, { id: 101 });

        return;
    }

    sendJson(response, 500, { message: `Unexpected route: ${request.method} ${url.pathname}` });
}

function pullResponse(fixture: GitHubFixture): Record<string, unknown> {
    // eslint-disable-next-line anti-slop/no-known-value-widening -- pull-response fixture keeps the API payload shape open
    return {
        number: 1,
        title: 'Fix return value',
        body: 'Integration fixture',
        user: { login: 'alice' },
        base: { ref: 'main', sha: fixture.baseSha },
        head: { ref: 'feature', sha: fixture.headSha }
    };
}

function changedFilesResponse(largePatch = false): Record<string, unknown>[] {
    if (largePatch) {
        const lines = Array.from({ length: 3000 }, (_unused, index) => `+export const generated${index} = ${index};`);

        return [
            {
                filename: 'src/file-0.js',
                status: 'modified',
                additions: 3000,
                deletions: 0,
                patch: `@@ -1,1 +1,3000 @@\n${lines.join('\n')}`
            }
        ];
    }

    return [
        {
            filename: 'src/file-0.js',
            status: 'modified',
            additions: 1,
            deletions: 0,
            patch: '@@ -20,0 +21 @@\n+export const changed = true;'
        }
    ];
}

function metadataComment(headSha: string): Record<string, unknown> {
    const metadata = `{"headSha":"${headSha}","status":"complete"}`;

    // eslint-disable-next-line anti-slop/no-known-value-widening -- metadata-comment fixture keeps the API payload shape open
    return {
        id: 99,
        body: `<!-- sakre-review -->\n<!-- sakre-metadata ${metadata} -->`,
        created_at: '2026-09-01T00:00:00Z',
        user: { type: 'Bot', login: 'github-actions[bot]' }
    };
}

async function readJsonBody(request: IncomingMessage, field: string): Promise<string> {
    const chunks: Buffer[] = [];

    for await (const chunk of request) {
        // SAFETY: the Node request iterator yields Uint8Array chunks; Buffer.from copies them for JSON parsing.
        chunks.push(Buffer.from(chunk as Uint8Array));
    }

    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));

    if (isRecord(value) && field in value) {
        const fieldValue = value[field];

        // eslint-disable-next-line anti-slop/no-runtime-typeof -- narrows the parsed body field before returning it
        if (typeof fieldValue === 'string') {
            return fieldValue;
        }
    }

    throw new Error(`Request body does not contain string field ${field}.`);
}

// eslint-disable-next-line anti-slop/no-unknown-parameters -- JSON serialization accepts any fixture payload
function sendJson(response: ServerResponse, status: number, value: unknown): void {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value));
}

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
    await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();

    // eslint-disable-next-line anti-slop/no-runtime-typeof -- guards the fixture-server address before reading the TCP port
    if (address === null || typeof address === 'string') {
        throw new Error('GitHub fixture server did not expose a TCP port.');
    }

    return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
    if (!server.listening) {
        return;
    }

    await new Promise<void>((resolve, reject) => {
        server.close((error) => {
            if (error) {
                reject(error);
            } else {
                resolve();
            }
        });
    });
}

async function writeEvent(root: string, commentBody: string, authorAssociation: string): Promise<string> {
    const eventPath = path.join(root, 'event.json');
    await writeFile(
        eventPath,
        JSON.stringify({
            action: 'created',
            issue: { number: 1, pull_request: {} },
            comment: { id: 50, body: commentBody, author_association: authorAssociation },
            repository: { name: 'demo', owner: { login: 'acme' } }
        })
    );

    return eventPath;
}

function booleanInput(value: boolean): string {
    if (value) {
        return 'true';
    }

    return 'false';
}

function run(command: string, arguments_: string[], cwd: string): string {
    const result = Bun.spawnSync({ cmd: [command, ...arguments_], cwd, stdout: 'pipe', stderr: 'pipe' });

    if (result.exitCode !== 0) {
        throw new Error(`${command} failed: ${result.stderr.toString()}`);
    }

    return result.stdout.toString().trim();
}

async function fileExists(filePath: string): Promise<boolean> {
    try {
        await stat(filePath);

        return true;
    } catch {
        return false;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    // eslint-disable-next-line anti-slop/no-runtime-typeof -- type-guard narrowing of untrusted input; the predicate is the boundary
    return typeof value === 'object' && value !== null;
}
