import type { AiRuntime, AiStructuredCall, AiStructuredResult } from './runtime';

const EMPTY_AGENT_RESULT = {
    summary: 'Mock review completed without calling an AI provider.',
    findings: [],
    usedContext7: false,
    context7Topics: []
};

const EMPTY_COORDINATOR_RESULT = {
    summary: 'Mock review completed without calling an AI provider.',
    findings: []
};

/* Deterministic local runtime: lets the review cycle be tested without a
   provider, HTTP request, or provider credential. */
export function createMockRuntime(): AiRuntime {
    return {
        runStructured: (input) => mockResponse(input),
        close: () => Promise.resolve()
    };
}

function mockResponse(input: AiStructuredCall): Promise<AiStructuredResult> {
    /* Mock mode has no provider request to construct, so every call it answers
       crosses its execution boundary and stays visible as model provenance. */
    input.onProviderDispatch?.();

    if (input.agentId === 'coordinator') {
        return Promise.resolve({ structured: EMPTY_COORDINATOR_RESULT, text: '' });
    }

    if (input.agentId === 'verifier') {
        return Promise.resolve({ structured: mockVerifierResult(input), text: '' });
    }

    return Promise.resolve({ structured: EMPTY_AGENT_RESULT, text: '' });
}

function mockVerifierResult(input: AiStructuredCall): Record<string, string> {
    const findingId = /Finding id:\s+(?<findingId>\S+)/u.exec(input.userPrompt)?.groups?.findingId;

    // eslint-disable-next-line anti-slop/no-known-value-widening -- mock seam returns the engine-shaped verifier record
    return {
        findingId: findingId ?? 'mock-finding',
        state: 'rejected',
        reason: 'Mock mode does not evaluate provider findings.'
    };
}
