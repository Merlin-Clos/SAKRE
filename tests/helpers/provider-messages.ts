/* Shared narrowing for the fake providers: a provider request body is external
   data, so every field is read through type guards instead of assertions. */
// eslint-disable-next-line anti-slop/no-unsafe-dictionary-type -- shared guard over schemaless provider payloads; callers narrow through it
export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textBlocks(content: unknown): string[] {
    if (typeof content === 'string') {
        return [content];
    }

    if (!Array.isArray(content)) {
        return [];
    }

    return content
        .filter((block) => isRecord(block))
        .filter((block) => block.type === 'text')
        .map((block) => {
            const { text } = block;

            if (typeof text === 'string') {
                return text;
            }

            return '';
        });
}

/* Concatenated user-role text from an Anthropic-compatible messages array. */
export function readUserText(messages: unknown): string {
    if (!Array.isArray(messages)) {
        return '';
    }

    return messages
        .filter((message) => isRecord(message))
        .filter((message) => message.role === 'user')
        .flatMap((message) => textBlocks(message.content))
        .join('\n');
}

/* Concatenated user-role text from an OpenAI Responses `input` array, where a
   text block is typed `input_text` instead of `text`. */
export function readResponsesUserText(input: unknown): string {
    if (!Array.isArray(input)) {
        return '';
    }

    return input
        .filter((item) => isRecord(item))
        .filter((item) => item.role === 'user')
        .flatMap((item) => responsesTextBlocks(item.content))
        .join('\n');
}

function responsesTextBlocks(content: unknown): string[] {
    if (typeof content === 'string') {
        return [content];
    }

    if (!Array.isArray(content)) {
        return [];
    }

    return content
        .filter((block) => isRecord(block))
        .filter((block) => block.type === 'input_text' || block.type === 'text' || block.type === 'output_text')
        .map((block) => {
            const { text } = block;

            if (typeof text === 'string') {
                return text;
            }

            return '';
        });
}
