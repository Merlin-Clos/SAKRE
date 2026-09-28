export type EngineFormValue = string | number | boolean | readonly string[];

export type EngineFormAnswer = Readonly<Record<string, EngineFormValue>>;

export interface EngineFormCondition {
    readonly key: string;
    readonly op: 'eq' | 'neq';
    readonly value: string | number | boolean;
}

export interface EngineFormOption {
    readonly value: string;
    readonly label: string;
    readonly description?: string;
}

export interface EngineFormField {
    readonly key: string;
    readonly type: 'string' | 'number' | 'integer' | 'boolean' | 'multiselect' | 'external';
    readonly title?: string;
    readonly description?: string;
    readonly required?: boolean;
    readonly hidden?: boolean;
    readonly default?: EngineFormValue;
    readonly options?: readonly EngineFormOption[];
    readonly url?: string;
    readonly when?: readonly EngineFormCondition[];
}

export interface EngineIntegrationMethod {
    readonly id?: string;
    readonly type: 'oauth' | 'key' | 'env' | 'command';
    readonly label?: string;
    readonly form?: readonly EngineFormField[];
}

export type EngineIntegrationConnection =
    | { readonly type: 'credential'; readonly id: string; readonly label: string; readonly method: 'key' | 'oauth' }
    | { readonly type: 'env'; readonly name: string };

export interface EngineIntegrationInfo {
    readonly id: string;
    readonly name: string;
    readonly methods: readonly EngineIntegrationMethod[];
    readonly connections: readonly EngineIntegrationConnection[];
}

export interface EngineOAuthAttempt {
    readonly attemptID: string;
    readonly url: string;
    readonly instructions: string;
    readonly mode: 'auto' | 'code';
    readonly time: { readonly created: number; readonly expires: number };
}

export type EngineOAuthAttemptStatus =
    | { readonly status: 'pending'; readonly time: EngineOAuthAttempt['time'] }
    | { readonly status: 'complete'; readonly time: EngineOAuthAttempt['time'] }
    | { readonly status: 'expired'; readonly time: EngineOAuthAttempt['time'] }
    | { readonly status: 'failed'; readonly message: string; readonly time: EngineOAuthAttempt['time'] };

export interface EngineHostClient {
    readonly integration: {
        readonly list: (input: {
            location: { directory: string };
        }) => Promise<{ data: readonly EngineIntegrationInfo[] }>;
        readonly get: (input: {
            integrationID: string;
            location: { directory: string };
        }) => Promise<{ data: EngineIntegrationInfo }>;
        readonly connect: {
            readonly key: (input: {
                integrationID: string;
                key: string;
                location: { directory: string };
            }) => Promise<void>;
        };
        readonly oauth: {
            readonly connect: (input: {
                integrationID: string;
                methodID: string;
                answer?: EngineFormAnswer;
                location: { directory: string };
            }) => Promise<{ data: EngineOAuthAttempt }>;
            readonly status: (input: {
                integrationID: string;
                attemptID: string;
                location: { directory: string };
            }) => Promise<{ data: EngineOAuthAttemptStatus }>;
            readonly complete: (input: {
                integrationID: string;
                attemptID: string;
                code?: string;
                location: { directory: string };
            }) => Promise<void>;
            readonly cancel: (input: {
                integrationID: string;
                attemptID: string;
                location: { directory: string };
            }) => Promise<void>;
        };
    };
    readonly credential: {
        readonly activate: (input: { credentialID: string }) => Promise<void>;
    };
    readonly provider: {
        readonly list: (input: { location: { directory: string } }) => Promise<{
            data: readonly {
                readonly id: string;
                readonly activation: string;
                readonly settings?: { readonly apiKey?: string };
            }[];
        }>;
    };
    readonly model: {
        readonly list: (input: { location: { directory: string } }) => Promise<{
            data: readonly {
                readonly id: string;
                readonly providerID: string;
                readonly modelID: string;
                readonly package?: string;
                readonly enabled: boolean;
                readonly cost: readonly { readonly input: number; readonly output: number }[];
                readonly variants: readonly { readonly id: string }[];
            }[];
        }>;
    };
    readonly sessions: {
        readonly create: (input: {
            location: { directory: string };
            title: string;
            model: { providerID: string; id: string; variant?: string };
        }) => Promise<{ id: string }>;
        // eslint-disable-next-line anti-slop/no-unknown-returns -- opaque engine prompt result awaited without inspection
        readonly prompt: (input: { sessionID: string; text: string }) => Promise<unknown>;
        readonly context: (input: { sessionID: string }) => Promise<readonly unknown[]>;
        readonly wait: (input: { sessionID: string }) => Promise<void>;
        // eslint-disable-next-line anti-slop/no-unknown-returns -- opaque engine interrupt result awaited without inspection
        readonly interrupt: (input: { sessionID: string }) => Promise<unknown>;
        readonly remove: (input: { sessionID: string }) => Promise<void>;
        readonly instructions: {
            readonly entry: {
                readonly put: (input: { sessionID: string; key: string; value: string }) => Promise<void>;
            };
        };
    };
    readonly events: {
        readonly subscribe: (options: { signal?: AbortSignal }) => AsyncIterable<unknown>;
    };
    readonly close: () => Promise<void>;
}
