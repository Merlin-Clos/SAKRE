import { OpenCode } from '@opencode/sdk';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/* Use the installed SDK's offline catalogue, not a model name whose lifetime is
   controlled by a provider. The discovery host has its own database and only
   fake keys; it never prompts a model or loads user/project configuration. */
type CatalogueModel = Awaited<ReturnType<OpenCode.Interface['model']['list']>>['data'][number];

export const catalogueModels = await loadCatalogue();

export function selectCatalogueModel(matches: (model: CatalogueModel) => boolean): CatalogueModel {
    const selected = catalogueModels.find(
        (model) =>
            model.enabled &&
            model.capabilities.tools &&
            model.capabilities.input.includes('text') &&
            model.capabilities.output.includes('text') &&
            matches(model)
    );

    if (selected === undefined) {
        throw new Error('The bundled catalogue has no enabled text/tool model matching the test protocol.');
    }

    return selected;
}

export const ANTHROPIC_TEST_MODEL = selectCatalogueModel(
    (model) => model.providerID === 'anthropic' && model.package === '@opencode/ai/providers/anthropic'
).id;

async function loadCatalogue(): Promise<CatalogueModel[]> {
    const root = await mkdtemp(path.join(tmpdir(), 'sakre-test-catalogue-'));

    try {
        await using host = await OpenCode.create({
            config: {
                project: false,
                directory: root,
                content: JSON.stringify({
                    providers: {
                        anthropic: { settings: { apiKey: 'fake-catalogue-key' } },
                        openai: { settings: { apiKey: 'fake-catalogue-key' } },
                        'opencode-go': { settings: { apiKey: 'fake-catalogue-key' } }
                    },
                    plugins: [],
                    instructions: [],
                    skills: [],
                    lsp: false,
                    formatter: false,
                    update: 'disable',
                    snapshots: false
                })
            },
            models: { fetch: false },
            fs: { filewatcher: false, fff: false },
            database: { path: path.join(root, 'catalogue.db') },
            events: { persist: false }
        });

        const location = { directory: root };
        await host.integration.list({ location });

        const result = await host.model.list({ location });

        return result.data;
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}
