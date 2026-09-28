import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import { DEFAULT_CONFIG_PATH } from '../../src/identity';
import {
    ConfigParseError,
    DEFAULT_DEADLINE_MINUTES,
    DEFAULT_DIFF_BUDGET_CHARS,
    loadReviewConfig
} from '../../src/config/load';
import {
    MAX_DEADLINE_MINUTES,
    MAX_DIFF_BUDGET_CHARS,
    MIN_DEADLINE_MINUTES,
    MIN_DIFF_BUDGET_CHARS
} from '../../src/config/schema';
import { EffectiveRunError, resolveEffectiveRun } from '../../src/config/effective-run';
import { rejectionOf } from '../helpers/rejection';

class FakeVcs {
    private readonly files: Record<string, string | null>;
    public calls: { path: string; ref: string }[] = [];

    public constructor(files: Record<string, string | null>) {
        this.files = files;
    }

    public getFileContent(path: string, ref: string): Promise<string | null> {
        this.calls.push({ path, ref });
        const value = this.files[path] ?? null;

        return Promise.resolve(value);
    }
}

const BASE_SHA = 'b'.repeat(40);

const HEAD_SHA = 'c'.repeat(40);

describe('protected config loading', () => {
    test('uses embedded defaults when the repository has no config', async () => {
        const vcs = new FakeVcs({});
        const config = await loadReviewConfig(vcs, BASE_SHA);
        expect(config.provider).toBe('anthropic');
        expect(config.review.deadlineMinutes).toBe(DEFAULT_DEADLINE_MINUTES);
        expect(config.review.failurePolicy).toBe('continue-partial');
        expect(config.review.diffBudgetChars).toBe(DEFAULT_DIFF_BUDGET_CHARS);
        expect(config.tools.context7.enabled).toBe(false);
        expect(config.tools.web.enabled).toBe(false);
    });

    test('resolves the complete classification rules from the embedded defaults', async () => {
        const config = await loadReviewConfig(new FakeVcs({}), BASE_SHA);
        expect(config.classification.lockfilePatterns).toContain('bun.lock');
        expect(config.classification.criticalPathPatterns).toContain('**/auth/**');
        expect(config.classification.securityPathPatterns).toContain('**/*secret*');
        expect(config.classification.generatedMarkers.length).toBeGreaterThan(0);
    });

    test('a repository classification override replaces only the lists it declares', async () => {
        const vcs = new FakeVcs({
            [DEFAULT_CONFIG_PATH]: 'classification:\n  lockfilePatterns:\n    - custom.lock\n'
        });

        const config = await loadReviewConfig(vcs, BASE_SHA);
        expect(config.classification.lockfilePatterns).toEqual(['custom.lock']);
        expect(config.classification.criticalPathPatterns).toContain('**/auth/**');
    });

    test('reads an explicit local config from disk instead of the base SHA', async () => {
        const root = await mkdtemp(nodePath.join(tmpdir(), 'sakre-local-config-'));

        try {
            const localPath = nodePath.join(root, 'trusted.yml');
            await writeFile(localPath, 'model: local-model\nreview:\n  diffBudgetChars: 30000\n', 'utf8');
            const vcs = new FakeVcs({});
            const config = await loadReviewConfig(vcs, BASE_SHA, { localConfigPath: localPath });
            expect(config.model).toBe('local-model');
            expect(config.review.diffBudgetChars).toBe(30_000);
            expect(vcs.calls).toHaveLength(0);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test('fails closed when the explicit local config is unreadable', async () => {
        const missingPath = nodePath.join(tmpdir(), 'sakre-missing-config.yml');

        const failure = await rejectionOf(
            loadReviewConfig(new FakeVcs({}), BASE_SHA, { localConfigPath: missingPath })
        );

        expect(failure).toBeInstanceOf(ConfigParseError);
        expect(failure.message).toContain('Failed to read the explicit config');
    });

    test('reads the repository config at the base SHA, never at head', async () => {
        const vcs = new FakeVcs({ [DEFAULT_CONFIG_PATH]: 'provider: openai-compatible\n' });
        await loadReviewConfig(vcs, BASE_SHA);
        expect(vcs.calls).toHaveLength(1);
        expect(vcs.calls[0]?.ref).toBe(BASE_SHA);
        expect(vcs.calls[0]?.ref).not.toBe(HEAD_SHA);
    });

    test('extends defaults with the base-SHA config and applies operational inputs last', async () => {
        const vcs = new FakeVcs({
            [DEFAULT_CONFIG_PATH]: [
                'provider: openai-compatible',
                'model: my-model',
                'review:',
                '  deadlineMinutes: 30',
                'tools:',
                '  context7:',
                '    enabled: true'
            ].join('\n')
        });

        const config = await loadReviewConfig(vcs, BASE_SHA, { operational: { defaultModel: 'override-model' } });
        expect(config.provider).toBe('openai-compatible');
        expect(config.model).toBe('override-model');
        expect(config.review.deadlineMinutes).toBe(30);
        expect(config.tools.context7.enabled).toBe(true);
    });

    test('rejects unknown keys so guardrails cannot be replaced from the repository', async () => {
        const vcs = new FakeVcs({
            [DEFAULT_CONFIG_PATH]: 'permissions:\n  edit: allow\n'
        });

        expect(await rejectionOf(loadReviewConfig(vcs, BASE_SHA))).toBeInstanceOf(Error);
    });

    test('rejects universal globs and out-of-repository paths in roles', async () => {
        const universal = new FakeVcs({
            [DEFAULT_CONFIG_PATH]:
                'agents:\n  roles:\n    - name: everything\n      objective: review\n      globs: ["**"]\n'
        });

        const universalFailure = await rejectionOf(loadReviewConfig(universal, BASE_SHA));
        expect(universalFailure.message).toContain('universal glob');

        const absolute = new FakeVcs({
            [DEFAULT_CONFIG_PATH]:
                'agents:\n  roles:\n    - name: escape\n      objective: review\n      globs: ["/etc/**"]\n'
        });

        const absoluteFailure = await rejectionOf(loadReviewConfig(absolute, BASE_SHA));
        expect(absoluteFailure.message).toContain('inside the repository');
    });

    test('reports invalid YAML as a config parse error', async () => {
        const vcs = new FakeVcs({ [DEFAULT_CONFIG_PATH]: 'provider: [unclosed\n' });
        expect(await rejectionOf(loadReviewConfig(vcs, BASE_SHA))).toBeInstanceOf(ConfigParseError);
    });

    test('accepts an (agent, tier) routing matrix cell and a prompt override id', async () => {
        const vcs = new FakeVcs({
            [DEFAULT_CONFIG_PATH]: [
                'models:',
                '  routing:',
                '    correctness: { hard: hard-only-model }',
                '    tests: { standard: tests-model }',
                'prompts:',
                '  overrides:',
                '    tests: prompts/tests.md'
            ].join('\n')
        });

        const config = await loadReviewConfig(vcs, BASE_SHA);
        expect(config.models?.routing?.correctness?.hard).toBe('hard-only-model');
        expect(config.models?.routing?.correctness?.lite).toBeUndefined();
        expect(config.models?.routing?.tests?.standard).toBe('tests-model');
        expect(config.prompts.overrides?.tests).toBe('prompts/tests.md');
    });

    test('rejects a routing id that is not a known agent', async () => {
        const vcs = new FakeVcs({
            [DEFAULT_CONFIG_PATH]: 'models:\n  routing:\n    securty:\n      hard: hard-model\n'
        });

        const failure = await rejectionOf(loadReviewConfig(vcs, BASE_SHA));
        expect(failure.message).toContain('models.routing.securty is not a known agent id');
    });

    test('rejects an empty routing cell and an unknown tier-plan agent', async () => {
        const emptyRoute = new FakeVcs({
            [DEFAULT_CONFIG_PATH]: 'models:\n  routing:\n    security: {}\n'
        });

        const emptyFailure = await rejectionOf(loadReviewConfig(emptyRoute, BASE_SHA));
        expect(emptyFailure.message).toContain('models.routing.security does not declare a default or tier model');

        const unknownPlan = new FakeVcs({
            [DEFAULT_CONFIG_PATH]: [
                'agents:',
                '  plan:',
                '    lite: [no-such-agent]',
                '    standard: [correctness]',
                '    hard: [correctness]'
            ].join('\n')
        });

        const planFailure = await rejectionOf(loadReviewConfig(unknownPlan, BASE_SHA));
        expect(planFailure.message).toContain('agents.plan.lite references unknown agent');
    });

    test('rejects malformed catalogue keys', async () => {
        const blank = new FakeVcs({
            [DEFAULT_CONFIG_PATH]: ['models:', '  catalog:', "    '   ': {}"].join('\n')
        });

        const blankFailure = await rejectionOf(loadReviewConfig(blank, BASE_SHA));
        expect(blankFailure.message).toContain('must not be blank');

        const overlay = new FakeVcs({
            [DEFAULT_CONFIG_PATH]: [
                'model: global-model',
                'models:',
                '  catalog:',
                "    'a#b': {}",
                '    global-model: {}'
            ].join('\n')
        });

        const overlayFailure = await rejectionOf(loadReviewConfig(overlay, BASE_SHA));
        expect(overlayFailure.message).toContain('without a variant overlay');
    });

    test('rejects an unreferenced catalogue entry', async () => {
        const vcs = new FakeVcs({
            [DEFAULT_CONFIG_PATH]: [
                'model: global-model',
                'models:',
                '  catalog:',
                '    unused-model: {}',
                '    global-model: {}'
            ].join('\n')
        });

        const failure = await rejectionOf(loadReviewConfig(vcs, BASE_SHA));
        expect(failure.message).toContain('models.catalog.unused-model is not referenced');
    });

    test('rejects unknown prompt override ids before reading a prompt', async () => {
        const vcs = new FakeVcs({ [DEFAULT_CONFIG_PATH]: 'prompts:\n  overrides:\n    unknown: prompts/unknown.md\n' });

        expect(await rejectionOf(loadReviewConfig(vcs, BASE_SHA))).toBeInstanceOf(Error);
        expect(vcs.calls).toEqual([{ path: DEFAULT_CONFIG_PATH, ref: BASE_SHA }]);
    });

    test('rejects duplicate declarative role names', async () => {
        const vcs = new FakeVcs({
            [DEFAULT_CONFIG_PATH]: [
                'agents:',
                '  roles:',
                '    - name: migrations',
                '      objective: Review migrations.',
                '      globs: ["db/migrations/**"]',
                '    - name: migrations',
                '      objective: Review another migration.',
                '      globs: ["schema/**"]'
            ].join('\n')
        });

        const duplicateFailure = await rejectionOf(loadReviewConfig(vcs, BASE_SHA));
        expect(duplicateFailure.message).toContain('Role names must be unique.');
    });

    test('bounds the configurable deadline around the production default', async () => {
        expect(DEFAULT_DEADLINE_MINUTES).toBeGreaterThanOrEqual(MIN_DEADLINE_MINUTES);
        expect(DEFAULT_DEADLINE_MINUTES).toBeLessThanOrEqual(MAX_DEADLINE_MINUTES);

        for (const deadline of [MIN_DEADLINE_MINUTES - 1, MAX_DEADLINE_MINUTES + 1]) {
            const vcs = new FakeVcs({ [DEFAULT_CONFIG_PATH]: `review:\n  deadlineMinutes: ${deadline}\n` });
            expect(await rejectionOf(loadReviewConfig(vcs, BASE_SHA))).toBeInstanceOf(Error);
        }
    });

    test('accepts a custom diff budget and rejects values outside its bounds', async () => {
        const custom = new FakeVcs({ [DEFAULT_CONFIG_PATH]: 'review:\n  diffBudgetChars: 30000\n' });
        const config = await loadReviewConfig(custom, BASE_SHA);
        expect(config.review.diffBudgetChars).toBe(30_000);

        for (const budget of [MIN_DIFF_BUDGET_CHARS - 1, MAX_DIFF_BUDGET_CHARS + 1]) {
            const vcs = new FakeVcs({ [DEFAULT_CONFIG_PATH]: `review:\n  diffBudgetChars: ${budget}\n` });
            expect(await rejectionOf(loadReviewConfig(vcs, BASE_SHA))).toBeInstanceOf(Error);
        }
    });

    test('rejects universal globs beyond the obvious double-star forms', async () => {
        const doubleDouble = new FakeVcs({
            [DEFAULT_CONFIG_PATH]:
                'agents:\n  roles:\n    - name: all\n      objective: review\n      globs: ["**/**"]\n'
        });

        const doubleDoubleFailure = await rejectionOf(loadReviewConfig(doubleDouble, BASE_SHA));
        expect(doubleDoubleFailure.message).toContain('universal glob');

        const braces = new FakeVcs({
            [DEFAULT_CONFIG_PATH]:
                'agents:\n  roles:\n    - name: brace-all\n      objective: review\n      globs: ["{**,**/*}"]\n'
        });

        const bracesFailure = await rejectionOf(loadReviewConfig(braces, BASE_SHA));
        expect(bracesFailure.message).toContain('universal glob');
    });

    test('requires provider, model and credential together before any paid call', () => {
        // SAFETY: config fixture with an intentionally-undefined model exercises the missing-model error path.
        // eslint-disable-next-line anti-slop/no-chained-type-assertions -- config fixture bridged to the resolved config type for the validation case
        const baseConfig = {
            provider: 'anthropic',
            model: undefined,
            review: { failurePolicy: 'continue-partial', deadlineMinutes: 15 },
            tools: { context7: { enabled: false }, web: { enabled: false } },
            agents: { disabled: [], roles: [] }
        } as unknown as Parameters<typeof resolveEffectiveRun>[0]['config'];

        expect(() => resolveEffectiveRun({ config: baseConfig, apiKey: 'key', isMockMode: false })).toThrow(
            EffectiveRunError
        );
        expect(() => resolveEffectiveRun({ config: { ...baseConfig, model: 'claude-x' }, isMockMode: false })).toThrow(
            EffectiveRunError
        );

        const effective = resolveEffectiveRun({
            config: { ...baseConfig, model: 'claude-x' },
            apiKey: 'key',
            isMockMode: false
        });

        expect(effective).toMatchObject({ provider: 'anthropic', model: 'claude-x', apiKey: 'key' });
    });

    test('rejects an unknown operational provider before any provider call', async () => {
        const vcs = new FakeVcs({});

        const failure = await rejectionOf(
            loadReviewConfig(vcs, BASE_SHA, { operational: { provider: 'unknown-provider' } })
        );

        expect(failure.message).toContain('operational provider');
    });

    test('accepts a native provider only when the local options allow it', () => {
        // SAFETY: full config fixture bridged to the resolved config type; the resolved values are asserted below.
        // eslint-disable-next-line anti-slop/no-chained-type-assertions -- config fixture bridged to the resolved config type for the validation case
        const config = {
            provider: 'openai',
            model: 'gpt-5',
            review: { failurePolicy: 'continue-partial', deadlineMinutes: 15 },
            tools: { context7: { enabled: false }, web: { enabled: false } },
            agents: { disabled: [], roles: [] }
        } as unknown as Parameters<typeof resolveEffectiveRun>[0]['config'];

        const storeBacked = resolveEffectiveRun({
            config,
            isMockMode: false,
            allowUnsupportedProvider: true,
            allowMissingCredential: true
        });

        expect(storeBacked).toMatchObject({ provider: 'openai', model: 'gpt-5' });
        expect(storeBacked.apiKey).toBeUndefined();

        expect(() => resolveEffectiveRun({ config, isMockMode: false, allowUnsupportedProvider: true })).toThrow(
            EffectiveRunError
        );
        expect(() => resolveEffectiveRun({ config, isMockMode: false, apiKey: 'key' })).toThrow(EffectiveRunError);
    });
});
