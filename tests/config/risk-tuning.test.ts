import { describe, expect, test } from 'bun:test';
import { DEFAULT_CONFIG_PATH } from '../../src/identity';
import { loadReviewConfig } from '../../src/config/load';
import { DEFAULT_RISK_RULES } from '../../src/analysis/risk-rules';
import { assessRisk } from '../../src/analysis/risk';
import type { VcsChangedFile } from '../../src/vcs/types';
import { rejectionOf } from '../helpers/rejection';

class FakeVcs {
    private readonly files: Record<string, string | null>;
    public calls: { path: string; ref: string }[] = [];

    public constructor(files: Record<string, string | null>) {
        this.files = files;
    }

    public getFileContent(path: string, ref: string): Promise<string | null> {
        this.calls.push({ path, ref });

        return Promise.resolve(this.files[path] ?? null);
    }
}

const BASE_SHA = 'b'.repeat(40);

const SMALL_REPOSITORY = { recognizedFilesCount: 1000, physicalLines: 100_000 };

function changedFile(path: string, additions = 0, deletions = 0): VcsChangedFile {
    return { path, status: 'modified', additions, deletions, patch: { state: 'none' } };
}

const CUSTOM_CONFIG = [
    'risk:',
    '  thresholds:',
    '    liteMaxScore: 5',
    '    standardMaxScore: 10',
    '  weights:',
    '    changedFiles: 1',
    '    changedLines: 0.1',
    '  largeChangeLines: 500',
    '  escalations:',
    '    - id: db-migrations',
    "      patterns: ['db/**']",
    '      minTier: hard',
    '      addSpecialist: security'
].join('\n');

describe('risk tuning config', () => {
    test('custom thresholds, weights and a custom escalation id drive tier and specialists', async () => {
        const vcs = new FakeVcs({ [DEFAULT_CONFIG_PATH]: CUSTOM_CONFIG });
        const config = await loadReviewConfig(vcs, BASE_SHA);

        expect(config.risk.thresholds).toEqual({ liteMaxScore: 5, standardMaxScore: 10 });
        expect(config.risk.weights).toEqual({ changedFiles: 1, changedLines: 0.1 });
        expect(config.risk.largeChangeLines).toBe(500);
        expect(config.risk.escalations.map((rule) => rule.id)).toEqual(['db-migrations']);

        const migrated = assessRisk({
            changedFiles: [changedFile('db/schema.sql', 5)],
            ...SMALL_REPOSITORY,
            rules: config.risk
        });

        expect(migrated.volumeTier).toBe('lite');
        expect(migrated.tier).toBe('hard');
        expect(migrated.escalations.map((escalation) => escalation.id)).toEqual(['db-migrations']);
        expect(migrated.requiredSpecialists).toEqual(['security']);

        const weighted = assessRisk({
            changedFiles: [
                changedFile('src/plain-a.ts', 1),
                changedFile('src/plain-b.ts', 1),
                changedFile('src/plain-c.ts', 1),
                changedFile('src/plain-d.ts', 1),
                changedFile('src/plain-e.ts', 1),
                changedFile('src/plain-f.ts', 1)
            ],
            ...SMALL_REPOSITORY,
            rules: config.risk
        });

        expect(weighted.volumeTier).toBe('standard');

        const replaced = assessRisk({
            changedFiles: [changedFile('auth/login.ts', 4)],
            ...SMALL_REPOSITORY,
            rules: config.risk
        });

        expect(replaced.signals).toEqual([]);
        expect(replaced.tier).toBe('lite');
        expect(replaced.requiredSpecialists).toEqual([]);
    });

    test('invalid risk tuning fails closed before any provider call', async () => {
        const cases: { name: string; yaml: string; message: string }[] = [
            {
                name: 'inverted thresholds',
                yaml: 'risk:\n  thresholds:\n    liteMaxScore: 20\n    standardMaxScore: 10\n',
                message: 'liteMaxScore'
            },
            {
                name: 'zero file ratio',
                yaml: 'risk:\n  ratios:\n    fileRatio: 0\n',
                message: 'fileRatio'
            },
            {
                name: 'zero large-change threshold',
                yaml: 'risk:\n  largeChangeLines: 0\n',
                message: 'largeChangeLines'
            },
            {
                name: 'lite escalation tier',
                yaml: "risk:\n  escalations:\n    - id: weak\n      patterns: ['db/**']\n      minTier: lite\n",
                message: 'minTier'
            },
            {
                name: 'duplicate escalation ids',
                yaml: "risk:\n  escalations:\n    - id: same\n      patterns: ['db/**']\n      minTier: hard\n    - id: same\n      patterns: ['src/**']\n      minTier: standard\n",
                message: 'unique'
            },
            {
                name: 'universal escalation pattern',
                yaml: "risk:\n  escalations:\n    - id: everything\n      patterns: ['**']\n      minTier: hard\n",
                message: 'universal glob'
            }
        ];

        for (const { yaml, message } of cases) {
            const failure = await rejectionOf(loadReviewConfig(new FakeVcs({ [DEFAULT_CONFIG_PATH]: yaml }), BASE_SHA));

            expect(failure.message).toContain(message);
        }
    });

    test('absent risk config keeps byte-identical defaults', async () => {
        const config = await loadReviewConfig(new FakeVcs({}), BASE_SHA);

        expect(config.risk).toEqual(DEFAULT_RISK_RULES);
        expect(JSON.stringify(config.risk)).toBe(JSON.stringify(DEFAULT_RISK_RULES));
    });
});
