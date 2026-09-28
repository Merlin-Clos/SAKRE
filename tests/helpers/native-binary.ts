import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { nativeBaseDirectory, preferredCacheRoot } from '../../src/native/cache-paths';
import { optionalSystemBinary } from './artifact-repository';

/* Locates a pinned native tool for a real-binary test: env override, system PATH, or content-addressed cache. Returns
   undefined when the exact pinned version is unavailable; the caller skips. */

export async function resolvePinnedBinary(
    tool: 'scc' | 'cccc',
    version: string,
    envVariable: string
): Promise<string | undefined> {
    const explicit = process.env[envVariable];

    const candidates = [explicit, optionalSystemBinary(tool), await cachedBinary(tool, version)]
        .filter((candidate): candidate is string => candidate !== undefined && candidate !== '')
        .flatMap((candidate) => executableCandidates(candidate));

    for (const candidate of candidates) {
        if (await reportsVersion(candidate, version)) {
            return candidate;
        }
    }

    return undefined;
}

/* A workflow may pass the directory-relative tool name without the Windows
   extension; both spellings resolve to the same executable. */
function executableCandidates(candidate: string): string[] {
    if (process.platform === 'win32' && !candidate.endsWith('.exe')) {
        return [candidate, `${candidate}.exe`];
    }

    return [candidate];
}

async function cachedBinary(tool: string, version: string): Promise<string | undefined> {
    const cacheRoot = preferredCacheRoot({ platform: process.platform, environment: process.env, home: homedir() });

    if (cacheRoot === undefined) {
        return undefined;
    }

    const root = path.join(nativeBaseDirectory(cacheRoot), 'bin', tool);
    const directories = await readDirectory(root);
    const match = directories.find((directory) => directory.startsWith(`${version}-`));

    if (match === undefined) {
        return undefined;
    }

    if (process.platform === 'win32') {
        return path.join(root, match, `${tool}.exe`);
    }

    return path.join(root, match, tool);
}

async function readDirectory(directory: string): Promise<string[]> {
    try {
        return await readdir(directory);
    } catch {
        return [];
    }
}

function reportsVersion(binary: string, version: string): Promise<boolean> {
    return new Promise((resolve) => {
        const child = spawn(binary, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
        let output = '';
        child.stdout.on('data', (chunk: Buffer) => {
            output += chunk.toString('utf8');
        });
        child.on('error', () => {
            resolve(false);
        });
        child.on('close', () => {
            resolve(output.includes(version));
        });
    });
}
