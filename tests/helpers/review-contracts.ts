export interface JsonSchemaObject {
    type: unknown;
    additionalProperties: unknown;
    properties: Record<string, unknown>;
    required: string[];
}

export function jsonSchemaObjectAtPath(schema: unknown, path: readonly string[]): JsonSchemaObject {
    let current = asRecord(schema);

    for (const segment of path) {
        if (segment === 'items') {
            current = asRecord(current.items);
        } else {
            current = asRecord(asRecord(current.properties)[segment]);
        }
    }

    const { required } = current;

    if (!Array.isArray(required) || !required.every((field): field is string => typeof field === 'string')) {
        throw new TypeError('Expected a JSON Schema required string array.');
    }

    return {
        type: current.type,
        additionalProperties: current.additionalProperties,
        properties: asRecord(current.properties),
        required: required.toSorted()
    };
}

export function omitPropertyAtPath(
    input: Record<string, unknown>,
    path: readonly (string | number)[]
): Record<string, unknown> {
    return asRecord(omitPath(input, path));
}

function omitPath(value: unknown, path: readonly (string | number)[]): unknown {
    const [segment, ...remaining] = path;

    if (segment === undefined) {
        throw new TypeError('Cannot omit an empty property path.');
    }

    if (typeof segment === 'number') {
        if (!Array.isArray(value)) {
            throw new TypeError('Expected an array while resolving the property path.');
        }

        return value.map((entry: unknown, index: number): unknown => {
            if (index !== segment) {
                return entry;
            }

            return omitPath(entry, remaining);
        });
    }

    const object = asRecord(value);
    const entries = Object.entries(object);

    if (remaining.length === 0) {
        return Object.fromEntries(entries.filter(([key]) => key !== segment));
    }

    return Object.fromEntries(
        entries.map(([key, entry]) => {
            if (key !== segment) {
                return [key, entry];
            }

            return [key, omitPath(entry, remaining)];
        })
    );
}

function asRecord(value: unknown): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new TypeError('Expected a JSON object.');
    }

    // SAFETY: the guard above throws for non-objects; only plain JSON objects reach this return.
    return value as Record<string, unknown>;
}
