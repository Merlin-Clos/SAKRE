/* Bounded fan-out with fixed workers that preserves input order. One implementation serves every fan-out so the bound cannot drift. */
export async function mapWithConcurrency<Item, Result>(
    items: readonly Item[],
    limit: number,
    transform: (item: Item) => Promise<Result>
): Promise<Result[]> {
    const results: Result[] = [];
    /* A failed transform stops new pulls, but running transforms still settle before reject, so no worker writes after cleanup starts. */
    // eslint-disable-next-line anti-slop/no-known-value-widening -- worker state starts empty by design
    const state: { next: number; failure?: { error: unknown } } = { next: 0 };

    async function worker(): Promise<void> {
        while (state.next < items.length && state.failure === undefined) {
            const index = state.next;
            state.next += 1;
            const item = items[index];

            if (item !== undefined) {
                try {
                    results[index] = await transform(item);
                } catch (error) {
                    state.failure ??= { error };
                }
            }
        }
    }

    const workerCount = Math.min(Math.max(1, limit), items.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    if (state.failure !== undefined) {
        throw state.failure.error;
    }

    return results;
}
