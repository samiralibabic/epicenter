import { describe, expect, it } from 'bun:test';
import {
	type AsyncStorage,
	createInstallationId,
	createInstallationIdAsync,
	type SimpleStorage,
} from './installation-id.js';

function makeMemoryStorage(
	initial: Record<string, string> = {},
): SimpleStorage {
	const store = new Map(Object.entries(initial));
	return {
		getItem: (k) => store.get(k) ?? null,
		setItem: (k, v) => {
			store.set(k, v);
		},
	};
}

function makeAsyncMemoryStorage(
	initial: Record<string, string> = {},
): AsyncStorage {
	const store = new Map(Object.entries(initial));
	return {
		getItem: async (k) => store.get(k) ?? null,
		setItem: async (k, v) => {
			store.set(k, v);
		},
	};
}

describe('createInstallationId', () => {
	it('returns the existing value when storage already holds one', () => {
		const storage = makeMemoryStorage({
			'epicenter.installation.id': 'preexisting-id',
		});
		expect(createInstallationId({ storage })).toBe('preexisting-id');
	});

	it('generates and persists when storage is empty', () => {
		const storage = makeMemoryStorage();
		const fresh = createInstallationId({ storage });
		expect(fresh).toMatch(/^[a-z0-9]{15}$/);
		expect(storage.getItem('epicenter.installation.id')).toBe(fresh);
	});

	it('returns the same value on subsequent calls (idempotent)', () => {
		const storage = makeMemoryStorage();
		const first = createInstallationId({ storage });
		const second = createInstallationId({ storage });
		expect(second).toBe(first);
	});

	it('does not collide on independent storages', () => {
		const a = createInstallationId({ storage: makeMemoryStorage() });
		const b = createInstallationId({ storage: makeMemoryStorage() });
		expect(a).not.toBe(b);
	});
});

describe('createInstallationIdAsync', () => {
	it('returns the existing value when storage already holds one', async () => {
		const storage = makeAsyncMemoryStorage({
			'epicenter.installation.id': 'preexisting-id',
		});
		expect(await createInstallationIdAsync({ storage })).toBe('preexisting-id');
	});

	it('generates and persists when storage is empty', async () => {
		const storage = makeAsyncMemoryStorage();
		const fresh = await createInstallationIdAsync({ storage });
		expect(fresh).toMatch(/^[a-z0-9]{15}$/);
		expect(await storage.getItem('epicenter.installation.id')).toBe(fresh);
	});

	it('returns the same value on subsequent calls (idempotent)', async () => {
		const storage = makeAsyncMemoryStorage();
		const first = await createInstallationIdAsync({ storage });
		const second = await createInstallationIdAsync({ storage });
		expect(second).toBe(first);
	});
});
