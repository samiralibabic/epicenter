import { describe, expect, test } from 'bun:test';

import { hashYDocClientId } from './client-id.js';

describe('hashYDocClientId', () => {
	test('is deterministic for the same input', () => {
		expect(hashYDocClientId('/vault/scripts/import-feed.ts')).toBe(
			hashYDocClientId('/vault/scripts/import-feed.ts'),
		);
	});

	test('produces distinct ids for distinct inputs', () => {
		expect(hashYDocClientId('/vault/scripts/a.ts')).not.toBe(
			hashYDocClientId('/vault/scripts/b.ts'),
		);
	});

	test('returns a positive safe integer (Yjs reserves clientID 0)', () => {
		const id = hashYDocClientId('/some/path');
		expect(Number.isSafeInteger(id)).toBe(true);
		expect(id).toBeGreaterThan(0);
		expect(id).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
	});

	test('handles empty string without throwing', () => {
		const id = hashYDocClientId('');
		expect(Number.isSafeInteger(id)).toBe(true);
		expect(id).toBeGreaterThan(0);
	});
});
