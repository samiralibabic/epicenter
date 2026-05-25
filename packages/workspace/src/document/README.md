# Workspace Document API

A typed interface over Y.js for apps that need to evolve their data schema over time.

## The Idea

This is a wrapper around Y.js that handles schema versioning. Local-first apps can't run migration scripts, so data has to evolve gracefully. Old data coexists with new. The Workspace API bakes that into the design: define your schemas once with versions, write a migration function, and everything else is typed.

The pattern: a vanilla `openX()` function constructs the workspace's `Y.Doc`, composes `attach*` calls inline, and returns whatever shape your app needs. There is no framework wrapper, just plain functions and the `attach*` primitives. Apps split factory code into `index.ts` (iso doc factory) and `<binding>.ts` (env-specific factory adding persistence/sync). Runtime lifecycle then lives in `session.svelte.ts` for SvelteKit signed-in apps or `client.ts` for singleton clients; see `.claude/skills/workspace-app-layout/SKILL.md`.

```
+----------------------------------------------------------------+
| Your App                                                       |
+----------------------------------------------------------------+
| function openBlog(): { ydoc, tables, ...; dispose }            |
+----------------------------------------------------------------+
| attachTable / attachTables / attachKv                          |
| attachEncryption -> .attachTable / .attachTables / .attachKv    |
| attachIndexedDb / attachYjsLog / attachBroadcastChannel        |
| attachLocalStorage(ydoc, { server, ownerId, keyring })  // encrypted IDB + scoped BC |
| wipeLocalStorage({ server, ownerId })           // delete local data for owner |
| openCollaboration (sync + presence + dispatch)                 |
| attachSqliteMaterializer                                       |
+----------------------------------------------------------------+
| Y.Doc (raw CRDT)                                               |
+----------------------------------------------------------------+
```

## The Pattern: define vs attach vs create

Three prefixes, each with a consistent meaning:

- **`define*`** is pure: no Y.Doc, no side effects. Schemas, KV definitions, action factories.
- **`attach*`** binds a capability to an existing `Y.Doc` (or, in one documented cross-package case, to a sibling attachment). Side-effectful: registers observers or destroy listeners at call time. Returns a typed handle.
- **`create*`** is pure construction: no listeners, no subscriptions at call time. Primitives like `createDisposableCache` return handles that attach later.

See `.agents/skills/attach-primitive/SKILL.md` for the full contract (shape, invariants, barrier naming).

```typescript
import * as Y from 'yjs';
import { column, defineTable, attachTable } from '@epicenter/workspace';

// Pure schema. `_v` is library-managed: never declare it as a column.
const postsTable = defineTable({
  id: column.string(),
  title: column.string(),
});

// Vanilla factory: owns Y.Doc creation, composes attachments
function openBlog() {
  const ydoc = new Y.Doc({ guid: 'blog' });
  const tables = {
    posts: attachTable(ydoc, 'posts', postsTable),
  };
  return {
    ydoc,
    tables,
    [Symbol.dispose]() { ydoc.destroy(); },
  };
}

const workspace = openBlog();
workspace.tables.posts.set({ id: '1', title: 'Hello' });
```

## Composing More

The factory body is where you wire everything. Because you own the return shape, you can expose whatever handles your app needs.

### Encryption (server-managed value encryption)

The encryption coordinator owns sibling attachments: `attachTable` / `attachTables` / `attachKv` are methods on it, not top-level exports.

```typescript
import { attachEncryption } from '@epicenter/workspace';
import type { Keyring } from '@epicenter/encryption';

function openBlog({ keyring }: { keyring: () => Keyring }) {
  const ydoc = new Y.Doc({ guid: 'blog' });
  const encryption = attachEncryption(ydoc, { keyring });
  const tables = encryption.attachTables(myTables);
  const kv = encryption.attachKv(myKv);
  return { ydoc, tables, kv, encryption, [Symbol.dispose]() { ydoc.destroy(); } };
}
```

### Persistence + collaboration

Auth belongs to the app. The workspace factory receives the signed-in identity
(`ownerId` + `keyring` + `auth`) and a WebSocket opener, then passes them to
`attachLocalStorage` and `openCollaboration`. `openCollaboration` wraps the
sync supervisor, mirrors the relay's server-owned presence channel as
`devices`, and runs inbound dispatch frames against the local action registry.

```typescript
import type { SignedIn } from '@epicenter/svelte';
import {
  attachEncryption,
  attachLocalStorage,
  openCollaboration,
  roomWsUrl,
  wipeLocalStorage,
} from '@epicenter/workspace';

function openBlog({
  signedIn,
  deviceId,
}: {
  signedIn: SignedIn;
  deviceId: string;
}) {
  const ydoc = new Y.Doc({ guid: 'blog' });
  const encryption = attachEncryption(ydoc, { keyring: signedIn.keyring });
  const tables = encryption.attachTables(myTables);

  // Server + owner scoped encrypted IDB + cross-tab BroadcastChannel in one call.
  const idb = attachLocalStorage(ydoc, {
    server: signedIn.server,
    ownerId: signedIn.ownerId,
    keyring: signedIn.keyring,
  });

  const collaboration = openCollaboration(ydoc, {
    url: roomWsUrl({
      baseURL: signedIn.auth.baseURL,
      ownerId: signedIn.ownerId,
      guid: ydoc.guid,
      deviceId,
    }),
    openWebSocket: signedIn.auth.openWebSocket,
    onReconnectSignal: signedIn.auth.onStateChange,
    waitFor: idb.whenLoaded,
    actions: {},
  });

  return {
    ydoc, tables, idb, collaboration,
    async wipe() {
      ydoc.destroy();
      await Promise.all([idb.whenDisposed, collaboration.whenDisposed]);
      await wipeLocalStorage({
        server: signedIn.server,
        ownerId: signedIn.ownerId,
      });
    },
    [Symbol.dispose]() { ydoc.destroy(); },
  };
}
```

`attachLocalStorage(ydoc, { server, ownerId, keyring })` derives the IDB
database name and BroadcastChannel key from `server` + `ownerId` + `ydoc.guid`
under a single durable prefix, so two signed-in owners on the same browser
profile never share local storage or exchange plaintext cross-tab updates.
`wipeLocalStorage` deletes every database under that prefix in one call: no
explicit guid list to maintain.

For content documents (rich-text bodies, attachments) that only need bytes-on-the-wire, use `openCollaboration` with an empty `actions: {}` registry. Inbound dispatch frames reply `ActionNotFound`; the byte transport and presence channel are identical.

### Per-row content documents

Tables stay lean (ids, titles, metadata). Rich content lives in a separate per-row content cache keyed on the row's content guid. The row holds the guid; the cache opens a Y.Doc per row on demand. See `apps/fuji/src/lib/browser.ts` for the canonical pattern.

## Design Decisions

**Row-level atomicity.** `set()` replaces the entire row. No field-level updates. Every write is a complete row in the latest schema.

**Migration on read, not on write.** Old data transforms when loaded, not when written. Old rows stay old in storage until explicitly rewritten.

**No write validation.** Writes aren't validated at runtime. TypeScript ensures shape; reads validate and return invalid on corruption.

**No field-level observation.** Observe entire tables or KV keys. Let your UI framework handle field reactivity.

**Why `_v` instead of `v`.** The library-managed version field uses a framework metadata prefix, the same convention as `_id` in MongoDB. Users never declare or read `_v`; the library stamps it on every write and strips it on every read. The underscore makes the reserved key visually distinct in storage dumps.

## Testing

Tests live in `*.test.ts` next to the implementation. Use `new Y.Doc()` for in-memory tests. Migrations are validated by reading old data and checking the result.

## Canonical references

- `apps/whispering/src/lib/whispering/client.ts`: encryption + IndexedDB + BroadcastChannel + per-row materialization
- `apps/fuji/src/lib/browser.ts`: encryption + IndexedDB + sync + server-owned presence
- `packages/workspace/README.md`: quick start
- `packages/workspace/SYNC_ARCHITECTURE.md`: multi-device sync design
