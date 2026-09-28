import { rmSync } from 'node:fs';
import { chmod, copyFile, link, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/* Scripted tools control the exact argv, environment, stdout, stderr and exit code the production process layer observes.
   POSIX execs the running Bun binary through a shell wrapper; Windows hardlinks one compiled launcher per tool name that
   imports the `<name>.body.mjs` sibling. Both use the direct spawn path of the real binaries with args at `process.argv.slice(2)`. */

const LAUNCHER_SOURCE = `import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const stem = basename(process.execPath).replace(/\\.exe$/i, '');
await import(pathToFileURL(join(dirname(process.execPath), stem + '.body.mjs')).href);
`;

const HARDLINK_FALLBACK_CODES: ReadonlySet<string> = new Set(['EXDEV', 'EPERM', 'EACCES']);

let launcher: Promise<string> | null = null;

let launcherRoot: string | null = null;

export async function scriptedTool(directory: string, name: string, body: string): Promise<string> {
    const bodyPath = path.join(directory, `${name}.body.mjs`);
    await writeFile(bodyPath, body, 'utf8');

    if (process.platform === 'win32') {
        const compiled = await compiledLauncher();
        const target = path.join(directory, `${name}.exe`);
        await linkOrCopy(compiled, target);

        return target;
    }

    const target = path.join(directory, name);
    await writeFile(target, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(bodyPath)} "$@"\n`, {
        mode: 0o755
    });
    await chmod(target, 0o755);

    return target;
}

function compiledLauncher(): Promise<string> {
    launcher ??= compileLauncher();

    return launcher;
}

async function compileLauncher(): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), 'sakre-scripted-tool-'));
    launcherRoot = root;
    const entry = path.join(root, 'launcher.mjs');
    const outfile = path.join(root, 'launcher.exe');
    await writeFile(entry, LAUNCHER_SOURCE, 'utf8');

    /* The launcher runs with the measured tree as its cwd; it must never load a
       bunfig or .env a fixture may have committed. */
    const result = await Bun.build({
        entrypoints: [entry],
        compile: { outfile, autoloadBunfig: false, autoloadDotenv: false }
    });

    if (!result.success) {
        throw new Error(`The scripted-tool launcher failed to compile: ${result.logs.map(logMessage).join('\n')}`);
    }

    return outfile;
}

function logMessage(log: { message: string }): string {
    return log.message;
}

async function linkOrCopy(source: string, target: string): Promise<void> {
    try {
        await link(source, target);
    } catch (error) {
        if (!isHardlinkUnsupported(error)) {
            throw error;
        }

        await copyFile(source, target);
    }
}

// eslint-disable-next-line anti-slop/no-unknown-parameters -- inspects caught filesystem errors; narrows with instanceof before reading code
function isHardlinkUnsupported(error: unknown): boolean {
    return error instanceof Error && 'code' in error && HARDLINK_FALLBACK_CODES.has(String(error.code));
}

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", `'\\''`)}'`;
}

/* The launcher is process-wide state shared by every scripted tool in the file;
   the OS temp directory gets it back on exit. */
process.on('exit', () => {
    if (launcherRoot !== null) {
        rmSync(launcherRoot, { recursive: true, force: true });
    }
});
