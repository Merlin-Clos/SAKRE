import { describe, expect, test } from 'bun:test';
import { ActionInputsError, readActionInputs } from '../../src/action/inputs';

class FakeInputReader {
    private readonly values: Record<string, string>;

    public constructor(values: Record<string, string>) {
        this.values = values;
    }

    public getInput(name: string): string {
        return this.values[name] ?? '';
    }
}

describe('action inputs validation', () => {
    test('requires a GitHub token', () => {
        expect(() => readActionInputs(new FakeInputReader({}))).toThrow(ActionInputsError);
    });

    test('requires the provider credential outside mock mode', () => {
        const reader = new FakeInputReader({
            github_token: 'token',
            provider: 'anthropic'
        });

        expect(() => readActionInputs(reader)).toThrow('provider_api_key');

        const mockReader = new FakeInputReader({
            github_token: 'token',
            provider: 'anthropic',
            mock_mode: 'true'
        });

        expect(readActionInputs(mockReader).isMockMode).toBe(true);
    });

    test('rejects an invalid provider base URL', () => {
        const reader = new FakeInputReader({
            github_token: 'token',
            provider_api_key: 'key',
            provider_base_url: 'not-a-url'
        });

        expect(() => readActionInputs(reader)).toThrow('provider_base_url');
    });

    test('rejects a config path outside the protected repository tree', () => {
        for (const configPath of ['/etc/sakre.yml', '../sakre.yml', '.github/../sakre.yml']) {
            expect(() =>
                readActionInputs(new FakeInputReader({ github_token: 'token', config_path: configPath }))
            ).toThrow('config_path');
        }
    });

    test('applies defaults for optional inputs and keeps credentials separate', () => {
        const inputs = readActionInputs(
            new FakeInputReader({
                github_token: 'token',
                provider: 'openai-compatible',
                provider_api_key: 'secret-key',
                provider_base_url: 'https://api.example.com/v1'
            })
        );

        expect(inputs.triggerCommand).toBe('@sakre');
        expect(inputs.allowedAuthorAssociations).toEqual(['OWNER', 'MEMBER', 'COLLABORATOR']);
        expect(inputs.configPath).toBe('.github/sakre.yml');
        expect(inputs.provider).toBe('openai-compatible');
        expect(inputs.forceOverBudget).toBe(false);
        expect(inputs.credentials.apiKey).toBe('secret-key');
        expect(inputs.credentials.baseURL).toBe('https://api.example.com/v1');
    });

    test('reads the explicit per-run over-budget force', () => {
        const reader = new FakeInputReader({ github_token: 'token', force_over_budget: 'true' });
        expect(readActionInputs(reader).forceOverBudget).toBe(true);
    });

    test('derives the public trigger only from a GitHub-mention-compatible agent name', () => {
        for (const agentName of ['a', 'acme-reviewer', `a${'b'.repeat(38)}`]) {
            const inputs = readActionInputs(new FakeInputReader({ github_token: 'token', agent_name: agentName }));
            expect(inputs.triggerCommand).toBe(`@${agentName}`);
        }

        for (const agentName of ['-starts-with-hyphen', 'ends-with-hyphen-', 'invalid_name', `a${'b'.repeat(39)}`]) {
            expect(() =>
                readActionInputs(new FakeInputReader({ github_token: 'token', agent_name: agentName }))
            ).toThrow('agent_name');
        }
    });

    test('never exposes the credential through the serialisable fields', () => {
        const inputs = readActionInputs(
            new FakeInputReader({ github_token: 'token', provider: 'anthropic', provider_api_key: 'secret-key' })
        );

        const serialisable = {
            githubToken: inputs.githubToken,
            triggerCommand: inputs.triggerCommand,
            configPath: inputs.configPath,
            provider: inputs.provider
        };

        expect(JSON.stringify(serialisable)).not.toContain('secret-key');
    });
});
