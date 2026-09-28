import { Credential } from '@opencode/sdk';
import { expect, test } from 'bun:test';
import { classifyCredentialAvailability, missingCredentialMessage } from '../../src/engine/credentials';

const first = { type: 'credential', id: Credential.ID.create(), label: 'first', method: 'key' } as const;

const second = { type: 'credential', id: Credential.ID.create(), label: 'second', method: 'oauth' } as const;

const environment = { type: 'env', name: 'PROVIDER_KEY' } as const;

test('admits a public route only when no selected integration credential or environment connection takes priority', () => {
    expect(classifyCredentialAvailability({ methods: [], connections: [] }, true)).toEqual({ kind: 'keyless' });
    expect(classifyCredentialAvailability({ methods: [], connections: [environment] }, true)).toEqual({ kind: 'env' });
    expect(classifyCredentialAvailability({ methods: [], connections: [first] }, true)).toEqual({
        kind: 'activatable',
        credentialID: first.id
    });
});

test('never guesses which of several current-host credentials to activate', () => {
    expect(classifyCredentialAvailability({ methods: [], connections: [first, second] }, false)).toEqual({
        kind: 'ambiguous',
        count: 2
    });
});

test('reports deferred OAuth only if the selected integration offers it, without credential values', () => {
    const oauth = { type: 'oauth', id: 'oauth', label: 'OAuth' } as const;
    const availability = classifyCredentialAvailability({ methods: [oauth], connections: [] }, false);
    expect(availability).toEqual({ kind: 'oauth-unavailable' });
    expect(missingCredentialMessage('provider', availability, false)).toContain('auth login provider');
    const missing = classifyCredentialAvailability({ methods: [], connections: [] }, false);
    expect(missing).toEqual({ kind: 'missing' });
    expect(missingCredentialMessage('provider', missing, false)).toContain('No usable credential');
});
