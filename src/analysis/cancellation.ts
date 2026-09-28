export class CancelledError extends Error {
    public constructor(message = 'Operation cancelled.') {
        super(message);
        this.name = 'CancelledError';
    }
}
