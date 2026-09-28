/* Deterministic OpenAI Responses-compatible SSE provider for native-provider tests: the engine resolves a routed model
   through its bundled catalogue, so the entry selects the package and endpoint. Proves routing with no external call;
   claims nothing about a real provider. */
import { readResponsesUserText as readProviderUserText } from './provider-messages';

export type FakeResponsesReply =
    | { type: 'text'; text: string }
    | { type: 'tool'; name: string; input: unknown }
    | { type: 'error'; status: number; body: unknown };

export interface FakeResponsesRequest {
    path: string;
    model: string;
    /* Concatenated user-role text, so a test can assert the prompt reached the
       provider through the production message surface. */
    userText: string;
    /* Every credential-carrying header the provider received, so a test can
       assert which key the engine used. */
    authHeaders: Record<string, string>;
    bodyBytes: number;
}

export interface FakeResponsesProvider {
    baseURL: string;
    requests: FakeResponsesRequest[];
    waitForRequest: (count: number) => Promise<void>;
    stop: () => Promise<void>;
}

function sse(events: [string, unknown][]): Response {
    const body = events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');

    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

function responseCreated(): [string, unknown] {
    return [
        'response.created',
        {
            type: 'response.created',
            sequence_number: 0,
            response: {
                id: 'resp_fake',
                object: 'response',
                created_at: 0,
                status: 'in_progress',
                model: 'fake',
                output: []
            }
        }
    ];
}

function completed(output: unknown[]): [string, unknown] {
    return [
        'response.completed',
        {
            type: 'response.completed',
            sequence_number: 9,
            response: {
                id: 'resp_fake',
                object: 'response',
                status: 'completed',
                output,
                usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
            }
        }
    ];
}

function textReply(text: string): Response {
    const item = {
        id: 'msg_fake',
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [] }]
    };

    return sse([
        responseCreated(),
        [
            'response.output_item.added',
            {
                type: 'response.output_item.added',
                sequence_number: 1,
                output_index: 0,
                item: { id: 'msg_fake', type: 'message', status: 'in_progress', role: 'assistant', content: [] }
            }
        ],
        [
            'response.content_part.added',
            {
                type: 'response.content_part.added',
                sequence_number: 2,
                item_id: 'msg_fake',
                output_index: 0,
                content_index: 0,
                part: { type: 'output_text', text: '', annotations: [] }
            }
        ],
        [
            'response.output_text.delta',
            {
                type: 'response.output_text.delta',
                sequence_number: 3,
                item_id: 'msg_fake',
                output_index: 0,
                content_index: 0,
                delta: text
            }
        ],
        [
            'response.output_text.done',
            {
                type: 'response.output_text.done',
                sequence_number: 4,
                item_id: 'msg_fake',
                output_index: 0,
                content_index: 0,
                text
            }
        ],
        ['response.output_item.done', { type: 'response.output_item.done', sequence_number: 5, output_index: 0, item }],
        completed([item])
    ]);
}

// eslint-disable-next-line anti-slop/no-unknown-parameters -- scripted tool input serialized into the SSE fixture with JSON.stringify
function toolReply(id: string, callID: string, name: string, input: unknown): Response {
    const item = {
        id,
        type: 'function_call',
        status: 'completed',
        call_id: callID,
        name,
        arguments: JSON.stringify(input)
    };

    return sse([
        responseCreated(),
        [
            'response.output_item.added',
            {
                type: 'response.output_item.added',
                sequence_number: 1,
                output_index: 0,
                item: { id, type: 'function_call', status: 'in_progress', call_id: callID, name, arguments: '' }
            }
        ],
        [
            'response.function_call_arguments.delta',
            {
                type: 'response.function_call_arguments.delta',
                sequence_number: 2,
                item_id: id,
                output_index: 0,
                delta: JSON.stringify(input)
            }
        ],
        [
            'response.function_call_arguments.done',
            {
                type: 'response.function_call_arguments.done',
                sequence_number: 3,
                item_id: id,
                output_index: 0,
                arguments: JSON.stringify(input)
            }
        ],
        ['response.output_item.done', { type: 'response.output_item.done', sequence_number: 4, output_index: 0, item }],
        completed([item])
    ]);
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

export function startFakeResponses(script: FakeResponsesReply[]): FakeResponsesProvider {
    const requests: FakeResponsesRequest[] = [];
    const pending = [...script];
    const waiters: { count: number; resolve: () => void }[] = [];
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
            // SAFETY: the fake server parses the Responses request body; the model/input fields are read below.
            const parsed = JSON.parse(raw) as { model?: string; input?: unknown };
            requests.push({
                path: new URL(request.url).pathname,
                model: parsed.model ?? '',
                userText: readProviderUserText(parsed.input),
                authHeaders: readAuthHeaders(request.headers),
                bodyBytes: Buffer.byteLength(raw, 'utf8')
            });
            notify();
            const reply = pending.shift() ?? { type: 'text', text: 'DONE' };

            if (reply.type === 'text') {
                return textReply(reply.text);
            }

            if (reply.type === 'tool') {
                toolCallCount += 1;

                return toolReply(`fc_${toolCallCount}`, `call_${toolCallCount}`, reply.name, reply.input);
            }

            return Response.json(reply.body, { status: reply.status });
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
        stop: () => server.stop(true)
    };
}
