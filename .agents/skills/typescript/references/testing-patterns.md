# Testing Patterns

## When to Read This
Read this when writing TypeScript tests or deciding how to organize test files relative to source modules.

# Inline Definitions in Tests

## Prefer Inlining Single-Use Definitions

When a schema, builder, or configuration is only used once in a test, inline it directly at the call site rather than extracting to a variable.

### Bad Pattern (Extracted Variables)

```typescript
test('attaches tables to a Y.Doc', () => {
	const posts = defineTable(type({ id: 'string', title: 'string', _v: '1' }));

	const theme = defineKv(type("'light' | 'dark'"), 'light');

	const ydoc = new Y.Doc({ guid: 'test-app' });
	const tables = attachTables(ydoc, { posts });
	const kv = attachKv(ydoc, { theme });

	expect(ydoc.guid).toBe('test-app');
});
```

### Good Pattern (Inlined)

```typescript
test('attaches tables to a Y.Doc', () => {
	const ydoc = new Y.Doc({ guid: 'test-app' });
	const tables = attachTables(ydoc, {
		posts: defineTable(type({ id: 'string', title: 'string', _v: '1' })),
	});
	const kv = attachKv(ydoc, {
		theme: defineKv(type("'light' | 'dark'"), 'light'),
	});

	expect(ydoc.guid).toBe('test-app');
});
```

### Why Inlining is Better

1. **All context in one place**: No scrolling to understand what `posts` or `theme` are
2. **Reduces naming overhead**: No need to invent variable names for single-use values
3. **Matches mental model**: The definition IS the usage - they're one conceptual unit
4. **Easier to copy/modify**: Self-contained test setup is easier to duplicate and tweak

### When to Extract

Extract to a variable when:

- The value is used **multiple times** in the same test
- You need to call **methods on the result** (e.g., `posts.migrate()`, `posts.versions`)
- The definition is **shared across multiple tests** in a `beforeEach` or test fixture
- The inline version would exceed ~15-20 lines and hurt readability

### Applies To

- `defineTable()`, `defineKv()`, `createDisposableCache()` builders
- `attachTables()`, `attachKv()` factory calls
- Schema definitions (arktype, zod, etc.)
- Configuration objects passed to factories
- Mock functions used only once

# Test File Organization

## Shadow Source Files with Test Files

Each source file should have a corresponding test file in the same directory:

```
src/static/
├── schema-union.ts
├── schema-union.test.ts      # Tests for schema-union.ts
├── define-table.ts
├── define-table.test.ts      # Tests for define-table.ts
├── create-tables.ts
├── create-tables.test.ts     # Tests for create-tables.ts
└── types.ts                  # No test file (pure types)
```

### Benefits

- **Clear ownership**: Each test file tests exactly one source file
- **Easy navigation**: Find tests by looking next to the source
- **Focused testing**: Easier to run tests for just one module
- **Maintainability**: When source changes, you know which test file to update

### What Gets Test Files

| File Type                      | Test File? | Reason                                |
| ------------------------------ | ---------- | ------------------------------------- |
| Functions/classes with logic   | Yes        | Has behavior to test                  |
| Type definitions only          | No         | No runtime behavior                   |
| Re-export barrels (`index.ts`) | No         | Just re-exports, tested via consumers |
| Internal helpers               | Maybe      | Test via consumer if tightly coupled  |

### Naming Convention

- Source: `foo-bar.ts`
- Test: `foo-bar.test.ts`

### Integration Tests

For tests spanning multiple modules, either:

- Add to the test file of the highest-level consumer
- Create a dedicated `[feature].integration.test.ts` if substantial
