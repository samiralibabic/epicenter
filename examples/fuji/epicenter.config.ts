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
 * The default export is a single `defineWorkspace({...})` call. The loader
 * wraps it as `{ daemon: { routes: { <basename>: ... } } }` internally,
 * deriving the route name from this project directory's name. For the
 * `examples/fuji` directory the route name is `fuji`, so CLI commands
 * address it as `fuji.<action>` exactly as they did under the previous
 * `defineConfig({ daemon: { routes: { fuji } } })` shape.
 */

import { join } from 'node:path';
import { openFujiWorkspace } from '@epicenter/fuji';
import { defineWorkspace } from '@epicenter/workspace';
import {
	attachMarkdownMaterializer,
	slugFilename,
} from '@epicenter/workspace/document/materializer/markdown';
import { attachSqliteMaterializer } from '@epicenter/workspace/document/materializer/sqlite';
import {
	attachDaemonInfrastructure,
	openWriterSqlite,
} from '@epicenter/workspace/node';
import { createLogger } from 'wellcrafted/logger';

export default defineWorkspace({
	async open({
		projectDir,
		route,
		clientId,
		installationId,
		attachEncryption,
		openWebSocket,
	}) {
		const workspace = openFujiWorkspace(attachEncryption, { clientId });

		const infra = attachDaemonInfrastructure(workspace.ydoc, {
			projectDir,
			openWebSocket,
			installationId,
			actions: workspace.actions,
		});

		// Runtime cache: hidden under .epicenter/ at the project root.
		// The spec's future helper is `sqlitePath(projectDir)`; we inline the
		// path here so the example runs against today's package surface.
		const sqliteDb = openWriterSqlite({
			filePath: join(projectDir, '.epicenter', 'sqlite.db'),
			log: createLogger(`${route}-sqlite`),
		});
		workspace.ydoc.once('destroy', () => sqliteDb.close());

		attachSqliteMaterializer(workspace.ydoc, { db: sqliteDb }).table(
			workspace.tables.entries,
		);

		// Markdown: visible at project root, one directory per table.
		// Committed to git as the source of truth. The materializer appends
		// the table name to `dir`, so `dir: projectDir` produces
		// `<projectDir>/entries/<slug>.md` for the `entries` table.
		attachMarkdownMaterializer(workspace.ydoc, {
			dir: projectDir,
		}).table(workspace.tables.entries, { filename: slugFilename('title') });

		return infra;
	},
});
