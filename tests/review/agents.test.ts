import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadReviewConfig } from '../../src/config/load';
import { type AgentPlan, DEFAULT_AGENT_PLAN } from '../../src/config/schema';
import {
    AgentRosterError,
    buildAgentRoster,
    canResolveModelRoute,
    collectRoutedModelIds,
    parseModelRef,
    resolveModelRoute,
    selectAgentPlan
} from '../../src/review/agents';

// eslint-disable-next-line anti-slop/no-unsafe-dictionary-type -- agents-config fixture passed through to the roster builder
function roster(agentsConfig: Record<string, unknown> = {}): ReturnType<typeof buildAgentRoster> {
    return buildAgentRoster({ agents: agentsConfig });
}

/* The (agent, tier) matrix from the task contract: the resolution test below
   pins every cell of this table. */
const EXAMPLE_MATRIX = {
    coordinator: { lite: 'minimax-m3', standard: 'qwen3.7-max', hard: 'qwen3.7-max' },
    correctness: { lite: 'qwen3.7-plus', standard: 'kimi-k2.6', hard: 'glm-5.2' },
    security: { hard: 'deepseek-v4-pro' },
    performance: { hard: 'glm-5.2' },
    conventions: { standard: 'minimax-m3', hard: 'minimax-m3' },
    maintainability: { standard: 'kimi-k2.6', hard: 'glm-5.2' },
    verifier: { lite: 'glm-5.2', standard: 'glm-5.2', hard: 'deepseek-v4-pro' }
};

describe('agent roster', () => {
    test('provides every built-in role with a distinct objective by default', () => {
        const defaultRoster = roster();
        const ids = defaultRoster.specs.map((spec) => spec.id);
        expect(ids).toEqual([
            'correctness',
            'security',
            'performance',
            'conventions',
            'maintainability',
            'tests',
            'coordinator',
            'verifier'
        ]);
        const objectives = new Set(defaultRoster.specs.map((spec) => spec.objective));
        expect(objectives.size).toBe(defaultRoster.specs.length);
    });

    test('gives the tests specialist its full built-in proof objective', () => {
        const tests = roster().specs.find((spec) => spec.id === 'tests');
        expect(tests?.objective).toBe(
            'Find proof gaps: changed behavior without a meaningful test, weak assertions, and tests that pass while the behavior breaks.'
        );
    });

    test('honor disabled agents', () => {
        const defaultRoster = roster({ disabled: ['performance'] });
        expect(defaultRoster.specs.map((spec) => spec.id)).not.toContain('performance');
        expect(defaultRoster.disabled).toContain('performance');
    });

    test('adds declarative roles with their globs and objective', () => {
        const defaultRoster = roster({
            roles: [{ name: 'migrations', objective: 'Review schema migrations.', globs: ['**/migrations/**'] }]
        });

        const role = defaultRoster.specs.find((spec) => spec.id === 'migrations');
        expect(role?.kind).toBe('role');
        expect(role?.globs).toEqual(['**/migrations/**']);
        expect(role?.objective).toBe('Review schema migrations.');
    });

    test('rejects roles shadowing built-in ids', () => {
        expect(() => roster({ roles: [{ name: 'security', objective: 'evil override', globs: ['**'] }] })).toThrow(
            AgentRosterError
        );
    });

    test('rejects a built-in role collision even when that id is disabled', () => {
        expect(() =>
            roster({ disabled: ['security'], roles: [{ name: 'security', objective: 'override', globs: ['src/**'] }] })
        ).toThrow(AgentRosterError);
    });

    test('rejects a duplicated declarative role name', () => {
        const twice = [
            { name: 'migrations', objective: 'First.', globs: ['**/migrations/**'] },
            { name: 'migrations', objective: 'Second.', globs: ['**/other/**'] }
        ];

        expect(() => roster({ roles: twice })).toThrow(AgentRosterError);
    });

    test('a disabled declarative role never enters the roster', () => {
        const defaultRoster = roster({
            disabled: ['migrations'],
            roles: [{ name: 'migrations', objective: 'Review migrations.', globs: ['**/migrations/**'] }]
        });

        expect(defaultRoster.specs.map((spec) => spec.id)).not.toContain('migrations');
    });
});

describe('agent plan selection', () => {
    test('lite tier keeps correctness, tests, coordinator and verifier', () => {
        const plan = selectAgentPlan({ roster: roster(), tier: 'lite', requiredSpecialists: [] });
        expect(plan.map((spec) => spec.id)).toEqual(['correctness', 'tests', 'coordinator', 'verifier']);
    });

    test('standard tier adds conventions and maintainability but never drops tests', () => {
        const plan = selectAgentPlan({ roster: roster(), tier: 'standard', requiredSpecialists: [] });
        expect(plan.map((spec) => spec.id)).toContain('conventions');
        expect(plan.map((spec) => spec.id)).toContain('maintainability');
        expect(plan.map((spec) => spec.id)).toContain('tests');
    });

    test('required specialists are added even on lite tier, each at most once', () => {
        const plan = selectAgentPlan({ roster: roster(), tier: 'lite', requiredSpecialists: ['security', 'security'] });
        expect(plan.filter((spec) => spec.id === 'security')).toHaveLength(1);
    });

    test('declarative roles always run once with their globs', () => {
        const defaultRoster = roster({
            roles: [{ name: 'migrations', objective: 'Review migrations.', globs: ['**/migrations/**'] }]
        });

        const plan = selectAgentPlan({ roster: defaultRoster, tier: 'lite', requiredSpecialists: [] });
        const migrations = plan.find((spec) => spec.id === 'migrations');
        expect(migrations?.kind).toBe('role');
        expect(migrations?.globs).toEqual(['**/migrations/**']);
    });

    test('hard tier runs every specialist systematically without signals', () => {
        const ids = selectAgentPlan({ roster: roster(), tier: 'hard', requiredSpecialists: [] }).map((spec) => spec.id);
        expect(ids.join(',')).toBe(
            'correctness,security,performance,conventions,maintainability,tests,coordinator,verifier'
        );
    });

    test('lite and standard tiers gain signal specialists only through signals', () => {
        for (const tier of ['lite', 'standard'] as const) {
            const plain = selectAgentPlan({ roster: roster(), tier, requiredSpecialists: [] }).map((spec) => spec.id);

            const signaled = selectAgentPlan({
                roster: roster(),
                tier,
                requiredSpecialists: ['security', 'performance']
            }).map((spec) => spec.id);

            expect(plain).not.toContain('security');
            expect(signaled).toContain('security');
            expect(signaled).toContain('performance');
        }
    });

    test('a disabled specialist stays excluded even on the systematic hard tier', () => {
        const ids = selectAgentPlan({
            roster: roster({ disabled: ['performance'] }),
            tier: 'hard',
            requiredSpecialists: ['performance']
        }).map((spec) => spec.id);

        expect(ids).not.toContain('performance');
        expect(ids).toContain('security');
    });

    test('an explicit tier plan replaces the built-in policy', () => {
        const custom: AgentPlan = { ...DEFAULT_AGENT_PLAN, lite: ['coordinator', 'verifier'] };
        const plan = selectAgentPlan({ roster: roster(), tier: 'lite', requiredSpecialists: [], plan: custom });
        expect(plan.map((spec) => spec.id)).toEqual(['coordinator', 'verifier']);
    });
});

describe('model route resolution', () => {
    const base = { provider: 'anthropic' };

    test('the example (agent, tier) matrix resolves per the contract table', () => {
        const config = { provider: 'openai-compatible', models: { routing: EXAMPLE_MATRIX } };
        expect(resolveModelRoute(config, 'coordinator', 'lite').model).toBe('minimax-m3');
        expect(resolveModelRoute(config, 'coordinator', 'standard').model).toBe('qwen3.7-max');
        expect(resolveModelRoute(config, 'coordinator', 'hard').model).toBe('qwen3.7-max');
        expect(resolveModelRoute(config, 'correctness', 'lite').model).toBe('qwen3.7-plus');
        expect(resolveModelRoute(config, 'correctness', 'standard').model).toBe('kimi-k2.6');
        expect(resolveModelRoute(config, 'correctness', 'hard').model).toBe('glm-5.2');
        expect(resolveModelRoute(config, 'security', 'hard').model).toBe('deepseek-v4-pro');
        expect(resolveModelRoute(config, 'performance', 'hard').model).toBe('glm-5.2');
        expect(resolveModelRoute(config, 'conventions', 'standard').model).toBe('minimax-m3');
        expect(resolveModelRoute(config, 'maintainability', 'hard').model).toBe('glm-5.2');
        expect(resolveModelRoute(config, 'verifier', 'hard').model).toBe('deepseek-v4-pro');
        expect(config.provider).toBe('openai-compatible');
    });

    test('an exact cell beats the agent default and the global model', () => {
        const route = resolveModelRoute(
            {
                ...base,
                model: 'global-model',
                models: { routing: { security: { default: 'agent-default', hard: 'hard-model' } } }
            },
            'security',
            'hard'
        );

        expect(route).toEqual({ provider: 'anthropic', model: 'hard-model' });
    });

    test('the agent default applies when the tier cell is absent', () => {
        const route = resolveModelRoute(
            { ...base, model: 'global-model', models: { routing: { security: { default: 'agent-default' } } } },
            'security',
            'lite'
        );

        expect(route.model).toBe('agent-default');
    });

    test('the global model applies when the agent has no routing entry', () => {
        const route = resolveModelRoute(
            { ...base, model: 'global-model', models: { routing: { security: { hard: 'hard-model' } } } },
            'correctness',
            'hard'
        );

        expect(route.model).toBe('global-model');
    });

    test('the global model covers systematic hard specialists through the fallback', () => {
        const config = { provider: 'anthropic', model: 'global-model' };

        for (const agentId of ['security', 'performance']) {
            expect(resolveModelRoute(config, agentId, 'hard').model).toBe('global-model');
        }
    });

    test('an unresolved (agent, tier) resolves to no model instead of a wrong one', () => {
        const config = { provider: 'anthropic', models: { routing: { security: { hard: 'hard-model' } } } };
        expect(resolveModelRoute(config, 'security', 'lite')).toEqual({ provider: 'anthropic', model: undefined });
        expect(canResolveModelRoute(config, 'security', 'lite')).toBe(false);
        expect(canResolveModelRoute(config, 'security', 'hard')).toBe(true);
    });

    test('an empty model id fails closed to no model', () => {
        expect(resolveModelRoute({ provider: 'anthropic', model: '' }, 'security', 'lite')).toEqual({
            provider: 'anthropic',
            model: undefined
        });
        expect(resolveModelRoute({ provider: 'anthropic', model: '#overlay' }, 'security', 'lite')).toEqual({
            provider: 'anthropic',
            model: undefined
        });
        expect(canResolveModelRoute({ provider: 'anthropic', model: '' }, 'security', 'lite')).toBe(false);
    });

    test('an empty or default variant means no overlay', () => {
        expect(parseModelRef('model')).toEqual({ modelID: 'model' });
        expect(parseModelRef('model#')).toEqual({ modelID: 'model', variant: undefined });
        expect(parseModelRef('model#default')).toEqual({ modelID: 'model', variant: undefined });
        expect(parseModelRef('model#fast')).toEqual({ modelID: 'model', variant: 'fast' });
    });

    test('the tests specialist resolves through the same chain as every other agent', () => {
        const config = {
            provider: 'anthropic',
            model: 'global-model',
            models: { routing: { tests: { standard: 'tests-standard' } } }
        };

        expect(resolveModelRoute(config, 'tests', 'standard').model).toBe('tests-standard');
        expect(resolveModelRoute(config, 'tests', 'lite').model).toBe('global-model');
        expect(resolveModelRoute(config, 'tests', 'hard').model).toBe('global-model');
    });
});

const MATRIX_CONFIG = [
    'provider: openai-compatible',
    'model: global-model',
    'models:\n  routing:\n    coordinator: { lite: minimax-m3, standard: qwen3.7-max, hard: qwen3.7-max }\n    correctness: { standard: kimi-k2.6, hard: glm-5.2 }\n    security: { hard: deepseek-v4-pro }\n    performance: { hard: glm-5.2 }\n    conventions: { standard: minimax-m3, hard: minimax-m3 }\n    maintainability: { standard: kimi-k2.6, hard: glm-5.2 }\n    tests: { standard: kimi-k2.6, hard: glm-5.2 }\n    verifier: { standard: glm-5.2, hard: deepseek-v4-pro }'
].join('\n');

describe('Action and CLI routing parity', () => {
    test('both entrypoints load one matrix and resolve identical routes', async () => {
        const baseSha = 'a'.repeat(40);
        const actionConfig = await loadReviewConfig({ getFileContent: () => Promise.resolve(MATRIX_CONFIG) }, baseSha);
        const root = await mkdtemp(path.join(tmpdir(), 'sakre-routing-'));

        try {
            const localPath = path.join(root, 'trusted.yml');
            await writeFile(localPath, MATRIX_CONFIG, 'utf8');

            const cliConfig = await loadReviewConfig({ getFileContent: () => Promise.resolve(null) }, baseSha, {
                localConfigPath: localPath
            });

            for (const agentId of Object.keys(EXAMPLE_MATRIX)) {
                for (const tier of ['lite', 'standard', 'hard'] as const) {
                    expect(resolveModelRoute(cliConfig, agentId, tier)).toEqual(
                        resolveModelRoute(actionConfig, agentId, tier)
                    );
                }
            }

            expect(collectRoutedModelIds(cliConfig)).toEqual(collectRoutedModelIds(actionConfig));
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});

describe('declared model catalogue', () => {
    test('collects the global model and every routing cell once, sorted', () => {
        const ids = collectRoutedModelIds({
            model: 'global-model',
            models: {
                routing: {
                    security: { hard: 'agent-model', default: 'global-model' },
                    verifier: { lite: 'tier-model' }
                }
            }
        });

        expect(ids).toEqual(['agent-model', 'global-model', 'tier-model']);
    });

    test('returns nothing when no model is declared', () => {
        expect(collectRoutedModelIds({})).toEqual([]);
    });

    test('covers every model the pipeline can resolve for a routing-only config', () => {
        const config = { provider: 'openai-compatible', models: { routing: EXAMPLE_MATRIX } };
        const declared = collectRoutedModelIds(config);

        for (const agentId of Object.keys(EXAMPLE_MATRIX)) {
            for (const tier of ['lite', 'standard', 'hard'] as const) {
                const route = resolveModelRoute(config, agentId, tier);

                if (route.model !== undefined) {
                    expect(declared).toContain(route.model);
                }
            }
        }
    });
});
