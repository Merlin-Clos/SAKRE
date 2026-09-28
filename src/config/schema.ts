import { z } from 'zod';
import { DEFAULT_CONFIG_PATH, PRODUCT_NAME } from '../identity';
import { ACTION_PROVIDER_FAMILIES } from './providers';

const reviewProviders = ACTION_PROVIDER_FAMILIES;

const riskTiers = ['lite', 'standard', 'hard'] as const;

const builtInAgentIds = [
    'correctness',
    'security',
    'performance',
    'conventions',
    'maintainability',
    'tests',
    'coordinator',
    'verifier'
] as const;

const promptIds = [
    'shared',
    'correctness',
    'security',
    'performance',
    'conventions',
    'maintainability',
    'tests',
    'coordinator',
    'verifier'
] as const;

const MIN_DEADLINE_MINUTES = 1;

const MAX_DEADLINE_MINUTES = 60;

const MIN_DIFF_BUDGET_CHARS = 20_000;

const MAX_DIFF_BUDGET_CHARS = 1_000_000;

const ROLE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;

const REPO_CONFIG_SCHEMA_TITLE = `${PRODUCT_NAME} repository config (${DEFAULT_CONFIG_PATH})`;

/* A glob must stay inside the repo: no absolute path, no '..'. Universal globs
   are caught by semantic validation below. */
const SAFE_GLOB_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$)).+$/u;

const providerSchema = z.enum(reviewProviders);

const riskTierSchema = z.enum(riskTiers);

/* Model routing: plain (agent, tier) matrix plus optional catalog metadata. */
const modelCatalogEntrySchema = z.strictObject({
    artificialAnalysisUrl: z.url().optional()
});

const agentRoutingSchema = z.strictObject({
    default: z.string().min(1).optional(),
    lite: z.string().min(1).optional(),
    standard: z.string().min(1).optional(),
    hard: z.string().min(1).optional()
});

const modelsSchema = z.strictObject({
    catalog: z.record(z.string().min(1), modelCatalogEntrySchema).optional(),
    routing: z.record(z.string().min(1), agentRoutingSchema).optional()
});

const safeGlobSchema = z
    .string()
    .min(1)
    .regex(SAFE_GLOB_PATTERN, 'Glob must be relative and stay inside the repository.');

const globListSchema = z.array(safeGlobSchema).min(1);

/* Classification rules: single owner for risk, ReviewMap, and diff metadata. Each
   list is required in defaults and optional in overrides, so repos extend it. */
const classificationRulesSchema = z.strictObject({
    lockfilePatterns: globListSchema,
    vendorPatterns: globListSchema,
    assetPatterns: globListSchema,
    generatedPathPatterns: globListSchema,
    generatedMarkers: z.array(z.string().min(1)).min(1),
    generatedExceptions: globListSchema,
    docsPatterns: globListSchema,
    testPatterns: globListSchema,
    configPatterns: globListSchema,
    dependencyManifestPatterns: globListSchema,
    criticalPathPatterns: globListSchema,
    securityPathPatterns: globListSchema,
    performancePathPatterns: globListSchema,
    conventionPathPatterns: globListSchema
});

const classificationOverridesSchema = classificationRulesSchema.partial();

const riskSpecialistSchema = z.enum(['security', 'performance', 'conventions']);

const riskEscalationTierSchema = z.enum(['standard', 'hard']);

const riskEscalationRuleSchema = z.strictObject({
    id: z.string().min(1),
    patterns: globListSchema,
    minTier: riskEscalationTierSchema,
    addSpecialist: riskSpecialistSchema.optional()
});

const riskThresholdsOverrideSchema = z
    .strictObject({
        liteMaxScore: z.number().nonnegative(),
        standardMaxScore: z.number().nonnegative()
    })
    .partial();

const riskWeightsOverrideSchema = z
    .strictObject({
        changedFiles: z.number().nonnegative(),
        changedLines: z.number().nonnegative()
    })
    .partial();

const riskRatiosOverrideSchema = z
    .strictObject({
        fileRatio: z.number().gt(0).lte(1),
        lineRatio: z.number().gt(0).lte(1)
    })
    .partial();

/* Optional per-repo risk tuning. Every field is a partial override; absent
   means the canonical default. `escalations` replaces the whole list. */
const riskOverridesSchema = z.strictObject({
    thresholds: riskThresholdsOverrideSchema.optional(),
    weights: riskWeightsOverrideSchema.optional(),
    ratios: riskRatiosOverrideSchema.optional(),
    largeChangeLines: z.int().min(1).optional(),
    escalations: z.array(riskEscalationRuleSchema).optional()
});

const roleSchema = z.strictObject({
    name: z.string().regex(ROLE_NAME_PATTERN, 'Role name must be lowercase alphanumeric with dashes.'),
    objective: z.string().min(1),
    globs: z.array(safeGlobSchema).min(1)
});

const planTierSchema = z.array(z.string().min(1)).min(1);

const agentPlanSchema = z.strictObject({
    lite: planTierSchema,
    standard: planTierSchema,
    hard: planTierSchema
});

const agentsSchema = z
    .strictObject({
        disabled: z.array(z.string().min(1)).optional(),
        roles: z.array(roleSchema).optional(),
        /* Tier policy for built-ins; required specialists and roles join in the
           pipeline. */
        plan: agentPlanSchema.optional()
    })
    .superRefine(({ roles }, ctx) => {
        const roleNames = new Set<string>();

        for (const [index, role] of (roles ?? []).entries()) {
            if (roleNames.has(role.name)) {
                ctx.addIssue({ code: 'custom', path: ['roles', index, 'name'], message: 'Role names must be unique.' });
            }

            roleNames.add(role.name);
        }
    });

const reviewSchema = z.strictObject({
    failurePolicy: z.enum(['fail-fast', 'continue-partial']).optional(),
    deadlineMinutes: z.number().int().min(MIN_DEADLINE_MINUTES).max(MAX_DEADLINE_MINUTES).optional(),
    diffBudgetChars: z.int().min(MIN_DIFF_BUDGET_CHARS).max(MAX_DIFF_BUDGET_CHARS).optional(),
    /* Declarative exclusion from automatic agent context: safe globs matched
       path-only. Empty means no exclusion. */
    exclude: z.array(safeGlobSchema).optional()
});

const REPO_PATH_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\\]+\.md$/u;

const promptIdSchema = z.enum(promptIds);

const promptsSchema = z.strictObject({
    overrides: z
        .partialRecord(
            promptIdSchema,
            z.string().regex(REPO_PATH_PATTERN, 'Prompt override must be a relative .md path inside the repository.')
        )
        .optional()
});

const toolsSchema = z.strictObject({
    context7: z
        .strictObject({
            enabled: z.boolean().optional(),
            url: z.url().optional()
        })
        .optional(),
    web: z.strictObject({ enabled: z.boolean().optional() }).optional()
});

/* Repo config file. Guardrails live outside it: unknown keys are rejected, so
   they stay unreplaceable. */
const userReviewConfigSchema = z.strictObject({
    provider: providerSchema.optional(),
    model: z.string().min(1).optional(),
    models: modelsSchema.optional(),
    classification: classificationOverridesSchema.optional(),
    risk: riskOverridesSchema.optional(),
    agents: agentsSchema.optional(),
    review: reviewSchema.optional(),
    tools: toolsSchema.optional(),
    prompts: promptsSchema.optional()
});

type ReviewProvider = (typeof reviewProviders)[number];

type BuiltInAgentId = (typeof builtInAgentIds)[number];

type PromptId = (typeof promptIds)[number];

type RiskTier = (typeof riskTiers)[number];

type ModelCatalogEntry = z.infer<typeof modelCatalogEntrySchema>;

type AgentRouting = z.infer<typeof agentRoutingSchema>;

type AgentRole = z.infer<typeof roleSchema>;

type UserReviewConfig = z.infer<typeof userReviewConfigSchema>;

type ClassificationRules = z.infer<typeof classificationRulesSchema>;

type ClassificationOverrides = z.infer<typeof classificationOverridesSchema>;

type AgentPlan = Record<RiskTier, string[]>;

/* Default tier policy, mirrored in embedded defaults. Hard runs all specialists;
   lite and standard add signal-driven ones. `tests` runs every tier; coordinator
   and verifier are required lifecycle roles. */
export const DEFAULT_AGENT_PLAN: AgentPlan = {
    lite: ['correctness', 'tests', 'coordinator', 'verifier'],
    standard: ['correctness', 'conventions', 'maintainability', 'tests', 'coordinator', 'verifier'],
    hard: [
        'correctness',
        'security',
        'performance',
        'conventions',
        'maintainability',
        'tests',
        'coordinator',
        'verifier'
    ]
};

type RiskEscalationOverride = z.infer<typeof riskEscalationRuleSchema>;

type RiskOverrides = z.infer<typeof riskOverridesSchema>;

export {
    builtInAgentIds,
    classificationOverridesSchema,
    classificationRulesSchema,
    MAX_DEADLINE_MINUTES,
    MAX_DIFF_BUDGET_CHARS,
    MIN_DEADLINE_MINUTES,
    MIN_DIFF_BUDGET_CHARS,
    providerSchema,
    promptIds,
    promptIdSchema,
    REPO_CONFIG_SCHEMA_TITLE,
    reviewProviders,
    riskEscalationRuleSchema,
    riskOverridesSchema,
    riskTierSchema,
    roleSchema,
    userReviewConfigSchema
};

export type {
    AgentPlan,
    AgentRole,
    AgentRouting,
    BuiltInAgentId,
    ClassificationOverrides,
    ClassificationRules,
    ModelCatalogEntry,
    PromptId,
    ReviewProvider,
    RiskEscalationOverride,
    RiskOverrides,
    RiskTier,
    UserReviewConfig
};
