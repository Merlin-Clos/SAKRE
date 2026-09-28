import { expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_AGENT_NAME, ENV_PREFIX, PRODUCT_MARKER, PRODUCT_NAME, PRODUCT_SLUG } from '../src/identity';

/* The guard covers the product-named literals only. `CLI_LOCAL_COMMAND` and
   `CLI_AUTH_COMMAND` are identity-owned constants too, but their values
   ("local", "auth") are generic words that appear throughout the sources, so a
   literal scan cannot enforce them; the usage strings still derive from the
   same module. */
const PRODUCT_LITERALS = [PRODUCT_NAME, PRODUCT_SLUG, PRODUCT_MARKER, DEFAULT_AGENT_NAME, ENV_PREFIX];

const IDENTITY_FILE = path.join('src', 'identity.ts');

const SCANNED_DIRECTORIES = ['src', 'defaults'];

/* Renaming the product must be a one-file change for runtime code and bundled
   assets: no module, embedded prompt, or embedded default may repeat a product
   literal that the identity module already owns. */
test('runtime modules and bundled assets take every product name from the identity module', async () => {
    const files = await collectFiles(SCANNED_DIRECTORIES);
    const offenders: string[] = [];
    const candidates = files.filter((file) => file !== IDENTITY_FILE);

    for (const file of candidates) {
        const content = await readFile(file, 'utf8');

        if (PRODUCT_LITERALS.some((literal) => content.includes(literal))) {
            offenders.push(file);
        }
    }

    expect(offenders).toEqual([]);
});

async function collectFiles(directories: string[]): Promise<string[]> {
    const nested = await Promise.all(directories.map((directory) => scannableFiles(directory)));

    return nested.flat();
}

async function scannableFiles(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });

    const nested = await Promise.all(
        entries.map((entry): Promise<string[]> => {
            const entryPath = path.join(directory, entry.name);

            if (entry.isDirectory()) {
                return scannableFiles(entryPath);
            }

            const isTypeScript = entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts');
            const isTextAsset = entry.name.endsWith('.md') || entry.name.endsWith('.yml');

            if (isTypeScript || isTextAsset) {
                return Promise.resolve([entryPath]);
            }

            return Promise.resolve([]);
        })
    );

    return nested.flat();
}
