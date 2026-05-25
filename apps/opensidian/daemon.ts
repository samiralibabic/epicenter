/**
 * Opensidian daemon library default.
 *
 * `openOpensidianDaemon(ctx)` composes the daemon-side mount that any
 * Opensidian-consuming project can use directly when they want library-default
 * paths.
 *
 * What this does:
 *   1. workspace root doc (encrypted tables + KV via attachEncryption)
 *   2. infrastructure: Yjs log persistence + cloud sync via
 *      `attachDaemonInfrastructure`
 *
 * Daemon-side `actions: {}` is intentional: Opensidian's file and shell
 * actions need browser services (Yjs filesystem, in-browser SQLite, just-bash)
 * and stay in the app runtime.
 */

import { attachEncryption } from '@epicenter/workspace';
import type { DaemonWorkspaceContext } from '@epicenter/workspace/daemon';
import { attachDaemonInfrastructure } from '@epicenter/workspace/node';
import * as Y from 'yjs';
import { OPENSIDIAN_ID, opensidianTables } from './workspace.js';

export function openOpensidianDaemon({
	projectDir,
	yDocClientId,
	deviceId,
	ownerId,
	keyring,
	openWebSocket,
	onReconnectSignal,
}: DaemonWorkspaceContext) {
	const ydoc = new Y.Doc({ guid: OPENSIDIAN_ID, gc: true });
	ydoc.clientID = yDocClientId;
	const encryption = attachEncryption(ydoc, { keyring });
	encryption.attachTables(opensidianTables);
	encryption.attachKv({});

	return attachDaemonInfrastructure(ydoc, {
		projectDir,
		ownerId,
		deviceId,
		openWebSocket,
		onReconnectSignal,
		actions: {},
	});
}

export type OpensidianDaemon = ReturnType<typeof openOpensidianDaemon>;
