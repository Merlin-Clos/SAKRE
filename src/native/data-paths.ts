import path from 'node:path';
import { CACHE_DIRECTORY } from '../identity';
import type { NativeCacheEnvironment } from './cache-paths';

export function preferredDataRoot(input: NativeCacheEnvironment): string | undefined {
    if (input.platform === 'win32') {
        return (
            absoluteRoot(input.environment.APPDATA, input.platform) ??
            absoluteRoot(input.environment.LOCALAPPDATA, input.platform)
        );
    }

    if (input.platform === 'darwin') {
        return homeDirectory(input.home, 'Library', 'Application Support');
    }

    return (
        absoluteRoot(input.environment.XDG_DATA_HOME, input.platform) ?? homeDirectory(input.home, '.local', 'share')
    );
}

export function engineOAuthCredentialPath(input: NativeCacheEnvironment): string {
    const root = preferredDataRoot(input);

    if (root === undefined) {
        throw new Error('Cannot resolve the platform data directory for persistent OAuth credentials.');
    }

    return path.join(root, CACHE_DIRECTORY, 'engine', 'credentials.db');
}

function absoluteRoot(value: string | undefined, platform: NodeJS.Platform): string | undefined {
    let paths = path.posix;

    if (platform === 'win32') {
        paths = path.win32;
    }

    if (value === undefined || !paths.isAbsolute(value)) {
        return undefined;
    }

    return value;
}

function homeDirectory(home: string, ...segments: string[]): string | undefined {
    if (!path.isAbsolute(home)) {
        return undefined;
    }

    return path.join(home, ...segments);
}
