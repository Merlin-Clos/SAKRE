import { describe, expect, test } from 'bun:test';
import { buildEngineConfigContent } from '../../src/engine/config';

const BASE = {
    providerID: 'anthropic',
    providerFamily: 'anthropic' as const,
    modelIds: ['claude-opus-5'],
    checkoutDir: '/workspace/review',
    pluginDir: '/cache/engine-plugin'
};

describe('engine config content', () => {
    test('disables discovery, sharing, updates, snapshots, formatter and LSP', () => {
        // SAFETY: buildEngineConfigContent builds permissions from literal allow/deny entries; the entries are asserted below.
        const content = buildEngineConfigContent({ ...BASE });

        expect(content.$schema).toBe('https://opencode.ai/config.json');
        expect(content.share).toBe('disabled');
        expect(content.update).toBe('disable');
        expect(content.snapshots).toBe(false);
        expect(content.formatter).toBe(false);
        expect(content.lsp).toBe(false);
        expect(content.instructions).toEqual([]);
        expect(content.skills).toEqual([]);
        expect(content.websearch).toBe(false);
        expect(content.plugins).toEqual([BASE.pluginDir]);
    });

    test('denies everything and re-opens only the workspace read tools and submit tools', () => {
        const content = buildEngineConfigContent({ ...BASE });
        // SAFETY: buildEngineConfigContent builds permissions from literal allow/deny entries; the entries are asserted below.
        const permissions = content.permissions as { action: string; resource: string; effect: string }[];

        expect(permissions[0]).toEqual({ action: '*', resource: '*', effect: 'deny' });
        expect(permissions).toContainEqual({ action: 'read', resource: '/workspace/review/**', effect: 'allow' });
        expect(permissions).toContainEqual({ action: 'grep', resource: '/workspace/review/**', effect: 'allow' });
        expect(permissions).toContainEqual({ action: 'glob', resource: '/workspace/review/**', effect: 'allow' });
        expect(permissions).toContainEqual({ action: 'submit_findings', resource: '*', effect: 'allow' });
        expect(permissions).toContainEqual({ action: 'submit_coordination', resource: '*', effect: 'allow' });
        expect(permissions).toContainEqual({ action: 'submit_verdict', resource: '*', effect: 'allow' });
        expect(permissions.some((rule) => rule.action === 'webfetch')).toBe(false);
    });

    test('normalizes Windows checkout paths for permission scopes', () => {
        const content = buildEngineConfigContent({ ...BASE, checkoutDir: 'C:\\repo\\review' });
        // SAFETY: buildEngineConfigContent builds permissions from literal allow/deny entries; the entries are asserted below.
        const permissions = content.permissions as { action: string; resource: string; effect: string }[];

        expect(permissions).toContainEqual({ action: 'read', resource: 'C:/repo/review/**', effect: 'allow' });
    });

    test('allows webfetch only when the web tool is explicitly enabled', () => {
        const enabled = buildEngineConfigContent({ ...BASE, webEnabled: true });
        // SAFETY: buildEngineConfigContent builds permissions from literal allow/deny entries; the entries are asserted below.
        const permissions = enabled.permissions as { action: string; resource: string; effect: string }[];

        expect(permissions).toContainEqual({ action: 'webfetch', resource: '*', effect: 'allow' });
    });

    test('builds the anthropic provider overlay from explicit settings', () => {
        const content = buildEngineConfigContent({ ...BASE, apiKey: 'sk-ant', baseURL: 'http://127.0.0.1:1/v1' });

        expect(content.providers).toEqual({
            anthropic: { settings: { apiKey: 'sk-ant', baseURL: 'http://127.0.0.1:1/v1' } }
        });
    });

    test('declares the provider package and every routed model for openai-compatible', () => {
        const content = buildEngineConfigContent({
            ...BASE,
            providerID: 'openai-compatible',
            providerFamily: 'openai-compatible',
            modelIds: ['gpt-a', 'gpt-b'],
            apiKey: 'sk-openai'
        });

        expect(content.providers).toEqual({
            'openai-compatible': {
                settings: { apiKey: 'sk-openai' },
                package: '@opencode/ai/providers/openai-compatible',
                models: { 'gpt-a': {}, 'gpt-b': {} }
            }
        });
    });

    test('omits a native provider overlay when no explicit settings exist', () => {
        const content = buildEngineConfigContent({ ...BASE, providerID: 'opencode', providerFamily: 'native' });

        expect(content.providers).toEqual({});
    });

    test('adds Context7 only when a URL is configured, with the key as a bearer header', () => {
        const disabled = buildEngineConfigContent({ ...BASE });
        expect(disabled.mcp).toEqual({});

        const enabled = buildEngineConfigContent({
            ...BASE,
            context7Url: 'https://context7.example/mcp',
            context7ApiKey: 'ctx-key'
        });

        expect(enabled.mcp).toEqual({
            servers: {
                context7: {
                    type: 'remote',
                    url: 'https://context7.example/mcp',
                    headers: { Authorization: 'Bearer ctx-key' }
                }
            }
        });

        const anonymous = buildEngineConfigContent({ ...BASE, context7Url: 'https://context7.example/mcp' });
        expect(anonymous.mcp).toEqual({
            servers: { context7: { type: 'remote', url: 'https://context7.example/mcp' } }
        });
    });
});
