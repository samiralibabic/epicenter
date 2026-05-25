/**
 * On-disk format pinning tests for `PersistedAuth`.
 *
 * The PersistedAuth cell is JSON written to localStorage, chrome.storage.local,
 * or a mode-0600 file on disk. Existing cells on every signed-in machine
 * encode their fields in a specific order under specific names. Any change
 * that:
 *   - reorders the top-level keys (JSON.stringify follows insertion order)
 *   - renames a field (`userId` -> `userID`)
 *   - adds a required field (cells written before the change fail to parse)
 *   - changes the encoding of `keyBytesBase64` (base64 variant, padding)
 *
 * breaks every existing cell. These tests pin the byte-level format so any
 * such change fails loudly before it can ship.
 *
 * The fixtures are deliberately minimal: one keyring entry, short bearer
 * tokens, ASCII-only ids. The intent is not to test crypto or auth flow
 * (other tests do that) but to lock the shape consumers serialize against.
 */

import { expect, test } from 'bun:test';
import { PersistedAuth } from './auth-types.js';

const FIXTURE = {
	grant: {
		accessToken: 'a',
		refreshToken: 'r',
		accessTokenExpiresAt: 1_700_000_000_000,
	},
	userId: 'alice',
	ownerId: 'alice',
	keyring: [
		{
			version: 1,
			keyBytesBase64: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
		},
	],
};

const PINNED_JSON = `{"grant":{"accessToken":"a","refreshToken":"r","accessTokenExpiresAt":1700000000000},"userId":"alice","ownerId":"alice","keyring":[{"version":1,"keyBytesBase64":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="}]}`;

test('PersistedAuth.assert round-trips the on-disk fixture byte-identical', () => {
	const parsed = PersistedAuth.assert(FIXTURE);
	expect(JSON.stringify(parsed)).toBe(PINNED_JSON);
});

test('PersistedAuth rejects a cell missing any required field', () => {
	// arktype treats `{...FIXTURE, x: undefined}` as "x is missing" because
	// `x: string` rejects undefined. Verified manually; do not switch to a
	// strip pattern (e.g. delete broken.x) which would defeat the type-narrow
	// loop.
	const required = ['grant', 'userId', 'ownerId', 'keyring'] as const;
	for (const field of required) {
		const broken = { ...FIXTURE, [field]: undefined };
		expect(
			() => PersistedAuth.assert(broken),
			`expected PersistedAuth.assert to reject cell missing '${field}'`,
		).toThrow();
	}
});

test('PersistedAuth strips unknown top-level fields rather than rejecting', () => {
	const withExtra = { ...FIXTURE, legacyUnlock: { foo: 'bar' } };
	const parsed = PersistedAuth.assert(withExtra) as Record<string, unknown>;
	expect('legacyUnlock' in parsed).toBe(false);
	expect(JSON.stringify(parsed)).toBe(PINNED_JSON);
});
