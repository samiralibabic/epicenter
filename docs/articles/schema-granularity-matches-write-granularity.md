# Why Versioned Schemas Work in Epicenter

The key insight that makes schema versioning possible in Epicenter is deceptively simple: **the granularity of the schema matches the granularity of the writes**.

## The Problem with Cell-Level CRDTs

Most CRDT-based databases use cell-level merging. Each field in a row is an independent CRDT that can be edited concurrently:

```
Row: posts/row-1
├── title: Y.Text("Hello")      ← Can be edited independently
├── views: LWW(42)              ← Can be edited independently
└── author: LWW("alice")        ← Can be edited independently
```

This is great for concurrent editing. Alice can update `title` while Bob updates `views`, and both changes merge cleanly.

But it creates a fundamental problem for schema evolution: **after concurrent edits, different cells could be at different schema versions**.

Imagine you ship v2 of your schema that adds a `views` field. Alice's client (on v2) writes `{ title: "Hello", views: 0 }`. Bob's client (still on v1) writes `{ title: "World" }`. After sync, you have:

```
Row: posts/row-1
├── title: "World"    ← From Bob (v1 client)
├── views: 0          ← From Alice (v2 client)
```

What schema version is this row? It's... neither? It's a Frankenstein mix of v1 and v2 data. Your migration function can't handle this because the row isn't coherent.

## Epicenter's Solution: Row-Level Atomicity

Epicenter takes a different approach. Instead of cell-level CRDTs, we use **row-level last-write-wins**:

```
Row: posts/row-1 = { id: "row-1", title: "Hello", views: 42, _v: 2 }
                   ↑ Entire row is one atomic blob
```

When you update a row, you replace the entire thing. This means:

1. **The entire row has a coherent schema version** - all fields come from the same write
2. **Migration is straightforward** - check the version, transform the whole row
3. **No Frankenstein rows** - impossible to have mixed-version cells

## The Trade-off

This is a deliberate trade-off:

| Approach        | Concurrent Field Edits | Schema Versioning       |
| --------------- | ---------------------- | ----------------------- |
| Cell-level CRDT | Merge cleanly          | Broken (mixed versions) |
| Row-level LWW   | Last write wins        | Works perfectly         |

If Alice edits `title` and Bob edits `views` at the same time, one of their changes will be lost. The last writer wins for the entire row.

**When this trade-off makes sense:**

- Document-style data edited by one user at a time
- Apps where schema evolution is more important than concurrent field editing
- Data with frequent schema changes during development

**When to use cell-level CRDTs instead:**

- Highly collaborative apps (multiple users editing same row simultaneously)
- Apps with stable schemas that rarely change

## The API

Here's how it looks in practice:

```typescript
import { column, defineTable } from '@epicenter/workspace';
import Type from 'typebox';

const posts = defineTable(
	{ id: column.string(), title: column.string() },
	{
		id: column.string(),
		title: column.string(),
		views: column.number(),
	},
	{
		id: column.string(),
		title: column.string(),
		views: column.number(),
		tags: column.json(Type.Array(Type.String())),
	},
).migrate(({ value, version }) => {
	switch (version) {
		case 1: return { ...value, views: 0, tags: [] };
		case 2: return { ...value, tags: [] };
		case 3: return value;
	}
});
```

Each version is a positional argument to `defineTable(...)`. The `.migrate()` function receives `{ value, version }` and normalizes to the latest user-facing row. The library stamps a `_v` on each stored row, so the migrate router always knows which schema produced the bytes; `_v` itself is library-managed and never appears in user code.

## Same Pattern for KV

The same principle applies to key-value storage, though KV values don't carry a stored version stamp. They're validate-or-default: if the stored value fails validation, the entry falls back to the factory default:

```typescript
import { column, defineKv } from '@epicenter/workspace';
import Type from 'typebox';

const theme = defineKv(
	Type.Object({
		mode: Type.Union([Type.Literal('light'), Type.Literal('dark'), Type.Literal('system')]),
		accentColor: column.string(),
	}),
	() => ({ mode: 'light' as const, accentColor: '#3b82f6' }),
);
```

Each KV value is an atomic blob with a coherent shape. For small objects, validate-or-default is simpler than maintaining a version discriminator.

## The Key Insight

**Granularity match is what makes versioned schemas possible.**

- Tables: row-level writes → row-level schema versions (library stamps `_v` on every write, routes by it on read)
- KV: value-level writes → validate-or-default (no version stamp; bad data resets to the factory default)

If your writes are atomic at some boundary, your schemas can be versioned at that same boundary. Epicenter chooses row/value boundaries, which enables clean schema evolution at the cost of concurrent field editing.

This isn't the right choice for every app. But for apps that need to evolve their schemas over time (which is most apps), it's a powerful pattern that eliminates the "CRDT migration hell" that plagues many local-first applications.
