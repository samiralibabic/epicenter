/**
 * Integration tests for `tablesToDrizzleSchema`.
 *
 * Each test seeds a real materialized SQLite mirror, opens it read-only, wraps
 * it in Drizzle via the generated schema, and asserts that typed Drizzle
 * queries return the expected rows. The whole pipeline (TypeBox schema →
 * materializer DDL → mirror file → Drizzle reads) is exercised end-to-end.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import Type from 'typebox';
import * as Y from 'yjs';
import { attachTables, column, defineTable } from '../index.js';
import { tablesToDrizzleSchema } from './drizzle-schema.js';
import { attachBunSqliteMaterializer } from './materializer/sqlite/bun-sqlite.js';
import { openSqliteReader } from './open-sqlite-reader.js';

const entriesTable = defineTable({
	id: column.string(),
	title: column.string(),
	body: column.nullable(column.string()),
	wordCount: column.integer(),
	score: column.number(),
	published: column.boolean(),
	priority: column.enum(['low', 'medium', 'high']),
	tags: column.json(Type.Array(Type.String())),
	metadata: column.nullable(
		column.json(Type.Object({ author: Type.String() })),
	),
});

const definitions = { entries: entriesTable };

let workDir: string;

beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), 'drizzle-schema-'));
});

afterEach(() => {
	rmSync(workDir, { recursive: true, force: true });
});

type EntryRow = {
	id: string;
	title: string;
	body: string | null;
	wordCount: number;
	score: number;
	published: boolean;
	priority: 'low' | 'medium' | 'high';
	tags: string[];
	metadata: { author: string } | null;
};

async function seedMirror(filePath: string, rows: EntryRow[]) {
	const ydoc = new Y.Doc({ guid: 'drizzle-schema-test' });
	const tables = attachTables(ydoc, definitions);
	const materializer = attachBunSqliteMaterializer(ydoc, {
		filePath,
		debounceMs: 0,
	}).table(tables.entries);
	await materializer.whenFlushed;
	for (const row of rows) tables.entries.set(row);
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
	ydoc.destroy();
}

describe('tablesToDrizzleSchema', () => {
	test('reads back materialized rows through a Drizzle select', async () => {
		const filePath = join(workDir, 'mirror.db');
		await seedMirror(filePath, [
			{
				id: 'a',
				title: 'Alpha',
				body: 'first',
				wordCount: 1,
				score: 0.5,
				published: true,
				priority: 'high',
				tags: ['urgent', 'red'],
				metadata: { author: 'braden' },
			},
			{
				id: 'b',
				title: 'Beta',
				body: null,
				wordCount: 42,
				score: 3.14,
				published: false,
				priority: 'low',
				tags: [],
				metadata: null,
			},
		]);

		using reader = openSqliteReader({ filePath });
		const schema = tablesToDrizzleSchema(definitions);
		const db = drizzle(reader.db, { schema });

		const rows = await db
			.select()
			.from(schema.entries)
			.orderBy(schema.entries.id);

		expect(rows).toEqual([
			{
				id: 'a',
				title: 'Alpha',
				body: 'first',
				wordCount: 1,
				score: 0.5,
				published: true,
				priority: 'high',
				tags: ['urgent', 'red'],
				metadata: { author: 'braden' },
			},
			{
				id: 'b',
				title: 'Beta',
				body: null,
				wordCount: 42,
				score: 3.14,
				published: false,
				priority: 'low',
				tags: [],
				metadata: null,
			},
		]);
	});

	test('supports where clauses on indexed columns', async () => {
		const filePath = join(workDir, 'mirror.db');
		await seedMirror(filePath, [
			{
				id: 'a',
				title: 'Hello',
				body: null,
				wordCount: 1,
				score: 0,
				published: true,
				priority: 'low',
				tags: [],
				metadata: null,
			},
			{
				id: 'b',
				title: 'Goodbye',
				body: null,
				wordCount: 1,
				score: 0,
				published: true,
				priority: 'low',
				tags: [],
				metadata: null,
			},
		]);

		using reader = openSqliteReader({ filePath });
		const schema = tablesToDrizzleSchema(definitions);
		const db = drizzle(reader.db, { schema });

		const rows = await db
			.select({ id: schema.entries.id })
			.from(schema.entries)
			.where(eq(schema.entries.title, 'Hello'));

		expect(rows).toEqual([{ id: 'a' }]);
	});
});
