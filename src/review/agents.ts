import {
    type AgentPlan,
    type AgentRouting,
    builtInAgentIds,
    DEFAULT_AGENT_PLAN,
    type ModelCatalogEntry,
    type RiskTier,
    type UserReviewConfig
} from '../config/schema';

export type AgentKind = 'builtin' | 'role';

export interface AgentSpec {
    id: string;
    kind: AgentKind;
    objective: string;
    globs?: string[];
}

export interface AgentRoster {
    specs: AgentSpec[];
    disabled: string[];
}

export interface ResolvedModelRoute {
    provider: string;
    /* Undefined when no routing level declares a model; the pipeline fails
       closed for an active pair before any provider call. */
    model?: string;
    /* Undefined means the default variant; transported to the session `variant`
       field so OpenCode resolves it. */
    variant?: string;
}

const BUILTIN_OBJECTIVES: Record<string, string> = {
    correctness: 'Find bugs the compiler cannot see: broken logic, wrong error handling, race conditions, data loss.',
    security: 'Find exploitable weaknesses: injection, auth bypass, secret exposure, unsafe deserialization.',
    performance: 'Find regressions that matter at scale: N+1 queries, unbounded loops, blocking I/O, memory growth.',
    conventions: 'Find violations of the repository conventions and documentation drift.',
    maintainability: 'Find changes that make future changes harder: dead code, duplicated logic, leaky abstractions.',
    tests: 'Find proof gaps: changed behavior without a meaningful test, weak assertions, and tests that pass while the behavior breaks.',
    coordinator: 'Adjudicate specialist findings against the full diff and decide the final finding set.',
    verifier: 'Independently confirm or reject a single candidate finding using only repository evidence.'
};

/* Effective roster: enabled built-in agents, plus declarative roles from the
protected configuration. A role cannot shadow a built-in agent id. */
export function buildAgentRoster(config: Pick<UserReviewConfig, 'agents'>): AgentRoster {
    const agents = config.agents ?? {};
    const disabled = new Set<string>(agents.disabled);
    const specs: AgentSpec[] = [];
    const roleIds = new Set<string>();

    for (const role of agents.roles ?? []) {
        if (isBuiltinId(role.name)) {
            throw new AgentRosterError(`Role "${role.name}" shadows a built-in agent id.`);
        }

        if (roleIds.has(role.name)) {
            throw new AgentRosterError(`Role "${role.name}" is declared more than once.`);
        }

        roleIds.add(role.name);
    }

    for (const id of builtInAgentIds) {
        if (!disabled.has(id)) {
            const objective = BUILTIN_OBJECTIVES[id] ?? `Review as ${id}.`;
            specs.push({ id, kind: 'builtin', objective });
        }
    }

    for (const role of agents.roles ?? []) {
        if (!disabled.has(role.name)) {
            specs.push({ id: role.name, kind: 'role', objective: role.objective, globs: role.globs });
        }
    }

    return { specs, disabled: [...disabled].toSorted() };
}

export class AgentRosterError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = 'AgentRosterError';
    }
}

function isBuiltinId(id: string): boolean {
    // SAFETY: built-in ids are declared as string literals, so widening to string for the lookup is sound.
    return (builtInAgentIds as readonly string[]).includes(id);
}

/* Tier policy selects built-ins; required specialists and declarative roles
   always run. Each agent appears once. */
export interface AgentPlanInput {
    roster: AgentRoster;
    tier: RiskTier;
    requiredSpecialists: string[];
    plan?: AgentPlan;
}

export function selectAgentPlan(input: AgentPlanInput): AgentSpec[] {
    const plan = input.plan ?? DEFAULT_AGENT_PLAN;
    const configured = plan[input.tier];
    const basePlan = specsFor(input.roster, [...configured, ...input.requiredSpecialists]);
    const roles = input.roster.specs.filter((spec) => spec.kind === 'role');
    const seen = new Set<string>();
    const selected: AgentSpec[] = [];

    for (const spec of [...basePlan, ...roles]) {
        if (!seen.has(spec.id)) {
            seen.add(spec.id);
            selected.push(spec);
        }
    }

    return selected;
}

function specsFor(roster: AgentRoster, ids: string[]): AgentSpec[] {
    const specs: AgentSpec[] = [];

    for (const id of ids) {
        const spec = roster.specs.find((candidate) => candidate.kind === 'builtin' && candidate.id === id);

        if (spec !== undefined) {
            specs.push(spec);
        }
    }

    return specs;
}

/* Provider always defined here; model follows matrix order (agent+tier cell,
   agent default, global model). */
export interface ModelRoutingConfig {
    provider: string;
    model?: string;
    models?: {
        catalog?: Record<string, ModelCatalogEntry>;
        routing?: Record<string, AgentRouting>;
    };
}

export function resolveModelRoute(config: ModelRoutingConfig, agentId: string, tier: RiskTier): ResolvedModelRoute {
    const routing = config.models?.routing?.[agentId];
    const ref = routing?.[tier] ?? routing?.default ?? config.model;

    if (ref === undefined) {
        return { provider: config.provider, model: undefined };
    }

    const parsed = parseModelRef(ref);

    if (parsed.modelID === '') {
        return { provider: config.provider, model: undefined };
    }

    return { provider: config.provider, model: parsed.modelID, variant: parsed.variant };
}

/* Fail-closed check used before the first provider call: an active (agent, tier)
   must resolve to a model through the matrix or the global fallback. */
export function canResolveModelRoute(config: ModelRoutingConfig, agentId: string, tier: RiskTier): boolean {
    return resolveModelRoute(config, agentId, tier).model !== undefined;
}

/* `model` selects the default variant, `model#variant` the named overlay,
   `model#default` selects no overlay. Only the first `#` splits; empty parts
   are rejected. OpenCode owns the catalogue and rejects an unknown id. */
export function parseModelRef(ref: string): { modelID: string; variant?: string } {
    const separator = ref.indexOf('#');

    if (separator === -1) {
        return { modelID: ref };
    }

    const modelID = ref.slice(0, separator);
    const variant = ref.slice(separator + 1);

    if (variant === '' || variant === 'default') {
        return { modelID, variant: undefined };
    }

    return { modelID, variant };
}

/* Base model id without the variant overlay; the catalogue keys on model id. */
export function baseModelId(ref: string): string {
    return parseModelRef(ref).modelID;
}

/* Every routable model id, including the global one. Basis for a custom
   provider catalogue. Variants are stripped: the catalogue owns models,
   OpenCode owns overlays. */
export function collectRoutedModelIds(config: {
    model?: string;
    models?: { routing?: Record<string, AgentRouting> };
}): string[] {
    const ids = new Set<string>();

    if (config.model !== undefined) {
        ids.add(baseModelId(config.model));
    }

    for (const route of Object.values(config.models?.routing ?? {})) {
        for (const model of [route.default, route.lite, route.standard, route.hard]) {
            if (model !== undefined) {
                ids.add(baseModelId(model));
            }
        }
    }

    return [...ids].toSorted();
}
