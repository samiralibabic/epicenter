/**
 * Fuji browser runtime composition.
 *
 * Wraps `openFujiWorkspace(owner.attachEncryption)` with browser-only
 * attachments (encrypted IndexedDB, BroadcastChannel, root collaboration) and
 * a disposable cache of per-entry rich-text body sub-docs that each open their
 * own IDB/BroadcastChannel/sync. The action set comes from the shared
 * workspace opener so daemon-side and browser-side action surfaces stay
 * identical without a second factory call here.
 *
 * Cloud sync calls `openCollaboration` directly: each doc is owned by the
 * authenticated subject and addressed by its own `ydoc.guid`, so the URL is
 * `roomWsUrl(API, ydoc.guid)` with no client-side lookup. One
 * `auth.onStateChange` listener reconnects the root collaboration and every
 * live child sync across sign-in and sign-out transitions.
 *
 * The bundle's `wipe()` drops every encrypted IDB database for this owner;
 * `Symbol.dispose` tears down the root + cached child Y.Docs and detaches the
 * auth listener without touching local storage.
 */

import type { AuthClient } from '@epicenter/auth';
import { APP_URLS } from '@epicenter/constants/vite';
import {
	attachRichText,
	createDisposableCache,
	DateTimeString,
	type LocalOwner,
	onLocalUpdate,
	openCollaboration,
	roomWsUrl,
} from '@epicenter/workspace';
import * as Y from 'yjs';
import { type EntryId, openFujiWorkspace } from './workspace';

export function openFujiBrowser({
	owner,
	installationId,
	auth,
}: {
	owner: LocalOwner;
	installationId: string;
	auth: AuthClient;
}) {
	const workspace = openFujiWorkspace(owner.attachEncryption);
	const { ydoc: rootYdoc, tables, kv } = workspace;

	const idb = owner.attachLocal(rootYdoc);

	const entryContentDocs = createDisposableCache((entryId: EntryId) => {
		const childDocId = workspace.entryContentDocGuid(entryId);
		const ydoc = new Y.Doc({
			guid: childDocId,
			gc: true,
		});
		const body = attachRichText(ydoc);
		const childIdb = owner.attachLocal(ydoc);
		const childSync = openCollaboration(ydoc, {
			url: roomWsUrl(APP_URLS.API, ydoc.guid),
			openWebSocket: auth.openWebSocket,
			waitFor: childIdb.whenLoaded,
			installationId,
			actions: {},
		});

		onLocalUpdate(ydoc, () => {
			tables.entries.update(entryId, {
				updatedAt: DateTimeString.now(),
			});
		});

		return {
			ydoc,
			body,
			idb: childIdb,
			sync: childSync,
			/**
			 * child disposer rejections do not propagate; bundle.wipe() relies on
			 * IDB's deleteDatabase native blocking as belt-and-suspenders for
			 * storage deletion.
			 */
			[Symbol.dispose]() {
				ydoc.destroy();
			},
		};
	});

	const collaboration = openCollaboration(rootYdoc, {
		url: roomWsUrl(APP_URLS.API, rootYdoc.guid),
		openWebSocket: auth.openWebSocket,
		waitFor: idb.whenLoaded,
		installationId,
		actions: workspace.actions,
	});

	// Auth transitions: tell live sockets to retry.
	// Sign-in: a previously-rejected socket reconnects with the new token.
	// Sign-out: the server closes the existing socket on its own (4401);
	//   reconnect() ensures the supervisor doesn't sit in 'failed' if the
	//   user signs back in.
	const unsubscribeAuth = auth.onStateChange(() => {
		collaboration.reconnect();
		for (const child of entryContentDocs.values()) {
			child.sync.reconnect();
		}
	});

	return {
		ydoc: rootYdoc,
		tables,
		kv,
		batch: workspace.batch,
		idb,
		entryContentDocs,
		collaboration,
		async wipe() {
			const fallbackGuids = [
				rootYdoc.guid,
				...tables.entries
					.getAllValid()
					.map((entry) => workspace.entryContentDocGuid(entry.id)),
			];
			entryContentDocs[Symbol.dispose]();
			rootYdoc.destroy();
			await Promise.all([idb.whenDisposed, collaboration.whenDisposed]);
			await owner.wipeLocalYjsData(fallbackGuids);
		},
		[Symbol.dispose]() {
			unsubscribeAuth();
			entryContentDocs[Symbol.dispose]();
			rootYdoc.destroy();
		},
	};
}

export type FujiBrowser = ReturnType<typeof openFujiBrowser>;
