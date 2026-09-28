import { z } from 'zod';
import { DEFAULT_AGENT_NAME, DEFAULT_CONFIG_PATH } from '../identity';

const DEFAULT_ALLOWED_ASSOCIATIONS = 'OWNER,MEMBER,COLLABORATOR';

const AGENT_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;

export class ActionInputsError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = 'ActionInputsError';
    }
}

/* Credentials travel separately: never merged into serializable config, never
   logged. */
export interface ProviderCredentials {
    apiKey?: string;
    baseURL?: string;
}

export interface ActionInputs {
    githubToken: string;
    triggerCommand: string;
    allowedAuthorAssociations: string[];
    configPath: string;
    provider?: string;
    defaultModel?: string;
    isMockMode: boolean;
    forceOverBudget: boolean;
    credentials: ProviderCredentials;
}

interface InputReader {
    getInput: (name: string) => string;
}

/* Validates Action inputs. An input provider needs its credential at once; the
   config provider is validated atomically later with the same credential. */
export function readActionInputs(reader: InputReader): ActionInputs {
    const githubToken = requireGitHubToken(reader);
    const base = readBaseInputs(reader);
    const provider = readProviderInputs(reader, base.isMockMode);

    return {
        githubToken,
        triggerCommand: base.triggerCommand,
        allowedAuthorAssociations: base.allowedAuthorAssociations,
        configPath: base.configPath,
        provider: provider.provider,
        defaultModel: provider.defaultModel,
        isMockMode: base.isMockMode,
        forceOverBudget: base.forceOverBudget,
        credentials: { apiKey: provider.apiKey, baseURL: provider.baseURL }
    };
}

function requireGitHubToken(reader: InputReader): string {
    const githubToken = reader.getInput('github_token');

    if (githubToken === '') {
        throw new ActionInputsError('Input "github_token" is required.');
    }

    return githubToken;
}

function readBaseInputs(reader: InputReader): {
    triggerCommand: string;
    allowedAuthorAssociations: string[];
    configPath: string;
    isMockMode: boolean;
    forceOverBudget: boolean;
} {
    const agentName = optional(reader.getInput('agent_name')) ?? DEFAULT_AGENT_NAME;
    validateAgentName(agentName);
    const configPath = optional(reader.getInput('config_path')) ?? DEFAULT_CONFIG_PATH;
    validateConfigPath(configPath);

    // eslint-disable-next-line anti-slop/no-known-value-widening -- validated inputs assembled into the declared Action contract
    return {
        triggerCommand: `@${agentName}`,
        allowedAuthorAssociations: parseAllowedAssociations(reader.getInput('allowed_author_associations')),
        configPath,
        isMockMode: reader.getInput('mock_mode') === 'true',
        forceOverBudget: reader.getInput('force_over_budget') === 'true'
    };
}

function validateAgentName(agentName: string): void {
    if (!AGENT_NAME_PATTERN.test(agentName)) {
        throw new ActionInputsError('Input "agent_name" must be a GitHub-mention-compatible identifier.');
    }
}

function validateConfigPath(configPath: string): void {
    if (configPath.startsWith('/') || configPath.includes('\\') || configPath.split('/').includes('..')) {
        throw new ActionInputsError('Input "config_path" must be a relative path inside the repository.');
    }
}

function readProviderInputs(
    reader: InputReader,
    isMockMode: boolean
): { provider?: string; defaultModel?: string; apiKey?: string; baseURL?: string } {
    const provider = optional(reader.getInput('provider'));
    const apiKey = optional(reader.getInput('provider_api_key'));
    const baseURL = optional(reader.getInput('provider_base_url'));

    if (!isMockMode && provider !== undefined && apiKey === undefined) {
        throw new ActionInputsError(`Input "provider_api_key" is required for provider "${provider}".`);
    }

    validateBaseUrl(baseURL);

    // eslint-disable-next-line anti-slop/no-known-value-widening -- validated inputs assembled into the declared Action contract
    return { provider, defaultModel: optional(reader.getInput('default_model')), apiKey, baseURL };
}

function validateBaseUrl(baseURL: string | undefined): void {
    if (baseURL === undefined) {
        return;
    }

    const check = z.url().safeParse(baseURL);

    if (!check.success) {
        throw new ActionInputsError('Input "provider_base_url" must be a valid URL.');
    }
}

function optional(value: string): string | undefined {
    const trimmed = value.trim();

    if (trimmed === '') {
        return undefined;
    }

    return trimmed;
}

function parseAllowedAssociations(value: string): string[] {
    const associations = value
        .split(',')
        .map((item) => item.trim().toUpperCase())
        .filter((item) => item !== '');

    if (associations.length > 0) {
        return associations;
    }

    return DEFAULT_ALLOWED_ASSOCIATIONS.split(',');
}

export { DEFAULT_ALLOWED_ASSOCIATIONS };
