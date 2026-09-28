import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defaultClassificationRules } from '../../src/analysis/classification';
import { assessRisk } from '../../src/analysis/risk';
import { DEFAULT_RISK_RULES, riskRulesForClassification } from '../../src/analysis/risk-rules';
import type { VcsChangedFile } from '../../src/vcs/types';
import { buildRiskSummary } from '../../src/review/context';
import riskCases from '../fixtures/risk-cases.json' with { type: 'json' };

interface ChangedFileOptions {
    additions?: number;
    deletions?: number;
    previousPath?: string;
}

function changedFile(path: string, options: ChangedFileOptions = {}): VcsChangedFile {
    return {
        path,
        status: 'modified',
        additions: options.additions ?? 0,
        deletions: options.deletions ?? 0,
        previousPath: options.previousPath,
        patch: { state: 'none' }
    };
}

const SMALL_REPOSITORY = { recognizedFilesCount: 1000, physicalLines: 100_000 };

function filesForLines(totalLines: number): VcsChangedFile[] {
    const first = Math.ceil(totalLines / 2);

    return [
        changedFile('src/plain-a.ts', { additions: first }),
        changedFile('src/plain-b.ts', { additions: totalLines - first })
    ];
}

const nonEmptyStringFixtureSchema = z.string().min(1);

const positiveIntegerFixtureSchema = z.int().positive();

const nonnegativeIntegerFixtureSchema = z.int().nonnegative();

const nonnegativeNumberFixtureSchema = z.number().nonnegative();

const riskTierFixtureSchema = z.enum(['lite', 'standard', 'hard']);

const repositoryFixtureSchema = z.strictObject({
    recognizedFilesCount: positiveIntegerFixtureSchema,
    physicalLines: positiveIntegerFixtureSchema
});

const changeGroupFixtureSchema = z.strictObject({
    pathPrefix: nonEmptyStringFixtureSchema,
    count: positiveIntegerFixtureSchema,
    additions: nonnegativeIntegerFixtureSchema,
    deletions: nonnegativeIntegerFixtureSchema
});

const expectedRiskFixtureSchema = z.strictObject({
    changedFilesCount: nonnegativeIntegerFixtureSchema,
    changedLines: nonnegativeIntegerFixtureSchema,
    volumeScore: nonnegativeNumberFixtureSchema,
    fileRatio: nonnegativeNumberFixtureSchema,
    lineRatio: nonnegativeNumberFixtureSchema,
    volumeTier: riskTierFixtureSchema,
    tier: riskTierFixtureSchema,
    escalations: z.array(z.string()),
    requiredSpecialists: z.array(z.enum(['security', 'performance', 'conventions']))
});

const riskFixtureSchema = z.strictObject({
    name: nonEmptyStringFixtureSchema,
    repository: repositoryFixtureSchema,
    groups: z.array(changeGroupFixtureSchema),
    expected: expectedRiskFixtureSchema
});

type RiskFixture = z.infer<typeof riskFixtureSchema>;

const calibratedRiskCases = z.array(riskFixtureSchema).parse(riskCases);

function filesFromFixture(fixture: RiskFixture): VcsChangedFile[] {
    return fixture.groups.flatMap((group) =>
        Array.from({ length: group.count }, (_unused, index) =>
            changedFile(`${group.pathPrefix}-${index}.ts`, {
                additions: group.additions,
                deletions: group.deletions
            })
        )
    );
}

describe('risk tier computation', () => {
    for (const fixture of calibratedRiskCases) {
        test(`calibrated fixture: ${fixture.name}`, () => {
            const risk = assessRisk({ changedFiles: filesFromFixture(fixture), ...fixture.repository });
            expect(risk.changedFilesCount).toBe(fixture.expected.changedFilesCount);
            expect(risk.changedLines).toBe(fixture.expected.changedLines);
            expect(risk.volumeScore).toBeCloseTo(fixture.expected.volumeScore);
            expect(risk.fileRatio).toBeCloseTo(fixture.expected.fileRatio);
            expect(risk.lineRatio).toBeCloseTo(fixture.expected.lineRatio);
            expect(risk.volumeTier).toBe(fixture.expected.volumeTier);
            expect(risk.tier).toBe(fixture.expected.tier);
            expect(risk.escalations.map((escalation) => escalation.id)).toEqual(fixture.expected.escalations);
            expect(risk.requiredSpecialists).toEqual(fixture.expected.requiredSpecialists);
            const diagnostic = buildRiskSummary(risk, { unifiedDiff: '', files: [], complete: true });
            expect(diagnostic).toContain(`score ${fixture.expected.volumeScore}`);
            expect(diagnostic).toContain(`File ratio: ${fixture.expected.fileRatio}`);
            expect(diagnostic).toContain(`line ratio: ${fixture.expected.lineRatio}`);

            for (const escalation of risk.escalations) {
                expect(escalation.detail.length).toBeGreaterThan(0);
                expect(diagnostic).toContain(`${escalation.id} -> ${escalation.minTier} (${escalation.detail})`);
            }
        });
    }

    test('large volume reaches hard without escalations', () => {
        const files = Array.from({ length: 300 }, (_unused, index) =>
            changedFile(`src/file-${index}.ts`, { additions: 1 })
        );

        const risk = assessRisk({ changedFiles: files, ...SMALL_REPOSITORY });
        expect(risk.volumeTier).toBe('hard');
        expect(risk.tier).toBe('hard');
        expect(risk.escalations).toEqual([]);
    });

    test('file ratio escalates upward only and stays explainable', () => {
        const risk = assessRisk({
            changedFiles: [
                changedFile('src/a.ts', { additions: 2 }),
                changedFile('src/b.ts', { additions: 1 }),
                changedFile('src/c.ts', { additions: 1 })
            ],
            recognizedFilesCount: 10,
            physicalLines: 100_000
        });

        expect(risk.volumeTier).toBe('lite');
        expect(risk.tier).toBe('hard');
        expect(risk.escalations).toHaveLength(1);
        expect(risk.escalations[0]?.id).toBe('volume-ratio');
        expect(risk.escalations[0]?.detail).toContain('fileRatio=0.3');
    });

    test('line ratio escalates a small PR touching a tiny repository', () => {
        const risk = assessRisk({
            changedFiles: [changedFile('src/a.ts', { additions: 20 })],
            recognizedFilesCount: 1000,
            physicalLines: 100
        });

        expect(risk.volumeTier).toBe('lite');
        expect(risk.tier).toBe('hard');
        expect(risk.lineRatio).toBeGreaterThanOrEqual(DEFAULT_RISK_RULES.ratios.lineRatio);
    });

    test('a security signal adds the security specialist outside the max tier', () => {
        const risk = assessRisk({
            changedFiles: [changedFile('auth/login.ts', { additions: 4 })],
            ...SMALL_REPOSITORY
        });

        expect(risk.volumeTier).toBe('lite');
        expect(risk.signals.find((signal) => signal.id === 'security')?.paths).toEqual(['auth/login.ts']);
        expect(risk.escalations.find((escalation) => escalation.id === 'security')?.minTier).toBe('standard');
        expect(risk.tier).toBe('standard');
        expect(risk.requiredSpecialists).toContain('security');
    });

    test('workflows and dependency paths escalate with their matched paths', () => {
        const risk = assessRisk({
            changedFiles: [
                changedFile('.github/workflows/ci.yml', { additions: 5 }),
                changedFile('package.json', { additions: 2 })
            ],
            ...SMALL_REPOSITORY
        });

        const escalationIds = risk.escalations.map((escalation) => escalation.id);
        expect(escalationIds).toContain('workflows');
        expect(escalationIds).toContain('dependencies');
        expect(risk.signals.find((signal) => signal.id === 'workflows')?.paths).toEqual(['.github/workflows/ci.yml']);
        expect(risk.tier).toBe('standard');
    });

    test('nested auth and security directories escalate and require the security specialist', () => {
        for (const path of ['src/auth/login.ts', 'packages/api/src/auth/session.ts', 'app/security/policy.ts']) {
            const risk = assessRisk({
                changedFiles: [changedFile(path, { additions: 4 })],
                ...SMALL_REPOSITORY
            });

            expect(risk.tier).toBe('standard');
            expect(risk.requiredSpecialists).toContain('security');
            expect(risk.signals.find((signal) => signal.id === 'security')?.paths).toEqual([path]);
        }
    });

    test('non-JavaScript dependency manifests escalate the tier', () => {
        for (const path of [
            'pom.xml',
            'service/pom.xml',
            'build.gradle.kts',
            'Gemfile',
            'composer.json',
            'pyproject.toml',
            'src/App.csproj'
        ]) {
            const risk = assessRisk({
                changedFiles: [changedFile(path, { additions: 2 })],
                ...SMALL_REPOSITORY
            });

            expect(risk.tier).toBe('standard');
            expect(risk.signals.find((signal) => signal.id === 'dependencies')?.paths).toEqual([path]);
        }
    });

    test('migrations escalate to hard through their dedicated rule', () => {
        const risk = assessRisk({
            changedFiles: [changedFile('db/migrations/001_init.sql', { additions: 40 })],
            ...SMALL_REPOSITORY
        });

        expect(risk.escalations.map((escalation) => escalation.id)).toContain('migrations');
        expect(risk.tier).toBe('hard');
    });

    test('a performance path signal escalates and adds the performance specialist', () => {
        const risk = assessRisk({ changedFiles: [changedFile('server/handler.ts')], ...SMALL_REPOSITORY });
        expect(risk.tier).toBe('standard');
        expect(risk.requiredSpecialists).toContain('performance');
        expect(risk.escalations.map((escalation) => escalation.id)).toContain('performance');
    });

    test('a convention path signal escalates and adds the conventions specialist', () => {
        const risk = assessRisk({ changedFiles: [changedFile('AGENTS.md')], ...SMALL_REPOSITORY });
        expect(risk.tier).toBe('standard');
        expect(risk.requiredSpecialists).toContain('conventions');
        expect(risk.escalations.map((escalation) => escalation.id)).toContain('conventions');
    });

    test('a repository override replaces the performance and convention pattern lists', () => {
        const rules = defaultClassificationRules();

        const overridden = riskRulesForClassification({
            ...rules,
            criticalPathPatterns: ['vault/**'],
            dependencyManifestPatterns: ['deps/**'],
            securityPathPatterns: ['vault/**'],
            performancePathPatterns: ['perf/**'],
            conventionPathPatterns: ['CONVENTIONS.md']
        });

        const performance = assessRisk({
            changedFiles: [changedFile('perf/query.ts')],
            ...SMALL_REPOSITORY,
            rules: overridden
        });

        expect(performance.requiredSpecialists).toContain('performance');

        const conventions = assessRisk({
            changedFiles: [changedFile('CONVENTIONS.md')],
            ...SMALL_REPOSITORY,
            rules: overridden
        });

        expect(conventions.requiredSpecialists).toContain('conventions');

        const security = assessRisk({
            changedFiles: [changedFile('vault/token.ts')],
            ...SMALL_REPOSITORY,
            rules: overridden
        });

        expect(security.requiredSpecialists).toContain('security');
        expect(security.escalations.map((escalation) => escalation.id)).toContain('security');

        const critical = assessRisk({
            changedFiles: [changedFile('vault/migration.sql')],
            ...SMALL_REPOSITORY,
            rules: overridden
        });

        expect(critical.escalations.map((escalation) => escalation.id)).toContain('critical-paths');

        const dependencies = assessRisk({
            changedFiles: [changedFile('deps/manifest.json')],
            ...SMALL_REPOSITORY,
            rules: overridden
        });

        expect(dependencies.escalations.map((escalation) => escalation.id)).toContain('dependencies');

        const staleDefault = assessRisk({
            changedFiles: [changedFile('auth/login.ts')],
            ...SMALL_REPOSITORY,
            rules: overridden
        });

        expect(staleDefault.escalations.map((escalation) => escalation.id)).not.toContain('security');
    });

    test('volume tier boundaries are exact at the calibrated scores', () => {
        expect(assessRisk({ changedFiles: filesForLines(1455), ...SMALL_REPOSITORY }).volumeTier).toBe('lite');
        expect(assessRisk({ changedFiles: filesForLines(1456), ...SMALL_REPOSITORY }).volumeTier).toBe('standard');
        expect(assessRisk({ changedFiles: filesForLines(4330), ...SMALL_REPOSITORY }).volumeTier).toBe('standard');
        expect(assessRisk({ changedFiles: filesForLines(4331), ...SMALL_REPOSITORY }).volumeTier).toBe('hard');
    });

    test('a very large change adds the performance specialist', () => {
        const risk = assessRisk({
            changedFiles: [changedFile('src/bulk.ts', { additions: 300 })],
            ...SMALL_REPOSITORY
        });

        expect(risk.requiredSpecialists).toContain('performance');
    });

    test('escalations never decrease the volume tier', () => {
        const files = Array.from({ length: 300 }, (_unused, index) =>
            changedFile(`src/file-${index}.ts`, { additions: 1 })
        );

        const volumeRisk = assessRisk({ changedFiles: files, ...SMALL_REPOSITORY });

        const withSecurityFile = assessRisk({
            changedFiles: [...files, changedFile('auth/login.ts', { additions: 1 })],
            ...SMALL_REPOSITORY
        });

        expect(volumeRisk.tier).toBe('hard');
        expect(withSecurityFile.tier).toBe('hard');
    });

    test('the assessment carries the rules that produced the tier', () => {
        const risk = assessRisk({
            changedFiles: [changedFile('src/a.ts', { additions: 2 })],
            ...SMALL_REPOSITORY
        });

        expect(risk.appliedRules.thresholds).toEqual(DEFAULT_RISK_RULES.thresholds);
        expect(risk.appliedRules.weights).toEqual(DEFAULT_RISK_RULES.weights);
        expect(risk.appliedRules.escalations.map((rule) => rule.id)).toContain('security');
    });

    test('a rename keeps the sensitive origin visible to security signals', () => {
        const risk = assessRisk({
            changedFiles: [
                changedFile('docs/login-notes.md', { additions: 4, deletions: 0, previousPath: 'auth/login.ts' })
            ],
            ...SMALL_REPOSITORY
        });

        const securitySignal = risk.signals.find((signal) => signal.id === 'security');
        expect(securitySignal?.paths).toContain('auth/login.ts');
        expect(risk.requiredSpecialists).toContain('security');
    });

    test('the critical-path escalation and the coverage priority list share one source', () => {
        const critical = DEFAULT_RISK_RULES.escalations.find((rule) => rule.id === 'critical-paths');
        expect(critical?.patterns).toEqual([...defaultClassificationRules().criticalPathPatterns]);
        const security = DEFAULT_RISK_RULES.escalations.find((rule) => rule.id === 'security');

        for (const pattern of ['**/auth/**', '**/security/**', '**/middleware/**']) {
            expect(security?.patterns).toContain(pattern);
        }
    });

    test('assessment is deterministic for identical inputs', () => {
        const input = {
            changedFiles: [
                changedFile('auth/login.ts', { additions: 4 }),
                changedFile('.github/workflows/ci.yml', { additions: 5 })
            ],
            ...SMALL_REPOSITORY
        };

        expect(JSON.stringify(assessRisk(input))).toBe(JSON.stringify(assessRisk(input)));
    });
});
