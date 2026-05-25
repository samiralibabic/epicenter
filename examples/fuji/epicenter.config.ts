/**
 * Canonical Epicenter project: one workspace, defined inline.
 *
 * Layout (per specs/20260522T220000-workspace-project-layout.md):
 *   epicenter.config.ts       this file: marker + workspace definition
 *   entries/                  table data as markdown (committed)
 *   .epicenter/               runtime cache (gitignored)
 *     yjs.db                  Yjs persistence
 *     sqlite.db               SQL materializer
 *
 * Single-workspace shape: `defineWorkspace` default-exports the workspace
 * definition directly. The host derives the route name from the project
 * directory's basename (`fuji`).
 *
 * Composition is inline so the layout decisions are visible at the project
 * root. Other projects that want the library default paths can call
 * `openFujiDaemon(ctx)` from `@epicenter/fuji/daemon` instead of writing this
 * out by hand.
 */

import { join } from 'node:path';
import { createFujiActions, FUJI_ID, fujiTables } from '@epicenter/fuji';
import { attachEncryption, defineWorkspace } from '@epicenter/workspace';
import {
	attachMarkdownMaterializer,
	slugFilename,
} from '@epicenter/workspace/document/materializer/markdown';
import { attachBunSqliteMaterializer } from '@epicenter/workspace/document/materializer/sqlite';
import { attachDaemonInfrastructure } from '@epicenter/workspace/node';
import { createLogger } from 'wellcrafted/logger';
import * as Y from 'yjs';

export default defineWorkspace({
	open({
		projectDir,
		route,
		yDocClientId,
		deviceId,
		ownerId,
		keyring,
		openWebSocket,
		onReconnectSignal,
	}) {
		const ydoc = new Y.Doc({ guid: FUJI_ID, gc: true });
		ydoc.clientID = yDocClientId;
		const encryption = attachEncryption(ydoc, { keyring });
		const tables = encryption.attachTables(fujiTables);
		encryption.attachKv({});
		const actions = createFujiActions(tables);

		// Runtime cache: hidden under .epicenter/ at the project root.
		// Inlined so the canonical layout stays visible at the project root.
		attachBunSqliteMaterializer(ydoc, {
			filePath: join(projectDir, '.epicenter', 'sqlite.db'),
			log: createLogger(`${route}-sqlite`),
		}).table(tables.entries);

		// Markdown: visible at project root, one directory per table.
		// Committed to git as the source of truth. The materializer appends
		// the table name to `dir`, so `dir: projectDir` produces
		// `<projectDir>/entries/<slug>.md` for the `entries` table.
		attachMarkdownMaterializer(ydoc, {
			dir: projectDir,
		}).table(tables.entries, { filename: slugFilename('title') });

		return attachDaemonInfrastructure(ydoc, {
			projectDir,
			ownerId,
			deviceId,
			openWebSocket,
			onReconnectSignal,
			actions,
		});
	},
});
