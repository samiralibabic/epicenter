import { describe, expect, it } from 'bun:test';
import {
	type AsyncStorage,
	asDeviceId,
	createDeviceId,
	createDeviceIdAsync,
	type SimpleStorage,
} from './device-id.js';

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

describe('createDeviceId', () => {
	it('returns the existing value when storage already holds one', () => {
		const storage = makeMemoryStorage({
			'epicenter.device.id': 'preexisting-id',
		});
		expect(createDeviceId({ storage })).toBe(asDeviceId('preexisting-id'));
	});

	it('generates and persists when storage is empty', () => {
		const storage = makeMemoryStorage();
		const fresh = createDeviceId({ storage });
		expect(fresh).toMatch(/^[a-z0-9]{15}$/);
		expect(storage.getItem('epicenter.device.id')).toBe(fresh);
	});

	it('returns the same value on subsequent calls (idempotent)', () => {
		const storage = makeMemoryStorage();
		const first = createDeviceId({ storage });
		const second = createDeviceId({ storage });
		expect(second).toBe(first);
	});

	it('does not collide on independent storages', () => {
		const a = createDeviceId({ storage: makeMemoryStorage() });
		const b = createDeviceId({ storage: makeMemoryStorage() });
		expect(a).not.toBe(b);
	});
});

describe('createDeviceIdAsync', () => {
	it('returns the existing value when storage already holds one', async () => {
		const storage = makeAsyncMemoryStorage({
			'epicenter.device.id': 'preexisting-id',
		});
		expect(await createDeviceIdAsync({ storage })).toBe(
			asDeviceId('preexisting-id'),
		);
	});

	it('generates and persists when storage is empty', async () => {
		const storage = makeAsyncMemoryStorage();
		const fresh = await createDeviceIdAsync({ storage });
		expect(fresh).toMatch(/^[a-z0-9]{15}$/);
		expect(await storage.getItem('epicenter.device.id')).toBe(fresh);
	});

	it('returns the same value on subsequent calls (idempotent)', async () => {
		const storage = makeAsyncMemoryStorage();
		const first = await createDeviceIdAsync({ storage });
		const second = await createDeviceIdAsync({ storage });
		expect(second).toBe(first);
	});
});
