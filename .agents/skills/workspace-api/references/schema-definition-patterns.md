# Workspace Schema Definition Patterns

Detailed guidance for `defineTable`, `defineKv`, row type inference, scalar KV design, and branded table IDs.

## Tables

### Shorthand (Single Version)

Use when a table has only one version:

```typescript
import { defineTable } from '@epicenter/workspace';
import { type } from 'arktype';

const usersTable = defineTable(type({ id: UserId, email: 'string', _v: '1' }));
export type User = InferTableRow<typeof usersTable>;
```

Every table schema must include `_v` with a number literal. The type system enforces this: passing a schema without `_v` to `defineTable()` is a compile error.

### Variadic (Multiple Versions)

Use when you need to evolve a schema over time:

```typescript
const posts = defineTable(
	type({ id: 'string', title: 'string', _v: '1' }),
	type({ id: 'string', title: 'string', views: 'number', _v: '2' }),
).migrate((row) => {
	switch (row._v) {
		case 1:
			return { ...row, views: 0, _v: 2 };
		case 2:
			return row;
	}
});
```

### Row Type Inference

**Always derive row types with `InferTableRow<typeof X>` against the table definition.** Export the type from the same file that calls `defineTable()`. Consumers `import type` it directly: never re-derive.

```typescript
// Good: schema is the single source of truth
const postsTable = defineTable(/* ... */);
export type Post = InferTableRow<typeof postsTable>;
```

```typescript
// Bad: goes through the runtime Table instance
type Post = ReturnType<typeof workspace.tables.posts.getAllValid>[number];

// Bad: same smell with different method
type Post = ReturnType<typeof workspace.tables.posts.getAll>[number];
```

Why `InferTableRow` is better:
- Source of truth is the schema, not a method signature.
- Doesn't require importing/building the runtime client (works in workers, server code, isomorphic modules).
- Survives method renames and signature changes.
- Matches the convention used across every app in this repo.

**Don't relay types through state files.** Reactive state files (e.g. `*.svelte.ts`) should `import type` from the workspace definition module, not redefine or re-export the row type. Other consumers should also import the type directly from the workspace module: not from the state file. State files export runtime values; the workspace module exports types.

```typescript
// state/posts.svelte.ts
import type { Post } from '$lib/workspace';     // Good: import directly
// export type { Post };                         // Bad: pass-through re-export

// some-component.svelte
import { posts } from '$lib/state/posts.svelte';  // runtime
import type { Post } from '$lib/workspace';        // type: same source as state file
```

## KV Stores

KV stores use `defineKv(schema, defaultValue)`. No versioning, no migration: invalid stored data falls back to the default.

```typescript
import { defineKv } from '@epicenter/workspace';
import { type } from 'arktype';

const sidebar = defineKv(type({ collapsed: 'boolean', width: 'number' }), { collapsed: false, width: 300 });
const fontSize = defineKv(type('number'), 14);
const enabled = defineKv(type('boolean'), true);
```

### KV Design Convention: One Scalar Per Key

Use dot-namespaced keys for logical groupings of scalar values:

```typescript
// Good: each preference is an independent scalar
'theme.mode': defineKv(type("'light' | 'dark' | 'system'"), 'light'),
'theme.fontSize': defineKv(type('number'), 14),

// Bad: structured object invites migration needs
'theme': defineKv(type({ mode: "'light' | 'dark'", fontSize: 'number' }), { mode: 'light', fontSize: 14 }),
```

With scalar values, schema changes either don't break validation (widening `'light' | 'dark'` to `'light' | 'dark' | 'system'` still validates old data) or the default fallback is acceptable (resetting a toggle takes one click).

Exception: discriminated unions and `Record<string, T> | null` are acceptable when they represent a single atomic value.

## Branded Table IDs (Required)

Every table's `id` field and every string foreign key field MUST use a branded type instead of plain `'string'`. This prevents accidental mixing of IDs from different tables at compile time.

### Pattern

Define a branded type + arktype validator + generator in the same file as the workspace definition:

```typescript
import type { Brand } from 'wellcrafted/brand';
import { type } from 'arktype';
import { generateId, type Id } from '@epicenter/workspace';

// 1. Branded type + arktype validator (co-located with workspace definition)
export type ConversationId = Id & Brand<'ConversationId'>;
export const ConversationId = type('string').as<ConversationId>();

// 2. Generator function: the ONLY place with the cast
export const generateConversationId = (): ConversationId =>
	generateId() as ConversationId;

// 3. Use in defineTable + co-locate type export
const conversationsTable = defineTable(
	type({
		id: ConversationId,              // Primary key: branded
		title: 'string',
		'parentId?': ConversationId.or('undefined'),  // Self-referencing FK
		_v: '1',
	}),
);
export type Conversation = InferTableRow<typeof conversationsTable>;

// 4. At call sites: use the generator, never cast directly
const newId = generateConversationId();  // Good
// const newId = generateId() as string as ConversationId;  // Bad
```
