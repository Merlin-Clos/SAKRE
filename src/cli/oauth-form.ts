import type { EngineFormAnswer, EngineFormField, EngineFormOption, EngineFormValue } from '../engine/effect-client';
import type { OAuthLoginInput } from './oauth';
import { OAuthLoginError, requireInteractive } from './oauth-input';
import { isSafeAuthorizationUrl, openAuthorizationUrl } from './oauth-url';

type OAuthFormInput = Pick<OAuthLoginInput, 'interactive' | 'prompt' | 'stdout' | 'openUrl'>;

export async function collectFormAnswer(
    fields: readonly EngineFormField[],
    input: OAuthFormInput
): Promise<EngineFormAnswer> {
    const answer: Record<string, EngineFormValue> = {};

    for (const field of fields) {
        // eslint-disable-next-line no-await-in-loop -- dependent fields are prompted in declaration order.
        await collectField(field, input, answer);
    }

    return answer;
}

async function collectField(
    field: EngineFormField,
    input: OAuthFormInput,
    answer: Record<string, EngineFormValue>
): Promise<void> {
    if (field.hidden === true || !conditionsMatch(field, answer)) {
        return;
    }

    if (field.type === 'external') {
        await presentExternalField(field, input);

        return;
    }

    requireInteractive(input, `OAuth method requires the "${field.title ?? field.key}" form field`);
    const value = await promptField(field, input);

    if (value !== undefined) {
        answer[field.key] = value;
    }
}

function conditionsMatch(field: EngineFormField, answer: Readonly<Record<string, EngineFormValue>>): boolean {
    return (field.when ?? []).every((condition) => {
        const matches = answer[condition.key] === condition.value;

        if (condition.op === 'eq') {
            return matches;
        }

        return !matches;
    });
}

async function presentExternalField(field: EngineFormField, input: OAuthFormInput): Promise<void> {
    if (field.url === undefined) {
        return;
    }

    input.stdout.write(`${field.title ?? field.key}: ${field.url}\n`);

    if (isSafeAuthorizationUrl(field.url)) {
        await (input.openUrl ?? openAuthorizationUrl)(field.url);
    }
}

async function promptField(field: EngineFormField, input: OAuthFormInput): Promise<EngineFormValue | undefined> {
    if (field.options !== undefined && field.options.length > 0) {
        return promptOptions(field, input);
    }

    if (field.type === 'boolean') {
        return promptBoolean(field, input);
    }

    const value = await input.prompt(`${field.title ?? field.key}: `);

    return parseFieldValue(field, value);
}

function parseFieldValue(field: EngineFormField, value: string): EngineFormValue | undefined {
    if (field.type === 'number' || field.type === 'integer') {
        return parseNumericField(field, value.trim());
    }

    if (value === '' && field.default !== undefined) {
        return field.default;
    }

    if (value === '' && field.required === true) {
        throw new OAuthLoginError(`The OAuth field "${field.title ?? field.key}" is required.`);
    }

    if (field.type === 'multiselect') {
        return parseMultiValue(value);
    }

    return value;
}

function parseMultiValue(value: string): string[] {
    if (value === '') {
        return [];
    }

    return value.split(',').map((item) => item.trim());
}

function parseNumericField(field: EngineFormField, value: string): EngineFormValue | undefined {
    if (value === '') {
        if (field.default !== undefined) {
            return field.default;
        }

        if (field.required === true) {
            throw new OAuthLoginError(`The OAuth field "${field.title ?? field.key}" is required.`);
        }

        return undefined;
    }

    const number = Number(value);

    if (!Number.isFinite(number) || (field.type === 'integer' && !Number.isInteger(number))) {
        throw new OAuthLoginError(`The OAuth field "${field.title ?? field.key}" requires a number.`);
    }

    return number;
}

async function promptOptions(field: EngineFormField, input: OAuthFormInput): Promise<EngineFormValue> {
    const options = field.options ?? [];
    displayOptions(field, input, options);
    let question = 'Choose a number: ';

    if (field.type === 'multiselect') {
        question = 'Choose one or more numbers: ';
    }

    const value = await input.prompt(question);

    return parseOptionSelection(field, options, value);
}

function displayOptions(field: EngineFormField, input: OAuthFormInput, options: readonly EngineFormOption[]): void {
    input.stdout.write(`${field.title ?? field.key}:\n`);

    for (const [index, option] of options.entries()) {
        writeOption(input.stdout, option, index);
    }
}

function parseOptionSelection(
    field: EngineFormField,
    options: readonly EngineFormOption[],
    value: string
): EngineFormValue {
    if (field.type === 'multiselect') {
        return parseMultipleOptions(field, options, value);
    }

    if (value.trim() === '' && field.default !== undefined) {
        return field.default;
    }

    const selected = optionAt(options, value);

    if (selected === undefined) {
        throw new OAuthLoginError(`The OAuth field "${field.title ?? field.key}" has an invalid selection.`);
    }

    return selected;
}

function parseMultipleOptions(
    field: EngineFormField,
    options: readonly EngineFormOption[],
    value: string
): EngineFormValue {
    if (value.trim() === '' && field.default !== undefined) {
        return field.default;
    }

    if (value.trim() === '') {
        return [];
    }

    return value.split(',').map((item) => requiredOption(options, item, field));
}

function requiredOption(options: readonly EngineFormOption[], value: string, field: EngineFormField): string {
    const selected = optionAt(options, value);

    if (selected === undefined) {
        throw new OAuthLoginError(`The OAuth field "${field.title ?? field.key}" has an invalid selection.`);
    }

    return selected;
}

function writeOption(stream: NodeJS.WritableStream, option: EngineFormOption, index: number): void {
    let description = '';

    if (option.description !== undefined) {
        description = `: ${option.description}`;
    }

    stream.write(`  ${index + 1}. ${option.label}${description}\n`);
}

function optionAt(options: readonly EngineFormOption[], value: string): string | undefined {
    const index = Number(value.trim()) - 1;

    if (!Number.isInteger(index)) {
        return undefined;
    }

    return options[index]?.value;
}

async function promptBoolean(field: EngineFormField, input: OAuthFormInput): Promise<boolean> {
    const defaultValue = field.default === true;
    let suffix = '[y/N]';

    if (defaultValue) {
        suffix = '[Y/n]';
    }

    const answer = await input.prompt(`${field.title ?? field.key} ${suffix}: `);

    return parseBoolean(field, answer, defaultValue);
}

function parseBoolean(field: EngineFormField, answer: string, defaultValue: boolean): boolean {
    const value = answer.trim();

    if (value === '') {
        return defaultValue;
    }

    if (/^y(?:es)?$/iu.test(value)) {
        return true;
    }

    if (/^n(?:o)?$/iu.test(value)) {
        return false;
    }

    throw new OAuthLoginError(`The OAuth field "${field.title ?? field.key}" requires yes or no.`);
}
