/* Deterministic Anthropic-compatible SSE fixture for compiled-artifact tests. The coordinator session is detected from its
   system prompt so each role receives its own submit tool; a tool-result request is answered with text so the session idles. */
import { readUserText as readProviderUserText } from './provider-messages';

export interface ProviderRequest {
    tools: string[];
    system: string;
    /* Concatenated user-role text: review evidence and the final request
       travel on this surface after the 256 KiB instruction-entry split. */
    userText: string;
    /* Credential-carrying headers received by the provider, so a test can
       assert which key the engine used. */
    authHeaders: Record<string, string>;
}

export interface FakeArtifactProvider {
    baseURL: string;
    requests: ProviderRequest[];
    stop: () => Promise<void>;
}

export function startFakeProvider(): FakeArtifactProvider {
    const requests: ProviderRequest[] = [];

    const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        async fetch(request) {
            const raw = await request.text();
            // SAFETY: the fake server parses the SDK request body; the system/messages/tools fields are read below.
            const body = JSON.parse(raw) as { system?: unknown; messages?: unknown; tools?: { name?: string }[] };

            const tools = (body.tools ?? [])
                .map((tool) => tool.name)
                .filter((name): name is string => typeof name === 'string');

            const system = readSystem(body.system);
            requests.push({
                tools,
                system,
                userText: readUserText(body.messages),
                authHeaders: readAuthHeaders(request.headers)
            });

            if (tools.length === 0) {
                return textReply('Title');
            }

            if (raw.includes('tool_result')) {
                return textReply('DONE');
            }

            if (system.includes('You are the review coordinator')) {
                return toolReply(`toolu_${requests.length}`, 'submit_coordination', {
                    summary: 'No findings.',
                    findings: []
                });
            }

            return toolReply(`toolu_${requests.length}`, 'submit_findings', {
                summary: 'No findings.',
                findings: [],
                usedContext7: false,
                context7Topics: []
            });
        }
    });

    return {
        baseURL: `http://127.0.0.1:${server.port}/v1`,
        requests,
        stop: () => server.stop(true)
    };
}

function messageStart(): [string, unknown] {
    return [
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
    ];
}

function textReply(text: string): Response {
    return sse([
        messageStart(),
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
        messageStart(),
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

function sse(events: [string, unknown][]): Response {
    const content = events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');

    return new Response(content, { headers: { 'content-type': 'text/event-stream' } });
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

function readUserText(messages: unknown): string {
    return readProviderUserText(messages);
}

function readSystem(system: unknown): string {
    if (typeof system === 'string') {
        return system;
    }

    if (!Array.isArray(system)) {
        return '';
    }

    const parts: string[] = [];

    for (const part of system) {
        if (typeof part === 'object' && part !== null && 'text' in part) {
            // SAFETY: the null/object/text checks above establish a text block; only text is read.
            const { text } = part as { text?: unknown };

            if (typeof text === 'string') {
                parts.push(text);
            }
        }
    }

    return parts.join('\n');
}
