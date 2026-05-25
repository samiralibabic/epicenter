/**
 * Storage-class, nullability, and CHECK-constraint derivation over a TypeBox
 * column schema.
 *
 * The materializer reads schemas directly: it does not consult any column
 * wrapper or extension keyword. Storage class, nullability, primary-key
 * designation, and CHECK constraints fall out of the schema structure plus
 * the established `id` PK convention.
 *
 * `FlatJsonTSchema` already restricts every column to a `~kind` that has a
 * single SQLite storage class, so these helpers only have to read what's
 * there.
 */

import type { TSchema } from 'typebox';

export type SqliteStorage = 'TEXT' | 'INTEGER' | 'REAL';

type SchemaShape = {
	type?: string;
	const?: unknown;
	anyOf?: TSchema[];
};

function asShape(schema: TSchema): SchemaShape {
	return schema as unknown as SchemaShape;
}

/**
 * Derive the SQLite storage class for a column.
 *
 * - `string` / array / object → `TEXT` (objects and arrays are JSON-encoded)
 * - `integer` / `boolean` → `INTEGER` (booleans store as 0/1 by SQLite
 *   convention)
 * - `number` → `REAL`
 * - `const`: numeric integer → `INTEGER`, otherwise `TEXT`
 * - `anyOf` with a single non-null branch → recurse into that branch
 * - `anyOf` mixed → `TEXT` (JSON-encoded fallback)
 */
export function deriveStorage(schema: TSchema): SqliteStorage {
	const s = asShape(schema);
	if (s.type === 'integer') return 'INTEGER';
	if (s.type === 'number') return 'REAL';
	if (s.type === 'boolean') return 'INTEGER';
	if (s.type === 'string') return 'TEXT';
	if (s.type === 'array' || s.type === 'object') return 'TEXT';
	if (s.const !== undefined) {
		return typeof s.const === 'number' && Number.isInteger(s.const)
			? 'INTEGER'
			: 'TEXT';
	}
	if (s.anyOf) {
		const nonNull = s.anyOf.filter((branch) => asShape(branch).type !== 'null');
		if (nonNull.length === 1) {
			const only = nonNull[0];
			if (only) return deriveStorage(only);
		}
		return 'TEXT';
	}
	return 'TEXT';
}

/**
 * Whether the column's union includes a `Type.Null()` branch.
 */
export function isNullable(schema: TSchema): boolean {
	const s = asShape(schema);
	return Boolean(s.anyOf?.some((branch) => asShape(branch).type === 'null'));
}

/**
 * Derive a SQLite CHECK clause for an enum-shaped column. For
 * `column.enum(['a', 'b'])` the schema is `anyOf` of const, producing
 * `column IN ('a', 'b')`. Returns `undefined` for shapes that don't fit
 * the union-of-const pattern.
 */
export function deriveCheck(
	schema: TSchema,
	columnName: string,
): string | undefined {
	const s = asShape(schema);
	if (!s.anyOf) return undefined;
	const consts: (string | number)[] = [];
	for (const branch of s.anyOf) {
		const b = asShape(branch);
		if (b.const === undefined) return undefined;
		if (typeof b.const !== 'string' && typeof b.const !== 'number')
			return undefined;
		consts.push(b.const);
	}
	if (consts.length === 0) return undefined;
	const values = consts
		.map((v) => (typeof v === 'number' ? String(v) : `'${v}'`))
		.join(', ');
	return `${columnName} IN (${values})`;
}
