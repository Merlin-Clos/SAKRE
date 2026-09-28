import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createEngineHost, type EngineHost } from '../../src/engine/host';
import { materializeEnginePlugin } from '../../src/engine/plugin-source';
import { rejectionOf } from '../helpers/rejection';

setDefaultTimeout(120_000);

const roots: string[] = [];

const hosts: EngineHost[] = [];

afterEach(async () => {
    for (const instance of hosts.splice(0)) {
        await instance.client.close();
    }

    for (const root of roots.splice(0)) {
        await rm(root, { recursive: true, force: true });
    }
});

async function host(providerID: string, modelIds: string[], externalOAuth = false): Promise<EngineHost> {
    const root = await mkdtemp(path.join(tmpdir(), 'sakre-zen-'));
    roots.push(root);
    const workspace = path.join(root, 'workspace');
    await mkdir(workspace);

    const result = await createEngineHost({
        providerID,
        providerFamily: 'native',
        modelIds,
        externalOAuth,
        checkoutDir: workspace,
        pluginDir: await materializeEnginePlugin(path.join(root, 'plugins')),
        databasePath: path.join(root, 'review.db')
    });

    hosts.push(result);

    return result;
}

test('isolated embedded catalogue permits the two Zen Free routes without credentials', async () => {
    for (const modelID of ['mimo-v2.6-flash-free', 'muse-spark-1.3-contributor-free']) {
        const instance = await host('opencode', [modelID]);
        const location = { directory: instance.directory };
        const integration = await instance.client.integration.get({ integrationID: 'opencode', location });
        const providers = await instance.client.provider.list({ location });
        const models = await instance.client.model.list({ location });
        expect(integration.data.connections).toEqual([]);
        expect(providers.data.find((provider) => provider.id === 'opencode')?.activation).toBe('enabled');
        expect(models.data.find((model) => model.providerID === 'opencode' && model.modelID === modelID)?.enabled).toBe(
            true
        );
        const selected = models.data.find((model) => model.providerID === 'opencode' && model.modelID === modelID);
        expect(selected?.cost.length).toBeGreaterThan(0);
        expect(selected?.cost.every((tier) => tier.input === 0 && tier.output === 0)).toBe(true);
    }
});

test('never borrows an OpenCode Go key for Zen, nor treats Go as keyless', async () => {
    const error = await rejectionOf(host('opencode-go', ['muse-spark-1.3-contributor']));
    expect(error.message).toContain('No usable credential for provider "opencode-go"');
    expect(error.message).toContain('SAKRE_PROVIDER_API_KEY');
    const zen = await host('opencode', ['mimo-v2.6-flash-free']);

    const integration = await zen.client.integration.get({
        integrationID: 'opencode',
        location: { directory: zen.directory }
    });

    expect(integration.data.connections).toEqual([]);
});

test('denies keyless models that the embedded catalogue does not enable', async () => {
    const error = await rejectionOf(host('opencode', ['not-a-model']));
    expect(error.message).toContain('no persistent OAuth credential is selected');
});

test('a provider enabled without a public catalogue key still requires a credential', async () => {
    const error = await rejectionOf(host('anthropic', ['claude-sonnet-4-5']));
    expect(error.message).toContain('No usable credential for provider "anthropic"');
});

test('explains why an external OAuth entry cannot be activated in a fresh review database', async () => {
    const error = await rejectionOf(host('opencode-go', ['muse-spark-1.3-contributor'], true));
    expect(error.message).toContain('OAuth credential');
    expect(error.message).toContain('separate store');
    expect(error.message).toContain('deferred');
    expect(error.message).not.toContain('access');
});
