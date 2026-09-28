import path from 'node:path';

/* Tree paths are untrusted VCS data; every join goes through here so traversal, absolute paths, backslashes and NUL are rejected once. */

export function joinTreePath(root: string, filePath: string): string | undefined {
    if (!isTreePathSafe(filePath)) {
        return undefined;
    }

    return path.join(root, filePath);
}

/* Paths `path.join` would reinterpret cannot be materialized; callers record an explicit unmeasurable entry instead of failing. */
export function isTreePathSafe(filePath: string): boolean {
    if (filePath === '' || path.isAbsolute(filePath) || filePath.includes('\\') || filePath.includes('\0')) {
        return false;
    }

    return !filePath.split('/').includes('..');
}

/* Tools prefix relative paths with the walked root and keep native separators; canonical VCS paths never do. */
export function normalizeToolPath(filePath: string): string {
    const unified = filePath.replaceAll('\\', '/');

    if (unified.startsWith('./')) {
        return unified.slice(2);
    }

    return unified;
}
