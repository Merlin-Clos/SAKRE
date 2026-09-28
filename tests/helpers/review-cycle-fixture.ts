import { spawnSync } from 'node:child_process';
import type { ActionInputs } from '../../src/action/inputs';
import type { IntelligenceOutput, IntelligenceRunOptions } from '../../src/intelligence/pre-pass';
import type { RepositoryMetrics, ReviewMap } from '../../src/intelligence/schema';
import type { VcsPullRequestSnapshot } from '../../src/vcs/types';

/* Shared fixtures for review-cycle unit tests: one measurement, one mock-mode
   Action inputs object and one snapshot bound to the repository head. */

export const MEASUREMENT = { recognizedFilesCount: 1000, physicalLines: 100_000 };

/* Minimal but complete ReviewMap for unit tests that do not exercise the
   pre-pass: risk volume falls back to path-only classification. */
export function fakeIntelligenceOutput(
    options: IntelligenceRunOptions,
    metrics: typeof MEASUREMENT = MEASUREMENT
): IntelligenceOutput {
    return { map: emptyReviewMap(options, metrics), baseMetrics: metrics };
}

export function fakeIntelligence(
    metrics: typeof MEASUREMENT = MEASUREMENT
): (options: IntelligenceRunOptions) => Promise<IntelligenceOutput> {
    return (options) => Promise.resolve(fakeIntelligenceOutput(options, metrics));
}

function emptyReviewMap(options: IntelligenceRunOptions, metrics: typeof MEASUREMENT): ReviewMap {
    const repository = repositoryMetrics(metrics);

    const emptyHotspots = {
        largestCodeGrowth: [],
        largestFileComplexityGrowth: [],
        largestCognitiveGrowth: [],
        largestCyclomaticGrowth: [],
        drynessRegression: [],
        newFunctions: [],
        parseFailures: []
    };

    return {
        schemaVersion: 1,
        revisions: { baseSha: options.baseSha, headSha: options.headSha },
        tools: { scc: { version: '4.1.0', status: 'ok' }, cccc: { version: '1.6.0', status: 'ok' } },
        coverage: {
            scc: { languages: [], notCounted: [], unmeasurable: [], unsupported: [] },
            cccc: { languages: [], unsupported: [], parseErrorFiles: [] }
        },
        repository: {
            base: repository,
            head: { ...repository },
            delta: { ...repository, dryness: 0 },
            changed: { added: 0, modified: 0, removed: 0, renamed: 0 }
        },
        languages: [],
        files: [],
        functions: [],
        distributions: { cccc: { base: null, head: null, delta: null } },
        hotspots: emptyHotspots,
        hotspotOmissions: {
            omitted: {
                largestCodeGrowth: 0,
                largestFileComplexityGrowth: 0,
                largestCognitiveGrowth: 0,
                largestCyclomaticGrowth: 0,
                drynessRegression: 0,
                newFunctions: 0,
                parseFailures: 0
            }
        },
        warnings: []
    };
}

function repositoryMetrics(metrics: typeof MEASUREMENT): RepositoryMetrics {
    return {
        files: metrics.recognizedFilesCount,
        lines: metrics.physicalLines,
        code: 0,
        comments: 0,
        blanks: 0,
        bytes: 0,
        complexity: 0,
        cognitive: 0,
        uloc: 0,
        dryness: null
    };
}

export const INPUTS: ActionInputs = {
    githubToken: 'github-token',
    triggerCommand: '@sakre',
    allowedAuthorAssociations: ['OWNER'],
    configPath: '.github/sakre.yml',
    provider: 'anthropic',
    defaultModel: 'test-model',
    isMockMode: true,
    forceOverBudget: false,
    credentials: {}
};

export function currentHeadSha(): string {
    const result = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });

    if (result.status !== 0) {
        throw new Error(result.stderr.trim());
    }

    return result.stdout.trim();
}

export function makeSnapshot(headSha: string): VcsPullRequestSnapshot {
    return {
        pullRequest: {
            owner: 'acme',
            repo: 'demo',
            number: 1,
            title: 'Test review',
            body: '',
            authorLogin: 'alice',
            baseRef: 'main',
            baseSha: headSha,
            headRef: 'feature',
            headSha
        },
        changedFiles: [],
        comments: []
    };
}
