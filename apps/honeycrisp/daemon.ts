/**
 * Honeycrisp daemon library default.
 *
 * `openHoneycrispDaemon(ctx)` composes the daemon-side mount that any
 * Honeycrisp-consuming project can use directly when they want library-default
 * paths.
 *
 * What this does:
 *   1. workspace root doc (encrypted tables + KV via attachEncryption)
 *   2. SQLite materializer at `sqlitePath(projectDir, workspaceId)` for
 *      folders + notes
 *   3. Markdown materializer at `markdownPath(projectDir, workspaceId)` for
 *      notes
 *   4. infrastructure: Yjs log persistence + cloud sync via
 *      `attachDaemonInfrastructure`
 */

import { attachEncryption } from '@epicenter/workspace';
import type { DaemonWorkspaceContext } from '@epicenter/workspace/daemon';
import {
	attachMarkdownMaterializer,
	slugFilename,
} from '@epicenter/workspace/document/materializer/markdown';
import { attachSqliteMaterializer } from '@epicenter/workspace/document/materializer/sqlite';
import {
	attachDaemonInfrastructure,
	markdownPath,
	openWriterSqlite,
	sqlitePath,
} from '@epicenter/workspace/node';
import { createLogger } from 'wellcrafted/logger';
import * as Y from 'yjs';
import {
	createHoneycrispActions,
	HONEYCRISP_ID,
	honeycrispTables,
} from './workspace.js';

export function openHoneycrispDaemon({
	projectDir,
	route,
	yDocClientId,
	installationId,
	owner,
	keyring,
	openWebSocket,
	onReconnectSignal,
}: DaemonWorkspaceContext) {
	const ydoc = new Y.Doc({ guid: HONEYCRISP_ID, gc: true });
	ydoc.clientID = yDocClientId;
	const encryption = attachEncryption(ydoc, { keyring });
	const tables = encryption.attachTables(honeycrispTables);
	encryption.attachKv({});
	const actions = createHoneycrispActions(tables);

	const sqliteDb = openWriterSqlite({
		filePath: sqlitePath(projectDir, ydoc.guid),
		log: createLogger(`${route}-sqlite`),
	});
	ydoc.once('destroy', () => sqliteDb.close());

	const sqlite = attachSqliteMaterializer(ydoc, { db: sqliteDb });
	sqlite.table(tables.folders);
	sqlite.table(tables.notes);

	attachMarkdownMaterializer(ydoc, {
		dir: markdownPath(projectDir, ydoc.guid),
	}).table(tables.notes, { filename: slugFilename('title') });

	return attachDaemonInfrastructure(ydoc, {
		projectDir,
		owner,
		installationId,
		openWebSocket,
		onReconnectSignal,
		actions,
	});
}

export type HoneycrispDaemon = ReturnType<typeof openHoneycrispDaemon>;
