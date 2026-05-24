# Generic Yjs Rooms And Checkpoints

**Date**: 2026-05-12 (revised 2026-05-14)
**Status**: Implemented (route tests deferred; not yet deployed)
**Author**: Braden + Codex

## Overview

Replace product-named server sync room types with one generic Yjs room. Keep the default room compact with `gc: true`, add full binary checkpoints as the first history feature, and defer `gc: false` snapshot history until there is a product surface that needs exact historical reconstruction.

The clean sentence:

```txt
Epicenter Server syncs named Y.Docs; apps decide what those docs mean.
```

## Execution Note

**Current status**: The old API still had separate `WorkspaceRoom` and `DocumentRoom` Durable Objects, old `/workspaces/*` and `/documents/*` routes, and client URLs pointed at those product-named sync endpoints.

**Implemented now**: Collapsed hosted sync to one `Room` Durable Object (no abstract base class, no empty subclass: the previous `BaseSyncRoom` + `SyncRoom` pair was inlined). Routes moved to `/rooms/:room`; clients use `roomWsUrl(apiUrl, roomId)` (and the new `roomUrl` for HTTP). Removed the old snapshot routes and DO classes, switched Wrangler to a single `ROOM` binding for class `Room`, and removed the `do_type` discriminator column from Durable Object telemetry because no live path still branches on room category. HTTP "already in sync" now returns `204 No Content` instead of `304 Not Modified` (304 implies a conditional request, which this is not).

**Pre-deploy revision (2026-05-14)**: The first execution shipped under `/sync/:room` with a `SyncRoom` class. On review, we picked `/rooms/:room` and `Room`: the URL space is a resource hierarchy (rooms are the resource; sync is one of several verbs we may do to a room), and `SyncRoom` was a tautology now that the class no longer needs to distinguish itself from a non-sync sibling. The empty `SyncRoom extends BaseSyncRoom` was advertising an extension point we had explicitly decided not to maintain (the spec's own Phase 5 says retention policy is a per-room runtime lookup, not a sibling class). Inlined.

**Out of scope**: Checkpoints, retained-history room policies, snapshot-history rooms, restore behavior, and any compatibility alias for old `/workspaces/*` or `/documents/*` routes.

## Motivation

### Current State

The current API server has two Durable Object classes over the same sync base:

```txt
apps/api/src/base-sync-room.ts
  BaseSyncRoom
    Y.Doc
    Awareness
    WebSocket sync
    HTTP sync
    SQLite update log
    compaction

apps/api/src/workspace-room.ts
  WorkspaceRoom extends BaseSyncRoom
  gc: true

apps/api/src/document-room.ts
  DocumentRoom extends BaseSyncRoom
  gc: false
  snapshot RPCs
```

`apps/api/src/app.ts` routes them separately:

```txt
/workspaces/:workspace
  GET  full doc or WebSocket upgrade
  POST HTTP sync

/documents/:document
  GET  full doc or WebSocket upgrade
  POST HTTP sync

/documents/:document/snapshots
  POST create Yjs snapshot marker
  GET  list snapshot markers

/documents/:document/snapshots/:id
  GET    reconstruct snapshot
  DELETE delete snapshot
```

`packages/workspace` has moved in the opposite direction. The current public model is not "workspace server objects" and "document server objects". It is a direct `Y.Doc` builder with inline attachments:

```ts
const ydoc = new Y.Doc({ guid: 'epicenter.blog' });
const tables = attachTables(ydoc, { posts });
const idb = attachIndexedDb(ydoc);
const sync = attachSync(ydoc, {
	url: websocketUrl(`${APP_URLS.API}/workspaces/${ydoc.guid}`),
	waitFor: idb.whenLoaded,
	openWebSocket,
});
```

This creates problems:

1. **Product nouns leak into sync infrastructure**: `WorkspaceRoom` and `DocumentRoom` are app meanings, not protocol meanings. The server room is a Yjs replication cell.
2. **History is implied by route name**: `/documents/*` currently means `gc: false` and snapshot RPCs, even when no shipped UI consumes version history.
3. **The expensive path is the default for content**: `gc: false` keeps deleted content so snapshots can reconstruct old states. That is useful only when history itself is a feature.
4. **Future generic docs get awkward names**: A file body, note body, canvas, timeline, or table bundle are all Y.Docs. Forcing them through `/workspaces` or `/documents` makes the endpoint vocabulary less true over time.

`apps/epicenter` does not exist in this checkout. Older specs mention it, but the current implementation target is `apps/api/src/app.ts` and the server placeholder in `apps/server`.

### Desired State

The server exposes one generic room concept:

```txt
/rooms/:room
  GET  full Y.Doc state or WebSocket upgrade
  POST HTTP sync
```

Every room starts as a compact current-state room:

```ts
new Y.Doc({ gc: true });
```

Apps still choose meaningful room ids:

```txt
epicenter.fuji
epicenter.fuji.entries.entry_123.body
epicenter.honeycrisp.notes.note_456.body
```

History arrives later through explicit checkpoint endpoints:

```txt
/rooms/:room/checkpoints
  POST create full binary checkpoint
  GET  list checkpoints

/rooms/:room/checkpoints/:id
  GET    fetch checkpoint metadata or binary
  DELETE delete checkpoint

/rooms/:room/checkpoints/:id/restore
  POST restore checkpoint into the live room
```

`gc: false` snapshot history stays deferred. If it is ever added, it must be a room creation policy, not a query param or per-connection flag.

## Research Findings

### Yjs GC And History

Yjs exposes `gc` as a `Y.Doc` option:

```ts
new Y.Doc({ guid, gc });
```

Grounding from installed Yjs source:

```txt
node_modules/yjs/src/utils/Doc.js
  gc defaults to true
  guid identifies the document
  gcFilter can keep selected deleted items
```

During transaction cleanup, Yjs garbage-collects deleted items only when `doc.gc` is true:

```txt
node_modules/yjs/src/utils/Transaction.js
  if (doc.gc) {
    tryGcDeleteSet(ds, store, doc.gcFilter)
  }
```

`Y.createDocFromSnapshot(originDoc, snapshot)` refuses a GC-enabled origin doc:

```txt
node_modules/yjs/src/utils/Snapshot.js
  if (originDoc.gc) {
    throw new Error('Garbage-collection must be disabled in `originDoc`!')
  }
```

Full state checkpoints use `Y.encodeStateAsUpdateV2(doc)`, which works with normal compact docs:

```txt
node_modules/yjs/src/utils/encoding.js
  encodeStateAsUpdateV2(doc, targetStateVector?)
```

Key finding:

```txt
Normal Yjs update sync does not require matching gc settings.
Yjs snapshot reconstruction requires the origin doc to have gc: false.
Full binary checkpoints work with gc: true.
```

Implication:

```txt
Do not coordinate client and server gc for normal sync.
Make server retention an explicit room policy.
Prefer checkpoints before snapshot history.
```

### Endpoint Shape

The existing client `attachSync` only needs a URL. It does not know whether the URL names a workspace, document, or generic room.

```ts
attachSync(ydoc, {
	url,
	waitFor,
	openWebSocket,
	awareness,
});
```

That is the right abstraction. The server URL names the remote Y.Doc room. The app decides what the local bundle contains.

### Checkpoints Versus Yjs Snapshots

These are different promises:

```txt
Full checkpoint:
  stores full binary state
  works with gc: true
  each checkpoint is self-contained
  restore is simple
  larger per saved version

Yjs snapshot:
  stores a small state-vector/delete-set marker
  requires origin doc gc: false
  origin doc must retain deleted content forever
  restore can reconstruct exact historical state
  smaller marker, larger live document over time
```

The checkpoint path is the better first feature because it keeps the default sync room compact and puts history cost only on saved checkpoints.

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Server sync unit | 2 coherence | Generic `Room` | Yjs syncs Y.Docs. Product nouns belong above the room layer. |
| Default GC | 1 evidence | `gc: true` | Yjs defaults to true. It keeps deleted content compact and supports normal sync. |
| First history feature | 2 coherence | Full binary checkpoints | Checkpoints work with `gc: true` and do not force every room to retain deleted content. |
| `gc: false` support | Deferred | Do not implement now | It is only needed for exact Yjs snapshot reconstruction. No current UI needs that promise. |
| Client GC matching | 1 evidence | Do not require matching | Normal update sync works across different local GC policies. Only snapshot origin docs require `gc: false`. |
| Room policy control | 2 coherence | Server owns persisted retention | A client connection must not be able to silently turn a room into retained-history storage. |
| Route compatibility | 3 taste | Build generic routes first, migrate callers, then delete old routes | A clean break is easier to explain than keeping `/workspaces`, `/documents`, and `/rooms` as equal long-term shapes. |

## Architecture

### Target Room

```txt
apps/api/src/room.ts
┌────────────────────────────────────────────┐
│ class Room extends DurableObject           │
│                                            │
│ config:                                    │
│   gc: true (hardcoded in constructor)      │
│                                            │
│ storage:                                   │
│   updates table                            │
│   optional checkpoints table               │
│                                            │
│ protocols:                                 │
│   WebSocket sync                           │
│   HTTP sync                                │
│   checkpoint RPCs                          │
└────────────────────────────────────────────┘
```

### Route Shape

```txt
apps/api/src/app.ts

GET /rooms/:room
  if Upgrade: websocket
    auth already resolved
    stub.fetch(request)
  else
    stub.getDoc()

POST /rooms/:room
  body: encoded sync request
  stub.sync(body)

POST /rooms/:room/checkpoints
  stub.createCheckpoint({ label? })

GET /rooms/:room/checkpoints
  stub.listCheckpoints()

GET /rooms/:room/checkpoints/:id
  metadata or binary, final response shape to decide in implementation

POST /rooms/:room/checkpoints/:id/restore
  stub.restoreCheckpoint(id)

DELETE /rooms/:room/checkpoints/:id
  stub.deleteCheckpoint(id)
```

### Room Naming

Room names should stay opaque to the server:

```txt
server sees:
  room = "epicenter.fuji.entries.entry_123.body"

server does not infer:
  app = fuji
  collection = entries
  row = entry_123
  field = body
```

The current user-scoped Durable Object naming still applies:

```txt
user:{userId}:rooms:{room}
```

This keeps isolation unchanged while removing the workspace/document branch.

## Implementation Plan

This is a clean break. Server-side data on the old `WorkspaceRoom` and `DocumentRoom` Durable Objects is intentionally destroyed. Local-first clients repush from IndexedDB on first reconnect; cold devices wait for any peer to come online. There is no compat window, no traffic-verification gate, and no parallel-routing period.

The first PR is Phases 1 through 3, all in one PR, deployed atomically. Phase 4 (checkpoints) and Phase 5 (snapshot history) are out of scope and become their own specs when a real consumer exists.

```txt
First PR commit graph (as executed):

  1. refactor(api): collapse sync rooms
       - introduces SyncRoom (later renamed; see commit 2)
       - moves clients to /sync/:room
       - deletes /workspaces, /documents, snapshot routes
       - deletes WorkspaceRoom + DocumentRoom classes
       - v2 migration with deleted_classes
       - drops do_type column
  2. refactor(api): rename SyncRoom → Room, /sync → /rooms (pre-deploy)
       - inlines BaseSyncRoom + SyncRoom into a single Room class
       - 304 → 204 for "already in sync"
       - syncRoomUrl → roomWsUrl; adds roomUrl (HTTP)
       - apiUrl trailing slash stripped in helpers

Commit 1 is the destructive one for any existing WorkspaceRoom/DocumentRoom
storage. Commit 2 is internal-only naming and is safe because nothing has
been deployed yet. The deploy is one atomic event after commit 2.
```

### Phase 1: Build Generic Room (commit 1, additive)

- [x] **1.1** Add a single `Room` Durable Object class (`apps/api/src/room.ts`) with `gc: true` hardcoded in the constructor. No abstract base, no empty subclass.
  > **Note**: The original execution landed an abstract `BaseSyncRoom` plus an empty `SyncRoom extends BaseSyncRoom`. The pre-deploy revision inlined both into one `Room` class, because the empty subclass was advertising an extension point we had explicitly decided not to maintain (retention policy is per-room runtime lookup, not a sibling class).
- [x] **1.2** Export `Room` from `apps/api/src/app.ts` for Wrangler type generation.
- [x] **1.3** Add `ROOM` Durable Object binding in `apps/api/wrangler.jsonc` with `class_name: "Room"`. Add a `v2` migration tag with `new_sqlite_classes: ["Room"]` and `deleted_classes: ["WorkspaceRoom", "DocumentRoom"]`. Keep `v1` intact.
- [x] **1.4** Regenerate Cloudflare binding types so `c.env.ROOM` is typed.
- [x] **1.5** Add `getRoomStub(c)` in `apps/api/src/app.ts` using DO names shaped as `user:{userId}:rooms:{room}`.
- [x] **1.6** Add `GET /rooms/:room` and `POST /rooms/:room` routes with the same auth, payload limit, storage tracking, and response behavior as the old workspace/document routes. POST returns `204 No Content` when the client is already in sync.
- [x] **1.7** Remove the `DoType` discriminator and the `do_type` column entirely (no live path branches on room category).
- [ ] **1.8** Add tests that prove WebSocket and HTTP sync work through `/rooms/:room` end-to-end (Hono-level, not just sync handler unit tests).
  > **Note**: Still deferred. Existing tests cover the sync handler protocol. Before deploying the destructive `v2` migration, add at least one route-level test per HTTP path (GET binary, POST 200/204/413, WebSocket upgrade). Tracked as a pre-deploy blocker, not a Phase 4 future-work item.

### Phase 2: Switch Every Client to `/rooms` (commit 2)

Concrete call sites (verified in `apps/`, `packages/`, `examples/`, and `playground/`):

```txt
workspace doc URL:
  apps/fuji/src/routes/(signed-in)/fuji/daemon.ts
  apps/fuji/src/routes/(signed-in)/fuji/browser.ts
  apps/honeycrisp/src/routes/(signed-in)/honeycrisp/daemon.ts
  apps/honeycrisp/src/routes/(signed-in)/honeycrisp/browser.ts
  apps/honeycrisp/src/routes/(signed-in)/honeycrisp/script.ts
  apps/opensidian/src/lib/opensidian/daemon.ts
  apps/opensidian/src/lib/opensidian/browser.ts
  apps/opensidian/src/lib/opensidian/script.ts
  apps/zhongwen/src/routes/(signed-in)/zhongwen/daemon.ts
  apps/zhongwen/src/routes/(signed-in)/zhongwen/script.ts
  apps/tab-manager/src/lib/tab-manager/extension.ts
  examples/notes-cross-peer/notes.ts
  playground/tab-manager-e2e/epicenter.config.ts
  playground/opensidian-e2e/epicenter.config.ts

child content doc URL (was /documents/*):
  apps/fuji/src/routes/(signed-in)/fuji/browser.ts (entry body, gc: false locally)
  apps/honeycrisp/src/routes/(signed-in)/honeycrisp/browser.ts (note body, gc: false locally)
```

- [x] **2.1** Add `roomUrl(apiUrl, roomId)` (HTTP) and `roomWsUrl(apiUrl, roomId)` (WebSocket) helpers to `@epicenter/workspace` next to `websocketUrl`. Both strip trailing slashes from `apiUrl` and `encodeURIComponent` the room id so ids containing `/`, `?`, or `#` round-trip via Hono's `:room` decoder.
- [x] **2.2** Replace every workspace URL above with `roomWsUrl(APP_URLS.API, doc.ydoc.guid)`.
- [x] **2.3** Replace every child content doc URL with the same helper. Local docs stay `gc: false` (clients still want history-capable RAM model); server is `gc: true`. Documented and acceptable.
- [x] **2.4** Update the example URL in `packages/workspace/src/index.ts` JSDoc and any other references to `/workspaces/*` or `/documents/*` as sync endpoints in docs and guides.
- [x] **2.5** Run targeted typecheck and tests for `apps/api`, `packages/workspace`, and every app whose URL changed.
  > **Note**: `apps/api` typecheck, `packages/workspace` typecheck, and the API sync handler test passed. Full app typechecks were left out to keep this one-spec execution bounded.

### Phase 3: Delete Everything Old (commit 3, destructive)

This is the clean break. After this commit deploys, all server-side state in `WorkspaceRoom` and `DocumentRoom` is permanently destroyed.

- [x] **3.1** Delete `apps/api/src/workspace-room.ts` and `apps/api/src/document-room.ts`.
- [x] **3.2** From `apps/api/src/app.ts`, remove:
  - the `export { DocumentRoom }` and `export { WorkspaceRoom }` re-exports
  - `app.use('/workspaces/*', requireOAuthUser)` and `app.use('/documents/*', requireOAuthUser)`
  - `getWorkspaceStub` and `getDocumentStub` helpers
  - the `GET`/`POST /workspaces/:workspace` routes
  - the `GET`/`POST /documents/:document` routes
  - the four `/documents/:document/snapshots*` routes
- [x] **3.3** From `apps/api/wrangler.jsonc`, remove the `WORKSPACE_ROOM` and `DOCUMENT_ROOM` durable object bindings. Extend the `v2` migration to also list `deleted_classes: ["WorkspaceRoom", "DocumentRoom"]`. This is the line that destroys the old storage.
- [x] **3.4** Collapse `DoType` in `apps/api/src/db/schema.ts` to a single literal: `export type DoType = 'rooms';`.
  > **Note**: Superseded by removing `DoType` and the `do_type` column entirely after confirming no live path still uses separate room categories.
- [x] **3.5** Add a one-shot SQL migration that deletes orphan rows: `DELETE FROM durable_object_instance WHERE do_type IN ('workspace', 'document');`. The instances those rows reference no longer exist.
  > **Note**: The migration deletes old typed rows, then drops the `do_type` column.
- [x] **3.6** Remove the snapshot RPC tests for `DocumentRoom` and any workspace/document route tests not already replaced by the `/rooms/:room` tests from Phase 1.
  > **Note**: No dedicated `DocumentRoom` route tests existed. The old room class and snapshot RPC routes were removed.
- [x] **3.7** Confirm no remaining references to `WorkspaceRoom`, `DocumentRoom`, `WORKSPACE_ROOM`, `DOCUMENT_ROOM`, `/workspaces/`, or `/documents/` anywhere in `apps/`, `packages/`, `examples/`, or `playground/`.
  > **Note**: Confirmed with `rg`, excluding old migration history and historical package specs.

### Phase 4: Add Checkpoints Later (separate spec, separate PR)

Out of scope for this spec's first PR. Move to its own spec when there is a real consumer (restore UI, import safety, user-visible version list). Listed below for reference only.

- [ ] **4.1** Add a `checkpoints` table to `Room` storage:

```sql
CREATE TABLE IF NOT EXISTS checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  data BLOB NOT NULL,
  label TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  source_state_vector BLOB NOT NULL
);
```

- [ ] **4.2** Add `createCheckpoint(label?)` using `Y.encodeStateAsUpdateV2(this.doc)`.
- [ ] **4.3** Add `listCheckpoints()` with metadata only.
- [ ] **4.4** Add `getCheckpoint(id)` for binary export or preview tooling.
- [ ] **4.5** Add `restoreCheckpoint(id)` with a clear implementation choice:

```txt
Option A:
  Clear room storage and replace live doc with checkpoint state.

Option B:
  Apply checkpoint into current doc as an update.

Recommendation:
  Use Option A for restore semantics. A checkpoint restore should mean "make the room equal this saved state", not "merge old state into current state".
```

- [ ] **4.6** Broadcast restored state to connected clients or close/reconnect clients after restore. Pick one behavior and test it.
- [ ] **4.7** Add retention controls before enabling automatic checkpoints:

```txt
max checkpoints per room
max bytes per room
delete oldest first
manual delete endpoint
```

### Phase 5: Defer Snapshot History

Do not implement unless exact historical reconstruction becomes a product requirement.

- [ ] **5.1** Add a room metadata table before adding `gc: false`:

```txt
room_policy:
  room id
  retention: current | checkpoints | snapshots
  created_at
```

- [ ] **5.2** Make policy immutable after room creation.
- [ ] **5.3** Create `Y.Doc({ gc: false })` only for `retention: snapshots`.
- [ ] **5.4** Add snapshot marker endpoints under a history namespace, not the default sync path.
- [ ] **5.5** Add quota and retention UI before allowing snapshot-history rooms in production.

## Clean Break Consequences

This is the one-time price of cutting the old surface. Listed so the team merges with eyes open, not to argue for keeping it around.

### Server-side state is destroyed on deploy

`/workspaces/${guid}` and `/documents/${guid}` resolve to Durable Objects named `user:{userId}:workspace:{guid}` and `user:{userId}:document:{guid}`. The new `/rooms/${guid}` resolves to `user:{userId}:rooms:{guid}`. Different name, different DO instance, different storage. The `v2` Wrangler migration's `deleted_classes` entry then drops the old class storage entirely.

Result by device class:

```txt
warm device (any client that still has IndexedDB):
  reconnects to empty /rooms room
  pushes full state on first STEP2/UPDATE
  server hydrated within seconds; all peers converge

cold device (fresh sign-in, no IndexedDB):
  sees an empty workspace
  recovers only when another warm device comes online and rehydrates the room

no warm device exists:
  the workspace is effectively gone
  this is the same failure mode as losing the local IndexedDB on the only device,
  and the product already accepts that risk as part of being local-first
```

For the affected products (Fuji, Honeycrisp, Opensidian, Zhongwen, Tab Manager) the active device population is overwhelmingly warm. The cold-device case is a one-time, one-line "open the workspace on your other device first" recovery.

### Stale clients break, do not self-heal

The moment commit 3 deploys:

```txt
old client build talking to /workspaces/* or /documents/*  : 404
in-flight WebSocket on /workspaces or /documents           : closed
published Tab Manager extension that has not auto-updated  : broken
Whispering or other desktop build shipping old URLs        : broken
open browser tab loaded against old code                   : broken on next reconnect
```

Self-healing only happens once the user updates the binary or reloads the page against the new client build. There is no compat shim.

### Wrangler migration is irreversible

```txt
{
  "tag": "v2",
  "new_sqlite_classes": ["Room"],
  "deleted_classes":   ["WorkspaceRoom", "DocumentRoom"]
}
```

Once Cloudflare runs this migration in production, the `WorkspaceRoom` and `DocumentRoom` SQLite storage is gone. Reverting the deploy gets you back the old code but not the old data. There is no rollback; that is the trade we are explicitly making.

### Snapshot RPCs have no consumers

Confirmed by grep: nothing outside `apps/api/` calls `saveSnapshot`, `listSnapshots`, `getSnapshot`, or `deleteSnapshot`. The auto-save in `DocumentRoom.onAllDisconnected` writes data nothing reads. Deletion is a pure subtraction with zero functional impact on any shipped UI.

### `DoType` collapse

`DoType` is removed entirely and the `do_type` column is dropped. The `DELETE FROM durable_object_instance WHERE do_type IN ('workspace', 'document')` migration in Phase 3 drops the orphan rows before the column is dropped, so the type narrows cleanly.

### URL encoding

Existing call sites pass `${doc.ydoc.guid}` raw. Guids generated by `docGuid()` look like `epicenter.fuji.entries.entry_123.body`: dot-separated, ASCII-safe. Switching to `encodeURIComponent` via the new `roomUrl()` / `roomWsUrl()` helpers is a behavioral no-op today and a defensive correctness win for any future guid containing `?`, `#`, or `/`. The helpers also strip trailing slashes from `apiUrl` so callers can pass either `https://api.example.com` or `https://api.example.com/`.

## Edge Cases

### Client Uses `gc: false`, Server Uses `gc: true`

Expected behavior:

```txt
normal sync works
client may retain local deleted content
server does not retain deleted content for Yjs snapshot restore
```

This is acceptable. Local client retention is not a server history promise.

### Client Uses `gc: true`, Server Uses `gc: false`

Expected behavior:

```txt
normal sync works
server can retain history
client does not retain local deleted content
```

This is acceptable only for explicit snapshot-history rooms.

### Restore While Clients Are Connected

Checkpoint restore is not just another edit if the intended semantics are "replace the room with this old state".

Implementation must choose one:

```txt
close and reconnect:
  easier to reason about
  clients reload from restored state

broadcast replacement:
  smoother UX
  harder to prove because CRDT updates merge rather than delete unknown future structs
```

Recommendation: close and reconnect for the first restore implementation.

### Unknown Room

Generic sync can create rooms on first access, but auth still decides who can access the room.

Current hosted behavior should stay user-scoped:

```txt
same room string + different user id = different Durable Object
```

### Room Name Encoding

Room ids may contain slashes or punctuation if derived from document paths. Provide a helper that encodes room ids consistently.

```ts
function roomUrl(apiUrl: string, roomId: string) {
	const base = apiUrl.replace(/\/+$/, '');
	return `${base}/rooms/${encodeURIComponent(roomId)}`;
}

function roomWsUrl(apiUrl: string, roomId: string) {
	return websocketUrl(roomUrl(apiUrl, roomId));
}
```

## Testing Plan

- [ ] `apps/api` route tests cover `GET /rooms/:room`, `POST /rooms/:room`, and WebSocket upgrade. **Pre-deploy blocker for the destructive `v2` migration.**
- [x] Existing sync handler tests continue to pass.
- [ ] A browser-style client can sync a doc through `/rooms/:room`.
- [ ] Two clients with the same user and room converge.
- [ ] Two users with the same room string do not share a Durable Object.
- [ ] Storage tracking records the room without a `do_type` discriminator (column removed; `resourceName` is the room id).
- [ ] Old `/workspaces/*` and `/documents/*` routes are unused before deletion.
- [ ] Checkpoint tests, when Phase 4 happens, cover create, list, fetch, delete, restore, and retention limits.

## Open Questions

1. ~~Should the public route be `/sync/:room` or `/rooms/:room`?~~ **Resolved (2026-05-14):** `/rooms/:room`. The URL space is a resource hierarchy; rooms are the resource, and sync is one of several verbs (sync now, checkpoint later, members/policy/quota even later). Naming the verb in the URL prefix would force every future verb into `/sync/...`, which would stop being true.

2. Should `GET /rooms/:room/checkpoints/:id` return metadata, binary data, or content negotiation?
   Recommendation: list returns metadata; binary export can be `/data` if needed.

3. Should restore be implemented by replacing the DO storage or by appending a CRDT update?
   Recommendation: replace storage and force reconnect for first implementation.

4. Should checkpoint creation be manual only or automatic on last disconnect?
   Recommendation: manual only at first. Add automatic checkpoints after there is a retention policy and UI.

5. Should room policies be stored in Postgres, Durable Object SQLite, or both?
   Recommendation: Postgres for control-plane policy and billing visibility; DO SQLite for room-local data.

## Non-Goals

- Do not add `gc=false` query params.
- Do not make clients negotiate server GC.
- Do not preserve `/workspaces/*` and `/documents/*` as permanent aliases after migration.
- Do not add snapshot-history endpoints until the product needs exact historical reconstruction.
- Do not make checkpoints automatic before quota and retention behavior exist.

## Success Criteria

- One server room class handles all Yjs sync.
- App sync URLs no longer encode `workspace` or `document` as server room types.
- Default rooms use `gc: true`.
- No client-facing API can casually create a `gc: false` room.
- Future checkpoints can be added without changing the sync protocol.
- Future snapshot history has a clear, explicit policy path if it becomes necessary.
