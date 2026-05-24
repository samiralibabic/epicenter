/**
 * Protocol Unit Tests
 *
 * Tests the Yjs sync protocol helpers used by the server sync endpoint:
 * the frame encoders (`encodeSyncStep1` / `encodeSyncUpdate`), the
 * dispatcher (`handleSyncPayload`), and end-to-end synchronization.
 *
 * A binary frame is `[sync sub-type varint][payload]`; `readFrame` below
 * is the test-side decoder (production decodes inline at the transport).
 */

import { describe, expect, test } from 'bun:test';
import * as decoding from 'lib0/decoding';
import * as Y from 'yjs';
import {
	encodeSyncStep1,
	encodeSyncUpdate,
	handleSyncPayload,
	SYNC_MESSAGE_TYPE,
	type SyncMessageType,
} from './protocol';

// ============================================================================
// SYNC_MESSAGE_TYPE Constants
// ============================================================================

describe('SYNC_MESSAGE_TYPE constants', () => {
	test('have expected numeric values', () => {
		expect(SYNC_MESSAGE_TYPE.STEP1).toBe(0);
		expect(SYNC_MESSAGE_TYPE.STEP2).toBe(1);
		expect(SYNC_MESSAGE_TYPE.UPDATE).toBe(2);
	});
});

// ============================================================================
// Frame Encoders
// ============================================================================

describe('encodeSyncStep1', () => {
	test('produces a STEP1 frame carrying the document state vector', () => {
		const doc = createDoc((d) => d.getMap('test').set('foo', 'bar'));
		const { syncType, payload } = readFrame(encodeSyncStep1({ doc }));

		expect(syncType).toBe(SYNC_MESSAGE_TYPE.STEP1);
		expect(payload).toEqual(Y.encodeStateVector(doc));
	});

	test('frame changes after the document is modified', () => {
		const doc = createDoc();
		const before = encodeSyncStep1({ doc });

		doc.getMap('data').set('key', 'value');
		const after = encodeSyncStep1({ doc });

		expect(before).not.toEqual(after);
	});
});

describe('encodeSyncUpdate', () => {
	test('produces an UPDATE frame carrying the update bytes', () => {
		const doc = createDoc();
		let captured: Uint8Array | null = null;
		doc.on('updateV2', (update: Uint8Array) => {
			captured = update;
		});
		doc.getMap('data').set('key', 'value');

		if (!captured) {
			throw new Error('Expected a captured update after document mutation');
		}
		const { syncType, payload } = readFrame(
			encodeSyncUpdate({ update: captured }),
		);

		expect(syncType).toBe(SYNC_MESSAGE_TYPE.UPDATE);
		expect(payload).toEqual(captured);
	});

	test('handles an empty update', () => {
		const { syncType, payload } = readFrame(
			encodeSyncUpdate({ update: new Uint8Array(0) }),
		);

		expect(syncType).toBe(SYNC_MESSAGE_TYPE.UPDATE);
		expect(payload.length).toBe(0);
	});
});

// ============================================================================
// handleSyncPayload
// ============================================================================

describe('handleSyncPayload', () => {
	test('responds to STEP1 with a STEP2 frame the client can apply', () => {
		const serverDoc = createDoc((d) => {
			d.getMap('data').set('server', 'content');
		});
		const clientDoc = createDoc();

		const response = handleSyncPayload({
			syncType: SYNC_MESSAGE_TYPE.STEP1,
			payload: Y.encodeStateVector(clientDoc),
			doc: serverDoc,
			origin: 'test-client',
		});

		if (!response) {
			throw new Error('Expected a STEP2 response for a STEP1 payload');
		}
		const { syncType, payload } = readFrame(response);
		expect(syncType).toBe(SYNC_MESSAGE_TYPE.STEP2);

		// The client applies the STEP2 payload and converges on server content.
		Y.applyUpdateV2(clientDoc, payload);
		expect(clientDoc.getMap('data').get('server')).toBe('content');
	});

	test('returns null for sync step 2 (no response needed)', () => {
		const serverDoc = createDoc();
		const clientDoc = createDoc((d) => {
			d.getMap('data').set('client', 'content');
		});

		const response = handleSyncPayload({
			syncType: SYNC_MESSAGE_TYPE.STEP2,
			payload: Y.encodeStateAsUpdateV2(clientDoc),
			doc: serverDoc,
			origin: 'test-client',
		});

		expect(response).toBeNull();
	});

	test('returns null for sync update (no response needed)', () => {
		const serverDoc = createDoc();
		const updateV2 = Y.encodeStateAsUpdateV2(
			createDoc((d) => d.getMap('data').set('key', 'value')),
		);

		const response = handleSyncPayload({
			syncType: SYNC_MESSAGE_TYPE.UPDATE,
			payload: updateV2,
			doc: serverDoc,
			origin: 'test-client',
		});

		expect(response).toBeNull();
	});

	test('applies update to document', () => {
		const serverDoc = createDoc();
		const clientDoc = createDoc((d) => {
			d.getMap('data').set('key', 'value');
		});

		handleSyncPayload({
			syncType: SYNC_MESSAGE_TYPE.UPDATE,
			payload: Y.encodeStateAsUpdateV2(clientDoc),
			doc: serverDoc,
			origin: 'test-client',
		});

		expect(serverDoc.getMap('data').get('key')).toBe('value');
	});
});

// ============================================================================
// Full Sync Protocol Tests
// ============================================================================

describe('full sync protocol', () => {
	test('complete handshake syncs server content to client', () => {
		const serverDoc = createDoc((d) => {
			d.getMap('notes').set('note1', 'Hello from server');
		});
		const clientDoc = createDoc();

		// Server handles the client's state vector and responds with STEP2.
		const serverResponse = handleSyncPayload({
			syncType: SYNC_MESSAGE_TYPE.STEP1,
			payload: Y.encodeStateVector(clientDoc),
			doc: serverDoc,
			origin: 'client',
		});
		if (!serverResponse) {
			throw new Error('Expected a server sync response during handshake');
		}

		// Client decodes the STEP2 frame and applies it through the same path.
		const { syncType, payload } = readFrame(serverResponse);
		expect(syncType).toBe(SYNC_MESSAGE_TYPE.STEP2);
		handleSyncPayload({ syncType, payload, doc: clientDoc, origin: 'server' });

		expect(clientDoc.getMap('notes').get('note1')).toBe('Hello from server');
	});

	test('bidirectional sync merges both documents', () => {
		const doc1 = createDoc((d) => d.getMap('data').set('from1', 'value1'));
		const doc2 = createDoc((d) => d.getMap('data').set('from2', 'value2'));

		// Full bidirectional sync using Yjs V2 pattern
		syncDocs(doc1, doc2);

		expect(doc1.getMap('data').get('from1')).toBe('value1');
		expect(doc1.getMap('data').get('from2')).toBe('value2');
		expect(doc2.getMap('data').get('from1')).toBe('value1');
		expect(doc2.getMap('data').get('from2')).toBe('value2');
	});

	test('incremental updates are applied correctly', () => {
		const doc1 = createDoc();
		const doc2 = createDoc();

		// Capture V2 updates from doc1
		const updates: Uint8Array[] = [];
		doc1.on('updateV2', (update: Uint8Array) => {
			updates.push(update);
		});

		// Make changes
		doc1.getMap('data').set('key1', 'value1');
		doc1.getMap('data').set('key2', 'value2');
		doc1.getArray('list').push(['item1', 'item2']);

		// Apply V2 updates to doc2
		for (const update of updates) {
			Y.applyUpdateV2(doc2, update);
		}

		expect(doc2.getMap('data').get('key1')).toBe('value1');
		expect(doc2.getMap('data').get('key2')).toBe('value2');
		expect(doc2.getArray('list').toArray()).toEqual(['item1', 'item2']);
	});
});

// ============================================================================
// Edge Cases
// ============================================================================

describe('edge cases', () => {
	test('handshake syncs a large document (1000+ operations)', () => {
		const serverDoc = createDoc((d) => {
			const arr = d.getArray<string>('items');
			for (let i = 0; i < 1000; i++) {
				arr.push([`item-${i}`]);
			}
		});
		const clientDoc = createDoc();

		const response = handleSyncPayload({
			syncType: SYNC_MESSAGE_TYPE.STEP1,
			payload: Y.encodeStateVector(clientDoc),
			doc: serverDoc,
			origin: 'client',
		});
		if (!response) {
			throw new Error('Expected a STEP2 response for the handshake');
		}
		const { syncType, payload } = readFrame(response);
		handleSyncPayload({ syncType, payload, doc: clientDoc, origin: 'server' });

		expect(clientDoc.getArray('items').length).toBe(1000);
	});

	test('handles concurrent modifications (CRDT merge)', () => {
		const doc1 = createDoc();
		const doc2 = createDoc();

		// Both modify same key concurrently
		doc1.getMap('data').set('key', 'value1');
		doc2.getMap('data').set('key', 'value2');

		// Sync should resolve deterministically
		syncDocs(doc1, doc2);

		// Both should have same value (CRDT resolution)
		const val1 = doc1.getMap('data').get('key');
		const val2 = doc2.getMap('data').get('key');
		expect(val1).toBe(val2);
	});

	test('empty document produces a valid STEP1 frame', () => {
		const { syncType, payload } = readFrame(
			encodeSyncStep1({ doc: createDoc() }),
		);

		expect(syncType).toBe(SYNC_MESSAGE_TYPE.STEP1);
		// Even an empty doc has a state vector (carries clientID info).
		expect(payload).toBeInstanceOf(Uint8Array);
	});
});

// ============================================================================
// Test Utilities (hoisted - placed at bottom for readability)
// ============================================================================

/** Create a Y.Doc with optional initial content */
function createDoc(init?: (doc: Y.Doc) => void): Y.Doc {
	const doc = new Y.Doc();
	if (init) init(doc);
	return doc;
}

/**
 * Decode a binary sync frame into its sub-type and payload. Mirrors the
 * production transport decode (`Room.webSocketMessage` / `sync-supervisor`),
 * which asserts the sub-type varint as `SyncMessageType`.
 */
function readFrame(data: Uint8Array): {
	syncType: SyncMessageType;
	payload: Uint8Array;
} {
	const decoder = decoding.createDecoder(data);
	return {
		syncType: decoding.readVarUint(decoder) as SyncMessageType,
		payload: decoding.readVarUint8Array(decoder),
	};
}

/** Sync two documents bidirectionally (standard Yjs test pattern, V2) */
function syncDocs(doc1: Y.Doc, doc2: Y.Doc): void {
	const state1 = Y.encodeStateAsUpdateV2(doc1);
	const state2 = Y.encodeStateAsUpdateV2(doc2);
	Y.applyUpdateV2(doc1, state2);
	Y.applyUpdateV2(doc2, state1);
}
