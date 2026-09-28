/* Minimal AI boundary: the domain only interacts with this interface.
Sessions, tool loop, and events stay confined to the adapter. */
export const aiFailureKinds = [
    'provider-auth',
    'rate-limit',
    'timeout',
    'cancelled',
    'deadline-exceeded',
    'invalid-output',
    'runtime-failure'
] as const;

export type AiFailureKind = (typeof aiFailureKinds)[number];

export class AiError extends Error {
    public readonly kind: AiFailureKind;

    public constructor(kind: AiFailureKind, message: string) {
        super(message);
        this.name = 'AiError';
        this.kind = kind;
    }
}

export interface AiModelRoute {
    providerID: string;
    modelID: string;
    /* Undefined means the default variant. Transported from the routing matrix
       to the session; OpenCode rejects an unknown id. */
    variant?: string;
}

/* Runtime selects the structured contract from `agentId`; caller schemas cannot
   drift from the one the runtime enforces. */
export interface AiStructuredCall {
    agentId: string;
    model: AiModelRoute;
    /* Static behavioral policy: the engine session instruction entry. */
    systemPrompt: string;
    /* Review evidence plus the final request: the session user message. */
    userPrompt: string;
    /* Short continuation for a retry turn; required so an omitted retry can
       never fall back to resending the whole evidence message. */
    retryPrompt: string;
    /* Signals each turn dispatched to the provider, including retries. Lets
       provenance skip failures raised while a request is still constructed. */
    onProviderDispatch?: () => void;
    signal?: AbortSignal;
}

export interface AiStructuredResult {
    structured: unknown;
    text: string;
}

export interface AiRuntime {
    runStructured: (input: AiStructuredCall) => Promise<AiStructuredResult>;
    close: () => Promise<void>;
}
