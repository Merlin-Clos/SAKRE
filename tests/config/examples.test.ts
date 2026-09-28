import { expect, test } from 'bun:test';
import { stat } from 'node:fs/promises';
import picomatch from 'picomatch';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { DEFAULT_ALLOWED_ASSOCIATIONS } from '../../src/action/inputs';
import { DEFAULT_AGENT_NAME, DEFAULT_CONFIG_PATH, PRODUCT_NAME, PRODUCT_SLUG } from '../../src/identity';
import {
    DEFAULT_DEADLINE_MINUTES,
    DEFAULT_DIFF_BUDGET_CHARS,
    DEFAULT_FAILURE_POLICY,
    DEFAULT_PROVIDER
} from '../../src/config/load';
import { DEFAULT_AGENT_PLAN, REPO_CONFIG_SCHEMA_TITLE, userReviewConfigSchema } from '../../src/config/schema';
import { validateUserReviewConfig } from '../../src/config/validation';

const CONFIG_EXAMPLE = 'examples/sakre.yml';

const WORKFLOW_EXAMPLE = 'examples/workflow.yml';

const PRIVATE_WORKFLOW_EXAMPLE = 'examples/workflow-private-engine.yml';

const GITHUB_EXPRESSION_OPEN = `${String.fromCodePoint(36)}{{`;

const PUBLIC_FILES = [
    'action.yml',
    'README.md',
    'SECURITY.md',
    'LICENSE',
    'package.json',
    'sakre.schema.json',
    'renovate.json',
    'engine-pins.json',
    'defaults/review.yml',
    CONFIG_EXAMPLE,
    WORKFLOW_EXAMPLE,
    PRIVATE_WORKFLOW_EXAMPLE
];

const workflowExampleSchema = z.object({
    permissions: z.strictObject({
        contents: z.literal('read'),
        issues: z.literal('write'),
        'pull-requests': z.literal('read')
    }),
    concurrency: z.strictObject({
        group: z.string(),
        'cancel-in-progress': z.literal(false)
    })
});

const stringListSchema = z.array(z.string());

const renovatePackageRuleSchema = z.object({
    matchDepNames: stringListSchema.optional(),
    matchPackageNames: stringListSchema.optional(),
    matchManagers: stringListSchema.optional(),
    enabled: z.boolean().optional(),
    groupName: z.string().optional()
});

const renovateConfigSchema = z.object({
    extends: stringListSchema,
    rangeStrategy: z.literal('pin'),
    ignorePaths: stringListSchema,
    'github-actions': z.object({ managerFilePatterns: stringListSchema }),
    customManagers: z.array(z.unknown()).optional(),
    postUpgradeTasks: z.unknown().optional(),
    packageRules: z.array(renovatePackageRuleSchema)
});

const packageManifestSchema = z.object({
    dependencies: z.record(z.string(), z.string()),
    devDependencies: z.record(z.string(), z.string())
});

/* Mirrors Renovate's matchRegexOrGlob for the positive `/regex/` and glob patterns this config uses. */
function patternMatchesFile(pattern: string, file: string): boolean {
    if (pattern.startsWith('/') && pattern.endsWith('/')) {
        return new RegExp(pattern.slice(1, -1), 'u').test(file);
    }

    return picomatch(pattern, { dot: true })(file);
}

test('the public config example validates for both provider families', async () => {
    const example = validateUserReviewConfig(parseYaml(await Bun.file(CONFIG_EXAMPLE).text()));
    expect(example.provider).toBe('anthropic');
    expect(
        validateUserReviewConfig({ ...example, provider: 'openai-compatible', model: 'gateway-model-id' }).provider
    ).toBe('openai-compatible');
});

test('the public workflow includes safe triggering, concurrency and every review mode', async () => {
    const content = await Bun.file(WORKFLOW_EXAMPLE).text();
    const workflow = workflowExampleSchema.parse(parseYaml(content));
    expect(workflow.permissions).toEqual({ contents: 'read', issues: 'write', 'pull-requests': 'read' });
    expect(workflow.concurrency).toEqual({
        group: `${PRODUCT_SLUG}-${GITHUB_EXPRESSION_OPEN} github.event.issue.number }}`,
        'cancel-in-progress': false
    });
    expect(content).toContain('fetch-depth: 0');
    expect(content).toContain(`provider_api_key: '${GITHUB_EXPRESSION_OPEN} secrets.AI_PROVIDER_API_KEY }}'`);
    expect(content).toContain(`@${DEFAULT_AGENT_NAME} --diagnostic`);
    expect(content).toContain(`@${DEFAULT_AGENT_NAME} --force`);
    expect(content).toContain(`@${DEFAULT_AGENT_NAME} --force-over-budget`);
});

test('the public workflow example mirrors the CI checkout pin', async () => {
    const [example, ci] = await Promise.all([
        Bun.file(WORKFLOW_EXAMPLE).text(),
        Bun.file('.github/workflows/ci.yml').text()
    ]);

    const checkoutPin = /uses: (?<pin>actions\/checkout@[0-9a-f]{40} # \S+)/u.exec(ci)?.groups?.pin;

    if (checkoutPin === undefined) {
        throw new Error('The CI workflow does not pin actions/checkout with a version comment.');
    }

    expect(example).toContain(`uses: ${checkoutPin}`);
});

test('Renovate keeps the example workflow unignored and matched for the checkout pin', async () => {
    const config = renovateConfigSchema.parse(JSON.parse(await Bun.file('renovate.json').text()));
    expect(config.ignorePaths.some((pattern) => patternMatchesFile(pattern, WORKFLOW_EXAMPLE))).toBe(false);
    expect(
        config['github-actions'].managerFilePatterns.some((pattern) => patternMatchesFile(pattern, WORKFLOW_EXAMPLE))
    ).toBe(true);
});

test('Renovate tracks the upstream action reference in the public example', async () => {
    const config = renovateConfigSchema.parse(JSON.parse(await Bun.file('renovate.json').text()));
    const upstreamRef = `Merlin-Clos/${PRODUCT_NAME}`;

    expect(await Bun.file(WORKFLOW_EXAMPLE).text()).toContain(`${upstreamRef}@v1`);

    const disabled = config.packageRules.filter(
        (rule) => rule.enabled === false && rule.matchDepNames?.includes(upstreamRef) === true
    );

    expect(disabled).toEqual([]);
});

test('CI and release gates contain no provider credential or paid review step', async () => {
    const workflows = await Promise.all([
        Bun.file('.github/workflows/ci.yml').text(),
        Bun.file('.github/workflows/release.yml').text()
    ]);

    for (const workflow of workflows) {
        expect(workflow).not.toContain('provider_api_key');
        expect(workflow).not.toContain('AI_PROVIDER_API_KEY');
        expect(workflow).not.toContain(`@${DEFAULT_AGENT_NAME}`);
    }
});

test('public text artifacts contain no temporary audit tool, private owner or credential value', async () => {
    const forbidden = [
        ['anti', 'slop'].join('-'),
        ['Klod', 'Online'].join(''),
        ['opencode', 'key'].join('_'),
        ['OPENCODE', 'API', 'KEY'].join('_')
    ];

    /* The README origin note names KlodOnline deliberately as the project's
       public attribution; it is allowlisted verbatim, everything else stays
       forbidden. */
    const ORIGIN_NOTE =
        'The K is a nod to [KlodOnline](https://www.klod-online.com/), the project SAKRE originally grew out of.';

    for (const path of PUBLIC_FILES) {
        let content = await Bun.file(path).text();

        if (path === 'README.md') {
            expect(content).toContain(ORIGIN_NOTE);
            content = content.replace(ORIGIN_NOTE, '');
        }

        for (const token of forbidden) {
            expect(content).not.toContain(token);
        }

        expect(content).not.toMatch(/https?:\/\/[^\s/]*(?:\.internal|\.corp)(?:[/:\s]|$)/u);
        expect(content).not.toMatch(/(?:sk|key|token)-[A-Za-z0-9_-]{20,}/u);
    }
});

test('release gates build, verify, pin and publish every distributed runtime artifact', async () => {
    const release = await Bun.file('.github/workflows/release.yml').text();
    expect(release).toContain('needs: validate');
    expect(release).toContain('contents: write');
    expect(release).toContain('bun scripts/verify-native-assets.ts --target');
    expect(release).toContain('bun scripts/build-release.ts --target');
    expect(release).toContain('bun test tests/artifact tests/integration');

    for (const artifact of [
        'sakre-linux-x64',
        'sakre-linux-arm64',
        'sakre-darwin-x64',
        'sakre-darwin-arm64',
        'sakre-windows-x64.exe'
    ]) {
        expect(release).toContain(artifact);
    }

    expect(release).toContain('sha256sum dist-release/*.gz > SHA256SUMS');
    expect(release).toMatch(/dist-release\/\$\{\{ matrix\.artifact \}\}\.gz/u);
    expect(release).toContain('The release tag must look like v1.2.3');
    expect(release).toContain('bun scripts/generate-engine-pins.ts --tag "$GITHUB_REF_NAME" --directory dist-release');
    expect(release).toContain('git push --force origin "refs/tags/$name"');
});

test('Renovate tracks the embedded engine SDK without vendor automation', async () => {
    const config = renovateConfigSchema.parse(JSON.parse(await Bun.file('renovate.json').text()));
    expect(config.extends).toContain('config:recommended');
    expect(config.extends).toContain('helpers:pinGitHubActionDigests');
    expect(config.postUpgradeTasks).toBeUndefined();
    expect(config.customManagers).toBeUndefined();
    expect(config.ignorePaths).toContain('**/dist-release/**');
    const engineGroup = config.packageRules.find((rule) => rule.groupName === 'embedded engine');
    expect(engineGroup?.matchPackageNames).toEqual(['@opencode/sdk']);
    const packageJson = packageManifestSchema.parse(JSON.parse(await Bun.file('package.json').text()));
    expect(packageJson.dependencies['@opencode-ai/sdk']).toBeUndefined();
    expect(packageJson.dependencies['@opencode/sdk']).toBeDefined();
});

test('Renovate tracks the Bun runtime from .bun-version inside the development tooling group', async () => {
    const config = renovateConfigSchema.parse(JSON.parse(await Bun.file('renovate.json').text()));
    expect(config.customManagers).toBeUndefined();
    const bunVersionFile = await Bun.file('.bun-version').text();
    const bunVersion = bunVersionFile.trim();
    const packageJson = packageManifestSchema.parse(JSON.parse(await Bun.file('package.json').text()));
    expect(bunVersion).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(packageJson.devDependencies['bun-types']).toBe(bunVersion);
    const toolingGroup = config.packageRules.find((rule) => rule.groupName === 'development tooling');
    expect(toolingGroup?.matchPackageNames).toContain('bun');

    for (const workflowPath of ['.github/workflows/ci.yml', '.github/workflows/release.yml']) {
        const workflow = await Bun.file(workflowPath).text();
        expect(workflow).toContain('bun-version-file: .bun-version');
        expect(workflow).not.toMatch(/bun-version:\s*\d/u);
    }
});

const inputMetadataSchema = z.object({ default: z.string().optional() });

const actionStepSchema = z.object({
    if: z.string().optional(),
    shell: z.string(),
    run: z.string(),
    env: z.record(z.string(), z.string())
});

const actionMetadataSchema = z.object({
    inputs: z.record(z.string(), inputMetadataSchema),
    runs: z.object({
        using: z.literal('composite'),
        steps: z.array(actionStepSchema)
    })
});

test('action metadata defaults match the runtime defaults', async () => {
    const action = actionMetadataSchema.parse(parseYaml(await Bun.file('action.yml').text()));
    expect(action.inputs.agent_name?.default).toBe(DEFAULT_AGENT_NAME);
    expect(action.inputs.allowed_author_associations?.default).toBe(DEFAULT_ALLOWED_ASSOCIATIONS);
    expect(action.inputs.config_path?.default).toBe(DEFAULT_CONFIG_PATH);
    expect(action.inputs.mock_mode?.default).toBe('false');
});

test('the composite Action maps every input to INPUT_* for the engine', async () => {
    const action = actionMetadataSchema.parse(parseYaml(await Bun.file('action.yml').text()));
    expect(action.runs.using).toBe('composite');

    const expected = Object.keys(action.inputs)
        .map((name) => `INPUT_${name.toUpperCase()}`)
        .toSorted();

    const unixStep = action.runs.steps.find((step) => step.shell === 'bash');
    const windowsStep = action.runs.steps.find((step) => step.shell === 'pwsh');
    expect(unixStep?.if).toContain("!= 'Windows'");
    expect(windowsStep?.if).toContain("== 'Windows'");

    for (const step of action.runs.steps) {
        expect(Object.keys(step.env).toSorted()).toEqual(expected);
    }
});

test('the repository ships no Node Action launcher bundle', async () => {
    for (const path of ['src/action/launcher.ts', 'dist/index.js', 'dist/index.js.map', 'tsconfig.runtime.json']) {
        expect(await fileExists(path)).toBe(false);
    }

    const packageJson = await Bun.file('package.json').text();
    expect(packageJson).not.toContain('build-action');
    expect(packageJson).not.toContain('check-dist');
});

async function fileExists(file: string): Promise<boolean> {
    try {
        await stat(file);

        return true;
    } catch {
        return false;
    }
}

test('embedded review defaults match the loader fallbacks', async () => {
    const defaults = z
        .object({
            provider: z.string(),
            review: z.object({ failurePolicy: z.string(), deadlineMinutes: z.number(), diffBudgetChars: z.number() })
        })
        .parse(parseYaml(await Bun.file('defaults/review.yml').text()));

    expect(defaults.provider).toBe(DEFAULT_PROVIDER);
    expect(defaults.review.failurePolicy).toBe(DEFAULT_FAILURE_POLICY);
    expect(defaults.review.deadlineMinutes).toBe(DEFAULT_DEADLINE_MINUTES);
    expect(defaults.review.diffBudgetChars).toBe(DEFAULT_DIFF_BUDGET_CHARS);
});

test('the published JSON schema mirrors the runtime config schema', async () => {
    const published: unknown = JSON.parse(await Bun.file('sakre.schema.json').text());
    expect(published).toEqual({
        ...z.toJSONSchema(userReviewConfigSchema),
        title: REPO_CONFIG_SCHEMA_TITLE
    });
});

test('the embedded agent plan matches the runtime fallback constant', async () => {
    const content = await Bun.file('defaults/review.yml').text();
    const document: unknown = parseYaml(content);
    const planSchema = z.record(z.string(), z.array(z.string()));
    const defaults = z.object({ agents: z.object({ plan: planSchema }) }).parse(document);
    expect(defaults.agents.plan).toEqual(DEFAULT_AGENT_PLAN);
});
