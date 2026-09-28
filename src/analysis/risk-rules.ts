import { defaultClassificationRules } from './classification';
import type { ClassificationRules, RiskOverrides } from '../config/schema';

const riskTiers = ['lite', 'standard', 'hard'] as const;

export type RiskTier = (typeof riskTiers)[number];

export type SpecialistId = 'security' | 'performance' | 'conventions';

export interface RiskEscalationRule {
    id: string;
    patterns: string[];
    minTier: Exclude<RiskTier, 'lite'>;
    addSpecialist?: SpecialistId;
}

export interface RiskRules {
    thresholds: { liteMaxScore: number; standardMaxScore: number };
    weights: { changedFiles: number; changedLines: number };
    ratios: { fileRatio: number; lineRatio: number };
    largeChangeLines: number;
    escalations: RiskEscalationRule[];
}

/* Patterns come from the classification owner; this module owns only the escalation policy. */
function escalationRule(input: {
    id: string;
    patterns: readonly string[];
    minTier: Exclude<RiskTier, 'lite'>;
    addSpecialist?: SpecialistId;
}): RiskEscalationRule {
    return { ...input, patterns: [...input.patterns] };
}

function defaultEscalations(): RiskEscalationRule[] {
    const classification = defaultClassificationRules();

    return [
        escalationRule({ id: 'critical-paths', patterns: classification.criticalPathPatterns, minTier: 'standard' }),
        escalationRule({ id: 'workflows', patterns: ['.github/workflows/**'], minTier: 'standard' }),
        escalationRule({
            id: 'dependencies',
            patterns: classification.dependencyManifestPatterns,
            minTier: 'standard'
        }),
        escalationRule({ id: 'migrations', patterns: ['**/migrations/**'], minTier: 'hard' }),
        escalationRule({
            id: 'security',
            patterns: classification.securityPathPatterns,
            minTier: 'standard',
            addSpecialist: 'security'
        }),
        /* Performance and convention paths escalate and bring their specialist, like the security signal. */
        escalationRule({
            id: 'performance',
            patterns: classification.performancePathPatterns,
            minTier: 'standard',
            addSpecialist: 'performance'
        }),
        escalationRule({
            id: 'conventions',
            patterns: classification.conventionPathPatterns,
            minTier: 'standard',
            addSpecialist: 'conventions'
        })
    ];
}

export const DEFAULT_RISK_RULES: RiskRules = {
    thresholds: { liteMaxScore: 12, standardMaxScore: 35 },
    weights: { changedFiles: 0.18, changedLines: 0.008 },
    ratios: { fileRatio: 0.2, lineRatio: 0.1 },
    largeChangeLines: 250,
    escalations: defaultEscalations()
};

/* Configured rules replace escalation pattern lists; thresholds, weights, ratios and tiers stay canonical. */
export function riskRulesForConfig(classification: ClassificationRules, risk?: RiskOverrides): RiskRules {
    const thresholds = { ...DEFAULT_RISK_RULES.thresholds, ...risk?.thresholds };
    const weights = { ...DEFAULT_RISK_RULES.weights, ...risk?.weights };
    const ratios = { ...DEFAULT_RISK_RULES.ratios, ...risk?.ratios };
    const largeChangeLines = risk?.largeChangeLines ?? DEFAULT_RISK_RULES.largeChangeLines;

    if (risk?.escalations !== undefined) {
        return {
            thresholds,
            weights,
            ratios,
            largeChangeLines,
            escalations: risk.escalations.map((rule) => ({ ...rule, patterns: [...rule.patterns] }))
        };
    }

    const base = rulesFromClassification(classification);

    return { ...base, thresholds, weights, ratios, largeChangeLines };
}

/* Previous entry point kept for compatibility; it applies no risk overrides. */
export function riskRulesForClassification(classification: ClassificationRules): RiskRules {
    return riskRulesForConfig(classification);
}

function rulesFromClassification(classification: ClassificationRules): RiskRules {
    // eslint-disable-next-line anti-slop/no-known-value-widening -- groups validated pattern lists by rule id
    const classified: Record<string, string[]> = {
        'critical-paths': [...classification.criticalPathPatterns],
        dependencies: [...classification.dependencyManifestPatterns],
        security: [...classification.securityPathPatterns],
        performance: [...classification.performancePathPatterns],
        conventions: [...classification.conventionPathPatterns]
    };

    return {
        ...DEFAULT_RISK_RULES,
        escalations: DEFAULT_RISK_RULES.escalations.map((rule) => {
            const patterns = classified[rule.id];

            if (patterns === undefined) {
                return rule;
            }

            return { ...rule, patterns };
        })
    };
}

/* Escalation matches keep their hunks before neutral paths when the diff budget runs out. */
export function escalationPriorityPatterns(rules: RiskRules = DEFAULT_RISK_RULES): string[] {
    return rules.escalations.flatMap((rule) => rule.patterns);
}
