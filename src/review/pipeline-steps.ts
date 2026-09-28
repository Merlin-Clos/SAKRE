import { createHash } from 'node:crypto';
import { AiError, type AiRuntime } from '../ai/runtime';
import {
    type AgentOutput,
    type CoordinatorFinding,
    type MaterializedFinding,
    parseAgentOutput,
    parseCoordinatorOutput
} from '../contracts/review';
import type { AgentSpec } from './agents';
import { buildAgentPrompt, buildCoordinatorPrompt, type LoadedPrompts, type PromptPayload } from './prompts';
import type { ReviewContext } from './context';
import type { ReviewGuidance, ReviewGuidanceProvenance } from './guidance';
import { withRetry } from './retry';
import { AgentStepError, toFailure } from './step-failure';

const FINGERPRINT_LENGTH = 16;

export interface AgentCandidates {
    spec: AgentSpec;
    summary: string;
    candidates: MaterializedFinding[];
}

export interface CoordinatorOutcome {
    summary: string;
    findings: CoordinatorFinding[];
}

export interface DeadlineHandle {
    signal: AbortSignal;
    isExpired: () => boolean;
    configure: (minutes: number) => void;
    cancel: () => void;
}

export type ModelResolver = (agentId: string) => { providerID: string; modelID: string; variant?: string };

export interface PipelineDeps {
    runtime: AiRuntime;
    prompts: LoadedPrompts;
    modelFor: ModelResolver;
    /* Compact ReviewMap projection for the agent (common or enriched). */
    projectionFor: (agentId: string) => string;
    /* Raw guidance is delivered to specialist agents only. */
    guidance?: ReviewGuidance;
    /* Engine-owned provenance for the coordinator and the verifier. */
    guidanceProvenance: ReviewGuidanceProvenance;
}

/* Single deadline: all operations share this signal. No attempt starts after
   expiry. */
export function createDeadline(minutes: number, external?: AbortSignal): DeadlineHandle {
    const controller = new AbortController();
    const startedAt = Date.now();

    let timer = setTimeout(
        () => {
            controller.abort();
        },
        minutes * 60 * 1000
    );

    function onExternalAbort(): void {
        controller.abort();
    }

    /* Already aborted external signal must fail the deadline at once: no second
       abort event follows. */
    if (external?.aborted === true) {
        controller.abort();
    }

    external?.addEventListener('abort', onExternalAbort, { once: true });

    return {
        signal: controller.signal,
        isExpired: () => controller.signal.aborted,
        configure: (configuredMinutes) => {
            clearTimeout(timer);
            const remainingMilliseconds = configuredMinutes * 60 * 1000 - (Date.now() - startedAt);

            if (remainingMilliseconds <= 0) {
                controller.abort();

                return;
            }

            timer = setTimeout(() => {
                controller.abort();
            }, remainingMilliseconds);
        },
        cancel: () => {
            clearTimeout(timer);
            external?.removeEventListener('abort', onExternalAbort);
        }
    };
}

export function fingerprintOf(finding: {
    title: string;
    impact: string;
    evidence: string;
    location?: { file?: string; line?: number; lineEnd?: number };
}): string {
    const material = `${finding.title}|${finding.impact}|${finding.evidence}|${finding.location?.file ?? ''}`;

    return createHash('sha256').update(material).digest('hex').slice(0, FINGERPRINT_LENGTH);
}

export function stableFindingId(
    agentId: string,
    finding: { location?: { file?: string; line?: number } },
    fingerprint: string
): string {
    const file = finding.location?.file ?? 'no-file';
    const line = finding.location?.line ?? 0;

    return `${agentId}:${file}:${line}:${fingerprint}`;
}

/* Specialist call runs with the single retry layer, then strict validation. At
   most one valid submission per session; invalid output fails, never silence. */
export async function runSpecialistStep(
    spec: AgentSpec,
    deps: PipelineDeps,
    context: ReviewContext,
    deadline: DeadlineHandle
): Promise<AgentCandidates> {
    const stage = `agent:${spec.id}`;

    const payload = buildAgentPrompt({
        spec,
        templates: deps.prompts.templates,
        prContext: context.prContext,
        diff: context.diff,
        history: context.history,
        riskSummary: context.riskSummary,
        reviewMap: deps.projectionFor(spec.id),
        guidance: deps.guidance
    });

    try {
        return await withRetry(stage, () => runAgentCall(spec, payload, deps, deadline));
    } catch (error) {
        throw new AgentStepError(stage, toFailure(stage, error));
    }
}

async function runAgentCall(
    spec: AgentSpec,
    payload: PromptPayload,
    deps: PipelineDeps,
    deadline: DeadlineHandle
): Promise<AgentCandidates> {
    if (deadline.isExpired()) {
        throw new AiError('deadline-exceeded', `Deadline expired before agent ${spec.id} started.`);
    }

    const response = await deps.runtime.runStructured({
        agentId: spec.id,
        model: deps.modelFor(spec.id),
        systemPrompt: payload.systemPrompt,
        userPrompt: payload.userPrompt,
        retryPrompt: payload.retryPrompt,
        signal: deadline.signal
    });

    return materializeAgentOutput(spec, response.structured);
}

// eslint-disable-next-line anti-slop/no-unknown-parameters -- provider output validated by parseAgentOutput below
function materializeAgentOutput(spec: AgentSpec, structured: unknown): AgentCandidates {
    const validated: AgentOutput = parseAgentOutput(structured);

    const candidates = validated.findings.map((finding) => {
        const fingerprint = fingerprintOf(finding);

        return {
            ...finding,
            id: stableFindingId(spec.id, finding, fingerprint),
            fingerprint,
            sourceAgents: [spec.id]
        };
    });

    return { spec, summary: validated.summary, candidates };
}

export async function runCoordinatorStep(
    spec: AgentSpec,
    deps: PipelineDeps,
    context: ReviewContext,
    candidates: MaterializedFinding[],
    deadline: DeadlineHandle
): Promise<CoordinatorOutcome> {
    const stage = `agent:${spec.id}`;

    const payload = buildCoordinatorPrompt({
        spec,
        templates: deps.prompts.templates,
        evidence: {
            baseSha: context.baseSha,
            headSha: context.headSha,
            findings: candidates.map((candidate) => ({
                id: candidate.id,
                sourceAgent: candidate.sourceAgents[0] ?? 'unknown',
                path: candidate.location?.file,
                title: candidate.title,
                severity: candidate.severity,
                category: candidate.category,
                impact: candidate.impact,
                evidence: candidate.evidence,
                suggestedFix: candidate.suggestedFix
            })),
            diff: context.diff
        },
        riskSummary: context.riskSummary,
        history: context.history,
        reviewMap: deps.projectionFor(spec.id),
        guidance: deps.guidanceProvenance
    });

    try {
        return await withRetry(stage, async () => {
            if (deadline.isExpired()) {
                throw new AiError('deadline-exceeded', `Deadline expired before agent ${spec.id} started.`);
            }

            const response = await deps.runtime.runStructured({
                agentId: spec.id,
                model: deps.modelFor(spec.id),
                systemPrompt: payload.systemPrompt,
                userPrompt: payload.userPrompt,
                retryPrompt: payload.retryPrompt,
                signal: deadline.signal
            });

            const validated = parseCoordinatorOutput(response.structured);

            return { summary: validated.summary, findings: validated.findings };
        });
    } catch (error) {
        throw new AgentStepError(stage, toFailure(stage, error));
    }
}
