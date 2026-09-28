import { writeFileSync } from 'node:fs';
import { startFakeProvider } from '../helpers/fake-artifact-provider';

/* Standalone fake provider for the Linux offline proof: it runs inside the
   network namespace, writes its loopback base URL to the file named by
   SAKRE_FAKE_PROVIDER_PORT_FILE and serves until the wrapper terminates
   it. Keeping it in its own process lets the namespace test exercise the real
   engine instead of the mock runtime. */
const portFile = process.env.SAKRE_FAKE_PROVIDER_PORT_FILE;

if (portFile === undefined || portFile === '') {
    throw new Error('SAKRE_FAKE_PROVIDER_PORT_FILE is required.');
}

const provider = startFakeProvider();

writeFileSync(portFile, provider.baseURL, 'utf8');

/* Stopping the server drains the event loop, so the process exits by itself. */
function shutdown(): void {
    provider.stop().catch(() => {
        process.exitCode = 1;
    });
}

process.on('SIGTERM', shutdown);

process.on('SIGINT', shutdown);
