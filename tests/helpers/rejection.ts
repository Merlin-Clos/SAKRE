export async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
    try {
        await promise;
    } catch (error) {
        if (error instanceof Error) {
            return error;
        }

        return new Error(String(error));
    }

    throw new Error('Expected promise to reject.');
}
