import { configureLogSink, createStreamLogSink, resetLogSink } from '../../src/logger';

export interface CapturedLogs {
    text: () => string;
    lines: () => string[];
}

/* Captures every line the code under test writes through the shared log sink. Expected negative paths (intentional
   failures and fallbacks) keep real logging and assertions but never reach the production Action sink, so a green run
   emits no `::error::`/`::warning::` annotation for them. */
export async function withCapturedLogs<Result>(run: (logs: CapturedLogs) => Promise<Result>): Promise<Result> {
    const chunks: string[] = [];

    // SAFETY: the sink only calls write; the fake captures chunks for assertions and never touches the real stream.
    // eslint-disable-next-line anti-slop/no-chained-type-assertions -- sink fake implements only write; the chain bridges it to WritableStream
    const stream = {
        write: (chunk: string): boolean => {
            chunks.push(chunk);

            return true;
        }
    } as unknown as NodeJS.WritableStream;

    configureLogSink(createStreamLogSink(stream));

    try {
        return await run({
            text: () => chunks.join(''),
            lines: () => chunks.join('').split('\n')
        });
    } finally {
        resetLogSink();
    }
}
