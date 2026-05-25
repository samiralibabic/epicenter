/**
 * Local-only recipe: regression guard.
 *
 * Pins the composition a local-only consumer (desktop notes app, offline
 * CLI, test fixture) is meant to use. The recipe does NOT route through
 * `attachLocalStorage` or `attachEncryption`: those are cloud-synced
 * composites that require an owner-scoped keyring. Local-only data has no
 * cloud adversary, so plain IDB + plain BroadcastChannel + plain
 * `attachTable` is the right shape.
 *
 * If this file ever needs to import from `@epicenter/auth`,
 * `@epicenter/encryption`, or `@epicenter/constants/identity`, the
 * primitives have drifted away from the local-only ergonomic that
 * motivated the workspace split. Either rename the test, or fix the
 * primitive.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { IDBKeyRange, indexedDB } from 'fake-indexeddb';
import * as Y from 'yjs';
import { attachBroadcastChannel } from './attach-broadcast-channel.js';
import { attachIndexedDb } from './attach-indexed-db.js';
import { attachTable } from './attach-table.js';
import { column } from './column/index.js';
import { defineTable } from './define-table.js';

Object.assign(globalThis, { indexedDB, IDBKeyRange });

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

const NoteDef = defineTable({
	id: column.string(),
	body: column.string(),
});

describe('local-only recipe', () => {
	beforeEach(() => {
		FakeBroadcastChannel.names = [];
		Object.assign(globalThis, {
			BroadcastChannel:
				FakeBroadcastChannel as unknown as typeof BroadcastChannel,
		});
	});

	afterEach(async () => {
		Object.assign(globalThis, { BroadcastChannel: originalBroadcastChannel });
		await new Promise<void>((resolve) => {
			const request = indexedDB.deleteDatabase('local-notes');
			request.onsuccess = () => resolve();
			request.onerror = () => resolve();
			request.onblocked = () => resolve();
		});
	});

	test('persist + broadcast + table compose with no auth or encryption', async () => {
		const ydoc = new Y.Doc({ guid: 'local-notes' });
		const idb = attachIndexedDb(ydoc);
		attachBroadcastChannel(ydoc);
		await idb.whenLoaded;

		const notes = attachTable(ydoc, 'notes', NoteDef);
		notes.set({ id: 'first', body: 'hello local-first' });

		const { data: stored, error } = notes.get('first');
		expect(error).toBeNull();
		expect(stored).toEqual({ id: 'first', body: 'hello local-first' });

		expect(FakeBroadcastChannel.names).toEqual(['yjs.local-notes']);

		ydoc.destroy();
		await idb.whenDisposed;
	});

	test('data survives a fresh open on the same guid', async () => {
		const first = new Y.Doc({ guid: 'local-notes' });
		const firstIdb = attachIndexedDb(first);
		await firstIdb.whenLoaded;
		const firstNotes = attachTable(first, 'notes', NoteDef);
		firstNotes.set({ id: 'persist-me', body: 'survives reload' });
		first.destroy();
		await firstIdb.whenDisposed;

		const second = new Y.Doc({ guid: 'local-notes' });
		const secondIdb = attachIndexedDb(second);
		await secondIdb.whenLoaded;
		const secondNotes = attachTable(second, 'notes', NoteDef);

		const { data: stored } = secondNotes.get('persist-me');
		expect(stored).toEqual({
			id: 'persist-me',
			body: 'survives reload',
		});

		second.destroy();
		await secondIdb.whenDisposed;
	});
});
