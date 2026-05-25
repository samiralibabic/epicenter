/**
 * `attachBunSqliteMaterializer(ydoc, { filePath })`: bun:sqlite-backed
 * materializer. Owns the database file end-to-end: opens it (with the
 * writer-side WAL pragmas), mirrors Y.Doc table rows into it, and closes
 * the handle when the ydoc is destroyed.
 *
 * Daemon-side. For browser/in-memory use, see `attachTursoMaterializer`
 * in the sibling `./turso.ts`.
 *
 * @example
 * ```ts
 * const materializer = attachBunSqliteMaterializer(ydoc, {
 *   filePath: sqlitePath(projectDir, ydoc.guid),
 *   waitFor: idb.whenLoaded,
 * }).table(tables.entries, { fts: ['title', 'body'] });
 *
 * // Daemon-local typed reads:
 * const schema = tablesToDrizzleSchema(definitions);
 * const db = drizzle(materializer.client, { schema });
 * const rows = await db.select().from(schema.entries);
 * ```
 *
 * @module
 */

import type { Database } from 'bun:sqlite';
import { createLogger, type Logger } from 'wellcrafted/logger';
import type * as Y from 'yjs';
import type { BaseRow, Table } from '../../attach-table.js';
import { openWriterSqlite } from '../../sqlite-writer.js';
import { attachSqliteMaterializerCore, type TableConfig } from './core.js';

/**
 * Options for {@link attachBunSqliteMaterializer}.
 */
export type AttachBunSqliteMaterializerOptions = {
	/**
	 * Absolute path to the bun:sqlite mirror file, or `':memory:'` for an
	 * ephemeral in-memory mirror. The parent directory is created on demand
	 * (no-op for `:memory:`).
	 */
	filePath: ':memory:' | (string & {});

	/**
	 * Debounce window for the materializer's incremental row flush. Defaults
	 * to 100 ms. Set to 0 in tests where each `set()` should flush on the
	 * next microtask.
	 */
	debounceMs?: number;

	/**
	 * Gate: the materializer awaits this before the initial DDL + full-load.
	 * Matches the `waitFor` convention used by `openCollaboration`. Omit for
	 * no gate.
	 */
	waitFor?: Promise<unknown>;

	/**
	 * Logger for background failures (debounced sync flush, FTS query, WAL
	 * pragma fallbacks). Defaults to a console-backed logger with source
	 * `attachBunSqliteMaterializer`.
	 */
	log?: Logger;
};

/**
 * Builder returned by {@link attachBunSqliteMaterializer}. Mirrors the core
 * builder shape but threads `.client` through the chained `.table()` calls,
 * so consumers can write
 * `attachBunSqliteMaterializer(...).table(...).client` without losing the
 * augmentation through the chain.
 */
export type AttachBunSqliteMaterializerBuilder = Omit<
	ReturnType<typeof attachSqliteMaterializerCore>,
	'table'
> & {
	table<TRow extends BaseRow>(
		table: Table<TRow>,
		config?: TableConfig<TRow>,
	): AttachBunSqliteMaterializerBuilder;
	/**
	 * The underlying bun:sqlite Database handle. Use it directly or wrap in
	 * Drizzle (`drizzle(materializer.client, { schema })`) for typed reads.
	 */
	client: Database;
};

/**
 * Attach a bun:sqlite-backed materializer to a Y.Doc. The materializer
 * opens the file at `filePath`, applies the writer-side WAL pragmas, and
 * closes the handle on `ydoc.destroy()`.
 *
 * The returned builder exposes the underlying `Database` as `.client`, so
 * callers can wrap it in Drizzle (`drizzle(materializer.client, { schema })`)
 * for typed reads against the same file.
 */
export function attachBunSqliteMaterializer(
	ydoc: Y.Doc,
	{
		filePath,
		debounceMs,
		waitFor,
		log = createLogger('attachBunSqliteMaterializer'),
	}: AttachBunSqliteMaterializerOptions,
): AttachBunSqliteMaterializerBuilder {
	const client = openWriterSqlite({ filePath, log });

	const coreBuilder = attachSqliteMaterializerCore(ydoc, {
		db: client,
		debounceMs,
		waitFor,
		log,
	});

	// Registered AFTER core's own destroy listener so dispose() runs first
	// (cancels timers, detaches observers) before the database handle closes.
	// `close()` can throw if the handle is already shut by a duplicate destroy;
	// swallow and log rather than letting it escape the destroy listener.
	ydoc.once('destroy', () => {
		try {
			client.close();
		} catch (cause) {
			log.warn(
				new Error('attachBunSqliteMaterializer: client.close failed', {
					cause,
				}),
			);
		}
	});

	const augmented: AttachBunSqliteMaterializerBuilder = {
		...coreBuilder,
		// Re-bind .table so chained calls keep returning the augmented builder
		// (with .client), not the bare core builder.
		table(table, config) {
			coreBuilder.table(table, config);
			return augmented;
		},
		client,
	};
	return augmented;
}
