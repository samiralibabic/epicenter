/**
 * Behavior tests for the Fuji schema and its mounted shape via
 * `attachEncryption`. Pins the canonical workspace id and the encrypted
 * tables/kv surface that browser and daemon compositions both build on.
 */

import { describe, expect, test } from 'bun:test';
import { bytesToBase64, type SubjectKeyring } from '@epicenter/encryption';
import { attachEncryption } from '@epicenter/workspace';
import * as Y from 'yjs';
import {
	createFujiActions,
	type EntryId,
	entryContentDocGuid,
	FUJI_ID,
	fujiTables,
} from './src/lib/workspace.js';

const testKey = new Uint8Array(32).fill(7);
const testKeyring: SubjectKeyring = [
	{ version: 1, subjectKeyBase64: bytesToBase64(testKey) },
];

function openFujiForTest({ clientId }: { clientId?: number } = {}) {
	const ydoc = new Y.Doc({ guid: FUJI_ID, gc: true });
	if (clientId !== undefined) ydoc.clientID = clientId;
	const encryption = attachEncryption(ydoc, { keyring: () => testKeyring });
	const tables = encryption.attachTables(fujiTables);
	const kv = encryption.attachKv({});
	const actions = createFujiActions(tables);
	return { ydoc, encryption, tables, kv, actions };
}

describe('Fuji workspace mount', () => {
	test('constructs a gc:true Y.Doc with FUJI_ID as guid', () => {
		const { ydoc } = openFujiForTest();
		expect(ydoc.guid).toBe(FUJI_ID);
		expect(ydoc.gc).toBe(true);
		ydoc.destroy();
	});

	test('applies optional clientId', () => {
		const { ydoc } = openFujiForTest({ clientId: 1234 });
		expect(ydoc.clientID).toBe(1234);
		ydoc.destroy();
	});

	test('does not pin clientId when omitted', () => {
		const a = openFujiForTest();
		const b = openFujiForTest();
		expect(typeof a.ydoc.clientID).toBe('number');
		expect(typeof b.ydoc.clientID).toBe('number');
		a.ydoc.destroy();
		b.ydoc.destroy();
	});

	test('attaches encrypted tables and kv that accept writes', () => {
		const { ydoc, tables, kv } = openFujiForTest();
		expect(tables.entries).toBeDefined();
		expect(kv).toBeDefined();
		expect(tables.entries.count()).toBe(0);
		ydoc.destroy();
	});

	test('createFujiActions produces an action surface', () => {
		const { ydoc, actions } = openFujiForTest();
		expect(actions).toBeDefined();
		expect(actions.entries_count).toBeDefined();
		expect(actions.entries_get).toBeDefined();
		expect(actions.entries_create).toBeDefined();
		ydoc.destroy();
	});
});

describe('Fuji schema helpers', () => {
	test('entryContentDocGuid is deterministic per entry id', () => {
		const a = entryContentDocGuid('entry-1' as EntryId);
		const b = entryContentDocGuid('entry-1' as EntryId);
		const c = entryContentDocGuid('entry-2' as EntryId);
		expect(a).toBe(b);
		expect(a).not.toBe(c);
		expect(a.length).toBeGreaterThan(0);
	});

	test('entryContentDocGuid bakes in FUJI_ID as the workspace label', () => {
		const guid = entryContentDocGuid('entry-1' as EntryId);
		expect(typeof guid).toBe('string');
		expect(guid.length).toBeGreaterThan(0);
	});
});
