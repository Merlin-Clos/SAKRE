import type { ProviderFamily } from '../config/providers';
import { engineSubmitToolNames } from './submit';

/* Every field the inline engine configuration needs. The host options extend
   this shape, so a new engine setting is declared once. */
export interface EngineConfigOptions {
    providerID: string;
    providerFamily: ProviderFamily;
    modelIds: readonly string[];
    apiKey?: string;
    baseURL?: string;
    checkoutDir: string;
    pluginDir: string;
    context7Url?: string;
    context7ApiKey?: string;
    webEnabled?: boolean;
}

export interface EnginePermissionRule {
    action: string;
    resource: string;
    effect: 'allow' | 'deny';
}

/* The engine host starts from deny-all and re-opens only the read-only tools
   scoped to the review workspace, plus our submit tools. `external_directory`
   keeps the same boundary explicit for paths outside the session directory. */
function permissionRules(input: EngineConfigOptions): EnginePermissionRule[] {
    const scoped = `${input.checkoutDir.replaceAll('\\', '/')}/**`;

    const rules: EnginePermissionRule[] = [
        { action: '*', resource: '*', effect: 'deny' },
        { action: 'read', resource: scoped, effect: 'allow' },
        { action: 'grep', resource: scoped, effect: 'allow' },
        { action: 'glob', resource: scoped, effect: 'allow' },
        { action: 'external_directory', resource: scoped, effect: 'allow' },
        ...Object.values(engineSubmitToolNames).map((name) => ({
            action: name,
            resource: '*',
            effect: 'allow' as const
        }))
    ];

    if (input.webEnabled === true) {
        rules.push({ action: 'webfetch', resource: '*', effect: 'allow' });
    }

    return rules;
}

function providerSettings(input: EngineConfigOptions): Record<string, unknown> {
    const settings: Record<string, unknown> = {};

    if (input.apiKey !== undefined && input.apiKey !== '') {
        settings.apiKey = input.apiKey;
    }

    if (input.baseURL !== undefined) {
        settings.baseURL = input.baseURL;
    }

    return settings;
}

/* Provider overlay per family: anthropic ships with the engine; the
   openai-compatible family needs its provider package and model catalogue
   since an undeclared model is rejected before any provider call; native
   providers use the built-in definition and the engine credential store,
   so the block exists only for explicit settings. */
function providerBlocks(input: EngineConfigOptions): Record<string, unknown> {
    const settings = providerSettings(input);

    if (input.providerFamily === 'openai-compatible') {
        const models = Object.fromEntries(input.modelIds.map((modelId) => [modelId, {}]));

        return {
            [input.providerID]: {
                settings,
                package: '@opencode/ai/providers/openai-compatible',
                models
            }
        };
    }

    if (input.providerFamily === 'anthropic' || Object.keys(settings).length > 0) {
        return { [input.providerID]: { settings } };
    }

    return {};
}

function mcpBlock(input: EngineConfigOptions): Record<string, unknown> {
    if (input.context7Url === undefined) {
        return {};
    }

    const server: Record<string, unknown> = { type: 'remote', url: input.context7Url };

    if (input.context7ApiKey !== undefined && input.context7ApiKey !== '') {
        server.headers = { Authorization: `Bearer ${input.context7ApiKey}` };
    }

    return { servers: { context7: server } };
}

/* Builds the inline engine configuration: only the selected provider, our
   submit-plugin directory, no project/user instruction discovery, no sharing,
   updates, snapshots, formatter or LSP, and network access only through an
   explicit Context7 or web opt-in. The host is created with `project: false`,
   so this document is the only configuration the engine sees. */
export function buildEngineConfigContent(input: EngineConfigOptions): Record<string, unknown> {
    return {
        $schema: 'https://opencode.ai/config.json',
        share: 'disabled',
        update: 'disable',
        snapshots: false,
        formatter: false,
        lsp: false,
        instructions: [],
        skills: [],
        websearch: false,
        plugins: [input.pluginDir],
        permissions: permissionRules(input),
        mcp: mcpBlock(input),
        providers: providerBlocks(input)
    };
}
