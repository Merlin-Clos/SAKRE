import { describe, expect, test } from 'bun:test';
import { Writable } from 'node:stream';
import { parseAuthCliArgs } from '../../src/cli/auth-program';
import { CliExitError, type CliStreams, parseLocalCliArgs } from '../../src/cli/program';
import { DEFAULT_CONFIG_PATH } from '../../src/identity';

interface CapturedStream {
    stream: NodeJS.WritableStream;
    read: () => string;
}

interface CliExit {
    exitCode: number;
    stdout: string;
    stderr: string;
}

describe('local CLI arguments', () => {
    test('applies the documented defaults', () => {
        /* ToEqual ignores undefined properties, so this also rejects a wrong
           non-empty default for any unset option. */
        expect(parseLocalCliArgs([], captureStreams())).toEqual({
            context: 'auto',
            auth: 'auto',
            configPath: DEFAULT_CONFIG_PATH,
            output: 'terminal',
            isMockMode: false,
            forceOverBudget: false
        });
    });

    test('parses every option, inline values and flags', () => {
        const options = parseLocalCliArgs(
            [
                '--repo',
                '/repo',
                '--base=main~1',
                '--head',
                'feature',
                '--context',
                'github',
                '--auth',
                'opencode',
                '--provider',
                'openai',
                '--model',
                'gpt-5',
                '--credential',
                'cred_123',
                '--config',
                '.github/review.yml',
                '--instructions',
                'review-guidance.md',
                '--output',
                'github-pr',
                '--output-file',
                'review.md',
                '--pr',
                '42',
                '--mock',
                '--force-over-budget'
            ],
            captureStreams()
        );

        expect(options).toEqual({
            repositoryDir: '/repo',
            baseRef: 'main~1',
            headRef: 'feature',
            context: 'github',
            auth: 'opencode',
            provider: 'openai',
            model: 'gpt-5',
            credential: 'cred_123',
            configPath: '.github/review.yml',
            localConfigPath: '.github/review.yml',
            instructionsPath: 'review-guidance.md',
            output: 'github-pr',
            outputFile: 'review.md',
            prNumber: 42,
            isMockMode: true,
            forceOverBudget: true
        });
    });

    test('prints help on stdout and exits zero', () => {
        for (const flag of ['--help', '-h']) {
            const outcome = expectExit((streams) => parseLocalCliArgs([flag], streams));
            expect(outcome.exitCode).toBe(0);
            expect(outcome.stdout).toContain('Usage: sakre local');
            expect(outcome.stdout).toContain('--force-over-budget');
            /* The context/output contract is part of the help, not only the
               README. */
            expect(outcome.stdout).toContain('--context git');
            expect(outcome.stdout).toContain('--output-file <path>');
            expect(outcome.stdout).toContain('--instructions <path>');
            expect(outcome.stdout).toContain('8000');
            expect(outcome.stdout).toContain('GITHUB_TOKEN');
            expect(outcome.stderr).toBe('');
        }
    });

    test('reports an unknown option on stderr', () => {
        const outcome = expectExit((streams) => parseLocalCliArgs(['--unknown'], streams));
        expect(outcome.exitCode).toBe(1);
        expect(outcome.stdout).toBe('');
        expect(outcome.stderr).not.toBe('');
    });

    test('rejects a positional argument on stderr', () => {
        const outcome = expectExit((streams) => parseLocalCliArgs(['positional'], streams));
        expect(outcome.exitCode).toBe(1);
        expect(outcome.stdout).toBe('');
        expect(outcome.stderr).not.toBe('');
    });

    /* Commander consumes a literal `--` as its end-of-options marker; the base
       CLI rejected it wherever it appeared. */
    test('rejects the end-of-options separator on stderr', () => {
        for (const args of [['--'], ['--base', '--'], ['--mock', '--']]) {
            const outcome = expectExit((streams) => parseLocalCliArgs(args, streams));
            expect(outcome.exitCode).toBe(1);
            expect(outcome.stdout).toBe('');
            expect(outcome.stderr).not.toBe('');
        }
    });

    test('rejects a missing value on stderr', () => {
        for (const args of [['--base'], ['--instructions']]) {
            const outcome = expectExit((streams) => parseLocalCliArgs(args, streams));
            expect(outcome.exitCode).toBe(1);
            expect(outcome.stdout).toBe('');
            expect(outcome.stderr).not.toBe('');
        }
    });

    /* Commander consumes an option-like token as a value and accepts an empty
       inline value; the CLI contract rejects both. */
    test('rejects empty and option-like values on stderr', () => {
        for (const args of [['--base', '--mock'], ['--base='], ['--instructions', '--mock'], ['--instructions=']]) {
            const outcome = expectExit((streams) => parseLocalCliArgs(args, streams));
            expect(outcome.exitCode).toBe(1);
            expect(outcome.stdout).toBe('');
            expect(outcome.stderr).not.toBe('');
        }
    });

    test('rejects invalid enumerations and pull request numbers on stderr', () => {
        for (const args of [
            ['--context', 'both'],
            ['--auth', 'oauth'],
            ['--output', 'json'],
            ['--pr', '0'],
            ['--pr', 'seven']
        ]) {
            const outcome = expectExit((streams) => parseLocalCliArgs(args, streams));
            expect(outcome.exitCode).toBe(1);
            expect(outcome.stdout).toBe('');
            expect(outcome.stderr).not.toBe('');
        }
    });

    test('accepts zero-padded pull request numbers', () => {
        expect(parseLocalCliArgs(['--pr', '007'], captureStreams()).prNumber).toBe(7);
        expect(parseLocalCliArgs(['--pr=042'], captureStreams()).prNumber).toBe(42);
    });
});

describe('auth CLI arguments', () => {
    test('parses the provider and optional API key', () => {
        expect(parseAuthCliArgs(['login', 'anthropic'], captureStreams())).toEqual({
            command: 'login',
            provider: 'anthropic'
        });
        expect(parseAuthCliArgs(['login', 'anthropic', '--key', 'sk-ant-1'], captureStreams())).toEqual({
            command: 'login',
            provider: 'anthropic',
            key: 'sk-ant-1'
        });
        expect(parseAuthCliArgs(['login', 'openai', '--method', 'chatgpt-headless'], captureStreams())).toEqual({
            command: 'login',
            provider: 'openai',
            method: 'chatgpt-headless'
        });
        expect(parseAuthCliArgs(['list', 'openai'], captureStreams())).toEqual({ command: 'list', provider: 'openai' });
        expect(parseAuthCliArgs(['remove', 'cred_123'], captureStreams())).toEqual({
            command: 'remove',
            credentialID: 'cred_123'
        });
    });

    test('answers --help on the command and on login with exit zero', () => {
        for (const args of [['--help'], ['-h'], ['login', '--help'], ['login', '-h']]) {
            const outcome = expectExit((streams) => parseAuthCliArgs(args, streams));
            expect(outcome.exitCode).toBe(0);
            expect(outcome.stdout).toContain('Usage: sakre auth');
            expect(outcome.stderr).toBe('');
        }

        const login = expectExit((streams) => parseAuthCliArgs(['login', '--help'], streams));
        expect(login.stdout).toContain('provider');
        expect(login.stdout).toContain('--key');
        expect(login.stdout).toContain('--method');
    });

    test('rejects a missing provider and an invalid key value', () => {
        const missing = expectExit((streams) => parseAuthCliArgs(['login'], streams));
        expect(missing.exitCode).toBe(1);
        expect(missing.stderr).toContain('auth login');

        const emptyKey = expectExit((streams) => parseAuthCliArgs(['login', 'anthropic', '--key', '--'], streams));
        expect(emptyKey.exitCode).toBe(1);
        expect(emptyKey.stderr).not.toBe('');
    });

    test('rejects a leading separator instead of dispatching login', () => {
        const outcome = expectExit((streams) => parseAuthCliArgs(['--', 'login'], streams));
        expect(outcome.exitCode).toBe(1);
        expect(outcome.stdout).toBe('');
        expect(outcome.stderr).toContain('auth login');
    });

    test('writes the usage on stderr and exits non-zero for any other subcommand', () => {
        for (const args of [['logout'], []]) {
            const outcome = expectExit((streams) => parseAuthCliArgs(args, streams));
            expect(outcome.exitCode).toBe(1);
            expect(outcome.stdout).toBe('');
            expect(outcome.stderr).toContain('Usage: sakre auth');
            expect(outcome.stderr).toContain('login');
        }
    });
});

function captureStream(): CapturedStream {
    let text = '';

    const stream = new Writable({
        write(chunk: Buffer, _encoding, callback): void {
            text += chunk.toString('utf8');
            callback();
        }
    });

    return { stream, read: () => text };
}

function captureStreams(): CliStreams {
    return { stdout: captureStream().stream, stderr: captureStream().stream };
}

// eslint-disable-next-line anti-slop/no-unknown-returns -- the parse return value is discarded; only exit behavior is observed
function expectExit(parse: (streams: CliStreams) => unknown): CliExit {
    const stdout = captureStream();
    const stderr = captureStream();

    try {
        parse({ stdout: stdout.stream, stderr: stderr.stream });
    } catch (error) {
        if (error instanceof CliExitError) {
            return { exitCode: error.exitCode, stdout: stdout.read(), stderr: stderr.read() };
        }

        throw error;
    }

    throw new Error('Expected the CLI parser to exit.');
}
