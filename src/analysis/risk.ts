import { classifyFile, defaultClassificationRules, type FileClassification } from './classification';
import { matchesAnyGlob } from './globs';
import { DEFAULT_RISK_RULES, type RiskRules, type RiskTier, type SpecialistId } from './risk-rules';
import type { ClassificationRules } from '../config/schema';
import { changedFilePaths, type VcsChangedFile } from '../vcs/types';

export interface RiskSignal {
    id: string;
    paths: string[];
}

export interface RiskEscalation {
    id: string;
    minTier: RiskTier;
    detail: string;
}

export interface RiskAssessment {
    appliedRules: RiskRules;
    tier: RiskTier;
    volumeTier: RiskTier;
    volumeScore: number;
    changedFilesCount: number;
    changedLines: number;
    /* Noise files stay visible as changed files but never inflate volume, ratios or specialists. */
    noiseFilesCount: number;
    fileRatio: number;
    lineRatio: number;
    signals: RiskSignal[];
    escalations: RiskEscalation[];
    requiredSpecialists: SpecialistId[];
}

export interface RiskInput {
    changedFiles: VcsChangedFile[];
    recognizedFilesCount: number;
    physicalLines: number;
    rules?: RiskRules;
    classification?: ClassificationRules;
    /* Content-aware pre-pass classifications keyed by path; when absent, files fall back to path-only. */
    fileClassifications?: ReadonlyMap<string, FileClassification>;
}

const TIER_RANK: Record<RiskTier, number> = { lite: 0, standard: 1, hard: 2 };

const NOISE_RATIO_DENOMINATOR_FALLBACK = 1;

/* Volume tier is computed first; ratios and escalations can only raise it. */
export function assessRisk(input: RiskInput): RiskAssessment {
    const rules = input.rules ?? DEFAULT_RISK_RULES;
    const classification = input.classification ?? defaultClassificationRules();
    const classifications = classificationsFor(input, classification);
    const volume = computeVolume(input.changedFiles, rules, classifications);
    const ratios = computeRatios(volume.changedFilesCount, volume.changedLines, input);
    const signals = collectSignals(input.changedFiles, rules);

    const escalations = collectEscalations({
        rules,
        volumeTier: volume.tier,
        fileRatio: ratios.fileRatio,
        lineRatio: ratios.lineRatio,
        signals
    });

    const tier = applyEscalations(volume.tier, escalations);

    return {
        appliedRules: rules,
        tier,
        volumeTier: volume.tier,
        volumeScore: volume.score,
        changedFilesCount: volume.changedFilesCount,
        changedLines: volume.changedLines,
        noiseFilesCount: volume.noiseFilesCount,
        fileRatio: ratios.fileRatio,
        lineRatio: ratios.lineRatio,
        signals,
        escalations,
        requiredSpecialists: collectSpecialists(signals, volume.changedLines, rules)
    };
}

/* Pre-pass classifications win through generated markers; path-only is the fallback without measured content. */
function classificationsFor(
    input: RiskInput,
    classification: ClassificationRules
): ReadonlyMap<string, FileClassification> {
    const provided = input.fileClassifications;

    if (provided !== undefined) {
        return provided;
    }

    return new Map(
        input.changedFiles.map((file) => [
            file.path,
            classifyFile({ path: file.path, previousPath: file.previousPath, rules: classification })
        ])
    );
}

interface VolumeEstimate {
    changedFilesCount: number;
    changedLines: number;
    noiseFilesCount: number;
    score: number;
    tier: RiskTier;
}

interface VolumeTotals {
    changedFilesCount: number;
    changedLines: number;
    noiseFilesCount: number;
}

function computeVolume(
    changedFiles: VcsChangedFile[],
    rules: RiskRules,
    classifications: ReadonlyMap<string, FileClassification>
): VolumeEstimate {
    const totals: VolumeTotals = { changedFilesCount: 0, changedLines: 0, noiseFilesCount: 0 };

    for (const file of changedFiles) {
        accumulateVolume(totals, file, classifications);
    }

    const score =
        totals.changedFilesCount * rules.weights.changedFiles + totals.changedLines * rules.weights.changedLines;

    return { ...totals, score, tier: tierForScore(score, rules) };
}

function accumulateVolume(
    totals: VolumeTotals,
    file: VcsChangedFile,
    classifications: ReadonlyMap<string, FileClassification>
): void {
    if (classifications.get(file.path)?.risk.noise === true) {
        totals.noiseFilesCount += 1;

        return;
    }

    totals.changedFilesCount += 1;
    totals.changedLines += file.additions + file.deletions;
}

interface RatioEstimate {
    fileRatio: number;
    lineRatio: number;
}

function computeRatios(changedFilesCount: number, changedLines: number, input: RiskInput): RatioEstimate {
    const recognizedFiles = Math.max(input.recognizedFilesCount, NOISE_RATIO_DENOMINATOR_FALLBACK);
    const physicalLines = Math.max(input.physicalLines, NOISE_RATIO_DENOMINATOR_FALLBACK);

    return { fileRatio: changedFilesCount / recognizedFiles, lineRatio: changedLines / physicalLines };
}

function applyEscalations(volumeTier: RiskTier, escalations: RiskEscalation[]): RiskTier {
    let tier = volumeTier;

    for (const escalation of escalations) {
        tier = maxTier(tier, escalation.minTier);
    }

    return tier;
}

function tierForScore(score: number, rules: RiskRules): RiskTier {
    if (score <= rules.thresholds.liteMaxScore) {
        return 'lite';
    }

    if (score <= rules.thresholds.standardMaxScore) {
        return 'standard';
    }

    return 'hard';
}

/* Sensitive paths check both new and old paths, so a rename cannot escape the security reviewer. */
function collectSignals(changedFiles: VcsChangedFile[], rules: RiskRules): RiskSignal[] {
    const signals: RiskSignal[] = [];

    for (const rule of rules.escalations) {
        const paths = changedFiles
            .flatMap((file) => changedFilePaths(file))
            .filter((path) => matchesAnyGlob(path, rule.patterns));

        const uniquePaths = [...new Set(paths)];

        if (uniquePaths.length > 0) {
            signals.push({ id: rule.id, paths: uniquePaths });
        }
    }

    return signals;
}

interface EscalationInput {
    rules: RiskRules;
    volumeTier: RiskTier;
    fileRatio: number;
    lineRatio: number;
    signals: RiskSignal[];
}

function collectEscalations(input: EscalationInput): RiskEscalation[] {
    const escalations: RiskEscalation[] = [];
    const ratioTier = ratioEscalationTier(input);

    if (TIER_RANK[ratioTier] > TIER_RANK[input.volumeTier]) {
        escalations.push({
            id: 'volume-ratio',
            minTier: ratioTier,
            detail: `fileRatio=${input.fileRatio}, lineRatio=${input.lineRatio} reached escalation thresholds ${input.rules.ratios.fileRatio}/${input.rules.ratios.lineRatio}`
        });
    }

    for (const signal of input.signals) {
        const rule = input.rules.escalations.find((candidate) => candidate.id === signal.id);

        if (rule && TIER_RANK[rule.minTier] > TIER_RANK[input.volumeTier]) {
            escalations.push({
                id: rule.id,
                minTier: rule.minTier,
                detail: `matched paths: ${signal.paths.join(', ')}`
            });
        }
    }

    return escalations;
}

function ratioEscalationTier(input: EscalationInput): RiskTier {
    if (input.fileRatio >= input.rules.ratios.fileRatio || input.lineRatio >= input.rules.ratios.lineRatio) {
        return 'hard';
    }

    return input.volumeTier;
}

/* Signal specialists are added regardless of volume tier; a security signal always brings its reviewer. */
function collectSpecialists(signals: RiskSignal[], changedLines: number, rules: RiskRules): SpecialistId[] {
    const specialists = new Set<SpecialistId>();

    for (const signal of signals) {
        const rule = rules.escalations.find((candidate) => candidate.id === signal.id);

        if (rule?.addSpecialist) {
            specialists.add(rule.addSpecialist);
        }
    }

    if (changedLines >= rules.largeChangeLines) {
        specialists.add('performance');
    }

    return [...specialists].toSorted();
}

function maxTier(left: RiskTier, right: RiskTier): RiskTier {
    if (TIER_RANK[left] >= TIER_RANK[right]) {
        return left;
    }

    return right;
}
