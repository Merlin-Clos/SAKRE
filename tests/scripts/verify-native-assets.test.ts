import { expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { median } from '../../scripts/benchmark-intelligence';
import { parseVerifyArguments } from '../../scripts/verify-native-assets';
import { resolvePinnedBinary } from '../helpers/native-binary';

/* F-016 regression: the parser must not swallow the next option token as the
   --expose-dir value, and the benchmark median must be a real median. */

test('--expose-dir consumes its own value and rejects option tokens', () => {
    const explicit = parseVerifyArguments(['--target', 'linux-x64', '--expose-dir', '/tmp/tools']);
    expect(explicit).toEqual({ targets: ['linux-x64'], exposeDirectory: '/tmp/tools' });
    const inline = parseVerifyArguments(['--expose-dir=/tmp/tools']);
    expect(inline.exposeDirectory).toBe('/tmp/tools');
    expect(inline.targets.length).toBeGreaterThan(1);
    expect(() => parseVerifyArguments(['--expose-dir', '--target=linux-x64'])).toThrow(
        '--expose-dir requires a value.'
    );
    expect(() => parseVerifyArguments(['--expose-dir='])).toThrow('--expose-dir requires a value.');
});

test('the benchmark median averages the two middle values for an even count', () => {
    expect(median([])).toBe(0);
    expect(median([5])).toBe(5);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([40, 10, 30, 20])).toBe(25);
});

test.skipIf(process.platform !== 'linux')(
    'the real-binary helper falls back to the runtime cache directory layout',
    async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'sakre-native-cache-'));

        try {
            const directory = path.join(root, 'sakre', 'bin', 'scc', '9.9.9-cachetest');
            await mkdir(directory, { recursive: true });
            const binary = path.join(directory, 'scc');
            await writeFile(binary, '#!/bin/sh\necho "scc version 9.9.9"\n', { mode: 0o755 });
            await chmod(binary, 0o755);
            const previous = process.env.XDG_CACHE_HOME;
            process.env.XDG_CACHE_HOME = root;

            try {
                /* 9.9.9 is not the system version, so only the cache entry can match. */
                const resolved = await resolvePinnedBinary('scc', '9.9.9', 'SAKRE_SCC_BINARY_UNSET');
                expect(resolved).toBe(binary);
            } finally {
                if (previous === undefined) {
                    delete process.env.XDG_CACHE_HOME;
                } else {
                    process.env.XDG_CACHE_HOME = previous;
                }
            }
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    }
);
