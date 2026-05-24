/// <reference lib="dom" />

/**
 * `wipeLocalStorage`: delete every `(server, owner)`-scoped IndexedDB
 * database on the current browser profile.
 *
 * Enumerates `indexedDB.databases()` and clears every entry whose name
 * starts with the durable prefix produced by {@link getOwnedYjsPrefix} for
 * the given `(server, owner)` pair. This is a free function with no auth
 * coupling: the caller (sign-out handler, "delete my local data" button,
 * admin migration) passes the pair explicitly.
 *
 * Belt-and-suspenders with an explicit guid list is unnecessary: every
 * encrypted IDB database is created under the owner prefix, and the prefix
 * scan catches all of them.
 *
 * No-ops gracefully when `indexedDB.databases()` is unavailable (older
 * browsers): nothing to enumerate means nothing to delete here.
 *
 * @module
 */

import type { Owner } from '@epicenter/auth';
import { clearDocument } from 'y-indexeddb';
import { getOwnedYjsPrefix } from './local-yjs-key.js';

/**
 * Delete every encrypted IndexedDB database owned by `(server, owner)` on
 * this browser profile.
 *
 * @example
 * ```ts
 * await wipeLocalStorage({ server: signedIn.server, owner: signedIn.owner });
 * ```
 */
export async function wipeLocalStorage({
	server,
	owner,
}: {
	server: string;
	owner: Owner;
}): Promise<void> {
	const prefix = getOwnedYjsPrefix(server, owner);
	if (!('databases' in indexedDB)) return;
	const databases = await indexedDB.databases().catch(() => []);
	const names = databases
		.map((db) => db.name)
		.filter(
			(name): name is string =>
				typeof name === 'string' && name.startsWith(prefix),
		);
	await Promise.all(names.map((name) => clearDocument(name)));
}
