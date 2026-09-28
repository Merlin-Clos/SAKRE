import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createEmbeddedEngineRuntime, type EmbeddedEngineRuntime } from '../../src/engine/runtime';
import { resolveSafeCheckoutDirectory, UnsafeCheckoutError } from '../../src/engine/checkout';
import { materializeEnginePlugin } from '../../src/engine/plugin-source';
import { createTrustedWorkspace, type TrustedWorkspace } from '../../src/workspace/trusted';
import { startFakeAnthropic } from '../helpers/fake-anthropic';
import { rejectionOf } from '../helpers/rejection';

setDefaultTimeout(60_000);

const HOSTILE_DIR = path.join(import.meta.dir, 'fixtures', 'hostile');

const ALLOWED_TOOLS = ['glob', 'grep', 'read', 'submit_coordination', 'submit_findings', 'submit_verdict'];

const FINDINGS = { summary: 'No findings.', findings: [], usedContext7: false, context7Topics: [] };

const runtimes: EmbeddedEngineRuntime[] = [];

const workspaces: TrustedWorkspace[] = [];

const cleanup: string[] = [];

afterEach(async () => {
    for (const runtime of runtimes.splice(0)) {
        await runtime.close();
    }

    for (const workspace of workspaces.splice(0)) {
        await workspace.close();
    }

    await Promise.all(cleanup.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function startEngine(checkoutDir: string): Promise<{
    runtime: EmbeddedEngineRuntime;
    provider: ReturnType<typeof startFakeAnthropic>;
}> {
    const root = await mkdtemp(path.join(tmpdir(), 'sakre-hostile-engine-'));
    cleanup.push(root);
    const provider = startFakeAnthropic([{ type: 'tool', name: 'submit_findings', input: FINDINGS }]);

    const runtime = await createEmbeddedEngineRuntime({
        providerID: 'anthropic',
        providerFamily: 'anthropic',
        modelIds: ['claude-opus-5'],
        apiKey: 'sk-ant-hostile',
        baseURL: provider.baseURL,
        checkoutDir,
        pluginDir: await materializeEnginePlugin(path.join(root, 'plugin-cache')),
        databasePath: path.join(root, 'engine.db')
    });

    runtimes.push(runtime);

    return { runtime, provider };
}

function agentCall(): Parameters<EmbeddedEngineRuntime['runStructured']>[0] {
    return {
        agentId: 'correctness',
        model: { providerID: 'anthropic', modelID: 'claude-opus-5' },
        systemPrompt: 'ROLE SYSTEM PROMPT',
        userPrompt: 'Review.',
        retryPrompt: 'Review.'
    };
}

describe('hostile workspace isolation', () => {
    test('rejects an escaping hostile symlink before any engine session or database exists', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'sakre-hostile-symlink-'));
        cleanup.push(root);
        const checkoutDir = path.join(root, 'checkout');
        const outsideDir = path.join(root, 'outside');
        await Promise.all([mkdir(checkoutDir), mkdir(outsideDir)]);
        await symlink(outsideDir, path.join(checkoutDir, 'escape'), 'dir');

        const provider = startFakeAnthropic([]);

        try {
            const failure = await rejectionOf(
                createEmbeddedEngineRuntime({
                    providerID: 'anthropic',
                    providerFamily: 'anthropic',
                    modelIds: ['claude-opus-5'],
                    apiKey: 'sk-ant-hostile',
                    baseURL: provider.baseURL,
                    checkoutDir,
                    pluginDir: path.join(root, 'plugin'),
                    databasePath: path.join(root, 'engine.db')
                })
            );

            expect(failure).toBeInstanceOf(UnsafeCheckoutError);
            expect(failure.message).toContain('symlink outside the checkout');
            expect(await Bun.file(path.join(root, 'engine.db')).exists()).toBe(false);
        } finally {
            await provider.stop();
        }
    });

    test('exposes only the read and submit tools and never loads checkout plugins', async () => {
        const harness = await startEngine(HOSTILE_DIR);

        try {
            await harness.runtime.runStructured(agentCall());

            const [request] = harness.provider.requests;

            if (request === undefined) {
                throw new Error('The provider received no request.');
            }

            expect(request.tools.toSorted()).toEqual(ALLOWED_TOOLS);
            expect(request.system).toContain('ROLE SYSTEM PROMPT');
        } finally {
            await harness.provider.stop();
        }
    });

    test('a trusted BASE overlay keeps HEAD agent instructions out of the engine prompt', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'sakre-hostile-overlay-'));
        cleanup.push(root);
        const repositoryDir = path.join(root, 'repository');
        await mkdir(repositoryDir);
        git(repositoryDir, ['init', '-q', '-b', 'main']);
        git(repositoryDir, ['config', 'user.email', 'hostile@example.com']);
        git(repositoryDir, ['config', 'user.name', 'Hostile Fixture']);
        await writeFile(path.join(repositoryDir, 'app.js'), 'export const value = 1;\n', 'utf8');
        git(repositoryDir, ['add', '-A']);
        git(repositoryDir, ['commit', '-qm', 'base']);
        const baseSha = rev(repositoryDir, 'HEAD');
        await writeFile(path.join(repositoryDir, 'AGENTS.md'), 'HEAD AGENTS INSTRUCTIONS MUST NOT LEAK\n', 'utf8');
        await mkdir(path.join(repositoryDir, 'nested'), { recursive: true });
        await writeFile(
            path.join(repositoryDir, 'nested', 'AGENTS.md'),
            'NESTED HEAD INSTRUCTIONS MUST NOT LEAK\n',
            'utf8'
        );
        git(repositoryDir, ['add', '-A']);
        git(repositoryDir, ['commit', '-qm', 'head']);
        const headSha = rev(repositoryDir, 'HEAD');

        const workspace = await createTrustedWorkspace({ repositoryDir, baseSha, headSha });
        workspaces.push(workspace);
        const harness = await startEngine(workspace.directory);

        try {
            await harness.runtime.runStructured(agentCall());

            for (const request of harness.provider.requests) {
                expect(request.system).not.toContain('HEAD AGENTS INSTRUCTIONS MUST NOT LEAK');
                expect(request.system).not.toContain('NESTED HEAD INSTRUCTIONS MUST NOT LEAK');
            }
        } finally {
            await harness.provider.stop();
        }
    });

    test('ignores a hostile user-level home, config and credential store', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'sakre-hostile-home-'));
        cleanup.push(root);
        const home = path.join(root, 'home');
        const configHome = path.join(home, 'config');
        const dataHome = path.join(home, 'data');
        await mkdir(path.join(configHome, 'opencode'), { recursive: true });
        await mkdir(path.join(dataHome, 'opencode'), { recursive: true });
        await writeFile(path.join(home, 'AGENTS.md'), 'USER LEVEL AGENTS INSTRUCTIONS MUST NOT LEAK\n', 'utf8');
        await writeFile(
            path.join(configHome, 'opencode', 'opencode.json'),
            JSON.stringify({ instructions: ['AGENTS.md'], plugin: ['./evil.js'] }),
            'utf8'
        );
        await writeFile(
            path.join(dataHome, 'opencode', 'auth.json'),
            JSON.stringify({ anthropic: { type: 'api', key: 'sk-ant-hostile-store' } }),
            'utf8'
        );

        const originalEnvironment = {
            HOME: process.env.HOME,
            XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
            XDG_DATA_HOME: process.env.XDG_DATA_HOME
        };

        process.env.HOME = home;
        process.env.XDG_CONFIG_HOME = configHome;
        process.env.XDG_DATA_HOME = dataHome;

        try {
            const harness = await startEngine(HOSTILE_DIR);

            try {
                await harness.runtime.runStructured(agentCall());

                const [request] = harness.provider.requests;

                if (request === undefined) {
                    throw new Error('The provider received no request.');
                }

                /* The explicit key is used; the hostile store entry, user
                   AGENTS.md and user opencode.json never reach the engine. */
                expect(request.authHeaders['x-api-key']).toBe('sk-ant-hostile');
                expect(request.system).not.toContain('USER LEVEL AGENTS INSTRUCTIONS MUST NOT LEAK');
                expect(request.tools.toSorted()).toEqual(ALLOWED_TOOLS);
            } finally {
                await harness.provider.stop();
            }
        } finally {
            restoreEnvironment(originalEnvironment);
        }
    });
});

describe('checkout path validation', () => {
    test('accepts a clean checkout and a symlink pointing inside', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'sakre-hostile-inside-'));
        cleanup.push(root);
        const checkoutDir = path.join(root, 'checkout');
        const innerDir = path.join(checkoutDir, 'inner');
        await mkdir(innerDir, { recursive: true });
        await writeFile(path.join(innerDir, 'file.ts'), 'export const value = 1;\n');
        await symlink(innerDir, path.join(checkoutDir, 'link-inside'), 'dir');

        expect(await resolveSafeCheckoutDirectory(checkoutDir)).toBe(await realpath(checkoutDir));
    });

    test('rejects a nested escaping symlink', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'sakre-hostile-nested-'));
        cleanup.push(root);
        const checkoutDir = path.join(root, 'checkout');
        const outsideDir = path.join(root, 'outside');
        await Promise.all([mkdir(path.join(checkoutDir, 'sub'), { recursive: true }), mkdir(outsideDir)]);
        await symlink(outsideDir, path.join(checkoutDir, 'sub', 'escape'), 'dir');

        const failure = await rejectionOf(resolveSafeCheckoutDirectory(checkoutDir));
        expect(failure).toBeInstanceOf(UnsafeCheckoutError);
        expect(failure.message).toContain('symlink outside the checkout');
    });

    test('rejects an absolute-target symlink pointing outside', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'sakre-hostile-absolute-'));
        cleanup.push(root);
        const checkoutDir = path.join(root, 'checkout');
        const outsideDir = path.join(root, 'outside');
        await Promise.all([mkdir(checkoutDir), mkdir(outsideDir)]);
        await symlink(outsideDir, path.join(checkoutDir, 'absolute-escape'), 'dir');

        const failure = await rejectionOf(resolveSafeCheckoutDirectory(checkoutDir));
        expect(failure).toBeInstanceOf(UnsafeCheckoutError);
    });

    test('rejects a symlink to the checkout parent directory', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'sakre-hostile-parent-'));
        cleanup.push(root);
        const checkoutDir = path.join(root, 'checkout');
        await mkdir(checkoutDir);
        await symlink(root, path.join(checkoutDir, 'parent-escape'), 'dir');

        const failure = await rejectionOf(resolveSafeCheckoutDirectory(checkoutDir));
        expect(failure).toBeInstanceOf(UnsafeCheckoutError);
        expect(failure.message).toContain('symlink outside the checkout');
    });

    test('wraps a missing checkout directory as unavailable', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'sakre-hostile-missing-'));
        cleanup.push(root);

        const failure = await rejectionOf(resolveSafeCheckoutDirectory(path.join(root, 'no-such-dir')));
        expect(failure).toBeInstanceOf(UnsafeCheckoutError);
        expect(failure.message).toContain('unavailable');
    });
});

function restoreEnvironment(original: Record<string, string | undefined>): void {
    for (const [name, value] of Object.entries(original)) {
        if (value === undefined) {
            Reflect.deleteProperty(process.env, name);
        } else {
            process.env[name] = value;
        }
    }
}

function git(repositoryDir: string, args: string[]): void {
    const result = Bun.spawnSync({ cmd: ['git', ...args], cwd: repositoryDir, stdout: 'pipe', stderr: 'pipe' });

    if (result.exitCode !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`);
    }
}

function rev(repositoryDir: string, ref: string): string {
    const result = Bun.spawnSync({
        cmd: ['git', 'rev-parse', ref],
        cwd: repositoryDir,
        stdout: 'pipe',
        stderr: 'pipe'
    });

    return result.stdout.toString().trim();
}
