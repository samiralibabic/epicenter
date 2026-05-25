# Workspace Actions, Layout, And Attachments

Detailed guidance for action factories, action return surfaces, JSDoc, workspace file layout, attachment ordering, and `connectWorkspace`.

## Actions

Actions wrap table operations as `defineMutation` (writes) or `defineQuery` (reads). Build them in a small factory that closes over `tables` and `batch`, then attach the result to the bundle returned from your workspace builder.

```typescript
import { defineMutation, defineQuery } from '@epicenter/workspace';
import { Type } from 'typebox';

export function createBlogActions({ tables, batch }) {
	return {
		/**
		 * Mark a post as published and record the publication timestamp.
		 *
		 * Separated from a raw `tables.posts.update()` call because publish
		 * involves setting multiple fields atomically and may trigger side
		 * effects (notifications, RSS rebuild) in future versions.
		 */
		publish: defineMutation({
			description: 'Publish a draft post',
			input: Type.Object({ id: tables.posts.schema.properties.id }),
			handler: ({ id }) => {
				batch(() => {
					tables.posts.update(id, { published: true, publishedAt: Date.now() });
				});
			},
		}),
	};
}

// Inside openBlog() or a createDisposableCache(...) builder:
//   const actions = createBlogActions({ tables, batch });
//   return { id, ydoc, tables, actions, batch, /* ... */ };
```

For full input composition guidance (full-row writes, narrow patches, blanket PATCH, id-only inputs), see [Deriving action input schemas](deriving-action-inputs.md).

### Return shapes: local vs. remote contract

Actions have **two** type surfaces depending on how they're invoked. **Local**
callers see the handler's signature verbatim: sync stays sync, raw stays raw,
throws throw. **Remote** callers (via `collaboration.dispatch()`)
always get `Promise<Result<T, DispatchError>>`: the transport wraps raw values
in `Ok` and converts thrown errors or returned `Err`s into
`Err(DispatchError.ActionFailed)`.

**Rule of thumb:**

- **Return `Err(TypedError)`** for failures local callers should branch on.
- **Throw** for bugs / invariants. On the wire, throws become `ActionFailed`.
  The caller loses the stack and can only say "something broke."
- **Return raw** when failure isn't a meaningful concept for the operation.

Remote peer calls currently expose `DispatchError`, not each handler's typed
error union. If a remote caller needs a narrower failure contract, add an
explicit action surface for that workflow.

For the full matrix (every caller's view of every handler shape, all the
decision trees, and the normalization boundaries), read
[Action return shapes](action-return-shapes.md).

### JSDoc on Action Methods

Every action method inside the `actions` object returned from the workspace builder should have a JSDoc comment. The JSDoc and the `description` field serve **different audiences**:

- **`description`**: consumed by MCP servers, CLI help text, and OpenAPI specs. Keep it short and declarative ("Import skills from disk").
- **JSDoc**: consumed by developers hovering in an IDE. Explain *why* the action exists as a separate operation, what non-obvious behavior it has, or what assumptions it makes.

```typescript
// Bad: Parrots the description
/** Import skills from an agentskills.io-compliant directory. */
importFromDisk: defineMutation({ description: 'Import skills from an agentskills.io-compliant directory', ... })

// Good: Adds distinct value
/**
 * Scan a directory of SKILL.md files and upsert them into the workspace.
 *
 * Skills without a `metadata.id` in their frontmatter get one generated
 * and written back to the file, so future imports produce stable IDs
 * across machines.
 */
importFromDisk: defineMutation({ description: 'Import skills from an agentskills.io-compliant directory', ... })
```

## Workspace File Structure

Each app splits workspace code into an **isomorphic `workspace/` folder** and a **runtime-specific `client.ts`**:

```
src/lib/
|
|-- workspace/                          <- 100% isomorphic (safe for Node, Bun, browser)
|   |-- definition.ts                   <- Schema: defineTable, defineKv, branded IDs
|   |-- actions.ts                      <- Isomorphic action factory: createXActions({ tables, batch })
|   +-- index.ts                        <- Barrel: re-exports definition + actions only
|
+-- client.ts                           <- Runtime singleton: openX() builder composing
                                           attachTables, attachIndexedDb/attachYjsLog,
                                           openCollaboration,
                                           attachEncryption, and runtime-specific actions
```

```
                    +-------------------------+
                    |     definition.ts        |
                    |  tables, KV, branded IDs |
                    +------------+------------+
                                 | imports
                    +------------v------------+
                    |     actions.ts           |
                    |  createXActions factory  |
                    |  ({ tables, batch })     |
                    +------------+------------+
                                 | imports
   +-----------------------------+-----------------------------+
   |                             |                             |
   v                             v                             v
+--------------+   +------------------+   +------------------+
| client.ts    |   | server-client.ts |   | cli-client.ts    |
| (browser)    |   | (Node/Bun)       |   | (CLI)            |
| attachIndex... |   | attachYjsLog     |   | attachYjsLog     |
| openCollab   |   | openCollab       |   | (no sync)        |
| Chrome APIs  |   | Node fs APIs     |   |                  |
+--------------+   +------------------+   +------------------+
```

### Layering Rules

1. **`definition.ts`**: Pure schema. `defineTable()`, `defineKv()`, branded ID types and generators. Isomorphic.
2. **`actions.ts`**: Factory that takes `{ tables, batch }` and returns an action tree of `defineQuery`/`defineMutation`. Isomorphic: no browser/Node APIs.
3. **`index.ts`**: Barrel that re-exports from `definition.ts` and `actions.ts` only. **Never re-exports from `client.ts`.** This is the import path for `$lib/workspace` and the package.json subpath export.
4. **`client.ts`**: Lives **outside** the `workspace/` folder at `src/lib/client.ts`. Exposes an `openX()` builder where runtime-specific attachments are composed (IndexedDB vs SQLite, browser vs Node APIs) and the full bundle is assembled, including runtime-specific actions. Singleton apps export the opened bundle directly (`export const workspace = openX()`). Per-row document caches use `createDisposableCache(builder)` beside that singleton.

### Import Convention

```typescript
// Components/state that need the live workspace instance:
import { workspace, auth } from '$lib/client';

// Components that only need types or the definition:
import { type Note, type NoteId, generateNoteId } from '$lib/workspace';

// Other packages in the monorepo:
import { createHoneycrisp } from '@epicenter/honeycrisp/workspace';
import { honeycrispTables } from '@epicenter/honeycrisp/definition';
```

### Package.json Subpath Exports

Each app exports a single `./workspace` subpath pointing to the barrel:

```json
{
  "exports": {
    "./workspace": "./src/lib/workspace/index.ts"
  }
}
```

The barrel is 100% isomorphic, so this single subpath is safe for any consumer (server, CLI, other apps). The separate `./definition` subpath is no longer needed since the barrel already re-exports everything from `definition.ts`.

### Isomorphic vs Runtime-Specific Actions

Isomorphic actions (table reads/writes, portable logic) belong in the exported `actions.ts` factory. Runtime-specific actions, whether browser APIs, Chrome extension APIs, Node/Bun filesystem calls, or Tauri commands, live in the `client.ts` builder where the relevant attachments and APIs are in scope.

```typescript
// workspace/actions.ts: isomorphic actions (exported via barrel)
export function createMyAppActions({ tables, batch }) {
  return {
    devices: {
      list: defineQuery({
        title: 'List Devices',
        description: 'List all synced devices.',
        input: Type.Object({}),
        handler: () => ({ devices: tables.devices.getAllValid() }),
      }),
    },
  };
}

// src/lib/client.ts: browser-specific attachments + runtime actions
function openMyApp() {
  const ydoc = new Y.Doc({ guid: 'epicenter.myapp' });
  const tables = attachTables(ydoc, myAppTables);
  const idb = attachIndexedDb(ydoc);
  const batch = (fn) => ydoc.transact(fn);

  const actions = defineActions({
    ...createMyAppActions({ tables, batch }),
    tabs_close: defineMutation({
      title: 'Close Tabs',
      description: 'Close browser tabs by ID.',
      input: Type.Object({ tabIds: Type.Array(Type.Number()) }),
      handler: async ({ tabIds }) => {
        await browser.tabs.remove(tabIds);  // Chrome API
        return { closedCount: tabIds.length };
      },
    }),
  });
  const collaboration = openCollaboration(ydoc, {
    url,
    waitFor: idb.whenLoaded,
    openWebSocket,
    replicaId,
    actions,
  });

  return { ydoc, tables, idb, collaboration, actions, batch, /* whenReady, ... */ };
}

export const workspace = openMyApp();
```

## Attachment Ordering

Attachments compose through plain lexical scope, so ordering is explicit: if `openCollaboration` needs to wait for local state, its `waitFor` option reads `idb.whenLoaded`, and `idb` must be defined first.

| Attachment | Typical `waitFor` | Behavior |
|---|---|---|
| `attachYjsLog` | none | Starts loading the Yjs update log immediately |
| `attachIndexedDb` | none | Starts loading IndexedDB immediately |
| `attachEncryption` | (none, sync) | Reads `encryptionKeys()` synchronously at each registration site |
| `openCollaboration` | `idb.whenLoaded` (or another local-load promise) | Opens WebSocket after local replay |

The standard shape is **persistence first, then collaboration with `waitFor`**:

```
attachIndexedDb  -------------> idb.whenLoaded resolves
                                       ->
openCollaboration({ waitFor: idb.whenLoaded }) -----> WebSocket opens -> synced
```

This ordering matters because sync only exchanges the delta between local state and the server. Without persistence loading first, every cold start downloads the full document.

```typescript
// Correct: persistence loads first, collaboration waits for idb, exchanges delta only
createDisposableCache((id) => {
  const ydoc = new Y.Doc({ guid: id });
  const tables = attachTables(ydoc, myTables);
  const idb = attachIndexedDb(ydoc);
  const collaboration = openCollaboration(ydoc, {
    url: roomWsUrl(serverUrl, ydoc.guid),
    waitFor: idb.whenLoaded,
    openWebSocket,
    replicaId,
  });
  return { id, ydoc, tables, idb, collaboration, /* ... */ };
});

// Wrong: collaboration starts before local state is loaded, downloads full document
createDisposableCache((id) => {
  const ydoc = new Y.Doc({ guid: id });
  const collaboration = openCollaboration(ydoc, { url, openWebSocket, replicaId });
  const idb = attachIndexedDb(ydoc);
  return { id, ydoc, idb, collaboration, /* ... */ };
});
```

### `connectWorkspace` (CLI/Script Shortcut)

For server-side Bun scripts, `connectWorkspace` from `@epicenter/cli` handles the unlock to sync chain automatically. It is **ephemeral by design: no local persistence**, so a script can coexist with a long-running `epicenter start` daemon without fighting over the same SQLite file:

```typescript
import { connectWorkspace } from '@epicenter/cli';
import { createFujiWorkspace } from '@epicenter/fuji/workspace';

const workspace = await connectWorkspace(createFujiWorkspace);
// Ready. Authenticated. Syncing. Full doc downloaded from server.

const entries = workspace.tables.entries.getAllValid();
await workspace.dispose();
```

Writes propagate through sync to the daemon, which owns the materializer (markdown, SQLite mirror, etc.).

Use `connectWorkspace` for one-off scripts and agent-written automation. Use `epicenter.config.ts` to register long-running daemon modules and materializers that need persistence and custom workspace-specific extensions. A per-route `daemon.ts` file is a conventional module layout, not a discovery rule.


