/// <reference lib="dom" />

import { clearDocument, IndexeddbPersistence } from 'y-indexeddb';
import type * as Y from 'yjs';

export type IndexedDbAttachment = {
	/**
	 * Resolves when local IndexedDB state has loaded into the Y.Doc: "your
	 * draft is in memory, edits are safe." Not CRDT convergence despite
	 * `y-indexeddb`'s upstream `whenSynced` name. Pair with `sync.whenConnected`
	 * when you also need remote state.
	 */
	whenLoaded: Promise<unknown>;
	clearLocal: () => Promise<void>;
	/**
	 * Resolves after `ydoc.destroy()` fires the cascade and the IndexedDB
	 * connection has actually closed. Bundle wipe methods await this before
	 * deleting persisted data.
	 */
	whenDisposed: Promise<unknown>;
};

export function attachIndexedDb(ydoc: Y.Doc): IndexedDbAttachment {
	const databaseName = ydoc.guid;
	const idb = new IndexeddbPersistence(databaseName, ydoc);
	// `IndexeddbPersistence`'s constructor binds `doc.on('destroy', this.destroy)`
	// eagerly, and its `destroy()` has no top-level idempotency guard: two calls
	// produce two independent `_db.then(db => db.close())` promises that resolve
	// at different moments. Strip the upstream binding so our wrapper is the
	// sole gateway. Cascade-triggered teardown resolves `whenDisposed` only
	// after the actual close completes, so wipe() can await an honest barrier.
	ydoc.off('destroy', idb.destroy);
	const { promise: whenDisposed, resolve: resolveDisposed } =
		Promise.withResolvers<void>();
	ydoc.once('destroy', async () => {
		try {
			await idb.destroy();
		} finally {
			resolveDisposed();
		}
	});
	return {
		whenLoaded: idb.whenSynced,
		clearLocal: () => clearDocument(databaseName),
		whenDisposed,
	};
}
