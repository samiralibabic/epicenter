/**
 * attachEncryption tests: keyring lookup failures surface at registration,
 * and readonly helpers expose encrypted reads without write methods.
 *
 * Encrypted IndexedDB and owner-scoped BroadcastChannel behavior live on
 * `attachLocalStorage`; see `attach-local-storage.test.ts` for those
 * round-trip tests.
 */

import { describe, expect, test } from 'bun:test';
import type { Keyring } from '@epicenter/encryption';
import { bytesToBase64 } from '@epicenter/encryption';
import { randomBytes } from '@noble/ciphers/utils.js';
import * as Y from 'yjs';
import { attachEncryption } from './attach-encryption.js';
import { column } from './column/index.js';
import { defineTable } from './define-table.js';

function toKeyring(key: Uint8Array): Keyring {
	return [{ version: 1, keyBytesBase64: bytesToBase64(key) }];
}

const encryptedRowDefinition = defineTable({
	id: column.string(),
	title: column.string(),
});

describe('attachEncryption', () => {
	test('keyring callback throwing at registration surfaces the throw', () => {
		const ydoc = new Y.Doc({ guid: 'enc-no-keys', gc: true });
		const encryption = attachEncryption(ydoc, {
			keyring: () => {
				throw new Error('not signed-in');
			},
		});
		expect(() => encryption.attachTable('a', encryptedRowDefinition)).toThrow(
			'not signed-in',
		);
	});

	test('attachReadonlyTable reads encrypted rows without exposing writes', () => {
		const keyring = toKeyring(randomBytes(32));
		const ydoc = new Y.Doc({ guid: 'enc-readonly-table', gc: true });
		const encryption = attachEncryption(ydoc, { keyring: () => keyring });
		const definition = defineTable({
			id: column.string(),
			title: column.string(),
		});
		const writer = encryption.attachTable('entries', definition);
		const reader = encryption.attachReadonlyTable('entries', definition);

		writer.set({ id: '1', title: 'Secret row' });

		expect(reader.get('1').data).toEqual({
			id: '1',
			title: 'Secret row',
		});
		expect('set' in reader).toBe(false);
		expect('bulkSet' in reader).toBe(false);
		expect('update' in reader).toBe(false);
		expect('delete' in reader).toBe(false);
		expect('bulkDelete' in reader).toBe(false);
		expect('clear' in reader).toBe(false);
	});

	test('attachReadonlyTables returns readonly helpers keyed by definition', () => {
		const keyring = toKeyring(randomBytes(32));
		const ydoc = new Y.Doc({ guid: 'enc-readonly-tables', gc: true });
		const encryption = attachEncryption(ydoc, { keyring: () => keyring });
		const definition = defineTable({
			id: column.string(),
			title: column.string(),
		});
		const writers = encryption.attachTables({ entries: definition });
		const readers = encryption.attachReadonlyTables({
			entries: definition,
		});

		writers.entries.set({ id: '1', title: 'Secret row' });

		expect(readers.entries.getAllValid()).toEqual([
			{ id: '1', title: 'Secret row' },
		]);
		expect('set' in readers.entries).toBe(false);
		expect('bulkSet' in readers.entries).toBe(false);
		expect('update' in readers.entries).toBe(false);
		expect('delete' in readers.entries).toBe(false);
		expect('bulkDelete' in readers.entries).toBe(false);
		expect('clear' in readers.entries).toBe(false);
	});
});
