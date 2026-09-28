import { describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ENGINE_PLUGIN_ID, enginePluginSource, materializeEnginePlugin } from '../../src/engine/plugin-source';
import { engineSubmitToolNames } from '../../src/engine/submit';

describe('engine plugin source', () => {
    test('registers every submit tool with codemode disabled and a submission guard', () => {
        const source = enginePluginSource();

        expect(source).toContain(ENGINE_PLUGIN_ID);

        for (const name of Object.values(engineSubmitToolNames)) {
            expect(source).toContain(name);
        }

        expect(source).toContain('options: { codemode: false }');
        expect(source).toContain('SUBMISSIONS');
        expect(source).toContain('already recorded');
    });

    test('materializes one content-addressed plugin directory and reuses it', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'sakre-plugin-'));

        try {
            const directory = await materializeEnginePlugin(root);

            expect(path.dirname(directory)).toBe(path.join(root, ENGINE_PLUGIN_ID));
            expect(await readdir(directory)).toEqual(['index.js']);
            const written = await readFile(path.join(directory, 'index.js'), 'utf8');
            expect(written).toBe(enginePluginSource());

            expect(await materializeEnginePlugin(root)).toBe(directory);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
