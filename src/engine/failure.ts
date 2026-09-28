import type { AiFailureKind } from '../ai/runtime';
import { redactSensitive } from '../logger';
import type { EngineSessionErrorInfo } from './session';

const HTTP_STATUS_UNAUTHORIZED = 401;

const HTTP_STATUS_FORBIDDEN = 403;

const HTTP_STATUS_REQUEST_TIMEOUT = 408;

const HTTP_STATUS_TOO_MANY_REQUESTS = 429;

const HTTP_STATUS_GATEWAY_TIMEOUT = 504;

/* HTTP status is the authoritative classification input (401/403 provider-auth,
   429 rate-limit, 408/504 timeout); message/type heuristic is the fallback
   for engine errors without a status. */
export function classifyEngineError(info: EngineSessionErrorInfo): AiFailureKind {
    return statusFailureKind(info.status) ?? typeFailureKind(info.type);
}

function statusFailureKind(status: number | undefined): AiFailureKind | undefined {
    if (status === HTTP_STATUS_UNAUTHORIZED || status === HTTP_STATUS_FORBIDDEN) {
        return 'provider-auth';
    }

    if (status === HTTP_STATUS_TOO_MANY_REQUESTS) {
        return 'rate-limit';
    }

    if (status === HTTP_STATUS_REQUEST_TIMEOUT || status === HTTP_STATUS_GATEWAY_TIMEOUT) {
        return 'timeout';
    }

    return undefined;
}

function typeFailureKind(type: string): AiFailureKind {
    const normalized = type.toLowerCase();

    if (normalized.includes('auth')) {
        return 'provider-auth';
    }

    if (normalized.includes('rate') || normalized.includes('limit')) {
        return 'rate-limit';
    }

    if (normalized.includes('timeout')) {
        return 'timeout';
    }

    return 'runtime-failure';
}

/* Status-only engine errors still need a usable message for logs, the failure
   comment, and the retry decision. This is the single normalization boundary,
   so redaction here covers every sink (ReviewFailure, the Markdown renderer,
   CLI stderr and --output-file). */
export function engineErrorDetail(info: EngineSessionErrorInfo): string {
    return redactSensitive(engineErrorText(info));
}

function engineErrorText(info: EngineSessionErrorInfo): string {
    if (info.message !== '') {
        return info.message;
    }

    if (info.status !== undefined) {
        return `Engine session failed with ${info.type} (HTTP ${info.status}).`;
    }

    return `Engine session failed with ${info.type}.`;
}
