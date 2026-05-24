import { describe, expect, test } from 'bun:test';
import { TRUSTED_ORIGINS } from './trusted-origins';

describe('TRUSTED_ORIGINS', () => {
	test('rejects arbitrary chrome-extension origins (no wildcard regression)', () => {
		expect(TRUSTED_ORIGINS).not.toContain('chrome-extension://attackerid');
		expect(TRUSTED_ORIGINS).not.toContain('chrome-extension://*');
		expect(TRUSTED_ORIGINS.some((o) => o.includes('*'))).toBe(false);
	});

	test('contains exactly one chrome-extension origin (the pinned tab-manager)', () => {
		const exts = TRUSTED_ORIGINS.filter((o) =>
			o.startsWith('chrome-extension://'),
		);
		expect(exts).toEqual([
			'chrome-extension://mkbnicfhpacdofmoocppnjjmdfmkkgda',
		]);
	});

	test('is frozen so Cloudflare isolates cannot accumulate mutations', () => {
		expect(Object.isFrozen(TRUSTED_ORIGINS)).toBe(true);
	});
});
