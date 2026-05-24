import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { onLocalUpdate } from './on-local-update.js';

describe('onLocalUpdate', () => {
	test('fires for local edits (null origin)', () => {
		const ydoc = new Y.Doc({ guid: 'a' });
		let calls = 0;
		onLocalUpdate(ydoc, () => calls++);
		ydoc.getText('content').insert(0, 'hi');
		expect(calls).toBe(1);
		ydoc.destroy();
	});

	test('skips applyUpdate with symbol origin (transport)', () => {
		const ydoc = new Y.Doc({ guid: 'a' });
		let calls = 0;
		onLocalUpdate(ydoc, () => calls++);

		const FAKE_TRANSPORT = Symbol('fake-transport');
		const remote = new Y.Doc({ guid: 'remote' });
		remote.getText('content').insert(0, 'synced');
		const update = Y.encodeStateAsUpdate(remote);
		Y.applyUpdate(ydoc, update, FAKE_TRANSPORT);

		expect(calls).toBe(0);
		remote.destroy();
		ydoc.destroy();
	});

	test('skips applyUpdate with no origin (IndexedDB-style replay)', () => {
		// tx.local is false for any applyUpdate regardless of origin shape, so
		// IDB hydration (which uses an instance origin, not a symbol) is
		// correctly filtered.
		const ydoc = new Y.Doc({ guid: 'a' });
		let calls = 0;
		onLocalUpdate(ydoc, () => calls++);

		const remote = new Y.Doc({ guid: 'remote' });
		remote.getText('content').insert(0, 'replay');
		const update = Y.encodeStateAsUpdate(remote);
		Y.applyUpdate(ydoc, update);

		expect(calls).toBe(0);
		remote.destroy();
		ydoc.destroy();
	});

	test('skips applyUpdate with instance origin (IndexedDB provider shape)', () => {
		const ydoc = new Y.Doc({ guid: 'a' });
		let calls = 0;
		onLocalUpdate(ydoc, () => calls++);

		const remote = new Y.Doc({ guid: 'remote' });
		remote.getText('content').insert(0, 'replay');
		const update = Y.encodeStateAsUpdate(remote);
		// y-indexeddb passes its persistence instance as origin, not a symbol.
		const fakeProvider = { kind: 'indexeddb' };
		Y.applyUpdate(ydoc, update, fakeProvider);

		expect(calls).toBe(0);
		remote.destroy();
		ydoc.destroy();
	});

	test('throwing callback is isolated and does not crash caller', () => {
		const ydoc = new Y.Doc({ guid: 'a' });
		const prevError = console.error;
		console.error = () => {};
		try {
			onLocalUpdate(ydoc, () => {
				throw new Error('listener boom');
			});
			expect(() => {
				ydoc.getText('content').insert(0, 'x');
			}).not.toThrow();
		} finally {
			console.error = prevError;
		}
		ydoc.destroy();
	});

	test('unsubscribe stops future callbacks', () => {
		const ydoc = new Y.Doc({ guid: 'a' });
		let calls = 0;
		const off = onLocalUpdate(ydoc, () => calls++);
		ydoc.getText('t').insert(0, 'a');
		off();
		ydoc.getText('t').insert(0, 'b');
		expect(calls).toBe(1);
		ydoc.destroy();
	});
});
