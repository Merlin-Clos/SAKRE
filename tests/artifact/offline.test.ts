import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { nativeTargetFor, releaseArtifactName } from '../../src/native/platform';
import { createRepository, fileExists, optionalSystemBinary, systemBinary } from '../helpers/artifact-repository';

/* Linux-only offline proof: the compiled artifact runs a complete review with
   the fake provider inside `unshare -rn`, so no external network is reachable.
   macOS and Windows cannot be network-isolated; their artifact jobs rely on the
   loopback fake-provider review instead. */
setDefaultTimeout(180_000);

const target = nativeTargetFor(process.platform, process.arch);

let artifactPath = '';

if (target !== undefined) {
    artifactPath = path.resolve('dist-release', releaseArtifactName(target));
}

const artifactAvailable = artifactPath !== '' && (await fileExists(artifactPath));

const namespaceMechanism = await resolveNamespaceMechanism();

const loopbackTool = loopbackSetupTool();

const offlineProofReady = artifactAvailable && namespaceMechanism !== undefined && loopbackTool !== undefined;

function loopbackSetupTool(): string | undefined {
    if (process.platform !== 'linux') {
        return undefined;
    }

    return optionalSystemBinary('ip');
}

/* GitHub's ubuntu-24.04 image restricts unprivileged user namespaces through
   AppArmor, so `unshare -rn` can fail there. The runner grants passwordless
   sudo, and a plain root network namespace gives the same isolation. The proof
   prefers the unprivileged form and only escalates when it is unavailable.
   `sudo` resets the environment, so the escalated form carries the isolated
   environment through explicit `env` assignments instead of the spawn env. */
interface NamespaceMechanism {
    command: string;
    arguments: readonly string[];
    forwardsEnvironment: boolean;
}

async function resolveNamespaceMechanism(): Promise<NamespaceMechanism | undefined> {
    if (process.platform !== 'linux') {
        return undefined;
    }

    const unshare = optionalSystemBinary('unshare');

    if (unshare !== undefined && (await commandSucceeds([unshare, '-rn', 'true']))) {
        return { command: unshare, arguments: ['-rn'], forwardsEnvironment: false };
    }

    const sudo = optionalSystemBinary('sudo');

    if (sudo !== undefined && unshare !== undefined && (await commandSucceeds([sudo, '-n', unshare, '-n', 'true']))) {
        return { command: sudo, arguments: ['-n', unshare, '-n'], forwardsEnvironment: true };
    }

    return undefined;
}

function commandSucceeds(argv: readonly string[]): Promise<boolean> {
    return new Promise((resolve) => {
        const [command, ...args] = argv;

        if (command === undefined) {
            resolve(false);

            return;
        }

        const probe = spawn(command, args, { stdio: 'ignore' });
        probe.on('error', () => {
            resolve(false);
        });
        probe.on('close', (code) => {
            resolve(code === 0);
        });
    });
}

describe('compiled engine artifact offline proof', () => {
    test.skipIf(!artifactAvailable || process.platform !== 'linux' || process.env.CI !== 'true')(
        'the Linux offline proof requires a usable network namespace in CI',
        () => {
            expect(namespaceMechanism).toBeDefined();
            expect(loopbackTool).toBeDefined();
        }
    );

    test.skipIf(!offlineProofReady)(
        'completes a fake-provider review inside a network namespace with no external network',
        async () => {
            if (namespaceMechanism === undefined || loopbackTool === undefined) {
                throw new Error('The offline proof started without a usable network namespace.');
            }

            const root = await mkdtemp(path.join(tmpdir(), 'sakre-artifact-netless-'));

            try {
                const repository = await createRepository(root);
                const home = path.join(root, 'home');
                const bin = path.join(root, 'bin');
                await Promise.all([mkdir(home), mkdir(bin)]);
                await symlink(systemBinary('git'), path.join(bin, 'git'));
                await symlink(systemBinary('tar'), path.join(bin, 'tar'));
                /* The waiting loop runs with the isolated PATH. */
                await symlink(systemBinary('sleep'), path.join(bin, 'sleep'));
                const portFile = path.join(root, 'fake-provider-url');
                const providerScript = path.resolve('tests', 'fixtures', 'fake-provider.ts');

                /* The provider runs inside the same network namespace as the
               engine: the namespace has only loopback, so a hidden fetch
               cannot succeed and the review must come from the real engine. */
                const result = await runInNamespace({
                    namespace: namespaceMechanism,
                    shell: '/bin/sh',
                    args: [
                        process.execPath,
                        providerScript,
                        portFile,
                        loopbackTool,
                        artifactPath,
                        'local',
                        '--base',
                        repository.baseSha,
                        '--head',
                        repository.headSha,
                        '--repo',
                        repository.rootDir,
                        '--provider',
                        'anthropic',
                        '--model',
                        'claude-sonnet-4-5'
                    ],
                    env: {
                        HOME: home,
                        PATH: bin,
                        XDG_CACHE_HOME: path.join(root, 'cache'),
                        XDG_DATA_HOME: path.join(home, 'data'),
                        SAKRE_PROVIDER_API_KEY: 'sk-ant-artifact',
                        SAKRE_FAKE_PROVIDER_PORT_FILE: portFile,
                        GITHUB_TOKEN: '',
                        NO_PROXY: '127.0.0.1,localhost',
                        /* The proof can escalate to root inside a checkout owned
                           by the runner user; git refuses such a repository
                           unless its directory is trusted. The namespace is
                           throwaway, so trust is scoped to it. */
                        GIT_CONFIG_COUNT: '1',
                        GIT_CONFIG_KEY_0: 'safe.directory',
                        GIT_CONFIG_VALUE_0: '*'
                    },
                    cwd: repository.rootDir
                });

                expect(result.exitCode, offlineFailure(result)).toBe(0);
                expect(result.stdout).toContain('Reviewed commit:');
                expect(result.stderr).not.toContain('::error::');
            } finally {
                await removeTree(root);
            }
        }
    );
});

function offlineFailure(result: { exitCode: number | null; stdout: string; stderr: string }): string {
    return `The offline review exited with ${String(result.exitCode)}.\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`;
}

/* `sudo` resets the environment, so an escalated namespace receives the
   isolated environment through explicit `env` assignments instead of the
   spawn environment. */
function namespaceArguments(namespace: NamespaceMechanism, environment: Record<string, string>): string[] {
    if (!namespace.forwardsEnvironment) {
        return [...namespace.arguments];
    }

    const assignments = Object.entries(environment).map(([key, value]) => `${key}=${value}`);

    return [...namespace.arguments, 'env', ...assignments];
}

function namespaceEnvironment(
    namespace: NamespaceMechanism,
    environment: Record<string, string>
): Record<string, string> {
    if (namespace.forwardsEnvironment) {
        return {};
    }

    return environment;
}

/* Runs the fixture provider and the engine inside one network namespace.
   Positional arguments are: bun, provider script, port file, loopback tool,
   artifact, artifact arguments. */
function runInNamespace(input: {
    namespace: NamespaceMechanism;
    shell: string;
    args: string[];
    env: Record<string, string>;
    cwd: string;
}): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    const { command } = input.namespace;

    const script = [
        'set -u',
        '"$1" "$2" &',
        'provider_pid=$!',
        "trap 'kill $provider_pid 2>/dev/null || true' EXIT",
        'port_file="$3"',
        'if [ -n "$4" ]; then "$4" link set lo up 2>/dev/null || true; fi',
        'artifact="$5"',
        'shift 5',
        'i=0',
        'while [ ! -s "$port_file" ] && [ "$i" -lt 200 ]; do sleep 0.05; i=$((i+1)); done',
        'if [ ! -s "$port_file" ]; then echo "the fake provider did not start" >&2; exit 1; fi',
        'provider_url=""',
        'IFS= read -r provider_url < "$port_file" || true',
        'SAKRE_PROVIDER_BASE_URL="$provider_url" "$artifact" "$@"',
        'status=$?',
        'exit $status'
    ].join('\n');

    return new Promise((resolve, reject) => {
        const child = spawn(
            command,
            [...namespaceArguments(input.namespace, input.env), input.shell, '-c', script, 'sh', ...input.args],
            {
                cwd: input.cwd,
                env: namespaceEnvironment(input.namespace, input.env),
                stdio: ['ignore', 'pipe', 'pipe']
            }
        );

        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => {
            stdout += chunk.toString('utf8');
        });
        child.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString('utf8');
        });
        child.on('error', reject);
        child.on('close', (exitCode) => {
            resolve({ exitCode, stdout, stderr });
        });
    });
}

/* Root-owned files can remain when the proof escalated to sudo; fall back to
   the same escalation only for the cleanup. */
async function removeTree(root: string): Promise<void> {
    try {
        await rm(root, { recursive: true, force: true });
    } catch {
        await new Promise<void>((resolve) => {
            const cleanup = spawn('sudo', ['-n', 'rm', '-rf', root], { stdio: 'ignore' });
            cleanup.on('error', () => {
                resolve();
            });
            cleanup.on('close', () => {
                resolve();
            });
        });
    }
}
