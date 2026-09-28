import { spawn } from 'node:child_process';

export function isSafeAuthorizationUrl(value: string): boolean {
    try {
        const url = new URL(value);

        return (
            (url.protocol === 'https:' ||
                (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) &&
            url.username === '' &&
            url.password === ''
        );
    } catch {
        return false;
    }
}

export function openAuthorizationUrl(url: string): Promise<boolean> {
    if (!isSafeAuthorizationUrl(url)) {
        return Promise.resolve(false);
    }

    const command = browserCommand(process.platform, url);

    if (command === undefined) {
        return Promise.resolve(false);
    }

    return new Promise((resolve) => {
        const child = spawn(command.executable, command.args, { detached: true, stdio: 'ignore' });
        child.once('spawn', () => {
            child.unref();
            resolve(true);
        });
        child.once('error', () => {
            resolve(false);
        });
    });
}

function browserCommand(platform: NodeJS.Platform, url: string): { executable: string; args: string[] } | undefined {
    if (platform === 'darwin') {
        return { executable: 'open', args: [url] };
    }

    if (platform === 'win32') {
        return { executable: 'explorer.exe', args: [url] };
    }

    if (platform === 'linux') {
        return { executable: 'xdg-open', args: [url] };
    }

    return undefined;
}
