import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import embeddedDefaults from '../../defaults/review.yml' with { type: 'text' };
import { defaultClassificationRules } from '../analysis/classification';
import { type RiskRules, riskRulesForConfig } from '../analysis/risk-rules';
import { describeError } from '../errors';
import { DEFAULT_CONFIG_PATH } from '../identity';
import { resolveOperationalProvider } from './providers';
import {
    type AgentPlan,
    type AgentRouting,
    type ClassificationRules,
    DEFAULT_AGENT_PLAN,
    type ModelCatalogEntry,
    type PromptId,
    type UserReviewConfig
} from './schema';
import { ConfigValidationError, validateRoutedModels, validateUserReviewConfig } from './validation';

const DEFAULT_PROVIDER = 'anthropic';

const DEFAULT_FAILURE_POLICY = 'continue-partial';

const DEFAULT_DEADLINE_MINUTES = 15;

const DEFAULT_DIFF_BUDGET_CHARS = 80_000;

interface ResolvedReviewConfig {
    provider: string;
    model?: string;
    models?: {
        catalog?: Record<string, ModelCatalogEntry>;
        routing?: Record<string, AgentRouting>;
    };
    classification: ClassificationRules;
    risk: RiskRules;
    agents: {
        disabled: string[];
        roles?: NonNullable<UserReviewConfig['agents']>['roles'];
        plan: AgentPlan;
    };
    review: {
        failurePolicy: 'fail-fast' | 'continue-partial';
        deadlineMinutes: number;
        diffBudgetChars: number;
        exclude: string[];
    };
    tools: {
        context7: { enabled: boolean; url?: string };
        web: { enabled: boolean };
    };
    prompts: {
        overrides?: Partial<Record<PromptId, string>>;
    };
}

interface OperationalInputs {
    provider?: string;
    defaultModel?: string;
}

interface VcsContentReader {
    getFileContent: (path: string, ref: string, signal?: AbortSignal) => Promise<string | null>;
}

export class ConfigParseError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = 'ConfigParseError';
    }
}

/* Effective config: embedded defaults, then repository config at the base SHA,
   then operational inputs. Never read at head: a PR cannot weaken its review. */
export interface LoadReviewConfigOptions {
    operational?: OperationalInputs;
    configPath?: string;
    /* Explicit CLI `--config <path>`: trusted-local file from disk, not a repo
       file at the base SHA. Missing or unreadable files fail closed. */
    localConfigPath?: string;
    signal?: AbortSignal;
    /* Local runs accept native OpenCode providers, which are not part of the
       Action's public provider families. */
    allowNativeProvider?: boolean;
}

export async function loadReviewConfig(
    vcs: VcsContentReader,
    baseSha: string,
    options: LoadReviewConfigOptions = {}
): Promise<ResolvedReviewConfig> {
    const operational = options.operational ?? {};
    const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
    const defaults = loadEmbeddedDefaults();
    let merged: Record<string, unknown> = { ...defaults };
    const repositoryContent = await readConfigContent(vcs, baseSha, options);

    if (repositoryContent !== null) {
        const repositoryConfig = validateUserReviewConfig(parseYamlContent(repositoryContent, configPath));
        merged = mergeConfigs(merged, { ...repositoryConfig });
    }

    const finalMerged = mergeConfigs(merged, operationalOverride(operational, options.allowNativeProvider === true));

    return buildResolvedConfig(finalMerged);
}

/* Explicit local path is trusted-local input; the default path is always read
   at the protected base SHA. */
function readConfigContent(
    vcs: VcsContentReader,
    baseSha: string,
    options: LoadReviewConfigOptions
): Promise<string | null> {
    if (options.localConfigPath === undefined) {
        return vcs.getFileContent(options.configPath ?? DEFAULT_CONFIG_PATH, baseSha, options.signal);
    }

    return readLocalConfig(options.localConfigPath);
}

async function readLocalConfig(filePath: string): Promise<string> {
    try {
        return await readFile(filePath, 'utf8');
    } catch (error) {
        throw new ConfigParseError(`Failed to read the explicit config ${filePath}: ${describeError(error)}`);
    }
}

/* Operational inputs win; `defaultModel` maps to `model`. Provider is validated
   before merging. */
function operationalOverride(operational: OperationalInputs, allowNativeProvider: boolean): Record<string, unknown> {
    const override: Record<string, unknown> = {};

    if (operational.provider !== undefined) {
        override.provider = operationalProvider(operational.provider, allowNativeProvider);
    }

    if (operational.defaultModel !== undefined) {
        override.model = operational.defaultModel;
    }

    return override;
}

function operationalProvider(provider: string, allowNativeProvider: boolean): string {
    const resolved = resolveOperationalProvider(provider, allowNativeProvider);

    if (resolved === undefined) {
        throw new ConfigValidationError(`Unknown operational provider "${provider}".`);
    }

    return resolved;
}

function loadEmbeddedDefaults(): UserReviewConfig {
    return validateUserReviewConfig(parseYamlContent(String(embeddedDefaults), 'defaults/review.yml'));
}

// eslint-disable-next-line anti-slop/no-unknown-returns -- YAML parses to unknown until schema-validated
function parseYamlContent(content: string, sourceName: string): unknown {
    try {
        return parseYaml(content);
    } catch (error) {
        const reason = describeError(error);
        throw new ConfigParseError(`Failed to parse YAML config from ${sourceName}: ${reason}`);
    }
}

function buildResolvedConfig(merged: UserReviewConfig): ResolvedReviewConfig {
    /* Defaults carry the full rule set; a repo may replace single lists via
       the canonical merge. */
    const classification = { ...defaultClassificationRules(), ...merged.classification };

    const resolved: ResolvedReviewConfig = {
        provider: merged.provider ?? DEFAULT_PROVIDER,
        model: merged.model,
        models: merged.models,
        classification,
        /* Risk tuning is optional; absent means the canonical defaults. A
           custom `escalations` list replaces the whole list. */
        risk: riskRulesForConfig(classification, merged.risk),
        agents: buildAgentsConfig(merged),
        review: buildReviewConfig(merged),
        tools: buildToolsConfig(merged),
        prompts: { overrides: merged.prompts?.overrides }
    };

    validateRoutedModels(resolved);

    return resolved;
}

function buildAgentsConfig(merged: UserReviewConfig): ResolvedReviewConfig['agents'] {
    return {
        disabled: merged.agents?.disabled ?? [],
        roles: merged.agents?.roles,
        plan: merged.agents?.plan ?? DEFAULT_AGENT_PLAN
    };
}

function buildReviewConfig(merged: UserReviewConfig): ResolvedReviewConfig['review'] {
    return {
        failurePolicy: merged.review?.failurePolicy ?? DEFAULT_FAILURE_POLICY,
        deadlineMinutes: merged.review?.deadlineMinutes ?? DEFAULT_DEADLINE_MINUTES,
        diffBudgetChars: merged.review?.diffBudgetChars ?? DEFAULT_DIFF_BUDGET_CHARS,
        exclude: merged.review?.exclude ?? []
    };
}

function buildToolsConfig(merged: UserReviewConfig): ResolvedReviewConfig['tools'] {
    return {
        context7: {
            enabled: merged.tools?.context7?.enabled ?? false,
            url: merged.tools?.context7?.url
        },
        web: { enabled: merged.tools?.web?.enabled ?? false }
    };
}

/* Recursive merge: objects merge, scalars and arrays replace. Most operational
   value wins. */
export function mergeConfigs(
    base: Record<string, unknown>,
    override: Record<string, unknown> | undefined
): Record<string, unknown> {
    if (!override) {
        return { ...base };
    }

    const merged: Record<string, unknown> = { ...base };

    for (const [key, overrideValue] of Object.entries(override)) {
        const baseValue = merged[key];

        if (isPlainObject(baseValue) && isPlainObject(overrideValue)) {
            merged[key] = mergeConfigs(baseValue, overrideValue);
        } else {
            merged[key] = overrideValue;
        }
    }

    return merged;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    // eslint-disable-next-line anti-slop/no-runtime-typeof -- object guard at the YAML decode boundary
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export { DEFAULT_DEADLINE_MINUTES, DEFAULT_DIFF_BUDGET_CHARS, DEFAULT_FAILURE_POLICY, DEFAULT_PROVIDER };

export { ConfigValidationError } from './validation';

export type { OperationalInputs, ResolvedReviewConfig };
