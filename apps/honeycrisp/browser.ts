/**
 * Honeycrisp browser composition.
 *
 * Single source of truth for "how Honeycrisp mounts in a browser." Calls
 * Tier 1 primitives inline so every line is visible top-to-bottom:
 *
 *  1. workspace root doc (encrypted tables + KV via attachEncryption)
 *  2. local storage + cloud sync for root (attachLocalStorage + openCollaboration)
 *  3. per-note rich-text body sub-docs (plaintext Y.XmlFragment + encrypted IDB)
 *
 * `openCollaboration` owns reconnect-on-auth-change internally, so this file
 * has no per-app onStateChange listener.
 *
 * The bundle's `wipe()` drops every encrypted IDB database for this subject;
 * `Symbol.dispose` tears down the root + cached child Y.Docs without touching
 * local storage.
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
	createHoneycrispActions,
	HONEYCRISP_ID,
	honeycrispTables,
	type NoteId,
	noteBodyDocGuid,
} from './workspace';

export function openHoneycrispBrowser({
	signedIn,
	installationId,
}: {
	signedIn: SignedIn;
	installationId: string;
}) {
	const ydoc = new Y.Doc({ guid: HONEYCRISP_ID, gc: true });
	const encryption = attachEncryption(ydoc, { keyring: signedIn.keyring });
	const tables = encryption.attachTables(honeycrispTables);
	const kv = encryption.attachKv({});
	const actions = createHoneycrispActions(tables);

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

	const noteBodyDocs = createDisposableCache((noteId: NoteId) => {
		const childYdoc = new Y.Doc({
			guid: noteBodyDocGuid(noteId),
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
			tables.notes.update(noteId, {
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
		noteBodyDocs,
		collaboration,
		async wipe() {
			noteBodyDocs[Symbol.dispose]();
			ydoc.destroy();
			await Promise.all([idb.whenDisposed, collaboration.whenDisposed]);
			await wipeLocalStorage({
				server: signedIn.server,
				owner: signedIn.owner,
			});
		},
		[Symbol.dispose]() {
			noteBodyDocs[Symbol.dispose]();
			ydoc.destroy();
		},
	};
}

export type HoneycrispBrowser = ReturnType<typeof openHoneycrispBrowser>;
