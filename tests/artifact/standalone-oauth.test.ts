import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Credential } from '@opencode/core/credential';
import { Integration } from '@opencode/schema/integration';
import { Effect, Schema } from 'effect';
import { persistentCredentialLayer, prepareOAuthCredentialStore } from '../../src/engine/oauth-credentials';
import { engineOAuthCredentialPath } from '../../src/native/data-paths';
import {
    credentialFreeEnvironment,
    runStandalone,
    standaloneArtifactAvailable,
    standaloneFailure
} from '../helpers/standalone-cli';

setDefaultTimeout(180_000);

let root = '';

beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'sakre-standalone-oauth-'));
});

afterAll(async () => {
    await rm(root, { recursive: true, force: true });
});

test.skipIf(!standaloneArtifactAvailable)(
    'lists and removes a persisted OAuth account without exposing its value',
    async () => {
        const cwd = await mkdtemp(path.join(root, 'auth-oauth-'));
        const environment = await credentialFreeEnvironment(root);

        const databasePath = engineOAuthCredentialPath({
            platform: process.platform,
            environment,
            home: environment.HOME ?? ''
        });

        await prepareOAuthCredentialStore(databasePath);

        const layer = persistentCredentialLayer({
            path: databasePath,
            integrationID: 'openai',
            persistCreatedSelection: true
        });

        const credential = await Effect.runPromise(
            Effect.gen(function* seedStandaloneOAuth() {
                const service = yield* Credential.Service;

                return yield* service.create({
                    integrationID: Schema.decodeUnknownSync(Integration.ID)('openai'),
                    label: 'offline account',
                    value: Credential.OAuth.make({
                        type: 'oauth',
                        methodID: Schema.decodeUnknownSync(Integration.MethodID)('offline-test'),
                        access: 'fake-standalone-access',
                        refresh: 'fake-standalone-refresh',
                        expires: Date.now() + 3_600_000
                    })
                });
            }).pipe(Effect.provide(layer))
        );

        const listed = await runStandalone(['auth', 'list', 'openai'], { cwd, env: environment });
        expect(listed.exitCode, standaloneFailure(listed)).toBe(0);
        expect(listed.stdout).toContain(`* ${credential.id}  openai  offline account`);
        expect(`${listed.stdout}${listed.stderr}`).not.toContain('fake-standalone-access');
        expect(`${listed.stdout}${listed.stderr}`).not.toContain('fake-standalone-refresh');

        const removed = await runStandalone(['auth', 'remove', credential.id], { cwd, env: environment });
        expect(removed.exitCode, standaloneFailure(removed)).toBe(0);
        const empty = await runStandalone(['auth', 'list', 'openai'], { cwd, env: environment });
        expect(empty.exitCode, standaloneFailure(empty)).toBe(0);
        expect(empty.stdout).toContain('No persistent OAuth credentials found.');
    }
);
