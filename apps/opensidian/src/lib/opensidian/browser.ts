import type { AuthClient } from '@epicenter/auth';
import { APP_URLS } from '@epicenter/constants/vite';
import {
	attachYjsFileSystem,
	createSqliteIndex,
	type FileId,
	fileContentDocGuid,
} from '@epicenter/filesystem';
import {
	attachTimeline,
	createDisposableCache,
	type LocalOwner,
	onLocalUpdate,
	openCollaboration,
	roomWsUrl,
} from '@epicenter/workspace';
import { Bash } from 'just-bash';
import { openOpensidianWorkspace } from 'opensidian';
import * as Y from 'yjs';
import { createOpensidianActions } from './actions';

export function openOpensidianBrowser({
	owner,
	installationId,
	auth,
}: {
	owner: LocalOwner;
	installationId: string;
	auth: AuthClient;
}) {
	const workspace = openOpensidianWorkspace(owner.attachEncryption);
	const { ydoc: rootYdoc, tables, kv } = workspace;

	const idb = owner.attachLocal(rootYdoc);

	const fileContentDocs = createDisposableCache((fileId: FileId) => {
		const childDocId = fileContentDocGuid({
			workspaceId: rootYdoc.guid,
			fileId,
		});
		const ydoc = new Y.Doc({
			guid: childDocId,
			gc: true,
		});
		onLocalUpdate(ydoc, () =>
			tables.files.update(fileId, { updatedAt: Date.now() }),
		);
		const childIdb = owner.attachLocal(ydoc);
		// File bodies sync through Cloud so device loss doesn't drop the
		// largest data class.
		const childSync = openCollaboration(ydoc, {
			url: roomWsUrl(APP_URLS.API, ydoc.guid),
			openWebSocket: auth.openWebSocket,
			waitFor: childIdb.whenLoaded,
			installationId,
			actions: {},
		});
		return {
			ydoc,
			content: attachTimeline(ydoc),
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
	const fileContent = {
		async read(fileId: FileId) {
			await using handle = fileContentDocs.open(fileId);
			await handle.idb.whenLoaded;
			return handle.content.read();
		},
		async write(fileId: FileId, text: string) {
			await using handle = fileContentDocs.open(fileId);
			await handle.idb.whenLoaded;
			handle.content.write(text);
		},
		async append(fileId: FileId, text: string) {
			await using handle = fileContentDocs.open(fileId);
			await handle.idb.whenLoaded;
			handle.content.appendText(text);
			return handle.content.read();
		},
	};
	const sqliteIndex = createSqliteIndex({
		readContent: fileContent.read,
	})({
		tables,
	});
	const sqliteIndexExports = sqliteIndex.exports;
	const fs = attachYjsFileSystem(rootYdoc, tables.files, fileContent);
	const bash = new Bash({ fs, cwd: '/' });
	const actions = createOpensidianActions({
		fs,
		sqliteIndex: sqliteIndexExports,
		bash,
	});

	const collaboration = openCollaboration(rootYdoc, {
		url: roomWsUrl(APP_URLS.API, rootYdoc.guid),
		openWebSocket: auth.openWebSocket,
		waitFor: idb.whenLoaded,
		installationId,
		actions,
	});

	// Auth transitions: tell live sockets to retry.
	// Sign-in: a previously-rejected socket reconnects with the new token.
	// Sign-out: the server closes the existing socket on its own (4401);
	//   reconnect() ensures the supervisor doesn't sit in 'failed' if the
	//   user signs back in.
	const unsubscribeAuth = auth.onStateChange(() => {
		collaboration.reconnect();
		for (const child of fileContentDocs.values()) {
			child.sync.reconnect();
		}
	});

	let docsTornDown = false;

	function teardownDocs() {
		if (docsTornDown) return;
		docsTornDown = true;
		fileContentDocs[Symbol.dispose]();
		sqliteIndex[Symbol.dispose]();
		rootYdoc.destroy();
	}

	return {
		ydoc: rootYdoc,
		tables,
		kv,
		batch: workspace.batch,
		idb,
		fileContentDocs,
		sqliteIndex: sqliteIndexExports,
		fs,
		bash,
		collaboration,
		async wipe() {
			const fallbackGuids = [
				rootYdoc.guid,
				...tables.files.getAllValid().map((file) =>
					fileContentDocGuid({
						workspaceId: rootYdoc.guid,
						fileId: file.id,
					}),
				),
			];
			teardownDocs();
			await Promise.all([idb.whenDisposed, collaboration.whenDisposed]);
			await owner.wipeLocalYjsData(fallbackGuids);
		},
		[Symbol.dispose]() {
			unsubscribeAuth();
			teardownDocs();
		},
	};
}

export type OpensidianBrowser = ReturnType<typeof openOpensidianBrowser>;
