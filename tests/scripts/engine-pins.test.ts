import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { enginePinsContent, hashEngineArtifacts } from '../../scripts/generate-engine-pins';

const COMMITTED_PIN = 'engine-pins.json';

const GENERATOR = path.resolve('scripts', 'generate-engine-pins.ts');

const RELEASE_TAG_PATTERN = /^v\d+\.\d+\.\d+$/u;

const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

const LINUX_GZ = 'sakre-linux-x64.gz';

const WINDOWS_GZ = 'sakre-windows-x64.exe.gz';

/* The pin is the SHA-256 of the decompressed engine: the composite resolver
   downloads the .gz asset, decompresses it and verifies the binary. */
function gzip(content: string): Uint8Array {
    return Bun.gzipSync(Buffer.from(content, 'utf8'));
}

function sha256Hex(content: string): string {
    return createHash('sha256').update(content).digest('hex');
}

test('the committed pin manifest is canonical and only names engine artifacts', async () => {
    const content = await readFile(COMMITTED_PIN, 'utf8');
    // SAFETY: the committed pin file is JSON with tag/assets; both are validated field by field below.
    // eslint-disable-next-line anti-slop/no-unsafe-dictionary-type -- pin-manifest assets map digests by name; entries are stringified below
    const manifest = JSON.parse(content) as { tag: unknown; assets: Record<string, unknown> };

    if (manifest.tag === null) {
        expect(Object.keys(manifest.assets)).toHaveLength(0);
    } else {
        // eslint-disable-next-line anti-slop/no-runtime-typeof -- asserts the manifest tag runtime type before use as a string
        expect(typeof manifest.tag).toBe('string');
        // SAFETY: the typeof assertion above establishes manifest.tag as a string.
        const tag = manifest.tag as string;
        expect(tag).toMatch(RELEASE_TAG_PATTERN);
        const digests = new Map(Object.entries(manifest.assets).map(([name, digest]) => [name, String(digest)]));
        expect(content).toBe(enginePinsContent(tag, digests));
    }

    for (const [name, digest] of Object.entries(manifest.assets)) {
        expect(name).toMatch(/^sakre-(?:linux|darwin|windows)-.*\.gz$/u);
        expect(String(digest)).toMatch(DIGEST_PATTERN);
    }
});

test('canonical pin content contains only known engine artifacts', () => {
    const content = enginePinsContent(
        'v1.2.3',
        new Map([
            [LINUX_GZ, 'a'.repeat(64)],
            ['not-an-engine', 'b'.repeat(64)]
        ])
    );

    expect(JSON.parse(content)).toEqual({ tag: 'v1.2.3', assets: { [LINUX_GZ]: 'a'.repeat(64) } });
    expect(content.endsWith('\n')).toBe(true);
    expect(() => enginePinsContent('v1.2', new Map([[LINUX_GZ, 'a'.repeat(64)]]))).toThrow(/must look like v1\.2\.3/u);
    expect(() => enginePinsContent('v1.2.3', new Map())).toThrow(/No engine artifacts/u);
    expect(() => enginePinsContent('v1.2.3', new Map([[LINUX_GZ, 'nope']]))).toThrow(/64 lowercase hex/u);
});

test('hashes the decompressed engine for each compressed artifact present', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'sakre-engine-pins-'));

    try {
        await writeFile(path.join(root, WINDOWS_GZ), gzip('windows'));
        await writeFile(path.join(root, LINUX_GZ), gzip('linux'));
        await writeFile(path.join(root, 'unrelated.txt'), 'other');
        const digests = await hashEngineArtifacts(root);
        expect([...digests.keys()]).toEqual([LINUX_GZ, WINDOWS_GZ]);
        expect(digests.get(LINUX_GZ)).toBe(sha256Hex('linux'));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('the generator writes the manifest and fails when no artifact was published', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'sakre-engine-pins-cli-'));
    const output = path.join(root, 'engine-pins.json');

    try {
        await writeFile(path.join(root, LINUX_GZ), gzip('linux'));

        const success = spawnSync(
            process.execPath,
            [GENERATOR, '--tag', 'v1.2.3', '--directory', root, '--output', output],
            { encoding: 'utf8' }
        );

        expect(success.status).toBe(0);
        expect(JSON.parse(await readFile(output, 'utf8'))).toEqual({
            tag: 'v1.2.3',
            assets: { [LINUX_GZ]: sha256Hex('linux') }
        });

        const empty = await mkdtemp(path.join(tmpdir(), 'sakre-engine-pins-empty-'));

        try {
            const failure = spawnSync(
                process.execPath,
                [GENERATOR, '--tag', 'v1.2.3', '--directory', empty, '--output', output],
                { encoding: 'utf8' }
            );

            expect(failure.status).not.toBe(0);
            expect(failure.stderr).toContain('No engine artifacts found');
        } finally {
            await rm(empty, { recursive: true, force: true });
        }
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
