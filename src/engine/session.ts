import type { AiModelRoute } from '../ai/runtime';
import type { EngineHost } from './host';

/* Static role system prompt is stored as one session instruction entry
   under this key; review evidence travels on the session message surface.
   Entry is removed with the session. */
export const ENGINE_SYSTEM_PROMPT_KEY = 'agent-system-prompt';

export interface EngineSessionRequest {
    title: string;
    model: AiModelRoute;
    systemPrompt: string;
}

export interface EngineSessionErrorInfo {
    type: string;
    message: string;
    status?: number;
}

export interface EngineToolCallInfo {
    name: string;
    status: string;
    input: unknown;
}

/* The engine publishes the terminal failure of a session as a durable event
   (`session.execution.failed`, and `session.step.failed` for the failing step).
   Both carry the same `{type,message,status}` error shape as an assistant
   message; the message surface only carries a provider error on an assistant
   message, so a request rejected before provider dispatch is visible here. */
export interface EngineSessionFailureEvent {
    sessionID: string;
    error: EngineSessionErrorInfo;
}

export interface EngineSessionMessages {
    error: EngineSessionErrorInfo | undefined;
    outcome: string | undefined;
    text: string;
    /* Engine commits an assistant message only when a step reached the
       provider (output, provider error with status, or provider failure); a
       request rejected during construction leaves only the user message and
       an idle outcome. */
    providerDispatched: boolean;
}

/* One session per agent call: the model and the role system prompt are fixed
   when the session opens, so a later call can never inherit another role's
   instructions or route. The session directory is the host's authorized
   directory, never a caller-supplied path. The variant overlay travels on the
   session model ref: undefined selects the default variant, any other id is
   resolved by OpenCode and an unknown id fails through its mechanism. */
export async function openEngineSession(host: EngineHost, request: EngineSessionRequest): Promise<string> {
    // eslint-disable-next-line anti-slop/no-known-value-widening -- explicit engine session model-ref contract
    const model: { providerID: string; id: string; variant?: string } = {
        providerID: request.model.providerID,
        id: request.model.modelID
    };

    if (request.model.variant !== undefined) {
        model.variant = request.model.variant;
    }

    const session = await host.client.sessions.create({
        location: { directory: host.directory },
        title: request.title,
        model
    });

    await host.client.sessions.instructions.entry.put({
        sessionID: session.id,
        key: ENGINE_SYSTEM_PROMPT_KEY,
        value: request.systemPrompt
    });

    return session.id;
}

/* Sessions are ephemeral: the caller removes one after its agent call so the
   run database never retains a reviewed diff or role prompt. Deleting the
   session alone leaves the instruction entry behind, so the entry goes first
   and session removal still runs if entry deletion fails. */
export async function removeEngineSession(host: EngineHost, sessionId: string): Promise<void> {
    await host.client.sessions.remove({ sessionID: sessionId });
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function readErrorInfo(value: unknown): EngineSessionErrorInfo | undefined {
    if (!isRecord(value) || typeof value.type !== 'string') {
        return undefined;
    }

    const info: EngineSessionErrorInfo = { type: value.type, message: '' };

    if (typeof value.message === 'string') {
        info.message = value.message;
    }

    if (typeof value.status === 'number') {
        info.status = value.status;
    }

    return info;
}

function readAssistantText(message: Record<string, unknown>): string | undefined {
    if (!Array.isArray(message.content)) {
        return undefined;
    }

    const texts = message.content
        .filter(isRecord)
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .filter((text): text is string => typeof text === 'string');

    return texts.at(-1);
}

function readIdleOutcome(message: Record<string, unknown>): string | undefined {
    if (message.type !== 'idle' || typeof message.outcome !== 'string') {
        return undefined;
    }

    return message.outcome;
}

/* Session messages are external data: every field is read through narrowing,
   unknown shapes are ignored instead of cast. */
export function readSessionMessages(messages: readonly unknown[]): EngineSessionMessages {
    const records = messages.filter((message) => isRecord(message));
    const assistant = records.filter((message) => message.type === 'assistant');

    return {
        error: readFirstError(assistant),
        outcome: readFirstOutcome(records),
        text: readLastText(assistant),
        providerDispatched: assistant.length > 0
    };
}

function readFirstError(assistant: readonly Record<string, unknown>[]): EngineSessionErrorInfo | undefined {
    for (const message of assistant) {
        const info = readErrorInfo(message.error);

        if (info !== undefined) {
            return info;
        }
    }

    return undefined;
}

function readFirstOutcome(records: readonly Record<string, unknown>[]): string | undefined {
    for (const message of records) {
        const outcome = readIdleOutcome(message);

        if (outcome !== undefined) {
            return outcome;
        }
    }

    return undefined;
}

function readLastText(assistant: readonly Record<string, unknown>[]): string {
    let text = '';

    for (const message of assistant) {
        const value = readAssistantText(message);

        if (value !== undefined) {
            text = value;
        }
    }

    return text;
}

function isUnknownArray(value: unknown): value is unknown[] {
    return Array.isArray(value);
}

function isFailureEventType(type: unknown): boolean {
    return type === 'session.execution.failed' || type === 'session.step.failed';
}

/* Engine events are external data: only the two failure types are accepted;
   missing session id or malformed error is ignored. */
export function readSessionFailureEvent(event: unknown): EngineSessionFailureEvent | undefined {
    if (!isRecord(event) || !isFailureEventType(event.type) || !isRecord(event.data)) {
        return undefined;
    }

    const { sessionID } = event.data;

    if (typeof sessionID !== 'string') {
        return undefined;
    }

    const error = readErrorInfo(event.data.error);

    if (error === undefined) {
        return undefined;
    }

    return { sessionID, error };
}

function readContentParts(message: Record<string, unknown>): unknown[] {
    if (!isUnknownArray(message.content)) {
        return [];
    }

    return message.content;
}

function readToolCall(part: Record<string, unknown>): EngineToolCallInfo | undefined {
    if (part.type !== 'tool' || typeof part.name !== 'string') {
        return undefined;
    }

    let state: Record<string, unknown> = {};
    const { state: rawState } = part;

    // eslint-disable-next-line anti-slop/no-known-value-widening -- external tool state narrowed via isRecord below
    if (isRecord(rawState)) {
        state = rawState;
    }

    const call: EngineToolCallInfo = { name: part.name, status: 'unknown', input: state.input };

    if (typeof state.status === 'string') {
        call.status = state.status;
    }

    return call;
}

export function readToolCalls(messages: readonly unknown[]): EngineToolCallInfo[] {
    return messages.flatMap((message): EngineToolCallInfo[] => {
        if (!isRecord(message) || message.type !== 'assistant') {
            return [];
        }

        return readContentParts(message).flatMap((part): EngineToolCallInfo[] => {
            if (!isRecord(part)) {
                return [];
            }

            const call = readToolCall(part);

            if (call === undefined) {
                return [];
            }

            return [call];
        });
    });
}
