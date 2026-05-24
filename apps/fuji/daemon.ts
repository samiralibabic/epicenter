/**
 * Fuji daemon library default.
 *
 * `openFujiDaemon(ctx)` composes the daemon-side mount that any
 * Fuji-consuming project can use directly when they want library-default
 * paths. The canonical `examples/fuji` project uses the project-layout spec
 * paths inline rather than calling this; see `examples/fuji/epicenter.config.ts`.
 *
 * What this does:
 *   1. workspace root doc (encrypted tables + KV via attachEncryption)
 *   2. SQLite materializer at `sqlitePath(projectDir, workspaceId)`
 *   3. Markdown materializer at `markdownPath(projectDir, workspaceId)`
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
import { createFujiActions, FUJI_ID, fujiTables } from './src/lib/workspace.js';

export function openFujiDaemon({
	projectDir,
	route,
	yDocClientId,
	installationId,
	owner,
	keyring,
	openWebSocket,
	onReconnectSignal,
}: DaemonWorkspaceContext) {
	const ydoc = new Y.Doc({ guid: FUJI_ID, gc: true });
	ydoc.clientID = yDocClientId;
	const encryption = attachEncryption(ydoc, { keyring });
	const tables = encryption.attachTables(fujiTables);
	encryption.attachKv({});
	const actions = createFujiActions(tables);

	const sqliteDb = openWriterSqlite({
		filePath: sqlitePath(projectDir, ydoc.guid),
		log: createLogger(`${route}-sqlite`),
	});
	ydoc.once('destroy', () => sqliteDb.close());

	attachSqliteMaterializer(ydoc, { db: sqliteDb }).table(tables.entries);
	attachMarkdownMaterializer(ydoc, {
		dir: markdownPath(projectDir, ydoc.guid),
	}).table(tables.entries, { filename: slugFilename('title') });

	return attachDaemonInfrastructure(ydoc, {
		projectDir,
		owner,
		installationId,
		openWebSocket,
		onReconnectSignal,
		actions,
	});
}

export type FujiDaemon = ReturnType<typeof openFujiDaemon>;
