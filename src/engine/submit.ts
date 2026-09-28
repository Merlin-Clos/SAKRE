import { agentOutputJsonSchema, coordinatorOutputJsonSchema, verifierOutputJsonSchema } from '../contracts/review';
import { readToolCalls } from './session';

/* Embedded submit tools: one per pipeline role family. The JSON Schema always
   comes from the same Zod contract the pipeline re-validates with, so the tool
   definition and the domain validation cannot diverge. */
export const engineSubmitToolNames = {
    findings: 'submit_findings',
    coordination: 'submit_coordination',
    verdict: 'submit_verdict'
} as const;

export type EngineSubmitToolName = (typeof engineSubmitToolNames)[keyof typeof engineSubmitToolNames];

export interface EngineSubmitToolSpec {
    name: EngineSubmitToolName;
    description: string;
    // eslint-disable-next-line anti-slop/no-unsafe-dictionary-type -- JSON Schema document derived from the Zod contract
    input: Record<string, unknown>;
}

const FINDINGS_DESCRIPTION =
    'Record the final review output for this session. Call exactly once with the complete result: a summary, every candidate finding, and whether Context7 was used. A second call is rejected.';

const COORDINATION_DESCRIPTION =
    'Record the adjudicated coordination result for this session. Call exactly once with the complete result: a summary and every retained finding with its source candidate ids. A second call is rejected.';

const VERDICT_DESCRIPTION =
    'Record the verifier verdict for the finding under review. Call exactly once with findingId, state (confirmed or rejected) and a repository-evidence reason. A second call is rejected.';

/* Coordinator and verifier are fixed pipeline agents; every other agent id is
   a specialist or a declarative role and submits findings. */
export function submitToolForAgent(agentId: string): EngineSubmitToolName {
    if (agentId === 'coordinator') {
        return engineSubmitToolNames.coordination;
    }

    if (agentId === 'verifier') {
        return engineSubmitToolNames.verdict;
    }

    return engineSubmitToolNames.findings;
}

export function engineSubmitToolSpecs(): EngineSubmitToolSpec[] {
    return [
        { name: engineSubmitToolNames.findings, description: FINDINGS_DESCRIPTION, input: agentOutputJsonSchema() },
        {
            name: engineSubmitToolNames.coordination,
            description: COORDINATION_DESCRIPTION,
            input: coordinatorOutputJsonSchema()
        },
        { name: engineSubmitToolNames.verdict, description: VERDICT_DESCRIPTION, input: verifierOutputJsonSchema() }
    ];
}

/* First completed submission for the expected tool wins. Failed calls (schema
   rejection or duplicate guard) are ignored: they only inform the model
   inside the turn. */
// eslint-disable-next-line anti-slop/no-unknown-returns -- unvalidated engine submission; the pipeline re-validates via Zod
export function readSubmission(messages: readonly unknown[], tool: EngineSubmitToolName): unknown {
    for (const call of readToolCalls(messages)) {
        if (call.name === tool && call.status === 'completed') {
            return call.input;
        }
    }

    return undefined;
}
