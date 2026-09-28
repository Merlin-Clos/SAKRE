import { expect, test } from 'bun:test';
import { Writable } from 'node:stream';
import { collectFormAnswer } from '../../src/cli/oauth-form';
import type { EngineFormField } from '../../src/engine/effect-client';
import { rejectionOf } from '../helpers/rejection';

test('an OpenCode OAuth option default is used when the operator presses Enter', async () => {
    const answer = await collectFormAnswer(
        [
            {
                type: 'string',
                key: 'region',
                default: 'public',
                options: [
                    { value: 'public', label: 'Public' },
                    { value: 'private', label: 'Private' }
                ]
            }
        ],
        {
            interactive: true,
            prompt: () => Promise.resolve(''),
            stdout: new Writable({
                write(_chunk, _encoding, callback): void {
                    callback();
                }
            })
        }
    );

    expect(answer).toEqual({ region: 'public' });
});

function form(
    fields: EngineFormField[],
    replies: string[],
    openUrl?: (url: string) => Promise<boolean>
): {
    prompts: string[];
    printed: string[];
    result: ReturnType<typeof collectFormAnswer>;
} {
    const prompts: string[] = [];
    const printed: string[] = [];

    // eslint-disable-next-line anti-slop/no-known-value-widening -- fixture contract annotation; documents the helper result shape
    return {
        prompts,
        printed,
        result: collectFormAnswer(fields, {
            interactive: true,
            prompt: (message) => {
                prompts.push(message);

                return Promise.resolve(replies.shift() ?? '');
            },
            stdout: new Writable({
                write(chunk, _encoding, callback): void {
                    printed.push(String(chunk));
                    callback();
                }
            }),
            openUrl
        })
    };
}

test('skips hidden fields and respects both eq and ne conditions', async () => {
    const input = form(
        [
            { key: 'choice', type: 'string' },
            { key: 'hidden', type: 'string', hidden: true },
            { key: 'equal', type: 'string', when: [{ key: 'choice', op: 'eq', value: 'yes' }] },
            { key: 'notEqual', type: 'string', when: [{ key: 'choice', op: 'neq', value: 'yes' }] },
            { key: 'notEqualSkipped', type: 'string', when: [{ key: 'choice', op: 'neq', value: 'no' }] }
        ],
        ['no', 'included']
    );

    expect(await input.result).toEqual({ choice: 'no', notEqual: 'included' });
    expect(input.prompts).toHaveLength(2);

    const eq = form(
        [
            { key: 'choice', type: 'string' },
            { key: 'equal', type: 'string', when: [{ key: 'choice', op: 'eq', value: 'yes' }] }
        ],
        ['yes', 'included']
    );

    expect(await eq.result).toEqual({ choice: 'yes', equal: 'included' });
});

test('external field prints URL without prompting and rejects unsafe URL dispatch', async () => {
    const opened: string[] = [];

    const input = form(
        [
            { key: 'link', type: 'external', url: 'https://example.test/authorize' },
            { key: 'unsafe', type: 'external', url: 'file:///etc/passwd' }
        ],
        [],
        (url) => {
            opened.push(url);

            return Promise.resolve(true);
        }
    );

    expect(await input.result).toEqual({});
    expect(input.prompts).toHaveLength(0);
    expect(input.printed.join('')).toContain('file:///etc/passwd');
    expect(opened).toEqual(['https://example.test/authorize']);
});

test('parses booleans, numbers, integer and multiselect answers without synthesizing empty numbers', async () => {
    const input = form(
        [
            { key: 'yes', type: 'boolean' },
            { key: 'no', type: 'boolean', default: true },
            { key: 'default', type: 'boolean', default: true },
            { key: 'count', type: 'integer' },
            { key: 'emptyNumber', type: 'number' },
            { key: 'ratio', type: 'number' },
            { key: 'tags', type: 'multiselect' }
        ],
        ['yes', 'n', '', '3', '', '1.5', 'alpha, beta']
    );

    expect(await input.result).toEqual({
        yes: true,
        no: false,
        default: true,
        count: 3,
        ratio: 1.5,
        tags: ['alpha', 'beta']
    });
});

test('whitespace-only numeric answers are omitted or rejected when required', async () => {
    expect(await form([{ key: 'optional', type: 'integer' }], ['   ']).result).toEqual({});
    expect(await form([{ key: 'defaulted', type: 'number', default: 2 }], ['   ']).result).toEqual({ defaulted: 2 });
    const failure = await rejectionOf(form([{ key: 'required', type: 'number', required: true }], ['   ']).result);
    expect(failure.message).toContain('required');
});

test('non-interactive form fields fail before prompting', async () => {
    const failure = await rejectionOf(
        collectFormAnswer([{ key: 'account', type: 'string', required: true }], {
            interactive: false,
            prompt: () => {
                throw new Error('Must not prompt.');
            },
            stdout: new Writable({
                write(_chunk, _encoding, callback): void {
                    callback();
                }
            })
        })
    );

    expect(failure.message).toContain('interactive terminal');
});

test('invalid field answers fail without sending malformed form values', async () => {
    for (const [field, answer] of [
        [{ key: 'required', type: 'string', required: true }, ''],
        [{ key: 'integer', type: 'integer' }, '1.5'],
        [{ key: 'number', type: 'number' }, 'oops'],
        [{ key: 'boolean', type: 'boolean' }, 'maybe'],
        [{ key: 'option', type: 'string', options: [{ value: 'a', label: 'A' }] }, '2'],
        [{ key: 'multi', type: 'multiselect', options: [{ value: 'a', label: 'A' }] }, '1,2']
    ] as const) {
        const input = form([field], [answer]);
        const failure = await rejectionOf(input.result);
        expect(failure.message).toMatch(/required|requires|invalid/u);
    }
});
