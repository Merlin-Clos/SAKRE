import { describe, expect, test } from 'bun:test';
import {
    ACTION_PROVIDER_FAMILIES,
    resolveOperationalProvider,
    runtimeProviderFamily
} from '../../src/config/providers';

describe('provider policy', () => {
    test('classifies the public families and local native providers', () => {
        expect(ACTION_PROVIDER_FAMILIES).toEqual(['anthropic', 'openai-compatible']);
        expect(runtimeProviderFamily('anthropic')).toBe('anthropic');
        expect(runtimeProviderFamily('openai-compatible')).toBe('openai-compatible');
        expect(runtimeProviderFamily('openai')).toBe('native');
        expect(runtimeProviderFamily('github-copilot')).toBe('native');
    });

    test('accepts an unknown provider only when native providers are allowed', () => {
        expect(resolveOperationalProvider('anthropic', false)).toBe('anthropic');
        expect(resolveOperationalProvider('openai', false)).toBeUndefined();
        expect(resolveOperationalProvider('openai', true)).toBe('openai');
        expect(resolveOperationalProvider('  openai  ', true)).toBe('openai');
        expect(resolveOperationalProvider('', true)).toBeUndefined();
        expect(resolveOperationalProvider('   ', false)).toBeUndefined();
    });
});
