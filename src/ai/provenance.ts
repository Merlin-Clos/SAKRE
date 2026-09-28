import { z } from 'zod';
import type { AiRuntime, AiStructuredCall } from './runtime';

/* One invocation that reached the provider: agent id, exact model id, optional
catalog metadata. Artificial Analysis URL exists only with a configured entry. */
const modelInvocationProvenanceSchema = z.strictObject({
    agentId: z.string().min(1),
    model: z.string().min(1),
    artificialAnalysisUrl: z.url().optional()
});

type ModelInvocationProvenance = z.infer<typeof modelInvocationProvenanceSchema>;

export interface ModelInvocationLog {
    /* The runtime the pipeline must call; recording is transparent. */
    runtime: AiRuntime;
    /* Deduplicated actual invocations in deterministic agent/model order. */
    modelsUsed: () => ModelInvocationProvenance[];
}

/* Records each call that crosses the provider boundary, deduplicated by
   (agent, model). The model comes from the resolved call, never re-derived;
   calls failing during request construction stay unrecorded. */
export function recordModelInvocations(
    runtime: AiRuntime,
    artificialAnalysisUrlFor?: (modelId: string) => string | undefined
): ModelInvocationLog {
    const invocations = new Map<string, ModelInvocationProvenance>();

    return {
        runtime: {
            runStructured: (input) => {
                function record(): void {
                    const ref = formatInvocationRef(input.model.modelID, input.model.variant);
                    const key = `${input.agentId}\u0000${ref}`;

                    if (!invocations.has(key)) {
                        invocations.set(key, invocationEntry(input, artificialAnalysisUrlFor));
                    }
                }

                return runtime.runStructured({ ...input, onProviderDispatch: record });
            },
            close: () => runtime.close()
        },
        modelsUsed: () => [...invocations.values()].toSorted(compareInvocations)
    };
}

function formatInvocationRef(modelID: string, variant?: string): string {
    if (variant === undefined || variant === '') {
        return modelID;
    }

    return `${modelID}#${variant}`;
}

function invocationEntry(
    input: AiStructuredCall,
    artificialAnalysisUrlFor: ((modelId: string) => string | undefined) | undefined
): ModelInvocationProvenance {
    const ref = formatInvocationRef(input.model.modelID, input.model.variant);
    const artificialAnalysisUrl = artificialAnalysisUrlFor?.(input.model.modelID);

    if (artificialAnalysisUrl === undefined) {
        return { agentId: input.agentId, model: ref };
    }

    return { agentId: input.agentId, model: ref, artificialAnalysisUrl };
}

function compareInvocations(first: ModelInvocationProvenance, second: ModelInvocationProvenance): number {
    if (first.agentId !== second.agentId) {
        if (first.agentId < second.agentId) {
            return -1;
        }

        return 1;
    }

    if (first.model === second.model) {
        return 0;
    }

    if (first.model < second.model) {
        return -1;
    }

    return 1;
}

export type { ModelInvocationProvenance };
