/**
 * SQLite Materializer Tests
 *
 * Tests the full attachSqliteMaterializerCore lifecycle: DDL generation, full load,
 * incremental sync, FTS5 search, rebuild, and dispose. Uses real Yjs documents
 * with defineTable schemas so the materializer exercises the actual workspace
 * observation path.
 *
 * Key behaviors:
 * - Materializer waits for `whenReady` before touching SQLite
 * - Full load inserts all valid rows on initialization
 * - Observer-based sync upserts changed rows and deletes removed rows
 * - FTS5 search returns ranked results with snippets
 * - rebuild() drops and recreates all materialized data
 * - dispose() stops observers and clears timeouts
 */

import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import {
	attachTables,
	createDisposableCache,
	defineTable,
} from '../../../index.js';
import { isAction, isMutation, isQuery } from '../../../shared/actions.js';
import { column } from '../../column/index.js';
import { attachSqliteMaterializerCore, type MirrorDatabase } from './core.js';

const postsTable = defineTable({
	id: column.string(),
	title: column.string(),
	published: column.nullable(column.boolean()),
});

const notesTable = defineTable({
	id: column.string(),
	body: column.string(),
});

const tableDefinitions = { posts: postsTable, notes: notesTable };

const hasFts5 = canUseFts5();

type TestDb = MirrorDatabase & {
	raw: Database;
	sqlCalls: string[];
	close(): void;
};

function createTestDb(): TestDb {
	const raw = new Database(':memory:');
	const sqlCalls: string[] = [];

	return {
		raw,
		sqlCalls,
		close() {
			raw.close();
		},
		run(sql: string) {
			sqlCalls.push(sql);
			return raw.run(sql);
		},
		prepare(sql: string) {
			sqlCalls.push(sql);
			return raw.prepare(sql);
		},
	};
}

type AttachedTables = ReturnType<typeof attachTables<typeof tableDefinitions>>;
type Materializer = ReturnType<typeof attachSqliteMaterializerCore>;
type TableRegistration = {
	table: Parameters<Materializer['table']>[0];
	config?: Parameters<Materializer['table']>[1];
};

type SetupOptions = {
	tables?: (t: AttachedTables) => TableRegistration[];
	debounceMs?: number;
};

function setup({ tables: tableRegistrations, debounceMs }: SetupOptions = {}) {
	const db = createTestDb();

	const cache = createDisposableCache(
		(id: string) => {
			const ydoc = new Y.Doc({ guid: id });
			const tables = attachTables(ydoc, tableDefinitions);

			const materializer = attachSqliteMaterializerCore(ydoc, {
				db,
				debounceMs,
			});

			const registrations =
				tableRegistrations?.(tables) ??
				([
					{ table: tables.posts },
					{ table: tables.notes },
				] as TableRegistration[]);
			for (const { table, config } of registrations) {
				materializer.table(table, config);
			}

			return {
				ydoc,
				tables,
				sqlite: materializer,
				[Symbol.dispose]() {
					ydoc.destroy();
				},
			};
		},
		{ gcTime: 0 },
	);

	const workspace = cache.open('test');
	return { db, workspace, cache };
}

function createDeferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((promiseResolve) => {
		resolve = promiseResolve;
	});

	return { promise, resolve };
}

function canUseFts5() {
	const raw = new Database(':memory:');

	try {
		raw.run('CREATE VIRTUAL TABLE test_fts USING fts5(title)');
		return true;
	} catch {
		return false;
	} finally {
		raw.close();
	}
}

async function waitForSyncCycle() {
	await new Promise((resolve) => setTimeout(resolve, 200));
}

function getRows(db: TestDb, tableName: string) {
	return db.raw
		.prepare(`SELECT * FROM "${tableName}" ORDER BY "id"`)
		.all() as Record<string, unknown>[];
}

function hasTable(db: TestDb, tableName: string) {
	const row = db.raw
		.prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?')
		.get('table', tableName);
	return row != null;
}

async function cleanup(setupResult: ReturnType<typeof setup>) {
	setupResult.workspace[Symbol.dispose]();
	setupResult.db.close();
}

// ============================================================================
// READINESS Tests
// ============================================================================

describe('attachSqliteMaterializerCore', () => {
	describe('readiness', () => {
		test('waits for whenReady before touching SQLite', async () => {
			const db = createTestDb();
			const gate = createDeferred();

			const cache = createDisposableCache(
				(id: string) => {
					const ydoc = new Y.Doc({ guid: id });
					const tables = attachTables(ydoc, tableDefinitions);

					const materializer = attachSqliteMaterializerCore(ydoc, {
						db,
						waitFor: gate.promise,
					})
						.table(tables.posts)
						.table(tables.notes);

					return {
						ydoc,
						tables,
						sqlite: materializer,
						[Symbol.dispose]() {
							ydoc.destroy();
						},
					};
				},
				{ gcTime: 0 },
			);

			const workspace = cache.open('ready-gated');

			try {
				await new Promise((resolve) => setTimeout(resolve, 25));
				expect(db.sqlCalls).toHaveLength(0);

				gate.resolve();
				await workspace.sqlite.whenFlushed;

				expect(db.sqlCalls.length).toBeGreaterThan(0);
				expect(hasTable(db, 'posts')).toBe(true);
			} finally {
				gate.resolve();
				workspace[Symbol.dispose]();
				db.close();
			}
		});
	});

	// ============================================================================
	// FULL LOAD Tests
	// ============================================================================

	describe('full load', () => {
		test('mirrors existing rows on initialization', async () => {
			const testSetup = setup();

			try {
				testSetup.workspace.tables.posts.set({
					id: 'post-1',
					title: 'Hello mirror',
					published: null,
				});
				testSetup.workspace.tables.posts.set({
					id: 'post-2',
					title: 'Second row',
					published: true,
				});

				await testSetup.workspace.sqlite.whenFlushed;

				expect(getRows(testSetup.db, 'posts')).toEqual([
					{ id: 'post-1', published: null, title: 'Hello mirror' },
					{ id: 'post-2', published: 1, title: 'Second row' },
				]);
			} finally {
				await cleanup(testSetup);
			}
		});

		test('mirrors only specified tables when tables option is provided', async () => {
			const testSetup = setup({ tables: (t) => [{ table: t.posts }] });

			try {
				testSetup.workspace.tables.posts.set({
					id: 'post-1',
					title: 'Mirrored post',
					published: null,
				});
				testSetup.workspace.tables.notes.set({
					id: 'note-1',
					body: 'Ignored note',
				});

				await testSetup.workspace.sqlite.whenFlushed;

				expect(hasTable(testSetup.db, 'posts')).toBe(true);
				expect(hasTable(testSetup.db, 'notes')).toBe(false);
				expect(getRows(testSetup.db, 'posts')).toEqual([
					{ id: 'post-1', published: null, title: 'Mirrored post' },
				]);
			} finally {
				await cleanup(testSetup);
			}
		});
	});

	// ============================================================================
	// INCREMENTAL SYNC Tests
	// ============================================================================

	describe('incremental sync', () => {
		test('upserts rows added after initialization', async () => {
			const testSetup = setup();

			try {
				await testSetup.workspace.sqlite.whenFlushed;

				testSetup.workspace.tables.posts.set({
					id: 'post-1',
					title: 'Added later',
					published: true,
				});

				await waitForSyncCycle();

				expect(getRows(testSetup.db, 'posts')).toEqual([
					{ id: 'post-1', published: 1, title: 'Added later' },
				]);
			} finally {
				await cleanup(testSetup);
			}
		});

		test('deletes rows removed from workspace', async () => {
			const testSetup = setup();

			try {
				testSetup.workspace.tables.posts.set({
					id: 'post-1',
					title: 'Delete me',
					published: null,
				});

				await testSetup.workspace.sqlite.whenFlushed;
				testSetup.workspace.tables.posts.delete('post-1');

				await waitForSyncCycle();

				expect(getRows(testSetup.db, 'posts')).toEqual([]);
			} finally {
				await cleanup(testSetup);
			}
		});

		test('updates rows modified in workspace', async () => {
			const testSetup = setup();

			try {
				testSetup.workspace.tables.posts.set({
					id: 'post-1',
					title: 'Before update',
					published: true,
				});

				await testSetup.workspace.sqlite.whenFlushed;
				testSetup.workspace.tables.posts.update('post-1', {
					title: 'After update',
					published: false,
				});

				await waitForSyncCycle();

				expect(getRows(testSetup.db, 'posts')).toEqual([
					{ id: 'post-1', published: 0, title: 'After update' },
				]);
			} finally {
				await cleanup(testSetup);
			}
		});
	});

	// ============================================================================
	// REBUILD Tests
	// ============================================================================

	describe('rebuild', () => {
		test('rebuild repopulates SQLite from Yjs', async () => {
			const testSetup = setup();

			try {
				testSetup.workspace.tables.posts.set({
					id: 'post-1',
					title: 'Persisted in Yjs',
					published: null,
				});

				await testSetup.workspace.sqlite.whenFlushed;
				testSetup.db.run('DELETE FROM "posts"');

				expect(getRows(testSetup.db, 'posts')).toEqual([]);

				await testSetup.workspace.sqlite.rebuild({});

				expect(getRows(testSetup.db, 'posts')).toEqual([
					{ id: 'post-1', published: null, title: 'Persisted in Yjs' },
				]);
			} finally {
				await cleanup(testSetup);
			}
		});

		test('rebuild single table without touching others', async () => {
			const testSetup = setup();

			try {
				testSetup.workspace.tables.posts.set({
					id: 'post-1',
					title: 'Post row',
					published: null,
				});
				testSetup.workspace.tables.notes.set({
					id: 'note-1',
					body: 'Note row',
				});

				await testSetup.workspace.sqlite.whenFlushed;
				testSetup.db.run('DELETE FROM "posts"');

				expect(getRows(testSetup.db, 'posts')).toEqual([]);
				expect(getRows(testSetup.db, 'notes')).toHaveLength(1);

				await testSetup.workspace.sqlite.rebuild({ table: 'posts' });

				expect(getRows(testSetup.db, 'posts')).toEqual([
					{ id: 'post-1', published: null, title: 'Post row' },
				]);
				expect(getRows(testSetup.db, 'notes')).toHaveLength(1);
			} finally {
				await cleanup(testSetup);
			}
		});

		test('rebuild throws for unknown table name', async () => {
			const testSetup = setup();

			try {
				await testSetup.workspace.sqlite.whenFlushed;

				expect(() =>
					testSetup.workspace.sqlite.rebuild({
						table: 'nonexistent',
					}),
				).toThrow('not in the materialized table set');
			} finally {
				await cleanup(testSetup);
			}
		});
	});

	describe('count', () => {
		test('count returns row count for a materialized table', async () => {
			const testSetup = setup();

			try {
				testSetup.workspace.tables.posts.set({
					id: 'post-1',
					title: 'First',
					published: null,
				});
				testSetup.workspace.tables.posts.set({
					id: 'post-2',
					title: 'Second',
					published: null,
				});

				await testSetup.workspace.sqlite.whenFlushed;

				expect(await testSetup.workspace.sqlite.count({ table: 'posts' })).toBe(
					2,
				);
				expect(await testSetup.workspace.sqlite.count({ table: 'notes' })).toBe(
					0,
				);
			} finally {
				await cleanup(testSetup);
			}
		});

		test('count returns 0 for non-existent table', async () => {
			const testSetup = setup();

			try {
				await testSetup.workspace.sqlite.whenFlushed;

				expect(
					await testSetup.workspace.sqlite.count({
						table: 'nonexistent',
					}),
				).toBe(0);
			} finally {
				await cleanup(testSetup);
			}
		});

		test('count propagates SQLite failures for registered tables', async () => {
			const testSetup = setup();

			try {
				await testSetup.workspace.sqlite.whenFlushed;
				testSetup.db.run('DROP TABLE "posts"');

				await expect(
					testSetup.workspace.sqlite.count({ table: 'posts' }),
				).rejects.toThrow();
			} finally {
				await cleanup(testSetup);
			}
		});
	});

	// ============================================================================
	// DISPOSE Tests
	// ============================================================================

	describe('dispose', () => {
		test('dispose cancels queued sync and ignores later writes', async () => {
			const testSetup = setup();

			try {
				await testSetup.workspace.sqlite.whenFlushed;

				testSetup.workspace.tables.posts.set({
					id: 'post-1',
					title: 'Queued row',
					published: null,
				});
				testSetup.workspace[Symbol.dispose]();

				await waitForSyncCycle();

				// The ydoc is destroyed, so further writes to tables are no-ops
				// as far as materialization is concerned; the observer has been
				// unsubscribed via materializer dispose.
				await waitForSyncCycle();

				expect(getRows(testSetup.db, 'posts')).toEqual([]);
			} finally {
				testSetup.db.close();
			}
		});
	});

	// ============================================================================
	// SEARCH Tests
	// ============================================================================

	describe('search', () => {
		test('search returns empty array when fts is not configured', async () => {
			const testSetup = setup();

			try {
				await testSetup.workspace.sqlite.whenFlushed;

				expect(
					await testSetup.workspace.sqlite.search({
						table: 'posts',
						query: 'hello',
					}),
				).toEqual([]);
			} finally {
				await cleanup(testSetup);
			}
		});

		if (hasFts5) {
			test('search returns ranked results with snippets when fts is configured', async () => {
				const testSetup = setup({
					tables: (t) =>
						[
							{ table: t.posts, config: { fts: ['title'] } },
							{ table: t.notes },
						] as TableRegistration[],
				});

				try {
					testSetup.workspace.tables.posts.set({
						id: 'post-1',
						title: 'Epicenter local-first mirror',
						published: null,
					});
					testSetup.workspace.tables.posts.set({
						id: 'post-2',
						title: 'Another search result',
						published: null,
					});

					await testSetup.workspace.sqlite.whenFlushed;

					const results = (await testSetup.workspace.sqlite.search({
						table: 'posts',
						query: 'mirror',
						limit: 10,
					})) as Array<{ id: string; snippet: string; rank: number }>;

					expect(results).toHaveLength(1);
					expect(results[0]?.id).toBe('post-1');
					expect(results[0]?.snippet).toContain('<mark>');
					expect(typeof results[0]?.rank).toBe('number');
				} finally {
					await cleanup(testSetup);
				}
			});
		}
	});

	// ============================================================================
	// ACTION BRAND Tests
	// ============================================================================

	describe('action brand', () => {
		test('search, count, rebuild are detectable via isAction()', async () => {
			const testSetup = setup();

			try {
				const { sqlite } = testSetup.workspace;
				expect(isAction(sqlite.search)).toBe(true);
				expect(isAction(sqlite.count)).toBe(true);
				expect(isAction(sqlite.rebuild)).toBe(true);

				expect(isQuery(sqlite.search)).toBe(true);
				expect(isQuery(sqlite.count)).toBe(true);
				expect(isMutation(sqlite.rebuild)).toBe(true);
			} finally {
				await cleanup(testSetup);
			}
		});
	});
});
