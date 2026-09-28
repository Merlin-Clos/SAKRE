import type { ReviewMap } from './schema';

/* The canonical object stays complete; only its log payload is capped, and any truncation is stated. */
export const REVIEW_MAP_LOG_CAP_CHARS = 256_000;

export function reviewMapLogPayload(map: ReviewMap, capChars: number = REVIEW_MAP_LOG_CAP_CHARS): string {
    const payload = JSON.stringify(map, undefined, 2);

    if (payload.length <= capChars) {
        return payload;
    }

    const omitted = payload.length - capChars;

    return `${payload.slice(0, capChars)}\n[ReviewMap log truncated: ${omitted} characters omitted; the internal map stays complete.]`;
}
