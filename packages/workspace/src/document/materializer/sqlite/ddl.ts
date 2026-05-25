/**
 * Generate SQLite DDL from a workspace table's latest-version row schema.
 *
 * Callers pass `definition.schema` (a TypeBox `TObject` which is itself a
 * JSON Schema). Column storage class and nullability come from
 * `deriveStorage` / `isNullable`, so `column.nullable(column.X())` rows map
 * cleanly to nullable SQLite columns.
 *
 * Since `_v` is library-managed and stripped from the user-facing row schema,
 * the generated DDL never contains a `_v` column. SQLite projects only what
 * the user declared.
 *
 * @module
 */

import type { TSchema } from 'typebox';
import { deriveStorage, isNullable } from '../../column/derive.js';

type JsonSchema = Record<string, unknown>;

// ════════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ════════════════════════════════════════════════════════════════════════════

/**
 * Generate a `CREATE TABLE IF NOT EXISTS` statement for a workspace table.
 *
 * Maps the table's latest-version row JSON Schema into a SQLite table
 * definition. Required scalar fields become `NOT NULL`, `id` becomes the
 * primary key, and complex values are stored as JSON text.
 *
 * @param tableName - The SQLite table name to create
 * @param jsonSchema - The JSON Schema for the table's row type
 * @returns A `CREATE TABLE IF NOT EXISTS` SQL statement
 *
 * @example
 * ```typescript
 * const sql = generateDdl('posts', {
 *   type: 'object',
 *   properties: {
 *     id: { type: 'string' },
 *     title: { type: 'string' },
 *     published: { type: 'boolean' },
 *   },
 *   required: ['id', 'title'],
 * });
 *
 * // CREATE TABLE IF NOT EXISTS "posts" ("id" TEXT PRIMARY KEY, "title" TEXT NOT NULL, "published" INTEGER)
 * ```
 */
export function generateDdl(tableName: string, jsonSchema: TSchema): string {
	const resolved = jsonSchema as unknown as JsonSchema;

	if (!isRecord(resolved.properties)) {
		throw new Error(
			'SQLite DDL generation requires an object schema with properties.',
		);
	}

	const properties = resolved.properties;
	const required = new Set(
		Array.isArray(resolved.required)
			? (resolved.required as unknown[]).filter(
					(value): value is string => typeof value === 'string',
				)
			: [],
	);

	const columns = Object.entries(properties).map(([name, propSchema]) => {
		if (!isRecord(propSchema)) {
			throw new Error(
				`SQLite DDL generation requires property "${name}" schema to be an object.`,
			);
		}
		return columnDef(name, propSchema as TSchema, required.has(name));
	});

	return `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(tableName)} (${columns.join(', ')})`;
}

/** Double-quote a SQL identifier, escaping embedded quotes. */
export function quoteIdentifier(identifier: string) {
	return `"${identifier.replaceAll('"', '""')}"`;
}

// ════════════════════════════════════════════════════════════════════════════
// PRIVATE HELPERS
// ════════════════════════════════════════════════════════════════════════════

function columnDef(
	name: string,
	propSchema: TSchema,
	isRequired: boolean,
): string {
	const quotedName = quoteIdentifier(name);

	if (name === 'id') {
		return `${quotedName} TEXT PRIMARY KEY`;
	}

	const storage = deriveStorage(propSchema);
	const nullable = !isRequired || isNullable(propSchema);

	return nullable
		? `${quotedName} ${storage}`
		: `${quotedName} ${storage} NOT NULL`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
