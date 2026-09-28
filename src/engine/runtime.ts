import { rm } from 'node:fs/promises';
import { AiError, type AiRuntime, type AiStructuredCall, type AiStructuredResult } from '../ai/runtime';
import { asError, describeError } from '../errors';
import { PRODUCT_NAME } from '../identity';
import { createLogger } from '../logger';
import { resolveSafeCheckoutDirectory } from './checkout';
import { classifyEngineError, engineErrorDetail } from './failure';
import { EngineFailureEvents } from './failure-events';
import { createEngineHost, type EngineHost, type EngineHostOptions } from './host';
import {
    type EngineSessionErrorInfo,
    type EngineSessionMessages,
    openEngineSession,
    readSessionMessages,
    removeEngineSession
} from './session';
import { type EngineSubmitToolName, readSubmission, submitToolForAgent } from './submit';

/* Completed turn without a submit_* call gets exactly one bounded retry;
   after that the step is an invalid-output failure, which the review domain
   never retries. */
export const SUBMISSION_ATTEMPT_COUNT = 2;

/* Engine publishes a session failure before the session settles, so this
   wait only covers event-stream delivery; the timeout is the safety net for a
   stream that dropped the frame. */
const FAILURE_EVENT_GRACE_MS = 1000;

const log = createLogger('engine');

/* Per-run engine database directory; removed on close. Absent when the caller
   owns a durable database path. */
export type EngineRuntimeOptions = EngineHostOptions & { databaseDirectory?: string };

export interface EmbeddedEngineRuntimeOptions {
    host: EngineHost;
    databaseDirectory?: string;
}

interface SubmissionAttempt {
    sessionId: string;
    input: AiStructuredCall;
    tool: EngineSubmitToolName;
    remaining: number;
}

/* AiRuntime adapter over the in-process engine. Host owns the provider
   catalogue, credentials, plugins and the authorized directory; this class owns
   session routing, submission extraction and the AiFailureKind taxonomy. */
export class EmbeddedEngineRuntime implements AiRuntime {
    private readonly host: EngineHost;
    private readonly databaseDirectory: string | undefined;
    private readonly failureEvents: EngineFailureEvents;

    public constructor(options: EmbeddedEngineRuntimeOptions) {
        this.host = options.host;
        this.databaseDirectory = options.databaseDirectory;
        this.failureEvents = new EngineFailureEvents(options.host.client.events);
    }

    public async runStructured(input: AiStructuredCall): Promise<AiStructuredResult> {
        try {
            return await this.produceStructured(input);
        } catch (error) {
            throw normalizeFailure(input, error);
        }
    }

    public async close(): Promise<void> {
        this.failureEvents.stop();

        try {
            await this.host.client.close();
        } finally {
            await this.removeDatabaseDirectory();
        }
    }

    private async removeDatabaseDirectory(): Promise<void> {
        if (this.databaseDirectory === undefined) {
            return;
        }

        try {
            await rm(this.databaseDirectory, { recursive: true, force: true });
        } catch (error) {
            log.warn('Failed to remove the per-run engine database', {
                directory: this.databaseDirectory,
                error: describeError(error)
            });
        }
    }

    private async produceStructured(input: AiStructuredCall): Promise<AiStructuredResult> {
        const tool = submitToolForAgent(input.agentId);

        const sessionId = await openEngineSession(this.host, {
            title: `${PRODUCT_NAME} ${input.agentId}`,
            model: input.model,
            systemPrompt: input.systemPrompt
        });

        try {
            const result = await this.attemptTurns({ sessionId, input, tool, remaining: SUBMISSION_ATTEMPT_COUNT });

            if (result !== undefined) {
                return result;
            }

            throw new AiError(
                'invalid-output',
                `Agent "${input.agentId}" completed without a valid ${tool} submission.`
            );
        } finally {
            /* Ephemeral by contract: the session (and with it the role prompt
               and the delimited diff) must not survive the agent call. */
            await this.removeSession(sessionId);
        }
    }

    private async removeSession(sessionId: string): Promise<void> {
        this.failureEvents.release(sessionId);

        try {
            await removeEngineSession(this.host, sessionId);
        } catch (error) {
            log.warn('Failed to prune the engine session after the agent call', {
                sessionId,
                error: describeError(error)
            });
        }
    }

    /* Sequential by contract: the retry runs because the previous turn
       completed without a submission. Retry sends only the short
       continuation; review evidence is already in session history, so it is
       never duplicated. */
    private async attemptTurns(attempt: SubmissionAttempt): Promise<AiStructuredResult | undefined> {
        const firstTurn = attempt.remaining === SUBMISSION_ATTEMPT_COUNT;
        let text = attempt.input.userPrompt;

        if (!firstTurn) {
            text = attempt.input.retryPrompt;
        }

        const result = await this.runTurn(attempt, text);

        if (result !== undefined || attempt.remaining <= 1) {
            return result;
        }

        return this.attemptTurns({ ...attempt, remaining: attempt.remaining - 1 });
    }

    private async runTurn(attempt: SubmissionAttempt, text: string): Promise<AiStructuredResult | undefined> {
        await this.startTurn(attempt.sessionId, attempt.input, text);
        await this.waitForIdle(attempt.sessionId, attempt.input.signal);

        return this.readTurnResult(attempt.sessionId, attempt.input, attempt.tool);
    }

    private async startTurn(sessionId: string, input: AiStructuredCall, text: string): Promise<void> {
        if (input.signal?.aborted === true) {
            this.interruptWithoutWaiting(sessionId);
            throw new AiError('cancelled', `Agent session ${sessionId} was cancelled before it started.`);
        }

        await this.host.client.sessions.prompt({ sessionID: sessionId, text });
    }

    private async readTurnResult(
        sessionId: string,
        input: AiStructuredCall,
        tool: EngineSubmitToolName
    ): Promise<AiStructuredResult | undefined> {
        const messages = await this.host.client.sessions.context({ sessionID: sessionId });
        const session = readSessionMessages(messages);

        /* Provider boundary is crossed once the engine commits an assistant
           message for this session; a failure raised while the request is still
           being constructed leaves none. Provenance is recorded only here. */
        if (session.providerDispatched) {
            input.onProviderDispatch?.();
        }

        await this.throwSessionFailure(session, sessionId);
        const structured = readSubmission(messages, tool);

        if (structured === undefined) {
            return undefined;
        }

        return { structured, text: session.text };
    }

    /* Failed session never yields a result: the provider error is the
       actionable failure. When the message surface carries none, the durable
       execution/step failure event recorded for the session supplies the cause;
       without one the failure stays a runtime failure. */
    private async throwSessionFailure(session: EngineSessionMessages, sessionId: string): Promise<void> {
        if (session.error !== undefined) {
            throw providerError(session.error);
        }

        if (session.outcome !== 'failed') {
            return;
        }

        const eventError = await this.failureEvents.waitFor(sessionId, FAILURE_EVENT_GRACE_MS);

        if (eventError !== undefined) {
            throw providerError(eventError);
        }

        throw new AiError('runtime-failure', `Agent session ${sessionId} failed without error detail.`);
    }

    /* Cancellation must stop the engine turn, not just the await: the session
       is interrupted best effort, then the caller sees `cancelled`. */
    private async waitForIdle(sessionId: string, signal?: AbortSignal): Promise<void> {
        const idle = this.host.client.sessions.wait({ sessionID: sessionId });

        if (signal === undefined) {
            await idle;

            return;
        }

        await this.raceAbort(idle, sessionId, signal);
    }

    private raceAbort(idle: Promise<unknown>, sessionId: string, signal: AbortSignal): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const onAbort = (): void => {
                this.interruptWithoutWaiting(sessionId);
                reject(new AiError('cancelled', `Agent session ${sessionId} was cancelled.`));
            };

            if (signal.aborted) {
                onAbort();

                return;
            }

            signal.addEventListener('abort', onAbort, { once: true });
            idle.then(
                (): void => {
                    signal.removeEventListener('abort', onAbort);
                    resolve();
                },
                // eslint-disable-next-line anti-slop/no-unknown-parameters -- promise rejection is untyped; converted via asError below
                (error: unknown): void => {
                    signal.removeEventListener('abort', onAbort);
                    reject(asError(error));
                }
            );
        });
    }

    private interruptWithoutWaiting(sessionId: string): void {
        this.host.client.sessions.interrupt({ sessionID: sessionId }).catch(ignoreInterruptFailure);
    }
}

/* Composes the host and the AiRuntime adapter. Plugin directory and engine
   database are provided by the caller: they are product-owned locations from
   the platform layer, not runtime concerns. */
export async function createEmbeddedEngineRuntime(options: EngineRuntimeOptions): Promise<EmbeddedEngineRuntime> {
    if (options.signal?.aborted === true) {
        throw new AiError('cancelled', 'Engine runtime creation was cancelled.');
    }

    const checkoutDir = await resolveSafeCheckoutDirectory(options.checkoutDir, options.signal);
    const host = await createEngineHost({ ...options, checkoutDir });

    return new EmbeddedEngineRuntime({ host, databaseDirectory: options.databaseDirectory });
}

/* HTTP status is the authoritative classification input (401/403 provider-auth,
   429 rate-limit, 408/504 timeout); message/type heuristic is the fallback
   for engine errors without a status. */
function providerError(info: EngineSessionErrorInfo): AiError {
    return new AiError(classifyEngineError(info), engineErrorDetail(info));
}

// eslint-disable-next-line anti-slop/no-unknown-parameters -- turn-failure boundary; narrowed via instanceof checks below
function normalizeFailure(input: AiStructuredCall, error: unknown): AiError {
    if (error instanceof AiError) {
        return error;
    }

    /* Fired abort wins over whatever the turn reported: the step is
       cancelled or expired, and no partial output may be accepted. */
    if (input.signal?.aborted === true) {
        return new AiError('cancelled', describeError(error));
    }

    if (error instanceof Error && error.name === 'AbortError') {
        return new AiError('cancelled', error.message);
    }

    return new AiError('runtime-failure', describeError(error));
}

function ignoreInterruptFailure(): void {
    // Best effort: cancellation already owns the user-visible outcome.
}
