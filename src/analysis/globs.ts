import picomatch from 'picomatch';

type PathMatcher = (path: string) => boolean;

const matcherCache = new Map<string, PathMatcher>();

function matcherFor(pattern: string): PathMatcher {
    const cached = matcherCache.get(pattern);

    if (cached !== undefined) {
        return cached;
    }

    const matcher = picomatch(pattern, { dot: true, nocase: true });
    matcherCache.set(pattern, matcher);

    return matcher;
}

/* Precompiled matchers; a leading double-star pattern also covers the root file with that name. */
export function matchesGlob(path: string, pattern: string): boolean {
    if (matcherFor(pattern)(path)) {
        return true;
    }

    const rootPattern = pattern.replace(/^\*\*\//u, '');

    if (rootPattern === pattern) {
        return false;
    }

    return matcherFor(rootPattern)(path);
}

export function matchesAnyGlob(path: string, patterns: readonly string[]): boolean {
    return patterns.some((pattern) => matchesGlob(path, pattern));
}
