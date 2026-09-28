import { AiError, type AiRuntime } from '../ai/runtime';
import { type FindingLocation, parseVerifierOutput, type ReviewFailure, type Severity } from '../contracts/review';
import { buildVerifierPrompt, type LoadedPrompts } from './prompts';
import type { ReviewGuidanceProvenance } from './guidance';
import type { DeadlineHandle, ModelResolver } from './pipeline-steps';
import { toFailure } from './step-failure';

/* Blocker and Important verify at every tier; Minor stays unverified. Tier sets
   width, never trust. */
export function isEligibleForVerification(severity: Severity, _tier: 'lite' | 'standard' | 'hard'): boolean {
    return severity === 'Blocker' || severity === 'Important';
}

export interface VerificationOutcome {
    verified: Map<string, { state: 'confirmed' | 'rejected'; reason: string }>;
    failures: ReviewFailure[];
}

export interface VerificationInput {
    findings: {
        id: string;
        severity: Severity;
        title: string;
        impact: string;
        evidence: string;
        location?: FindingLocation;
        suggestedFix?: string;
    }[];
    tier: 'lite' | 'standard' | 'hard';
    runtime: AiRuntime;
    prompts: LoadedPrompts;
    modelFor: ModelResolver;
    diff: string;
    projection: string;
    /* Provenance metadata only: the verifier never receives raw guidance. */
    guidance: ReviewGuidanceProvenance;
    deadline: DeadlineHandle;
}

/* Eligible findings verify in parallel in separate sessions. A verifier failure
   leaves the candidate unverified and the review incomplete; never removed. */
export async function verifyFindings(input: VerificationInput): Promise<VerificationOutcome> {
    const eligible = input.findings.filter((finding) => isEligibleForVerification(finding.severity, input.tier));
    const outcomes = await Promise.all(eligible.map((finding) => verifyFinding(input, finding)));
    const verified = new Map<string, { state: 'confirmed' | 'rejected'; reason: string }>();
    const failures: ReviewFailure[] = [];

    for (const outcome of outcomes) {
        if (outcome.outcome === undefined) {
            failures.push(toFailure(`verifier:${outcome.id}`, outcome.error));
        } else {
            verified.set(outcome.id, outcome.outcome);
        }
    }

    return { verified, failures };
}

interface SingleOutcome {
    id: string;
    outcome?: { state: 'confirmed' | 'rejected'; reason: string };
    error?: unknown;
}

async function verifyFinding(
    input: VerificationInput,
    finding: { id: string; title: string; impact: string; evidence: string; suggestedFix?: string }
): Promise<SingleOutcome> {
    try {
        const outcome = await verifyOne(input, finding);

        return { id: finding.id, outcome };
    } catch (error) {
        return { id: finding.id, error };
    }
}

async function verifyOne(
    input: VerificationInput,
    finding: {
        id: string;
        title: string;
        impact: string;
        evidence: string;
        location?: FindingLocation;
        suggestedFix?: string;
    }
): Promise<{ state: 'confirmed' | 'rejected'; reason: string }> {
    const payload = buildVerifierPrompt({
        templates: input.prompts.templates,
        finding,
        diff: input.diff,
        reviewMap: input.projection,
        guidance: input.guidance
    });

    if (input.deadline.isExpired()) {
        throw new AiError('cancelled', `Deadline expired before verifier for ${finding.id}.`);
    }

    const response = await input.runtime.runStructured({
        agentId: 'verifier',
        model: input.modelFor('verifier'),
        systemPrompt: payload.systemPrompt,
        userPrompt: payload.userPrompt,
        retryPrompt: payload.retryPrompt,
        signal: input.deadline.signal
    });

    const validated = parseVerifierOutput(response.structured);

    if (validated.findingId !== finding.id) {
        throw new AiError('invalid-output', 'Verifier returned a result for another finding.');
    }

    return { state: validated.state, reason: validated.reason };
}
