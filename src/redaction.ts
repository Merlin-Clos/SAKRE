/* Second-defense redaction for every log output and published comment; explicit credentials and known secret patterns are neutralized. */

const SECRET_PATTERNS: RegExp[] = [
    /gh[pousr]_[A-Za-z0-9]{16,}/gu,
    /github_pat_[A-Za-z0-9_]{20,}/gu,
    /sk-[A-Za-z0-9-]{12,}/gu,
    /AKIA[0-9A-Z]{16}/gu,
    /xox[baprs]-[A-Za-z0-9-]{10,}/gu,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/gu,
    /Bearer [A-Za-z0-9._-]{16,}/gu
];

const REDACTED_PLACEHOLDER = '[redacted]';

const MIN_SECRET_LENGTH = 8;

export interface Redactor {
    redact: (text: string) => string;
}

export function createRedactor(knownSecrets: string[] = []): Redactor {
    const explicitSecrets = knownSecrets.filter((secret) => secret.length >= MIN_SECRET_LENGTH);

    return {
        redact: (text: string) => redactText(text, explicitSecrets)
    };
}

/* Every string in an open credential value counts as a secret candidate for
   redaction: keys, account ids, and stringified primitives never reach a log. */
// eslint-disable-next-line anti-slop/no-unknown-parameters -- recursively collects secret strings from decoded entries
export function collectSecretStrings(value: unknown): string[] {
    // eslint-disable-next-line anti-slop/no-runtime-typeof -- intentional narrowing of open credential JSON
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        const text = String(value);

        if (text === '') {
            return [];
        }

        return [text];
    }

    if (Array.isArray(value)) {
        return value.flatMap((item) => collectSecretStrings(item));
    }

    // eslint-disable-next-line anti-slop/no-runtime-typeof -- intentional narrowing of open credential JSON
    if (typeof value === 'object' && value !== null) {
        return Object.values(value).flatMap((item) => collectSecretStrings(item));
    }

    return [];
}

function redactText(text: string, explicitSecrets: string[]): string {
    let redacted = text;

    for (const secret of explicitSecrets) {
        redacted = redacted.split(secret).join(REDACTED_PLACEHOLDER);
    }

    for (const pattern of SECRET_PATTERNS) {
        redacted = redacted.replace(pattern, REDACTED_PLACEHOLDER);
    }

    return redacted;
}
