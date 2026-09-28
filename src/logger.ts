import { debug, endGroup, error, info, startGroup, warning } from '@actions/core';
import { createRedactor, type Redactor } from './redaction';

const MAX_STRING_LENGTH = 500;

const MAX_DATA_LENGTH = 2000;

/* Action writes through @actions/core; CLI redirects to stderr so stdout stays reserved for results. */
export interface LogSink {
    debug: (message: string) => void;
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
    /* Bypasses per-string and per-data caps for payloads with their own cap (ReviewMap log). Redaction still applies. */
    raw: (message: string) => void;
    group: (title: string) => void;
    groupEnd: () => void;
}

const actionsLogSink: LogSink = {
    debug: (message) => {
        debug(message);
    },
    info: (message) => {
        info(message);
    },
    warn: (message) => {
        warning(message);
    },
    error: (message) => {
        error(message);
    },
    raw: (message) => {
        info(message);
    },
    group: (title) => {
        startGroup(title);
    },
    groupEnd: () => {
        endGroup();
    }
};

let activeRedactor: Redactor = createRedactor();

let activeSink: LogSink = actionsLogSink;

/* Call at startup with known credentials; every log output goes through the redactor. */
export function configureLogRedaction(knownSecrets: string[]): void {
    activeRedactor = createRedactor(knownSecrets);
}

export function configureLogSink(sink: LogSink): void {
    activeSink = sink;
}

export function resetLogSink(): void {
    activeSink = actionsLogSink;
}

/* Redirects log lines to a stream (stderr for the CLI) with Action sink formatting. */
export function createStreamLogSink(stream: NodeJS.WritableStream): LogSink {
    function write(message: string): void {
        stream.write(`${message}\n`);
    }

    return {
        debug: write,
        info: write,
        warn: write,
        error: write,
        raw: write,
        group: write,
        groupEnd: () => {
            // A stream has no group nesting.
        }
    };
}

export function redactSensitive(text: string): string {
    return activeRedactor.redact(text);
}

interface Logger {
    debug: (message: string, data?: Record<string, unknown>) => void;
    info: (message: string, data?: Record<string, unknown>) => void;
    warn: (message: string, data?: Record<string, unknown>) => void;
    error: (message: string, data?: Record<string, unknown>) => void;
    raw: (message: string) => void;
    group: (title: string) => void;
    groupEnd: () => void;
    time: (label: string) => void;
    timeEnd: (label: string, data?: Record<string, unknown>) => void;
    withScope: (scope: string) => Logger;
}

function createLogger(scope?: string, timers = new Map<string, number>()): Logger {
    return {
        debug: (message, data) => {
            activeSink.debug(formatMessage(scope, message, data));
        },
        info: (message, data) => {
            activeSink.info(formatMessage(scope, message, data));
        },
        warn: (message, data) => {
            activeSink.warn(formatMessage(scope, message, data));
        },
        error: (message, data) => {
            activeSink.error(formatMessage(scope, message, data));
        },
        raw: (message) => {
            activeSink.raw(formatScope(scope, activeRedactor.redact(message)));
        },
        group: (title) => {
            activeSink.group(formatScope(scope, title));
        },
        groupEnd: () => {
            activeSink.groupEnd();
        },
        time: (label) => {
            timers.set(timerKey(scope, label), now());
        },
        timeEnd: (label, data) => {
            const key = timerKey(scope, label);
            const startedAt = timers.get(key);
            timers.delete(key);

            if (startedAt === undefined) {
                activeSink.debug(formatMessage(scope, `Timer ${label} ended without a start time.`));

                return;
            }

            activeSink.info(
                formatMessage(scope, `${label} completed`, { ...data, durationMs: Math.round(now() - startedAt) })
            );
        },
        withScope: (childScope) => createLogger(childLoggerScope(scope, childScope), timers)
    };
}

function formatMessage(scope: string | undefined, message: string, data?: Record<string, unknown>): string {
    const suffix = formatData(data);
    const scopedMessage = formatScope(scope, activeRedactor.redact(message));

    if (!suffix) {
        return scopedMessage;
    }

    return `${scopedMessage} ${suffix}`;
}

function formatScope(scope: string | undefined, message: string): string {
    if (!scope) {
        return message;
    }

    return `[${scope}] ${message}`;
}

function formatData(data?: Record<string, unknown> | undefined): string {
    if (!data || Object.keys(data).length === 0) {
        return '';
    }

    try {
        // eslint-disable-next-line anti-slop/no-unknown-parameters -- JSON replacer walks arbitrary log data
        const serialized = JSON.stringify(data, (_key, value: unknown) => {
            // eslint-disable-next-line anti-slop/no-runtime-typeof -- truncates overlong log strings
            if (typeof value === 'string' && value.length > MAX_STRING_LENGTH) {
                return `${value.slice(0, MAX_STRING_LENGTH)}... [truncated ${value.length - MAX_STRING_LENGTH} chars]`;
            }

            if (value instanceof Error) {
                return {
                    name: value.name,
                    message: activeRedactor.redact(value.message),
                    stack: value.stack
                };
            }

            return value;
        });

        /* Redact before truncating, so secrets never survive an overlong payload. */
        const redacted = activeRedactor.redact(serialized);

        if (redacted.length > MAX_DATA_LENGTH) {
            return `${redacted.slice(0, MAX_DATA_LENGTH)}... [truncated ${redacted.length - MAX_DATA_LENGTH} chars]`;
        }

        return redacted;
    } catch {
        return JSON.stringify({ logData: '[unserializable]' });
    }
}

function childLoggerScope(scope: string | undefined, childScope: string): string {
    if (!scope) {
        return childScope;
    }

    return `${scope}:${childScope}`;
}

function timerKey(scope: string | undefined, label: string): string {
    return `${scope ?? 'root'}:${label}`;
}

function now(): number {
    return globalThis.performance?.now?.() ?? Date.now();
}

export type { Logger };

export { childLoggerScope, createLogger, formatData, formatMessage, timerKey };
