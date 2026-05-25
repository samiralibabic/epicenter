# Deriving Action Input Schemas From Tables

## When to Read This

Read when wiring a table operation as a `defineQuery`/`defineMutation` action whose input needs runtime validation (AI tool / MCP server, RPC over the sync socket, HTTP route, CLI command, or any other wire boundary).

In-app code calling `tables.X.set(row)` directly doesn't need a runtime input schema; TypeScript covers the call site. This guidance is for **actions exposed across a wire** where the input arrives as `unknown`.

## The Two Accessors

Every table definition and every attached table handle exposes the latest version's row schema as a TypeBox `TObject`:

```typescript
tables.notes.schema           // TObject<LastVersion>: convenience mirror on the handle
tables.notes.definition.schema // same value on the definition

tables.notes.schema.properties.id    // TSchema for the `id` column
tables.notes.schema.properties.title // TSchema for the `title` column
// ... one entry per column declared in the latest version
```

Same `TObject` either way. Reach for the handle accessor (`tables.notes.schema`) from action factories where you already have the attached `tables`; reach for `definition.schema` from code that holds the definition without the handle (e.g. codegen, DDL).

## Composition Pattern: No Helper Needed

There is no `createTableSchemas(table)` / `tableActions(table)` helper. Compose inline. The TypeBox primitives are short enough that a helper costs more than it saves.

### Full-row write (replace the entire row)

```typescript
import { defineMutation } from '@epicenter/workspace';

defineMutation({
  title: 'Replace note',
  description: 'Atomically replace a note with a complete row',
  input: tables.notes.schema,
  handler: (row) => tables.notes.set(row),
});
```

Use when the caller already has the full row (form submit with every field, restore from backup, sync replication).

### Narrow patch (set named fields)

Pluck the columns the action actually touches. The action's name should describe the narrow operation; the input schema should match.

```typescript
import { Type } from 'typebox';

defineMutation({
  title: 'Rename note',
  description: 'Change a note title',
  input: Type.Object({
    id:    tables.notes.schema.properties.id,
    title: tables.notes.schema.properties.title,
  }),
  handler: ({ id, title }) => tables.notes.update(id, { title }),
});
```

This is the right shape for most AI tools and CLI subcommands: the LLM/user sees a tool that says "I let you change title" rather than a blanket-patch tool that lets them change anything.

### Get / delete (id only)

```typescript
const idOnly = Type.Object({ id: tables.notes.schema.properties.id });

defineQuery({
  title: 'Get note',
  description: 'Fetch a note by id',
  input: idOnly,
  handler: ({ id }) => tables.notes.get(id),
});

defineMutation({
  title: 'Delete note',
  description: 'Delete a note by id',
  input: idOnly,
  handler: ({ id }) => tables.notes.delete(id),
});
```

### Blanket partial (PATCH semantics)

For HTTP `PATCH /notes/:id` or a generic admin edit surface, where the caller decides which fields to send:

```typescript
defineMutation({
  title: 'Patch note',
  description: 'Update any subset of note fields',
  input: Type.Object({
    id:    tables.notes.schema.properties.id,
    patch: Type.Partial(Type.Omit(tables.notes.schema, ['id'])),
  }),
  handler: ({ id, patch }) => tables.notes.update(id, patch),
});
```

This is the only case where the inline composition gets verbose. Still cheaper than a helper; extract one only if you have 3+ tables doing the same `Type.Partial(Type.Omit(schema, ['id']))` dance.

## What Not To Do

### Don't re-export columns as a separate object

`tables.notes.schema.properties.X` IS the column schema. There's no `tables.notes.columns` field. If you find yourself wanting one, you're looking for `tables.notes.schema.properties`.

### Don't build a `table.input.*` field

An earlier draft API exposed `tables.notes.input.get/set/update/delete` schemas on the handle. It was deleted because:

1. Action input shapes are caller-specific (narrow vs blanket, id-only vs full row, with optional metadata). Four pre-baked shapes don't fit the variation.
2. Storage handle and action-layer concerns are separate. Schemas for action inputs belong at the action site, not on the storage handle.
3. The composition above is short enough that a helper doesn't earn its keep until 3+ tables share an identical pattern.

When you need a shape that isn't there, build it inline at the callsite with `Type.Object` / `Type.Pick` / `Type.Omit` / `Type.Partial` over `tables.X.schema`.

### Don't validate twice

The table's CRUD methods (`set`, `update`) validate against the schema internally. The action's `input` schema validates the wire frame *before* the handler runs. Don't add a third validation pass inside the handler.

## Quick Reference

| Need | Input shape |
|---|---|
| Replace entire row | `tables.X.schema` |
| Set specific named fields | `Type.Object({ id: ..., field: ... })` plucked from `schema.properties` |
| Get / delete by id | `Type.Object({ id: tables.X.schema.properties.id })` |
| Blanket PATCH | `Type.Object({ id: ..., patch: Type.Partial(Type.Omit(tables.X.schema, ['id'])) })` |
| Internal app code | No schema needed; call `tables.X.set/update/get` directly |
