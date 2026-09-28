import picomatch from 'picomatch';
import { DEFAULT_RISK_RULES } from '../analysis/risk-rules';
import { collectRoutedModelIds } from '../review/agents';
import { type AgentRouting, builtInAgentIds, type UserReviewConfig, userReviewConfigSchema } from './schema';

const PLAN_TIERS = ['lite', 'standard', 'hard'] as const;

export class ConfigValidationError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = 'ConfigValidationError';
    }
}

/* Universal globs are refused: a pattern matching every sentinel path is
   rejected, whatever grammar it uses. */
const UNIVERSAL_GLOB_SENTINELS = ['file.txt', 'dir/file.txt', 'deep/nested/file.txt', '.hidden-file'] as const;

/* Schema parse plus semantic rules the JSON schema cannot express: safe globs,
   known routing ids, non-empty routes, well-formed refs, and tier roster. */
// eslint-disable-next-line anti-slop/no-unknown-parameters -- zod schema parses external config at this boundary
export function validateUserReviewConfig(value: unknown): UserReviewConfig {
    const parsed = userReviewConfigSchema.parse(value);

    for (const role of parsed.agents?.roles ?? []) {
        validateSafeGlobs(role.globs, `agents.roles[${role.name}].globs`);
    }

    validateRoutingAgents(parsed);
    validateAgentPlan(parsed);
    validateModelRefs(parsed);
    validateRiskConfig(parsed);

    return parsed;
}

export function validateSafeGlobs(globs: string[], errorPrefix: string): void {
    for (const glob of globs) {
        if (looksUniversal(glob)) {
            throw new ConfigValidationError(`${errorPrefix}: universal glob "${glob}" is not allowed.`);
        }
    }
}

/* Optional risk tuning fails closed: effective thresholds keep their order,
   escalation ids stay unique and non-blank, patterns stay safe. */
function validateRiskConfig(config: UserReviewConfig): void {
    const { risk } = config;

    if (risk === undefined) {
        return;
    }

    const lite = risk.thresholds?.liteMaxScore ?? DEFAULT_RISK_RULES.thresholds.liteMaxScore;
    const standard = risk.thresholds?.standardMaxScore ?? DEFAULT_RISK_RULES.thresholds.standardMaxScore;

    if (!(Number.isFinite(lite) && Number.isFinite(standard) && lite >= 0 && lite < standard)) {
        throw new ConfigValidationError(
            `risk.thresholds requires 0 <= liteMaxScore < standardMaxScore, got liteMaxScore=${lite}, standardMaxScore=${standard}.`
        );
    }

    validateRiskEscalations(config);
}

function validateRiskEscalations(config: UserReviewConfig): void {
    const escalations = config.risk?.escalations;

    if (escalations === undefined) {
        return;
    }

    const seen = new Set<string>();

    for (const [index, rule] of escalations.entries()) {
        assertUniqueEscalationId(rule.id, index, seen);
        validateSafeGlobs(rule.patterns, `risk.escalations[${rule.id}].patterns`);
    }
}

function assertUniqueEscalationId(ruleId: string, index: number, seen: Set<string>): void {
    if (ruleId.trim() === '') {
        throw new ConfigValidationError(`risk.escalations[${index}].id must not be blank.`);
    }

    if (seen.has(ruleId)) {
        throw new ConfigValidationError(`risk.escalations ids must be unique, duplicate "${ruleId}".`);
    }

    seen.add(ruleId);
}

function looksUniversal(glob: string): boolean {
    return UNIVERSAL_GLOB_SENTINELS.every((sentinel) => matchesSentinel(glob, sentinel));
}

function matchesSentinel(glob: string, sentinel: string): boolean {
    const isMatch = picomatch(glob, { dot: true });

    return isMatch(sentinel);
}

/* Routing ids and plan entries must name a built-in or a declared role; typos
   fail at load instead of resolving to nothing at run time. */
function validateRoutingAgents(config: UserReviewConfig): void {
    const known = knownAgentIds(config);

    for (const [agentId, route] of Object.entries(config.models?.routing ?? {})) {
        if (!known.has(agentId)) {
            throw new ConfigValidationError(`models.routing.${agentId} is not a known agent id.`);
        }

        if (!hasRoutingModel(route)) {
            throw new ConfigValidationError(`models.routing.${agentId} does not declare a default or tier model.`);
        }
    }
}

function hasRoutingModel(route: AgentRouting): boolean {
    return (
        route.default !== undefined ||
        route.lite !== undefined ||
        route.standard !== undefined ||
        route.hard !== undefined
    );
}

function validateAgentPlan(config: UserReviewConfig): void {
    const known = knownAgentIds(config);

    for (const tier of PLAN_TIERS) {
        for (const agentId of config.agents?.plan?.[tier] ?? []) {
            if (!known.has(agentId)) {
                throw new ConfigValidationError(`agents.plan.${tier} references unknown agent "${agentId}".`);
            }
        }
    }
}

function knownAgentIds(config: UserReviewConfig): Set<string> {
    const known = new Set<string>(builtInAgentIds);

    for (const role of config.agents?.roles ?? []) {
        known.add(role.name);
    }

    return known;
}

/* A ref is `model` or `model#variant`. Only the shape is checked here, so typos
   fail at load instead of picking the default silently. */
function validateModelRefs(config: UserReviewConfig): void {
    validateRoutingRefs({ model: config.model, routing: config.models?.routing });
    validateCatalogKeys(Object.keys(config.models?.catalog ?? {}));
}

function validateRoutingRefs(config: { model?: string; routing?: Record<string, AgentRouting> }): void {
    if (config.model !== undefined) {
        validateModelRef(config.model, 'model');
    }

    for (const [agentId, route] of Object.entries(config.routing ?? {})) {
        validateRouteRefs(agentId, route);
    }
}

function validateRouteRefs(agentId: string, route: AgentRouting): void {
    for (const tier of ['default', 'lite', 'standard', 'hard'] as const) {
        const ref = route[tier];

        if (ref !== undefined) {
            validateModelRef(ref, `models.routing.${agentId}.${tier}`);
        }
    }
}

function validateCatalogKeys(catalogIds: string[]): void {
    for (const catalogId of catalogIds) {
        if (catalogId.includes('#')) {
            throw new ConfigValidationError(
                `models.catalog.${catalogId} must be a base model id without a variant overlay.`
            );
        }

        if (catalogId.trim() === '') {
            throw new ConfigValidationError('models.catalog keys must not be blank.');
        }
    }
}

function validateModelRef(ref: string, path: string): void {
    const separator = ref.indexOf('#');

    if (separator === -1) {
        assertNonBlank(ref, path);

        return;
    }

    assertModelPart(ref.slice(0, separator), path);
    assertVariantPart(ref.slice(separator + 1), path);
}

function assertNonBlank(ref: string, path: string): void {
    if (ref.trim() === '') {
        throw new ConfigValidationError(`${path} must not be blank.`);
    }
}

function assertModelPart(modelID: string, path: string): void {
    if (modelID.trim() === '' || modelID.includes('#')) {
        throw new ConfigValidationError(`${path} has an empty model id before "#".`);
    }
}

function assertVariantPart(variant: string, path: string): void {
    if (variant === '' || variant.includes('#')) {
        throw new ConfigValidationError(`${path} has an empty variant after "#".`);
    }

    if (variant.trim() === '') {
        throw new ConfigValidationError(`${path} has a blank variant after "#".`);
    }
}

/* Catalog entries must be referenced: an unreferenced entry is a config mistake.
   Variants are stripped before comparison: catalogue owns models, OpenCode
   owns overlays. */
export function validateRoutedModels(config: {
    model?: string;
    // eslint-disable-next-line anti-slop/no-unsafe-dictionary-type -- catalog carries unvalidated model metadata
    models?: { catalog?: Record<string, unknown>; routing?: Record<string, AgentRouting> };
}): void {
    validateRoutingRefs({ model: config.model, routing: config.models?.routing });
    validateCatalogReference(config);
}

function validateCatalogReference(config: {
    model?: string;
    // eslint-disable-next-line anti-slop/no-unsafe-dictionary-type -- catalog carries unvalidated model metadata
    models?: { catalog?: Record<string, unknown>; routing?: Record<string, AgentRouting> };
}): void {
    const catalog = Object.keys(config.models?.catalog ?? {});

    if (catalog.length === 0) {
        return;
    }

    const referenced = new Set(collectRoutedModelIds(config));

    for (const modelId of catalog) {
        if (!referenced.has(modelId)) {
            throw new ConfigValidationError(
                `models.catalog.${modelId} is not referenced by models.routing or the global model.`
            );
        }
    }
}
