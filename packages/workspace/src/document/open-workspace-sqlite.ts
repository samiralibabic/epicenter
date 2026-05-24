/**
 * Convenience reader for the daemon's SQLite materializer.
 *
 * The daemon's `attachSqliteMaterializer` writes a queryable mirror at
 * `sqlitePath(projectDir, workspaceId)`. Scripts open that same file
 * read-only to issue plain SQL, bypassing the Y.Doc replay cost.
 *
 * For ranked FTS5 search plus snippet helpers, use `openSqliteReader`
 * instead; this function intentionally returns a bare `bun:sqlite`
 * `Database` so callers can `db.query(...).all(...)` (or wrap it with
 * Drizzle) without extra ceremony.
 */

import { Database } from 'bun:sqlite';
import type { ProjectDir } from '../shared/types.js';
import { sqlitePath } from './workspace-paths.js';

/**
 * Open the daemon's SQLite mirror for a workspace read-only.
 *
 * The returned handle has `journal_mode = WAL` so it shares snapshots with
 * the daemon writer and `query_only = 1` so any accidental write fails at
 * the driver. The caller closes the database with `db.close()` when done.
 *
 * Throws if no file exists at `sqlitePath(projectDir, workspaceId)`. That
 * usually means the daemon has not yet written its first materializer
 * snapshot for this workspace.
 *
 * @example
 * ```ts
 * import { findProjectRoot, openWorkspaceSqlite } from '@epicenter/workspace/node';
 * import { FUJI_ID } from '@epicenter/fuji';
 *
 * const db = openWorkspaceSqlite(findProjectRoot(), FUJI_ID);
 * const urgent = db.query('SELECT * FROM entries WHERE tag = ?').all('urgent');
 * db.close();
 * ```
 */
export function openWorkspaceSqlite(
	projectDir: ProjectDir,
	workspaceId: string,
): Database {
	const db = new Database(sqlitePath(projectDir, workspaceId), {
		readonly: true,
	});
	db.exec('PRAGMA journal_mode = WAL');
	db.exec('PRAGMA query_only = 1');
	return db;
}
