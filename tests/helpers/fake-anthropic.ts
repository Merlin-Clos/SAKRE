/* Deterministic Anthropic-compatible SSE provider for engine tests. Requests are recorded and answered from a scripted list;
   title requests (no tools) are answered automatically, so tests need no real network or provider SDK. */
import { readUserText as readProviderUserText } from './provider-messages';

export type FakeAnthropicReply =
    | { type: 'text'; text: string }
    | { type: 'tool'; name: string; input: unknown }
    | { type: 'error'; status: number; body: unknown }
    | { type: 'hang' };

export interface FakeAnthropicToolResult {
    text: string;
    isError: boolean;
}

export interface FakeAnthropicRequestRecord {
    model: string;
    tools: string[];
    system: string;
    /* Concatenated user-role text the provider received: review evidence and the
       final request travel on this surface after the 256 KiB instruction-entry
       split, so tests assert their full content here. */
    userText: string;
    /* Raw request-body size in bytes, so tests can prove a review larger than the
       instruction-entry cap still crosses the provider boundary. */
    bodyBytes: number;
    /* Every credential-carrying header the provider received, so tests can
       assert which key the engine used. */
    authHeaders: Record<string, string>;
    hasToolResult: boolean;
    /* Tool results returned to the model in this request, so tests can assert
       what the model was told about a rejected submission. */
    toolResults: FakeAnthropicToolResult[];
}

export interface FakeAnthropicProvider {
    baseURL: string;
    requests: FakeAnthropicRequestRecord[];
    waitForRequest: (count: number) => Promise<void>;
    stop: () => Promise<void>;
}

function sse(events: [string, unknown][]): Response {
    const body = events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');

    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

function textReply(text: string): Response {
    return sse([
        [
            'message_start',
            {
                type: 'message_start',
                message: {
                    id: 'msg_fake',
                    type: 'message',
                    role: 'assistant',
                    model: 'fake',
                    content: [],
                    stop_reason: null,
                    stop_sequence: null,
                    usage: { input_tokens: 1, output_tokens: 0 }
                }
            }
        ],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        [
            'message_delta',
            {
                type: 'message_delta',
                delta: { stop_reason: 'end_turn', stop_sequence: null },
                usage: { output_tokens: 1 }
            }
        ],
        ['message_stop', { type: 'message_stop' }]
    ]);
}

function toolReply(id: string, name: string, input: unknown): Response {
    return sse([
        [
            'message_start',
            {
                type: 'message_start',
                message: {
                    id: 'msg_fake',
                    type: 'message',
                    role: 'assistant',
                    model: 'fake',
                    content: [],
                    stop_reason: null,
                    stop_sequence: null,
                    usage: { input_tokens: 1, output_tokens: 0 }
                }
            }
        ],
        [
            'content_block_start',
            { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } }
        ],
        [
            'content_block_delta',
            {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) }
            }
        ],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        [
            'message_delta',
            {
                type: 'message_delta',
                delta: { stop_reason: 'tool_use', stop_sequence: null },
                usage: { output_tokens: 1 }
            }
        ],
        ['message_stop', { type: 'message_stop' }]
    ]);
}

function isUnknownArray(value: unknown): value is unknown[] {
    return Array.isArray(value);
}

function readSystemPart(part: unknown): string {
    if (part === null || typeof part !== 'object' || !('text' in part)) {
        return '';
    }

    const { text } = part;

    if (typeof text === 'string') {
        return text;
    }

    return '';
}

function readSystem(system: unknown): string {
    if (typeof system === 'string') {
        return system;
    }

    if (!isUnknownArray(system)) {
        return '';
    }

    const parts: string[] = [];

    for (const part of system) {
        parts.push(readSystemPart(part));
    }

    return parts.join('\n');
}

function readAuthHeaders(headers: Headers): Record<string, string> {
    const values: Record<string, string> = {};

    for (const name of ['authorization', 'x-api-key']) {
        const value = headers.get(name);

        if (value !== null && value !== '') {
            values[name] = value;
        }
    }

    // eslint-disable-next-line anti-slop/no-known-value-widening -- auth-header map extracted from the fake request; Record documents the header contract
    return values;
}

function readToolResultText(content: unknown): string {
    if (typeof content === 'string') {
        return content;
    }

    if (!isUnknownArray(content)) {
        return '';
    }

    const parts: string[] = [];

    for (const part of content) {
        if (part !== null && typeof part === 'object' && 'type' in part && part.type === 'text') {
            // SAFETY: the null/object/type checks above establish a text block; only text is read.
            const { text } = part as { text?: unknown };

            if (typeof text === 'string') {
                parts.push(text);
            }
        }
    }

    return parts.join('\n');
}

function readToolResults(parsed: unknown): FakeAnthropicToolResult[] {
    if (parsed === null || typeof parsed !== 'object' || !('messages' in parsed)) {
        return [];
    }

    // SAFETY: the object/messages checks above establish the envelope; isUnknownArray narrows messages below.
    const { messages } = parsed as { messages?: unknown };

    // eslint-disable-next-line anti-slop/no-known-value-widening -- messages stays unknown until the array guard narrows it
    if (!isUnknownArray(messages)) {
        return [];
    }

    const results: FakeAnthropicToolResult[] = [];

    for (const message of messages) {
        if (message !== null && typeof message === 'object' && 'content' in message) {
            // SAFETY: the null/object/content checks above establish the envelope; only content is read.
            const { content } = message as { content?: unknown };
            results.push(...readMessageToolResults(content));
        }
    }

    return results;
}

function isToolResultBlock(value: unknown): value is { content?: unknown; is_error?: unknown } {
    return value !== null && typeof value === 'object' && 'type' in value && value.type === 'tool_result';
}

function readMessageToolResults(content: unknown): FakeAnthropicToolResult[] {
    if (!isUnknownArray(content)) {
        return [];
    }

    const results: FakeAnthropicToolResult[] = [];

    for (const block of content) {
        if (isToolResultBlock(block)) {
            results.push({ text: readToolResultText(block.content), isError: block.is_error === true });
        }
    }

    return results;
}

export function startFakeAnthropic(script: FakeAnthropicReply[]): FakeAnthropicProvider {
    const requests: FakeAnthropicRequestRecord[] = [];
    const pending = [...script];
    const waiters: { count: number; resolve: () => void }[] = [];
    const hanging: (() => void)[] = [];
    let toolCallCount = 0;

    function notify(): void {
        const resolved = waiters.filter((waiter) => requests.length >= waiter.count);

        for (const waiter of resolved) {
            waiters.splice(waiters.indexOf(waiter), 1);
            waiter.resolve();
        }
    }

    const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        async fetch(request) {
            const raw = await request.text();

            // SAFETY: the fake server parses the SDK request body; the Anthropic message-envelope fields are read below.
            const parsed = JSON.parse(raw) as {
                model?: string;
                system?: unknown;
                messages?: unknown;
                tools?: { name?: string }[];
            };

            const tools = (parsed.tools ?? [])
                .map((tool) => tool.name)
                .filter((name): name is string => typeof name === 'string');

            requests.push({
                model: parsed.model ?? '',
                tools,
                system: readSystem(parsed.system),
                userText: readProviderUserText(parsed.messages),
                bodyBytes: Buffer.byteLength(raw, 'utf8'),
                authHeaders: readAuthHeaders(request.headers),
                hasToolResult: raw.includes('tool_result'),
                toolResults: readToolResults(parsed)
            });
            notify();

            if (tools.length === 0) {
                return textReply('Title');
            }

            const reply = pending.shift() ?? { type: 'text', text: 'DONE' };

            if (reply.type === 'text') {
                return textReply(reply.text);
            }

            if (reply.type === 'tool') {
                toolCallCount += 1;

                return toolReply(`toolu_${reply.name}_${toolCallCount}`, reply.name, reply.input);
            }

            if (reply.type === 'error') {
                return Response.json(reply.body, { status: reply.status });
            }

            return new Promise<Response>((resolve) => {
                hanging.push(() => {
                    resolve(textReply('late'));
                });
            });
        }
    });

    return {
        baseURL: `http://127.0.0.1:${server.port}/v1`,
        requests,
        waitForRequest: async (count: number): Promise<void> => {
            if (requests.length >= count) {
                return;
            }

            await new Promise<void>((resolve) => {
                waiters.push({ count, resolve });
            });
        },
        stop: async (): Promise<void> => {
            for (const resolve of hanging.splice(0)) {
                resolve();
            }

            await server.stop(true);
        }
    };
}
