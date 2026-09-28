import { describe, expect, test } from 'bun:test';
import { Writable } from 'node:stream';
import packageJson from '../../package.json' with { type: 'json' };
import type { CliStreams } from '../../src/cli/program';
import { routeRootCli } from '../../src/cli/root';
import { PRODUCT_NAME } from '../../src/identity';

/* Root dispatch happens before any Action input, credential, repository or
   native-tool initialization. */

interface CapturedStream {
    stream: NodeJS.WritableStream;
    read: () => string;
}

describe('root CLI dispatch', () => {
    test('answers help on stdout and exits zero without initializing anything', () => {
        for (const token of ['--help', '-h', 'help']) {
            const captured = captureStreamsWithReaders();
            expect(routeRootCli([token], captured.streams)).toEqual({ command: 'exit', exitCode: 0 });
            expect(captured.stdout.read()).toContain('Usage: sakre');
            expect(captured.stdout.read()).toContain('local');
            expect(captured.stdout.read()).toContain('auth');
            expect(captured.stderr.read()).toBe('');
        }
    });

    test('answers the version on stdout and exits zero', () => {
        for (const token of ['--version', '-v']) {
            const captured = captureStreamsWithReaders();
            expect(routeRootCli([token], captured.streams)).toEqual({ command: 'exit', exitCode: 0 });
            expect(captured.stdout.read().trim()).toBe(`${PRODUCT_NAME} ${packageJson.version}`);
            expect(captured.stderr.read()).toBe('');
        }
    });

    test('routes the subcommands and keeps no arguments as the Action entrypoint', () => {
        expect(routeRootCli([], captureStreams())).toEqual({ command: 'action' });
        expect(routeRootCli(['local', '--mock'], captureStreams())).toEqual({
            command: 'local',
            args: ['--mock']
        });
        expect(routeRootCli(['auth', 'login', 'anthropic'], captureStreams())).toEqual({
            command: 'auth',
            args: ['login', 'anthropic']
        });
    });

    test('routes help <command> to that command own help', () => {
        /* `help` with arguments must not print the root help: each command keeps
           one owner for its own help text. */
        expect(routeRootCli(['help', 'local'], captureStreams())).toEqual({
            command: 'local',
            args: ['--help']
        });
        expect(routeRootCli(['help', 'auth', 'login'], captureStreams())).toEqual({
            command: 'auth',
            args: ['login', '--help']
        });
        const captured = captureStreamsWithReaders();
        expect(routeRootCli(['help', 'badcmd'], captured.streams)).toEqual({ command: 'exit', exitCode: 1 });
        expect(captured.stderr.read()).toContain('unknown command');
    });

    test('fails an unknown command or option as an interactive error', () => {
        for (const token of ['badcmd', '--frobnicate']) {
            const captured = captureStreamsWithReaders();
            expect(routeRootCli([token], captured.streams)).toEqual({ command: 'exit', exitCode: 1 });
            expect(captured.stdout.read()).toBe('');
            const stderr = captured.stderr.read();

            if (token.startsWith('-')) {
                expect(stderr).toContain('unknown option');
            } else {
                expect(stderr).toContain('unknown command');
            }

            expect(stderr).toContain('Usage: sakre');
            expect(stderr).not.toContain('::error::');
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

function captureStreamsWithReaders(): { streams: CliStreams; stdout: CapturedStream; stderr: CapturedStream } {
    const stdout = captureStream();
    const stderr = captureStream();

    // eslint-disable-next-line anti-slop/no-known-value-widening -- stream-capture helper; annotation documents the streams pair
    return { streams: { stdout: stdout.stream, stderr: stderr.stream }, stdout, stderr };
}
