# Table and KV CRUD + Observation

## When to Read This

Read when implementing table/KV read-write operations, observation callbacks, or reactive integration guidance.

## Reading & Observing Data

### Table CRUD

Read methods return wellcrafted `Result<T, TableParseError>`. "Not found" on `get()` / `update()` is **not** an error: it surfaces as `data: null`. Parse failures (unknown `_v`, schema mismatch, migration throw) surface as `error: TableParseError`.

```typescript
import { TableParseError } from '@epicenter/workspace';

const { data: note, error } = tables.notes.get(id);
if (error) {
  // TableParseError: UnknownVersion | ValidationFailed | MigrationFailed
  logger.warn(error);
  return;
}
if (note === null) {
  // legitimate absence
  return;
}
// note is the user-facing row (no _v)
```

Full surface:

```typescript
table.get(id)                       // Result<TRow | null, TableParseError>
table.getAll()                      // Array<Result<TRow, TableParseError>>
table.getAllValid()                 // TRow[]              : drops invalid rows
table.getAllInvalid()               // TableParseError[]   : only the failures
table.filter(predicate)             // TRow[]              : predicate over valid rows
table.find(predicate)               // TRow | undefined    : first valid match
table.has(id)                       // boolean
table.count()                       // number

table.set(row)                      // upsert full row (replaces entire row)
table.bulkSet(rows, { chunkSize?, onProgress? })   // Promise<void>
table.update(id, partial)           // Result<TRow | null, TableParseError>
table.delete(id)                    // remove row
table.bulkDelete(ids, { chunkSize?, onProgress? }) // Promise<void>
table.clear()                       // remove every row
```

`set` and `update` accept the user-facing row shape: no `_v`. The library stamps the current version onto storage. `update`'s partial may not contain `id`.

### KV CRUD

```typescript
kv.get('key')              // returns Static<S>; falls back to defaultValue() on miss or invalid
kv.set('key', value)       // upsert
kv.delete('key')           // remove (subsequent get returns defaultValue())
kv.getAll()                // { [key]: Static<S> }  : uses defaultValue() for unset keys
```

### Observation

Tables and KV stores support change observation for reactive updates:

```typescript
// Table: callback receives changed row IDs per Y.Transaction
const unsub = tables.notes.observe((changedIds) => {
  for (const id of changedIds) {
    const { data: note, error } = tables.notes.get(id);
    if (error || note === null) continue;
    // ...
  }
});

// KV: per-key observation
const unsub = kv.observe('theme.mode', (change) => {
  if (change.type === 'set') { /* change.value */ }
  if (change.type === 'delete') { /* fell back to default */ }
});

// KV: observe every registered key in one callback
const unsub = kv.observeAll((changes) => {
  for (const [key, change] of changes) { /* ... */ }
});
```

**In Svelte apps**, prefer `fromTable`/`fromKv` from `@epicenter/svelte` instead of raw observers. See the `svelte` skill for the reactive table state pattern.
