/**
 * Fuji browser composition.
 *
 * Single source of truth for "how Fuji mounts in a browser." Calls Tier 1
 * primitives inline so every line is visible top-to-bottom:
 *
 *  1. workspace root doc (encrypted tables + KV via attachEncryption)
 *  2. local storage + cloud sync for root (attachLocalStorage + openCollaboration)
 *  3. per-entry child docs (plaintext Y.XmlFragment + encrypted IDB storage)
 *
 * `openCollaboration` owns reconnect-on-auth-change internally, so this file
 * has no per-app onStateChange listener.
 *
 * The bundle's `wipe()` drops every encrypted IDB database for this subject;
 * `Symbol.dispose` tears down the root + cached child Y.Docs without
 * touching local storage.
 */

import type { SignedIn } from '@epicenter/svelte';
import {
	attachEncryption,
	attachLocalStorage,
	attachRichText,
	createDisposableCache,
	DateTimeString,
	onLocalUpdate,
	openCollaboration,
	roomWsUrl,
	wipeLocalStorage,
} from '@epicenter/workspace';
import * as Y from 'yjs';
import {
	createFujiActions,
	type EntryId,
	entryContentDocGuid,
	FUJI_ID,
	fujiTables,
} from './workspace';

export function openFujiBrowser({
	signedIn,
	installationId,
}: {
	signedIn: SignedIn;
	installationId: string;
}) {
	const ydoc = new Y.Doc({ guid: FUJI_ID, gc: true });
	const encryption = attachEncryption(ydoc, { keyring: signedIn.keyring });
	const tables = encryption.attachTables(fujiTables);
	const kv = encryption.attachKv({});
	const actions = createFujiActions(tables);

	const idb = attachLocalStorage(ydoc, {
		server: signedIn.server,
		owner: signedIn.owner,
		keyring: signedIn.keyring,
	});
	const collaboration = openCollaboration(ydoc, {
		url: roomWsUrl({
			baseURL: signedIn.auth.baseURL,
			owner: signedIn.owner,
			guid: ydoc.guid,
			installationId,
		}),
		openWebSocket: signedIn.auth.openWebSocket,
		onReconnectSignal: signedIn.auth.onStateChange,
		waitFor: idb.whenLoaded,
		actions,
	});

	const entryContentDocs = createDisposableCache((entryId: EntryId) => {
		const childYdoc = new Y.Doc({
			guid: entryContentDocGuid(entryId),
			gc: true,
		});
		const body = attachRichText(childYdoc);
		const childIdb = attachLocalStorage(childYdoc, {
			server: signedIn.server,
			owner: signedIn.owner,
			keyring: signedIn.keyring,
		});
		const childSync = openCollaboration(childYdoc, {
			url: roomWsUrl({
				baseURL: signedIn.auth.baseURL,
				owner: signedIn.owner,
				guid: childYdoc.guid,
				installationId,
			}),
			openWebSocket: signedIn.auth.openWebSocket,
			onReconnectSignal: signedIn.auth.onStateChange,
			waitFor: childIdb.whenLoaded,
			actions: {},
		});

		onLocalUpdate(childYdoc, () => {
			tables.entries.update(entryId, {
				updatedAt: DateTimeString.now(),
			});
		});

		return {
			ydoc: childYdoc,
			body,
			idb: childIdb,
			sync: childSync,
			/**
			 * Child disposer rejections do not propagate; bundle.wipe() relies on
			 * IDB's deleteDatabase native blocking as belt-and-suspenders for
			 * storage deletion.
			 */
			[Symbol.dispose]() {
				childYdoc.destroy();
			},
		};
	});

	return {
		ydoc,
		tables,
		kv,
		actions,
		idb,
		entryContentDocs,
		collaboration,
		async wipe() {
			entryContentDocs[Symbol.dispose]();
			ydoc.destroy();
			await Promise.all([idb.whenDisposed, collaboration.whenDisposed]);
			await wipeLocalStorage({
				server: signedIn.server,
				owner: signedIn.owner,
			});
		},
		[Symbol.dispose]() {
			entryContentDocs[Symbol.dispose]();
			ydoc.destroy();
		},
	};
}

export type FujiBrowser = ReturnType<typeof openFujiBrowser>;
