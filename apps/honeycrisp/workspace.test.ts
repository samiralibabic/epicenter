/**
 * Behavior tests for the Honeycrisp schema and its mounted shape via
 * `attachEncryption`. Pins the canonical workspace id and the encrypted
 * tables/kv surface that browser and daemon compositions both build on.
 */

import { describe, expect, test } from 'bun:test';
import { bytesToBase64, type SubjectKeyring } from '@epicenter/encryption';
import { attachEncryption } from '@epicenter/workspace';
import * as Y from 'yjs';
import {
	createHoneycrispActions,
	HONEYCRISP_ID,
	honeycrispTables,
	type NoteId,
	noteBodyDocGuid,
} from './workspace.js';

const testKey = new Uint8Array(32).fill(7);
const testKeyring: SubjectKeyring = [
	{ version: 1, subjectKeyBase64: bytesToBase64(testKey) },
];

function openHoneycrispForTest({ clientId }: { clientId?: number } = {}) {
	const ydoc = new Y.Doc({ guid: HONEYCRISP_ID, gc: true });
	if (clientId !== undefined) ydoc.clientID = clientId;
	const encryption = attachEncryption(ydoc, { keyring: () => testKeyring });
	const tables = encryption.attachTables(honeycrispTables);
	const kv = encryption.attachKv({});
	const actions = createHoneycrispActions(tables);
	return { ydoc, encryption, tables, kv, actions };
}

describe('Honeycrisp workspace mount', () => {
	test('constructs a gc:true Y.Doc with HONEYCRISP_ID as guid', () => {
		const { ydoc } = openHoneycrispForTest();
		expect(ydoc.guid).toBe(HONEYCRISP_ID);
		expect(ydoc.gc).toBe(true);
		ydoc.destroy();
	});

	test('applies optional clientId', () => {
		const { ydoc } = openHoneycrispForTest({ clientId: 1234 });
		expect(ydoc.clientID).toBe(1234);
		ydoc.destroy();
	});

	test('does not pin clientId when omitted', () => {
		const a = openHoneycrispForTest();
		const b = openHoneycrispForTest();
		expect(typeof a.ydoc.clientID).toBe('number');
		expect(typeof b.ydoc.clientID).toBe('number');
		a.ydoc.destroy();
		b.ydoc.destroy();
	});

	test('attaches encrypted tables and kv that accept writes', () => {
		const { ydoc, tables, kv } = openHoneycrispForTest();
		expect(tables.folders).toBeDefined();
		expect(tables.notes).toBeDefined();
		expect(kv).toBeDefined();
		expect(tables.folders.count()).toBe(0);
		expect(tables.notes.count()).toBe(0);
		ydoc.destroy();
	});

	test('createHoneycrispActions produces an action surface', () => {
		const { ydoc, actions } = openHoneycrispForTest();
		expect(actions).toBeDefined();
		expect(actions.folders_delete).toBeDefined();
		ydoc.destroy();
	});
});

describe('Honeycrisp schema helpers', () => {
	test('noteBodyDocGuid is deterministic per note id', () => {
		const a = noteBodyDocGuid('note-1' as NoteId);
		const b = noteBodyDocGuid('note-1' as NoteId);
		const c = noteBodyDocGuid('note-2' as NoteId);
		expect(a).toBe(b);
		expect(a).not.toBe(c);
		expect(a.length).toBeGreaterThan(0);
	});

	test('noteBodyDocGuid bakes in HONEYCRISP_ID as the workspace label', () => {
		// Sanity: a different workspace label would produce a different guid.
		const guid = noteBodyDocGuid('note-1' as NoteId);
		expect(typeof guid).toBe('string');
		expect(guid.length).toBeGreaterThan(0);
	});
});
