# Primitive API (`@epicenter/workspace`)

## When to Read This

Read when composing any Y.Doc in the app: the top-level workspace doc, per-row content docs, settings, skills, or any other standalone Y.Doc. The builder owns `new Y.Doc(...)` and every `attach*` call. Use a direct `openX()` builder for singleton workspaces; wrap the builder in `createDisposableCache(...)` only when multiple consumers open documents by id.

`.withDocument()` on tables was removed. Per-row content docs are now their own `createDisposableCache`, keyed on the row's content guid.

## The Primitive: Just Y.Doc + attach\*

You construct a `Y.Doc` yourself and call `attach*` functions on it. `ydoc.destroy()` is the teardown. A builder closure returns the bundle:

```typescript
import {
  attachIndexedDb,
  attachRichText,
  onLocalUpdate,
  openCollaboration,
} from '@epicenter/workspace';
import * as Y from 'yjs';

function buildMyDoc(id: string) {
  // gc: false because the doc syncs. GC'd deletion markers break peers that
  // haven't seen the deletes. Only set true for purely local, ephemeral docs.
  const ydoc = new Y.Doc({ guid: id, gc: false });

  const content = attachRichText(ydoc);
  const idb = attachIndexedDb(ydoc);
  const collaboration = openCollaboration(ydoc, {
    url,
    openWebSocket,
    replicaId,
    waitFor: idb.whenLoaded,
  });

  onLocalUpdate(ydoc, () => { /* bump parent row updatedAt, etc. */ });

  return {
    ydoc,
    content,
    idb,
    collaboration,
    [Symbol.dispose]() { ydoc.destroy(); },
  };
}
```

Consumers await readiness through the attached subsystem (`handle.idb.whenLoaded`) rather than a flat `whenReady` alias. Add a top-level `whenReady` only when it composes two or more subsystem signals into one `Promise.all` (see `specs/20260506T020000-expose-attachments-not-aliases.md`).

Everything you need is in Yjs itself:

- `new Y.Doc({ guid, gc })`: allocate.
- `ydoc.destroy()`: teardown (fires `'destroy'`; every `attach*` self-registers cleanup via `ydoc.on('destroy', ...)`).
- `onLocalUpdate(ydoc, fn)`: side effects triggered only by **local** transactions (e.g. bumping a parent row's `updatedAt`). Filters out remote sync updates so you don't loop.

The builder is a plain function. For a cached, refcounted fan-out surface (shared handles, grace-period teardown), wrap it with `createDisposableCache`. See below.

## Attach Helpers

Each helper takes a `Y.Doc` and registers cleanup on `ydoc.on('destroy')`. Each returns only what it actually knows.

| Helper | Returns |
|---|---|
| `attachIndexedDb(ydoc)` | `{ whenLoaded, clearLocal, whenDisposed }` |
| `openCollaboration(ydoc, { url, openWebSocket?, replicaId, actions?, waitFor? })` | `{ whenConnected, status, onStatusChange, reconnect, whenDisposed, peers, dispatch }` |
| `attachRichText(ydoc)` | `RichTextAttachment`: `{ read, write, binding: Y.XmlFragment }` |
| `attachPlainText(ydoc)` | `PlainTextAttachment`: `{ read, write, binding: Y.Text }` |
| `attachTable(ydoc, name, def)` | Typed row helper over `Y.Map` |
| `attachKv(ydoc, defs)` | Typed KV helper |

`openCollaboration`'s `waitFor` gates the first connection attempt on another promise, typically `idb.whenLoaded`, so the first handshake exchanges only a delta, not the full document.

> **`attach*` is NOT idempotent.** Hold the reference from the first call. Calling any `attach*` helper twice against the same `Y.Doc` + slot is a caller bug; the framework does not catch it. For observer-installing primitives (`attachTable`, `attachKv`, `attachEncryption`) double-attach silently installs duplicate observers, causing undefined behavior. One attach site per slot, one reference, held for the life of the `Y.Doc`.

## Encrypted Variants (from `@epicenter/workspace`)

For workspaces that need at-rest encryption, the coordinator owns the sibling attachments as methods. There are no top-level `attachEncryptedX` exports.

| Helper | Purpose |
|---|---|
| `attachEncryption(ydoc, { encryptionKeys })` | Per-ydoc encryption coordinator. Returns `{ attachTable, attachTables, attachKv, attachIndexedDb, ... }`. Reads `encryptionKeys()` synchronously at every registration site. Teardown is synchronous and cascades from `ydoc.destroy()`. |
| `encryption.attachTable(name, def)` | Singular encrypted table; self-registers with the coordinator and is activated with the current keyring before being returned. |
| `encryption.attachTables(defs)` | Batch sugar over `encryption.attachTable`. |
| `encryption.attachKv(defs)` | Encrypted KV singleton. |
| `encryption.attachIndexedDb(targetYdoc, { userId })` | Encrypted local IndexedDB persistence for a root or child Y.Doc. |

Standard composition:

```ts
const ydoc       = new Y.Doc({ guid: id, gc: false });
const encryption = attachEncryption(ydoc, {
	encryptionKeys: () => requireSignedIn(auth).encryptionKeys,
});
const tables     = encryption.attachTables(myTables);
const kv         = encryption.attachKv(myKv);
```

Keys are read through the `encryptionKeys` callback when an encrypted resource is attached. There is no separate `applyKeys` step: registration and activation happen in one call. Already-attached encrypted stores keep the keyring they derived at attach time; same-user key rotation needs a re-attach to affect those stores. `encryptionKeys()` should throw if no keys are available (for example, signed-out): a throw means the workspace outlived its signed-in scope, which is a caller bug. The `requireSignedIn(auth)` helper from `@epicenter/auth` does exactly that.

Encryption is opt-in per slot; the coordinator carries the intent. Plaintext `attachTable(ydoc, name, def)` (top-level) and encrypted `encryption.attachTable(name, def)` (method) are both available; pick one per slot.

> **Never mix plaintext and encrypted wrappers on the same slot name.** Yjs returns the same underlying `Y.Array` to `attachTable(ydoc, 'posts', ...)` and `encryption.attachTable('posts', ...)` because `ydoc.getArray('table:posts')` is idempotent. If both run, the plaintext wrapper writes plaintext into the same yarray the encrypted wrapper thinks it owns, a silent data-at-rest leak. The framework does not catch this; the grep-able call-site shape (`encryption.attach*` vs top-level `attach*`) is the defense. One slot name, one variant, one intent.

IDB / broadcast / collaboration / sqlite transitively see already-encrypted bytes once encryption is registered. The Yjs update stream carries ciphertext blobs inside it. No additional encryption setup is needed at those transport layers.

## Readiness Signals: Split, Don't Precompose

Each helper returns what it actually knows. Callers compose at the call site.

- `idb.whenLoaded`: "local draft is in memory, edits are safe" (offline-first UI usually only needs this).
- `collaboration.whenConnected`: "transport established, first sync exchange finished" (CLIs that need remote state await this).

There is no `whenSynced` composite. If you need both, call `Promise.all([idb.whenLoaded, collaboration.whenConnected])` at the call site. This is intentional: `y-indexeddb`'s upstream `whenSynced` is a misnomer (it's local load, not convergence).

## Canonical Per-Row Content Doc

Replaces the old `.withDocument('content', { content: richText, guid: 'id', onUpdate })` on a table. The builder closure passes directly to `createDisposableCache`. No named intermediate function is needed. The default `gcTime` is 5 seconds.

```typescript
// apps/fuji/src/lib/entry-content-docs.ts
import {
  attachIndexedDb,
  attachRichText,
  createDisposableCache,
  docGuid,
  onLocalUpdate,
  openCollaboration,
  roomWsUrl,
} from '@epicenter/workspace';
import * as Y from 'yjs';
import { auth, workspace } from '$lib/client';

export const entryContentDocs = createDisposableCache((entryId: EntryId) => {
  const ydoc = new Y.Doc({
    guid: docGuid({
      workspaceId: workspace.id,  // no literal prefix: comes from the workspace
      collection: 'entries',
      rowId: entryId,
      field: 'content',
    }),
    gc: false,
  });

  const content = attachRichText(ydoc);
  const idb = attachIndexedDb(ydoc);
  const collaboration = openCollaboration(ydoc, {
    url: roomWsUrl(APP_URLS.API, ydoc.guid),
    openWebSocket: auth.openWebSocket,
    replicaId,
    waitFor: idb.whenLoaded,
  });

  // Local-only side effect: bump parent row when the user edits.
  // Filters out remote sync updates so we don't loop.
  onLocalUpdate(ydoc, () => {
    workspace.tables.entries.update(entryId, { updatedAt: DateTimeString.now() });
  });

  return {
    ydoc,
    content,
    idb,
    collaboration,
    // Consumers await `handle.idb.whenLoaded` directly. Add a
    // `whenReady: Promise.all([...])` field only when the bundle has
    // two or more subsystem signals to compose into one barrier
    // (e.g. `Promise.all([persistence.whenLoaded, unlock.whenChecked,
    // collaboration.whenConnected])`). A flat `whenReady: idb.whenLoaded`
    // alias lies about composition; expose the subsystem instead.
    // See specs/20260506T020000-expose-attachments-not-aliases.md.
    [Symbol.dispose]() { ydoc.destroy(); },
  };
});
```

Component owns the handle; the cache owns identity and the grace-period timer:

```svelte
<script lang="ts">
  import { entryContentDocs } from '$lib/entry-content-docs';
  let { row } = $props();
  $effect(() => {
    using handle = entryContentDocs.open(row.id);  // openCount++
    // [Symbol.dispose] fires on block exit; openCount--; gcTime timer arms
  });
</script>

{#await handle.whenReady}
  <Spinner />
{:then}
  <RichEditor binding={handle.content.binding} />
{/await}
```

Two tabs editing the same entry reconcile at the Yjs layer (IndexedDB + sync). The `createDisposableCache` cache dedupes in-process handles to the same `entryId`.

### `open(id)`: the only entry point

`cache.open(id)` returns `T & Disposable` synchronously. There is no `cache.load()`. Imperative callers pair `.open()` with `await handle.whenReady` at the call site when the builder exposes one:

```typescript
// Reactive: render gates on handle.whenReady inside {#await} or $effect.
$effect(() => {
  using handle = entryContentDocs.open(row.id);
  // subscribe to reactive state; nested effect can await readiness if needed
});

// Imperative: read/write from an action handler, CLI, or test.
async function readInstructions(id: SkillId): Promise<string> {
  await using h = instructionsDocs.open(id);
  await h.whenReady;           // builder convention: await what you need
  return h.instructions.read();
  // `await using` disposes h at scope exit; refcount--, gcTime timer arms.
}
```

`whenReady` is an optional `Promise<unknown>` field on the returned bundle. It earns its place only when it composes two or more attachment signals into one barrier (`Promise.all([...])`). When a bundle has a single async subsystem, expose the subsystem (`idb`, `persistence`, ...) and let consumers reach through (`handle.idb.whenLoaded`); a flat `whenReady: idb.whenLoaded` alias lies about composition and is the anti-pattern called out in `specs/20260506T020000-expose-attachments-not-aliases.md`. Composed `whenReady` fields are consumed by the CLI's `run` command, Whispering's migrations, `@epicenter/filesystem` ops, the sqlite-index materializer, and editor `{#await}` gates. Builders with nothing async to wait on can omit the field entirely. Consumers can pick a more specific gate at the call site:

```typescript
using h = docs.open(id);
await h.whenReady;            // builder-composed aggregate, if exposed
// or:
await h.idb.whenLoaded;       // specific attachment readiness
// or:
/* nothing: handle is already usable for this caller's purposes */
```

If a test or daemon needs a teardown barrier after disposal, opt into the attachment-level promise field:

```typescript
const h = docs.open(id);
h[Symbol.dispose]();
await h.idb.whenDisposed;     // attachment-level, not bundle-level
```

`whenReady` is the bundle-level readiness convention. Disposal is fully attachment-driven: each attachment self-registers cleanup on `ydoc.on('destroy')`, and `[Symbol.dispose]()` is synchronous. There's no aggregated bundle-level disposal barrier. Callers needing one (tests that close-then-reopen, CLI exit) reach for a specific attachment barrier at the call site (`await h.idb.whenDisposed`).

## GUID Convention

Every content-doc `Y.Doc` GUID follows a **4-part dotted form**:

```
${workspaceId}.${collection}.${rowId}.${field}
```

| Segment | Owner | Purpose | Example |
|---|---|---|---|
| `workspaceId` | **caller** | globally-unique workspace identity | `epicenter-fuji` |
| `collection` | **package/app** | namespace inside the workspace (not tied to the table name in the workspace schema) | `entries`, `notes`, `files`, `skills`, `references` |
| `rowId` | caller | identifies the row this doc hangs off | `entry_01H…` |
| `field` | **package/app** | which collaborative field this doc holds | `content`, `body`, `instructions` |

Rules:

- **`workspaceId` is required** at the cache factory level: no defaults. A default collapses IDB namespaces across apps that share a package, so two callers defaulting to the same literal would collide on disk.
- **`collection` is owned by the producer**, not a parameter. `createFileContentDocs` always writes `files` as the collection segment regardless of what the caller named their table. That's the point: the GUID namespace is independent of the workspace schema name.
- **`field` matches the returned key.** If the GUID ends in `.body`, the bundle should expose `{ body }`, not `{ content }`. Keeps domain vocabulary consistent from GUID to call site.
- **Separator is `.`** everywhere. No hyphens, no slashes. Workspace-level docs should follow the same dotted shape (e.g. `${workspaceId}.workspace.${epoch}`) rather than inventing their own separator.

For a package cache factory shared across apps, the shape is:

```typescript
export function createFileContentDocs({
  workspaceId,   // required: caller's workspace identity
  filesTable,    // caller injects the table to write back to
  persistence = 'indexeddb',
}: {
  workspaceId: string;
  filesTable: Table<FileRow>;
  persistence?: 'indexeddb' | 'none';
}) {
  return createDisposableCache((fileId: FileId) => {
    const ydoc = new Y.Doc({
      guid: docGuid({ workspaceId, collection: 'files', rowId: fileId, field: 'content' }),
      gc: false,
    });
    // …
  });
}
```

## Anti-Patterns

```typescript
// ❌ Don't reach through handle.ydoc to grab the raw Y type
const fragment = handle.ydoc.getXmlFragment('content');

// ✅ Use the attachment's API
handle.content.read();
handle.content.write('hello');
handle.content.binding;  // for editor bindings (Y.XmlFragment / Y.Text)
```

```typescript
// Don't compose a "whenSynced" that Promise.alls idb + collaboration
// You're hiding which signal the caller actually depends on.

// Expose atoms; compose at the call site only when you truly need both
await doc.whenLoaded;                                         // typical UI
await Promise.all([doc.whenLoaded, doc.whenConnected]);       // CLI needing remote state
```

```typescript
// ❌ Don't pass gc: true on a synced doc
new Y.Doc({ guid, gc: true });  // peers lose deletion markers

// ✅ Default to gc: false; only opt in for purely local ephemeral docs
new Y.Doc({ guid, gc: false });
```

## One primitive for every doc

There is no separate workspace/document split anymore. The app's top-level workspace doc is usually a direct `openX()` builder with `attachTables` + `attachKv` + persistence + `openCollaboration` inside. Per-row content docs use `createDisposableCache` with `attachRichText` / `attachPlainText` / `attachTimeline` + their own persistence + `openCollaboration`. Those are keyed by id and refcounted by the cache.

## Code References

- `packages/workspace/src/cache/disposable-cache.ts`: the cache + refcount primitive
- `packages/workspace/src/document/attach-indexed-db.ts`: persistence attach
- `packages/workspace/src/document/open-collaboration.ts`: sync, presence, peers, and remote dispatch
- `packages/workspace/src/document/attach-rich-text.ts`, `attach-plain-text.ts`
- `apps/fuji/src/lib/entry-content-doc.ts`: canonical per-row example
- `apps/tab-manager/src/lib/client.ts`: canonical workspace-scale example
