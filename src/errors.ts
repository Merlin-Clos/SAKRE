/* One owner for the error-to-message policy; loggers use it instead of re-deriving the `instanceof Error` branch. */

interface ErrorDetail {
    message: string;
}

function isErrorDetail(value: unknown): value is ErrorDetail {
    return (
        // eslint-disable-next-line anti-slop/no-runtime-typeof -- object guard at the thrown-value boundary
        typeof value === 'object' &&
        value !== null &&
        'message' in value &&
        // SAFETY: `message` key presence was checked above on a non-null object, so reading it is sound.
        // eslint-disable-next-line anti-slop/no-runtime-typeof -- narrows the probed message to strings
        typeof (value as { message?: unknown }).message === 'string'
    );
}

// eslint-disable-next-line anti-slop/no-unknown-parameters -- thrown values cross this boundary as unknown
export function describeError(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }

    /* SDK/RPC failures cross as plain tagged objects; String(error) would report "[object Object]". */
    if (isErrorDetail(error)) {
        return error.message;
    }

    return String(error);
}

// eslint-disable-next-line anti-slop/no-unknown-parameters -- thrown values cross this boundary as unknown
export function asError(error: unknown): Error {
    if (error instanceof Error) {
        return error;
    }

    return new Error(describeError(error));
}
