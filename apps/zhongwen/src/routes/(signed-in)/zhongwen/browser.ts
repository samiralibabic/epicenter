/**
 * Zhongwen browser composition.
 *
 * Single source of truth for "how Zhongwen mounts in a browser." Calls Tier 1
 * primitives inline so every line is visible top-to-bottom:
 *
 *  1. workspace root doc (encrypted tables + KV via attachEncryption)
 *  2. local storage + cloud sync for root (attachLocalStorage + openCollaboration)
 *
 * Zhongwen has no child docs and no daemon actions; the root doc is the
 * entire workspace surface. `openCollaboration` owns reconnect-on-auth-change
 * internally, so this file has no per-app onStateChange listener. The
 * bundle's `wipe()` drops every encrypted IDB database for this subject;
 * `Symbol.dispose` tears down the root Y.Doc without touching local storage.
 */

import type { SignedIn } from '@epicenter/svelte';
import {
	attachEncryption,
	attachLocalStorage,
	openCollaboration,
	roomWsUrl,
	wipeLocalStorage,
} from '@epicenter/workspace';
import { ZHONGWEN_ID, zhongwenKv, zhongwenTables } from '@epicenter/zhongwen';
import * as Y from 'yjs';

export function openZhongwenBrowser({
	signedIn,
	installationId,
}: {
	signedIn: SignedIn;
	installationId: string;
}) {
	const ydoc = new Y.Doc({ guid: ZHONGWEN_ID, gc: true });
	const encryption = attachEncryption(ydoc, { keyring: signedIn.keyring });
	const tables = encryption.attachTables(zhongwenTables);
	const kv = encryption.attachKv(zhongwenKv);

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
		actions: {},
	});

	return {
		ydoc,
		tables,
		kv,
		idb,
		collaboration,
		async wipe() {
			ydoc.destroy();
			await Promise.all([idb.whenDisposed, collaboration.whenDisposed]);
			await wipeLocalStorage({
				server: signedIn.server,
				owner: signedIn.owner,
			});
		},
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
}

export type ZhongwenBrowser = ReturnType<typeof openZhongwenBrowser>;
