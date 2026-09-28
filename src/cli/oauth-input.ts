export class OAuthLoginError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = 'OAuthLoginError';
    }
}

export function requireInteractive(input: { interactive: boolean }, reason: string): void {
    if (!input.interactive) {
        throw new OAuthLoginError(
            `${reason}; run this command in an interactive terminal or pass --method when applicable.`
        );
    }
}
