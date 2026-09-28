import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { nativeTargetFor, releaseArtifactName } from '../../src/native/platform';

const target = nativeTargetFor(process.platform, process.arch);

let artifactPath = process.env.SAKRE_ENGINE_BINARY ?? '';

if (artifactPath === '' && target !== undefined) {
    artifactPath = path.resolve('dist-release', releaseArtifactName(target));
}

const artifactAvailable = artifactPath !== '' && (await fileExists(artifactPath));

setDefaultTimeout(120_000);

interface LocalRepository {
    rootDir: string;
    baseSha: string;
    headSha: string;
}

/* Compiled artifact coverage for the CLI-only budget flow; review and engine
   behavior live in tests/artifact/review.test.ts. */
describe.skipIf(!artifactAvailable || process.platform === 'win32')('local CLI standalone artifact', () => {
    test('aborts an over-budget diff and forces it explicitly', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'sakre-local-artifact-budget-'));

        try {
            const repository = await createOverBudgetRepository(root);
            const home = path.join(root, 'home');
            const bin = path.join(root, 'bin');
            await Promise.all([mkdir(home), mkdir(bin)]);
            await symlink(systemBinary('git'), path.join(bin, 'git'));
            await symlink(systemBinary('tar'), path.join(bin, 'tar'));
            const env = { HOME: home, PATH: bin, XDG_CACHE_HOME: path.join(root, 'cache') };

            const aborted = await runArtifact(
                [
                    'local',
                    '--mock',
                    '--base',
                    repository.baseSha,
                    '--head',
                    repository.headSha,
                    '--repo',
                    repository.rootDir
                ],
                env
            );

            expect(aborted.exitCode).toBe(1);
            expect(aborted.stdout).toBe('');
            expect(aborted.stderr).toContain('diff = ');
            expect(aborted.stderr).toContain('limit = 20000');
            expect(aborted.stderr).toContain('--force-over-budget');

            const forced = await runArtifact(
                [
                    'local',
                    '--mock',
                    '--force-over-budget',
                    '--base',
                    repository.baseSha,
                    '--head',
                    repository.headSha,
                    '--repo',
                    repository.rootDir
                ],
                env
            );

            expect(forced.exitCode).toBe(1);
            expect(forced.stdout).toContain('review incomplete');
            expect(forced.stdout).toContain('Diff coverage is incomplete');
            expect(forced.stdout).toContain('src/app.js');
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});

async function createOverBudgetRepository(root: string): Promise<LocalRepository> {
    const rootDir = path.join(root, 'repository');
    await mkdir(rootDir);
    run('git', ['init', '-q', '-b', 'main'], rootDir);
    run('git', ['config', 'user.email', 'fixture@example.com'], rootDir);
    run('git', ['config', 'user.name', 'Local CLI Fixture'], rootDir);
    await mkdir(path.join(rootDir, '.github'));
    await writeFile(path.join(rootDir, '.github', 'sakre.yml'), 'review:\n  diffBudgetChars: 20000\n');
    await mkdir(path.join(rootDir, 'src'));
    await writeFile(path.join(rootDir, 'src', 'app.js'), 'export const value = 1;\n');
    run('git', ['add', '-A'], rootDir);
    run('git', ['commit', '-qm', 'base'], rootDir);
    const baseSha = run('git', ['rev-parse', 'HEAD'], rootDir);
    const lines = Array.from({ length: 1700 }, (_unused, index) => `export const value${index} = ${index};`);
    await writeFile(path.join(rootDir, 'src', 'app.js'), `${lines.join('\n')}\n`);
    run('git', ['add', '-A'], rootDir);
    run('git', ['commit', '-qm', 'head'], rootDir);

    return { rootDir, baseSha, headSha: run('git', ['rev-parse', 'HEAD'], rootDir) };
}

function systemBinary(name: string): string {
    const result = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
    const binary = result.stdout.trim();

    if (result.status !== 0 || binary === '') {
        throw new Error(`The artifact test requires ${name} on PATH.`);
    }

    return binary;
}

function runArtifact(
    args: string[],
    env: Record<string, string>
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        const child = spawn(artifactPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
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

function run(command: string, arguments_: string[], cwd: string): string {
    const result = spawnSync(command, arguments_, { cwd, encoding: 'utf8' });

    if (result.status !== 0) {
        throw new Error(`${command} failed: ${result.stderr}`);
    }

    return result.stdout.trim();
}

async function fileExists(filePath: string): Promise<boolean> {
    try {
        await access(filePath);

        return true;
    } catch {
        return false;
    }
}
