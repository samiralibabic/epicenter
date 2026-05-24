/**
 * `attachLocalStorage` and `wipeLocalStorage` behavior tests.
 *
 * Covers the identity-scoped pairing of encrypted IDB persistence and
 * cross-tab BroadcastChannel, keyed by `(server, owner, ydoc.guid)`. Pins
 * the durable storage shape so any accidental change to the layout is
 * caught here:
 *
 *   personal: epicenter/<server>/users/<userId>/<guid>
 *   team:     epicenter/<server>/<guid>
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	base64ToBytes,
	bytesToBase64,
	decryptBytes,
	deriveWorkspaceKey,
	type EncryptedBlob,
	type SubjectKeyring,
} from '@epicenter/encryption';
import { randomBytes } from '@noble/ciphers/utils.js';
import { IDBKeyRange, indexedDB } from 'fake-indexeddb';
import * as Y from 'yjs';
import { attachLocalStorage } from './attach-local-storage.js';
import { wipeLocalStorage } from './wipe-local-storage.js';

Object.assign(globalThis, { indexedDB, IDBKeyRange });

const SERVER = 'api.epicenter.so';
const personalOwner = (userId: string) =>
	({ kind: 'personal', userId }) as const;

function toKeyring(key: Uint8Array): SubjectKeyring {
	return [{ version: 1, subjectKeyBase64: bytesToBase64(key) }];
}

const noKeys: () => SubjectKeyring = () => toKeyring(randomBytes(32));

function tick(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

async function readEncryptedUpdates(dbName: string): Promise<EncryptedBlob[]> {
	const db = await new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open(dbName);
		request.onerror = () => reject(request.error);
		request.onsuccess = () => resolve(request.result);
	});
	try {
		const transaction = db.transaction(['updates'], 'readonly');
		const store = transaction.objectStore('updates');
		return await new Promise<EncryptedBlob[]>((resolve, reject) => {
			const request = store.getAll();
			request.onerror = () => reject(request.error);
			request.onsuccess = () => resolve(request.result as EncryptedBlob[]);
		});
	} finally {
		db.close();
	}
}

function keyringForGuid(
	keyring: SubjectKeyring,
	guid: string,
): Map<number, Uint8Array> {
	return new Map(
		keyring.map(({ version, subjectKeyBase64 }) => [
			version,
			deriveWorkspaceKey(base64ToBytes(subjectKeyBase64), guid),
		]),
	);
}

async function createDatabase(name: string): Promise<void> {
	const database = await new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open(name);
		request.onerror = () => reject(request.error);
		request.onsuccess = () => resolve(request.result);
	});
	database.close();
}

async function deleteDatabase(name: string): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const request = indexedDB.deleteDatabase(name);
		request.onerror = () => reject(request.error);
		request.onsuccess = () => resolve();
		request.onblocked = () => reject(new Error(`Delete blocked for ${name}`));
	});
}

async function databaseNames(): Promise<string[]> {
	const databases = await indexedDB.databases();
	return databases
		.map((database) => database.name)
		.filter((name): name is string => typeof name === 'string');
}

describe('attachLocalStorage', () => {
	test('throws when keyring throws', () => {
		const ydoc = new Y.Doc({ guid: 'encrypted-idb-no-keys', gc: true });
		expect(() =>
			attachLocalStorage(ydoc, {
				server: SERVER,
				owner: personalOwner('user-no-keys'),
				keyring: () => {
					throw new Error('not signed-in');
				},
			}),
		).toThrow('not signed-in');
		ydoc.destroy();
	});

	test('round trips encrypted Yjs updates through IndexedDB at the owner prefix', async () => {
		const userId = `user-${crypto.randomUUID()}`;
		const databaseName = `epicenter/${SERVER}/users/${userId}/encrypted-idb-roundtrip`;
		const keyring = toKeyring(randomBytes(32));

		const firstDoc = new Y.Doc({
			guid: 'encrypted-idb-roundtrip',
			gc: true,
		});
		const firstIdb = attachLocalStorage(firstDoc, {
			server: SERVER,
			owner: personalOwner(userId),
			keyring: () => keyring,
		});
		await firstIdb.whenLoaded;
		firstDoc.getText('body').insert(0, 'stored ciphertext');
		await tick();
		firstDoc.destroy();
		await firstIdb.whenDisposed;

		const rawUpdates = await readEncryptedUpdates(databaseName);
		expect(rawUpdates.length).toBeGreaterThan(0);
		expect(rawUpdates.every((update) => update[0] === 1)).toBe(true);

		const secondDoc = new Y.Doc({
			guid: 'encrypted-idb-roundtrip',
			gc: true,
		});
		const secondIdb = attachLocalStorage(secondDoc, {
			server: SERVER,
			owner: personalOwner(userId),
			keyring: () => keyring,
		});
		await secondIdb.whenLoaded;

		expect(secondDoc.getText('body').toString()).toBe('stored ciphertext');
		secondDoc.destroy();
		await secondIdb.whenDisposed;
		await secondIdb.clearLocal();
	});

	test('target guid changes the derived storage key', async () => {
		const userId = `user-${crypto.randomUUID()}`;
		const databaseName = `epicenter/${SERVER}/users/${userId}/encrypted-idb-guid-a`;
		const keyring = toKeyring(randomBytes(32));
		const ydoc = new Y.Doc({ guid: 'encrypted-idb-guid-a', gc: true });
		const idb = attachLocalStorage(ydoc, {
			server: SERVER,
			owner: personalOwner(userId),
			keyring: () => keyring,
		});
		await idb.whenLoaded;
		ydoc.getText('body').insert(0, 'guid bound');
		await tick();
		ydoc.destroy();
		await idb.whenDisposed;

		const rawUpdates = await readEncryptedUpdates(databaseName);
		const updateWithContent = rawUpdates.at(-1);
		expect(updateWithContent).toBeDefined();
		expect(() =>
			decryptBytes({
				keyring: keyringForGuid(keyring, 'encrypted-idb-guid-b'),
				blob: updateWithContent as EncryptedBlob,
				aad: new TextEncoder().encode('yjs-update-v2:encrypted-idb-guid-a'),
			}),
		).toThrow();
		await idb.clearLocal();
	});

	test('clearLocal clears the encrypted IndexedDB database', async () => {
		const userId = `user-${crypto.randomUUID()}`;
		const keyring = toKeyring(randomBytes(32));

		const firstDoc = new Y.Doc({ guid: 'encrypted-idb-clear', gc: true });
		const firstIdb = attachLocalStorage(firstDoc, {
			server: SERVER,
			owner: personalOwner(userId),
			keyring: () => keyring,
		});
		await firstIdb.whenLoaded;
		firstDoc.getText('body').insert(0, 'clear me');
		await tick();
		firstDoc.destroy();
		await firstIdb.whenDisposed;
		await firstIdb.clearLocal();

		const secondDoc = new Y.Doc({ guid: 'encrypted-idb-clear', gc: true });
		const secondIdb = attachLocalStorage(secondDoc, {
			server: SERVER,
			owner: personalOwner(userId),
			keyring: () => keyring,
		});
		await secondIdb.whenLoaded;

		expect(secondDoc.getText('body').toString()).toBe('');
		secondDoc.destroy();
		await secondIdb.whenDisposed;
		await secondIdb.clearLocal();
	});
});

const originalBroadcastChannel = globalThis.BroadcastChannel;

class FakeBroadcastChannel {
	static names: string[] = [];
	onmessage: ((event: MessageEvent) => void) | null = null;

	constructor(public name: string) {
		FakeBroadcastChannel.names.push(name);
	}

	postMessage(_message: unknown): void {}
	close(): void {}
}

describe('attachLocalStorage BroadcastChannel naming', () => {
	beforeEach(() => {
		FakeBroadcastChannel.names = [];
		Object.assign(globalThis, {
			BroadcastChannel:
				FakeBroadcastChannel as unknown as typeof BroadcastChannel,
		});
	});

	afterEach(() => {
		Object.assign(globalThis, { BroadcastChannel: originalBroadcastChannel });
	});

	test('uses an owner-scoped channel key without changing ydoc.guid', () => {
		const ydoc = new Y.Doc({ guid: 'epicenter.fuji' });

		attachLocalStorage(ydoc, {
			server: SERVER,
			owner: personalOwner('user-123'),
			keyring: noKeys,
		});

		// y-indexeddb compatibility: attachBroadcastChannel prepends `yjs.` so
		// channels coordinate with the same name y-indexeddb writes for the
		// shared database. The owner-scoped portion is everything after.
		expect(FakeBroadcastChannel.names).toEqual([
			`yjs.epicenter/${SERVER}/users/user-123/epicenter.fuji`,
		]);
		expect(ydoc.guid).toBe('epicenter.fuji');
		ydoc.destroy();
	});
});

describe('wipeLocalStorage', () => {
	afterEach(async () => {
		await Promise.all(
			(await databaseNames()).map((name) => deleteDatabase(name)),
		);
	});

	test('clears every database under the (server, owner) prefix', async () => {
		await createDatabase(`epicenter/${SERVER}/users/user-1/doc-a`);
		await createDatabase(`epicenter/${SERVER}/users/user-1/doc-b`);

		await wipeLocalStorage({
			server: SERVER,
			owner: personalOwner('user-1'),
		});

		const remaining = await databaseNames();
		expect(remaining).not.toContain(`epicenter/${SERVER}/users/user-1/doc-a`);
		expect(remaining).not.toContain(`epicenter/${SERVER}/users/user-1/doc-b`);
	});

	test('leaves other owners and unscoped databases alone', async () => {
		await createDatabase(`epicenter/${SERVER}/users/user-1/doc-a`);
		await createDatabase(`epicenter/${SERVER}/users/user-2/doc-c`);
		await createDatabase('unscoped-doc');

		await wipeLocalStorage({
			server: SERVER,
			owner: personalOwner('user-1'),
		});

		const remaining = await databaseNames();
		expect(remaining).not.toContain(`epicenter/${SERVER}/users/user-1/doc-a`);
		expect(remaining).toContain(`epicenter/${SERVER}/users/user-2/doc-c`);
		expect(remaining).toContain('unscoped-doc');
	});
});
