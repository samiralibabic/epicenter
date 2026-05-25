/**
 * `tablesToDrizzleSchema(defs)`: derive a Drizzle SQLite schema from workspace
 * `TableDefinition`s so callers can use Drizzle's typed query builder on the
 * mirror file opened by {@link openSqliteReader}.
 *
 * Read-only by design. The materializer (`attachSqliteMaterializer`) owns the
 * write path with prepared statements and `serializeValue`. Mixing Drizzle's
 * `{ mode: 'json' }` write encoder with that path would double-stringify;
 * routing only reads through Drizzle keeps the encoders single-owner.
 *
 * The mirror is a derived cache: Yjs is the source of truth, and rows reach
 * SQLite only after `table.getAllValid()` validates them. So columns map to
 * plain Drizzle primitives with no `customType` validation on read and no
 * CHECK constraints; on-disk corruption is a `rebuild()` signal, not a
 * per-read concern.
 *
 * `_v` is stripped from `definition.schema` before this code sees it (see
 * `attach-table.ts`), so the walker never has to special-case it.
 *
 * @example
 * ```ts
 * using reader = openSqliteReader({ filePath });
 * const schema = tablesToDrizzleSchema({ entries, tasks });
 * const db = drizzle(reader.db, { schema });
 * const rows = await db.select().from(schema.entries).where(eq(schema.entries.title, 'Hello'));
 * ```
 *
 * @module
 */

import type {
	$Type,
	BuildColumns,
	HasDefault,
	IsPrimaryKey,
	NotNull,
} from 'drizzle-orm';
import type {
	SQLiteBooleanBuilderInitial,
	SQLiteColumnBuilderBase,
	SQLiteIntegerBuilderInitial,
	SQLiteRealBuilderInitial,
	SQLiteTableWithColumns,
	SQLiteTextBuilderInitial,
	SQLiteTextJsonBuilderInitial,
} from 'drizzle-orm/sqlite-core';
import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { Static, TSchema } from 'typebox';
import type { TableDefinition, TableDefinitions } from './attach-table';

// ════════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ════════════════════════════════════════════════════════════════════════════

/**
 * Map a record of workspace `TableDefinition`s to Drizzle SQLite tables.
 *
 * Each table's columns flow from the latest version's row TObject:
 *
 * | TypeBox shape                | Drizzle column                                   |
 * | ---------------------------- | ------------------------------------------------ |
 * | `id` (string/branded)        | `text('id').primaryKey().notNull().$type<Id>()`  |
 * | `string` / branded / datetime| `text(name).$type<Static<S>>()`                  |
 * | `integer` / literal-int      | `integer(name)`                                  |
 * | `number`                     | `real(name)`                                     |
 * | `boolean`                    | `integer(name, { mode: 'boolean' })`             |
 * | union of string literals     | `text(name, { enum: [...] }).$type<Static<S>>()` |
 * | `object` / `array` / json    | `text(name, { mode: 'json' }).$type<Static<S>>()`|
 * | `column.nullable(inner)`     | inner column, `.notNull()` dropped               |
 *
 * Required columns chain `.notNull()`. The runtime walker hands back wide
 * `SQLiteColumnBuilderBase` values; the precise per-column types are
 * reconstructed by the {@link TablesToDrizzleSchema} mapped type and joined
 * at one boundary cast.
 */
export function tablesToDrizzleSchema<T extends TableDefinitions>(
	definitions: T,
): TablesToDrizzleSchema<T> {
	return Object.fromEntries(
		Object.entries(definitions).map(([name, definition]) => [
			name,
			buildTable(name, definition),
		]),
	) as unknown as TablesToDrizzleSchema<T>;
}

/**
 * Precise type for the dictionary returned by {@link tablesToDrizzleSchema}.
 *
 * Each entry is the `SQLiteTableWithColumns` Drizzle would have produced had
 * the user written `sqliteTable(name, { ... })` by hand. Downstream
 * `db.select().from(schema.entries)` and `eq(schema.entries.title, 'x')` get
 * full inference, including TypeBox brands carried through `.$type<>`.
 */
export type TablesToDrizzleSchema<T extends TableDefinitions> = {
	[K in keyof T & string]: DrizzleTableFor<K, T[K]>;
};

// ════════════════════════════════════════════════════════════════════════════
// TYPE-LEVEL WALKER
// ════════════════════════════════════════════════════════════════════════════

/**
 * The `SQLiteTableWithColumns` shape Drizzle would have inferred for one
 * `TableDefinition`. Built from the latest-version row schema by
 * {@link ColumnsForDef}; Drizzle's own `BuildColumns` projects the builders
 * to runtime `SQLiteColumn` instances with `tableName` plumbed through.
 */
// biome-ignore lint/suspicious/noExplicitAny: variance over TVersions
type DrizzleTableFor<
	Name extends string,
	D extends TableDefinition<any>,
> = SQLiteTableWithColumns<{
	name: Name;
	schema: undefined;
	columns: BuildColumns<Name, ColumnsForDef<D>, 'sqlite'>;
	dialect: 'sqlite';
}>;

/**
 * Walk `D['schema']['properties']` into a Drizzle column-builder dictionary.
 * Each property's TypeBox schema is paired with its required-ness (from the
 * sibling `required` tuple on the TObject) and routed through
 * {@link DrizzleColumnFor}.
 */
// biome-ignore lint/suspicious/noExplicitAny: variance over the TVersions tuple
type ColumnsForDef<D extends TableDefinition<any>> = D extends {
	schema: { properties: infer P };
}
	? P extends Record<string, TSchema>
		? {
				[K in keyof P & string]: DrizzleColumnFor<K, P[K], IsRequired<D, K>>;
			}
		: never
	: never;

/**
 * Is `K` listed in the TObject's `required` tuple? TypeBox emits `required`
 * as a JSON-Schema-style readonly string array; we use it as the source of
 * truth for `.notNull()` decisions.
 */
// biome-ignore lint/suspicious/noExplicitAny: variance over the TVersions tuple
type IsRequired<D extends TableDefinition<any>, K extends string> = D extends {
	schema: { required: infer R };
}
	? R extends readonly string[]
		? K extends R[number]
			? true
			: false
		: false
	: false;

// ─── Per-column branches ────────────────────────────────────────────────────

/**
 * Map one TypeBox column schema to its Drizzle column builder type.
 *
 * Three outer layers, applied in order:
 *
 * 1. `id` short-circuit: always text + primaryKey + notNull, brand from
 *    `Static<S>` preserved via `$Type` so branded ids (`column.string<NoteId>`)
 *    survive into `db.select()` results.
 * 2. Nullable unions (`column.nullable(inner)` = `Type.Union([inner, Null])`)
 *    are peeled by recursing into the non-null branch and forcing
 *    `Required = false`. The result never chains `.notNull()`.
 * 3. Everything else flows through {@link BaseColumnFor} (which dispatches
 *    on the schema's `~kind`) and is wrapped by {@link ApplyNotNull} based
 *    on the required flag.
 */
type DrizzleColumnFor<
	Name extends string,
	S extends TSchema,
	Required extends boolean,
> = Name extends 'id'
	? IdColumnFor<Name, S>
	: HasNullBranch<S> extends true
		? DrizzleColumnFor<Name, NonNullBranch<S>, false>
		: ApplyNotNull<BaseColumnFor<Name, S>, Required>;

/**
 * Drizzle column type for the workspace `id` primary key.
 *
 * `id` is always TEXT in the materializer DDL (`ddl.ts` hard-codes
 * `id TEXT PRIMARY KEY`), so we mirror that here. `IsPrimaryKey<HasDefault<NotNull<...>>>`
 * is the exact chain Drizzle's `text(name).primaryKey()` produces.
 *
 * `$Type<..., Static<S>>` preserves a TypeBox brand (`column.string<NoteId>()`
 * has `Static<> = NoteId`) so `schema.entries.id` query references and
 * select results stay branded end-to-end.
 */
type IdColumnFor<Name extends string, S extends TSchema> = IsPrimaryKey<
	HasDefault<NotNull<$Type<TextBuilder<Name>, Static<S>>>>
>;

/**
 * Shorthand for the most common Drizzle text builder shape (no enum
 * narrowing, no length). Used by every text branch that isn't an
 * `anyOf`-of-literals enum.
 */
type TextBuilder<Name extends string> = SQLiteTextBuilderInitial<
	Name,
	[string, ...string[]],
	undefined
>;

/**
 * Wrap a builder with Drizzle's `NotNull<>` brand when the column is required.
 * Kept as a separate alias so the modifier chain has one obvious join point
 * (mirrors the runtime `required ? col.notNull() : col` pattern).
 */
type ApplyNotNull<
	T extends SQLiteColumnBuilderBase,
	Required extends boolean,
> = Required extends true ? NotNull<T> : T;

/**
 * Pick the right Drizzle builder shape for a single column schema, assuming
 * the column is non-null. Nullability is layered on by the outer
 * {@link DrizzleColumnFor}; the `id` primary-key short-circuit also happens
 * outside this lookup.
 *
 * `anyOf` is handled here in two flavors:
 * - all string-literal branches → `text({ enum })` with `Static<S>` brand
 * - mixed branches → `text({ mode: 'json' })` with `Static<S>` as the JSON type
 *
 * Scalars dispatch through {@link ScalarKind} → {@link ScalarKindMap}: a
 * lookup table keeps each branch one line and makes adding new shapes a
 * single-entry change.
 */
type BaseColumnFor<Name extends string, S extends TSchema> = S extends {
	anyOf: infer A;
}
	? A extends readonly TSchema[]
		? AllStringConstBranches<A> extends true
			? $Type<
					SQLiteTextBuilderInitial<Name, AnyOfStringConsts<A>, undefined>,
					Static<S>
				>
			: $Type<SQLiteTextJsonBuilderInitial<Name>, Static<S>>
		: never
	: ScalarKindMap<Name, S>[ScalarKind<S>];

/**
 * String-tag of a scalar TypeBox schema, used to drive {@link ScalarKindMap}.
 * Returns `'json'` for shapes we don't recognize so the fallback lands on a
 * JSON-encoded text column (Drizzle handles `JSON.parse` automatically).
 */
type ScalarKind<S extends TSchema> = S extends
	| { type: 'integer' }
	| { const: number }
	? 'integer'
	: S extends { type: 'number' }
		? 'number'
		: S extends { type: 'boolean' }
			? 'boolean'
			: S extends { type: 'string' } | { const: string }
				? 'string'
				: S extends { type: 'object' } | { type: 'array' }
					? 'json'
					: 'json';

/**
 * Lookup table from {@link ScalarKind} to Drizzle builder type. Generic over
 * both the column `Name` (so the builder carries it) and the original schema
 * `S` (so brands flow into `$Type<..., Static<S>>` on text/json branches).
 *
 * The boolean / integer / real branches don't need `$Type` because their TS
 * data type is already `boolean` / `number` and TypeBox doesn't brand those.
 */
type ScalarKindMap<Name extends string, S extends TSchema> = {
	integer: SQLiteIntegerBuilderInitial<Name>;
	number: SQLiteRealBuilderInitial<Name>;
	boolean: SQLiteBooleanBuilderInitial<Name>;
	string: $Type<TextBuilder<Name>, Static<S>>;
	json: $Type<SQLiteTextJsonBuilderInitial<Name>, Static<S>>;
};

// ─── anyOf helpers ──────────────────────────────────────────────────────────

/**
 * True when `S`'s `anyOf` array contains a `Type.Null()` branch. Used to
 * detect `column.nullable(inner)` (sugar for `Type.Union([inner, Null])`).
 */
type HasNullBranch<S extends TSchema> = S extends { anyOf: infer A }
	? A extends readonly TSchema[]
		? Extract<A[number], { type: 'null' }> extends never
			? false
			: true
		: false
	: false;

/**
 * Peel the null branch off a nullable union, leaving the non-null inner
 * schema. Only meaningful when {@link HasNullBranch} is `true`; the recursive
 * call in {@link DrizzleColumnFor} flips `Required` to false at the same time.
 */
type NonNullBranch<S extends TSchema> = S extends { anyOf: infer A }
	? A extends readonly TSchema[]
		? Exclude<A[number], { type: 'null' }> extends TSchema
			? Exclude<A[number], { type: 'null' }>
			: never
		: never
	: never;

/**
 * True when every branch of an `anyOf` is `{ const: string }` (the shape
 * `column.enum(['a', 'b'])` produces). Drives the `text({ enum })` choice
 * in {@link BaseColumnFor}.
 */
type AllStringConstBranches<A extends readonly TSchema[]> = A[number] extends {
	const: string;
}
	? true
	: false;

/**
 * Pull the literal string values out of an `anyOf` array, preserving order
 * as a `[string, ...string[]]` tuple. Feeds Drizzle's `enum` option so the
 * column's TS type narrows to the literal union (e.g. `'low' | 'high'`).
 */
type AnyOfStringConsts<A extends readonly TSchema[]> = {
	[I in keyof A]: A[I] extends { const: infer C extends string } ? C : never;
} extends infer R
	? R extends [string, ...string[]]
		? R
		: [string, ...string[]]
	: [string, ...string[]];

// ════════════════════════════════════════════════════════════════════════════
// RUNTIME WALKER
// ════════════════════════════════════════════════════════════════════════════

/**
 * Build a single Drizzle SQLite table from a workspace table definition.
 *
 * Returns Drizzle's wide table type at the runtime layer; precise inference
 * is recovered by {@link tablesToDrizzleSchema}'s boundary cast.
 */
// biome-ignore lint/suspicious/noExplicitAny: variance over TVersions
function buildTable(name: string, definition: TableDefinition<any>) {
	const properties = (definition.schema as unknown as TObjectShape).properties;
	const requiredKeys = (definition.schema as unknown as TObjectShape).required;
	const required = new Set<string>(
		Array.isArray(requiredKeys) ? requiredKeys : [],
	);
	const columns = Object.fromEntries(
		Object.entries(properties).map(
			([key, schema]) =>
				[key, buildColumn(key, schema, required.has(key))] as const,
		),
	);
	return sqliteTable(name, columns);
}

/**
 * Walk a TypeBox column schema's JSON Schema representation into a Drizzle
 * column builder. Three layers mirror the type-level walker:
 *
 * 1. `id` short-circuit: text + primaryKey + notNull.
 * 2. Nullable union: recurse into the non-null branch, drop notNull.
 * 3. Everything else flows through {@link buildBaseColumn}; the
 *    `required ? col.notNull() : col` join happens once at the end.
 */
function buildColumn(
	name: string,
	schema: TSchema,
	required: boolean,
): SQLiteColumnBuilderBase {
	if (name === 'id') {
		return text(name).primaryKey().notNull();
	}

	const shape = schema as unknown as ColumnShape;

	if (Array.isArray(shape.anyOf)) {
		return buildAnyOfColumn(name, shape, required);
	}

	const base = buildBaseColumn(name, shape);
	return required ? base.notNull() : base;
}

/**
 * Resolve a `Type.Union(...)` shape:
 *
 * - `[..., Null]` (one non-null branch + null): recurse on the inner branch
 *   with `required = false`. The column admits null, so we never chain
 *   `.notNull()`.
 * - all string-literal branches (no null): `text({ enum })` so `enumValues`
 *   carries through to query inference.
 * - anything else: `text({ mode: 'json' })` fallback; Drizzle parses on read.
 */
function buildAnyOfColumn(
	name: string,
	shape: ColumnShape,
	required: boolean,
): SQLiteColumnBuilderBase {
	const branches = (shape.anyOf ?? []) as ColumnShape[];
	const nonNullBranches = branches.filter((branch) => branch.type !== 'null');
	const hasNullBranch = nonNullBranches.length !== branches.length;

	if (hasNullBranch && nonNullBranches.length === 1) {
		const inner = nonNullBranches[0] as TSchema;
		return buildColumn(name, inner, false);
	}

	if (
		!hasNullBranch &&
		nonNullBranches.length > 0 &&
		nonNullBranches.every((branch) => typeof branch.const === 'string')
	) {
		const values = nonNullBranches.map((branch) => branch.const as string) as [
			string,
			...string[],
		];
		const column = text(name, { enum: values });
		return required ? column.notNull() : column;
	}

	const column = text(name, { mode: 'json' });
	return required ? column.notNull() : column;
}

/**
 * Pick the right Drizzle builder for a non-union, non-`id` column. Mirrors
 * `deriveStorage` in `column/derive.ts`:
 *
 * - `integer` / int `const` → `integer(name)`
 * - `number` → `real(name)`
 * - `boolean` → `integer(name, { mode: 'boolean' })`
 * - `string` / string `const` → `text(name)`
 * - `object` / `array` → `text(name, { mode: 'json' })`
 * - unknown shape → JSON text fallback
 *
 * Returns the bare builder; `.notNull()` is layered on by {@link buildColumn}.
 */
type ScalarBaseColumn =
	| SQLiteIntegerBuilderInitial<string>
	| SQLiteRealBuilderInitial<string>
	| SQLiteBooleanBuilderInitial<string>
	| SQLiteTextBuilderInitial<string, [string, ...string[]], undefined>
	| SQLiteTextJsonBuilderInitial<string>;

function buildBaseColumn(name: string, shape: ColumnShape): ScalarBaseColumn {
	if (shape.type === 'integer') return integer(name);
	if (shape.type === 'number') return real(name);
	if (shape.type === 'boolean') return integer(name, { mode: 'boolean' });
	if (shape.type === 'string') return text(name);
	if (shape.type === 'object' || shape.type === 'array') {
		return text(name, { mode: 'json' });
	}
	if (shape.const !== undefined) {
		if (typeof shape.const === 'number' && Number.isInteger(shape.const)) {
			return integer(name);
		}
		return text(name);
	}
	return text(name, { mode: 'json' });
}

// ════════════════════════════════════════════════════════════════════════════
// MODULE-LEVEL HELPERS
// ════════════════════════════════════════════════════════════════════════════

type TObjectShape = {
	properties: Record<string, TSchema>;
	required?: readonly string[];
};

type ColumnShape = {
	type?: string;
	const?: unknown;
	anyOf?: unknown[];
};
