const MAX_ATTEMPTS = 2;

const RETRYABLE_KINDS = new Set(['rate-limit', 'timeout', 'runtime-failure']);

export interface RetryPolicy {
    maxAttempts?: number;
    onRetry?: (attempt: number, kind: string) => void;
}

/* Single retry layer: bounded, visible in tests, transient kinds only. No other
   layer may be added. */
export async function withRetry<T>(
    operation: string,
    run: (attempt: number) => Promise<T>,
    policy: RetryPolicy = {}
): Promise<T> {
    const maxAttempts = policy.maxAttempts ?? MAX_ATTEMPTS;
    let lastError: unknown = undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            return await run(attempt);
        } catch (error) {
            lastError = error;

            if (attempt >= maxAttempts || !isRetryable(error)) {
                break;
            }

            policy.onRetry?.(attempt, 'retryable');
        }
    }

    throw lastError;
}

// eslint-disable-next-line anti-slop/no-unknown-parameters -- thrown step values cross this boundary as unknown
function isRetryable(error: unknown): boolean {
    // eslint-disable-next-line anti-slop/no-runtime-typeof -- object guard before probing the failure kind
    if (typeof error !== 'object' || error === null || !('kind' in error)) {
        return false;
    }

    const { kind } = error;

    // eslint-disable-next-line anti-slop/no-runtime-typeof -- narrows the decoded kind probe
    return typeof kind === 'string' && RETRYABLE_KINDS.has(kind);
}

export { MAX_ATTEMPTS };
