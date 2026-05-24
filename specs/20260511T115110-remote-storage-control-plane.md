# Remote Storage Control Plane

**Date**: 2026-05-11
**Status**: Draft, revised after architecture review
**Author**: AI-assisted

## Overview

Epicenter needs a control plane for remote workspace and document storage. Durable Objects should keep owning the CRDT bytes. Postgres should own the account-visible registry: which remote copies exist, whether each copy is active or deleted, how many bytes were measured, and which remote generation a client is allowed to sync.

One-sentence test: a signed-in user can list, measure, disable, physically clean up, and explicitly re-enable each user-owned remote workspace or document copy without any stale local client silently recreating deleted server state.

## Newcomer Map

This feature sounds abstract because there are three different "copies" of the same workspace or document.

```txt
Your laptop or browser
  Local Y.Doc
  Local IndexedDB updates
  Local sync status

Epicenter API Worker
  Authenticates requests
  Decides whether sync is allowed
  Routes allowed sync to a Durable Object

Durable Object room
  Stores remote Yjs update bytes in SQLite
  Holds live WebSockets
  Holds the in-memory Y.Doc while warm

Postgres registry
  Lists rooms for the dashboard
  Stores lifecycle state
  Blocks deleted rooms from being recreated by stale clients
```

The important idea: deleting remote storage is not the same as deleting local data. The user keeps their local workspace or document. Epicenter deletes, or disables, only the server-side sync copy.

## Glossary

**Remote copy**: the server-side copy of a workspace or document stored in a Durable Object.

**Room**: one Durable Object instance for one workspace or document. The current naming pattern is `user:{userId}:workspace:{name}` or `user:{userId}:document:{name}`.

**Registry row**: one Postgres row in `durable_object_instance`. It is the account-visible record for a room.

**Tombstone**: a registry row that says "this remote copy was deleted or is being deleted". It blocks sync even if a stale client still has local Yjs updates.

**Generation**: a monotonic number stored in Postgres and sent by clients. It separates "old local client from before delete" from "client intentionally re-enabled remote sync".

**Physical cleanup**: the Durable Object operation that closes sockets, destroys runtime state, clears SQLite storage, and recreates empty tables.

## Current State

The API already maps each authenticated user and resource name to a deterministic Durable Object name.

```typescript
function getWorkspaceStub(c: Context<Env>) {
	const doName = `user:${c.var.user.id}:workspace:${c.req.param('workspace')}`;
	return {
		stub: c.env.WORKSPACE_ROOM.get(c.env.WORKSPACE_ROOM.idFromName(doName)),
		doName,
	};
}

function getDocumentStub(c: Context<Env>) {
	const doName = `user:${c.var.user.id}:document:${c.req.param('document')}`;
	return {
		stub: c.env.DOCUMENT_ROOM.get(c.env.DOCUMENT_ROOM.idFromName(doName)),
		doName,
	};
}
```

The API also records best-effort telemetry after sync.

```typescript
export const durableObjectInstance = pgTable('durable_object_instance', {
	userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
	doType: text('do_type').notNull().$type<DoType>(),
	resourceName: text('resource_name').notNull(),
	doName: text('do_name').primaryKey(),
	storageBytes: bigint('storage_bytes', { mode: 'number' }),
	createdAt: timestamp('created_at').defaultNow().notNull(),
	lastAccessedAt: timestamp('last_accessed_at').defaultNow().notNull(),
	storageMeasuredAt: timestamp('storage_measured_at'),
});
```

`BaseSyncRoom` can report approximate SQLite storage bytes, and it has a raw storage deletion method.

```typescript
async getDoc(): Promise<{ data: Uint8Array; storageBytes: number }> {
	return {
		data: Y.encodeStateAsUpdateV2(this.doc),
		storageBytes: this.ctx.storage.sql.databaseSize,
	};
}

async deleteStorage(): Promise<void> {
	await this.ctx.storage.deleteAll();
}
```

That is enough for rough telemetry. It is not enough for user-controlled deletion.

## Problems To Solve

1. **No user-facing inventory**: the dashboard shows billing and usage, but it does not list remote workspace or document storage.

2. **No user-facing delete path**: document snapshot deletion exists, but there is no route for deleting the whole remote sync copy.

3. **Telemetry is not lifecycle state**: `durable_object_instance` says a room was accessed. It does not say whether sync is currently allowed.

4. **`deleteAll()` is not a full runtime reset**: Cloudflare deletes persistent storage, but a warm Durable Object can still hold `this.doc`, awareness, WebSockets, and event listeners in memory.

5. **Local-first clients can recreate deleted remote data**: local IndexedDB can replay Yjs updates after the server copy is deleted. A server tombstone must block that replay.

6. **Re-enable is dangerous without a generation guard**: if the dashboard flips a row back to active, old tabs and desktop apps can upload old local state unless the server can tell old sync attempts from intentional new ones.

7. **Missing registry rows are not safe to ignore**: the old telemetry write was best effort. A missing row does not prove a Durable Object is empty.

## Desired State

Remote storage becomes an explicit account surface.

```txt
GET    /api/storage
POST   /api/storage/refresh
DELETE /api/storage/workspaces/:workspace
DELETE /api/storage/documents/:document
POST   /api/storage/workspaces/:workspace/recreate
POST   /api/storage/documents/:document/recreate
```

Sync now passes through a registry gate before it touches a Durable Object.

```txt
Client syncs a workspace
  -> API authenticates user
  -> API derives doName from session userId and route params
  -> API loads or creates the registry row
  -> active row with matching generation: route to Durable Object
  -> deleted or delete_pending row: reject sync
  -> generation mismatch: reject sync
  -> API records measured bytes only if the row is still active
```

Deletion is a lifecycle change first and a storage cleanup second.

```txt
User deletes remote data
  -> API writes a tombstone in Postgres
  -> API increments generation
  -> API calls the Durable Object cleanup method
  -> Durable Object closes sockets and resets runtime state
  -> Durable Object clears SQLite storage
  -> API marks cleanup confirmed
  -> future sync is rejected until explicit recreate
```

## Research Findings

These findings came from local code inspection and narrow DeepWiki questions against Cloudflare, Hono, Yjs, y-protocols, y-indexeddb, Better Auth, Drizzle, Turso, SvelteKit, shadcn-svelte, TanStack Table, Bitwarden, Signal libsignal, and Autumn.

| Area | Finding | Design impact |
| --- | --- | --- |
| Cloudflare Durable Objects | `ctx.storage.deleteAll()` deletes KV storage, SQL data, and alarms for this compatibility date. Warm object memory can still exist. | The DO needs an explicit runtime reset after `deleteAll()`. |
| Cloudflare WebSockets | Hibernated WebSocket attachments persist only while the socket lives and must fit structured clone limits. Closing sockets loses attachments. | Cleanup must close sockets and not rely on attachments after deletion. |
| Hono | Middleware can return structured JSON errors. WebSocket rejection must happen before or immediately after upgrade. | HTTP deleted sync should return JSON `410`. WebSocket deleted sync should close with a structured reason. |
| Yjs | `Y.Doc.destroy()` removes doc event listeners and emits destroy. Old listeners can leak memory or persist stale data. | Do not just replace `this.doc`. Destroy the old doc and detach stored listeners. |
| y-protocols Awareness | `Awareness.destroy()` clears local state and interval work. Closed connections should remove controlled client IDs. | Room reset must destroy awareness and teardown connections. |
| y-indexeddb | Local persistence does not know about remote tombstones. It can replay local updates after remote deletion. | The client must store a remote-sync-disabled state and respect server tombstones. |
| Better Auth | Server routes should derive user ownership from the validated session, not a route `userId`. | Storage routes must use `c.var.user.id` only. |
| Drizzle | Conditional `onConflictDoUpdate.where` is the safe pattern for upserts that must not reactivate soft-deleted rows. | Registry helper methods must use conditional updates or separate operations. |
| Turso and SQLite | Timestamp and bigint handling differ from Postgres. Partial-index conflict behavior can break during migration. | Keep schema simple. Avoid partial-index-dependent upserts for this feature. |
| shadcn-svelte | Core table, dialog, button, badge, dropdown, tabs, spinner, and alert components are enough for v1. | Do not add a heavy table library unless the row count or controls demand it. |
| TanStack Table | Useful for sorting, pagination, filtering, and type-safe columns. Overkill for a tiny fixed table. | Start simple unless the storage list grows beyond basic sorting. |
| Bitwarden | Soft delete first, cleanup later is a common account-data pattern. | Tombstone before physical cleanup. Keep retry possible. |
| Signal libsignal | Local state can survive while remote sending or session use is disabled. | Remote deletion should preserve local data and disable sync, not wipe local data. |
| Autumn | Persistent storage accounting should reconcile absolute gauges, not rely only on per-event deltas. | Storage billing should consume registry totals as absolute usage. |

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Remote bytes storage | 2 coherence | Keep CRDT update bytes in Durable Objects. | The current room model already isolates users, stores Yjs updates, and owns WebSockets. |
| Remote inventory | 2 coherence | Store the account-visible registry in Postgres. | Users need a queryable list. Durable Object names are deterministic lookups, not an index. |
| Registry table | 3 taste | Evolve `durable_object_instance` for v1. | It already contains the right identity and byte fields. Rename later only if the name keeps misleading contributors. |
| Delete semantics | 2 coherence | Tombstone first, then clean the Durable Object. | Tombstones block stale clients even if physical cleanup has to retry. |
| Missing-row delete | 2 coherence | Create a tombstone row and then attempt cleanup. | Missing telemetry does not prove missing storage. |
| Recreate semantics | 1 evidence | Require generation guard in v1. | y-indexeddb can replay local state. Recreate without generation lets stale clients upload. |
| Client handling | 1 evidence | Ship client support before server deletion routes. | Current clients only treat `4401` as terminal. A new `4410` close would retry forever. |
| Durable Object reset | 1 evidence | Destroy old doc and awareness, detach listeners, recreate schema, install a blank runtime. | `deleteAll()` clears storage, not warm memory. |
| Dashboard table | 3 taste | Start with core shadcn-svelte primitives. | The v1 list is compact. TanStack Table can be added when the table needs real table state. |

## Architecture

```txt
Client app
  owns:
    local Y.Doc
    local IndexedDB updates
    local remote-sync-disabled flag
    last accepted remote generation

        sync request
             |
             v

API Worker
  owns:
    Better Auth session check
    userId from c.var.user.id
    doName derivation
    registry gate

        allowed sync only
             |
             v

Durable Object room
  owns:
    in-memory Y.Doc
    Awareness
    accepted WebSockets
    updates table
    snapshots table for DocumentRoom
    SQLite byte measurement

        measured bytes
             |
             v

Postgres registry
  owns:
    userId
    doType
    resourceName
    doName
    status
    generation
    storageBytes
    storageMeasuredAt
    lastAccessedAt
    deleteRequestedAt
    deletedAt
    cleanupConfirmedAt
```

The boundary should stay simple:

```txt
Postgres answers: should this user be allowed to sync this remote copy?
Durable Object answers: what Yjs bytes exist for this one room?
Client answers: do I have local data, and am I allowed to send it?
```

## Registry Schema

Add lifecycle fields to `durable_object_instance`.

```typescript
export type RemoteStorageStatus = 'active' | 'delete_pending' | 'deleted';

export const durableObjectInstance = pgTable(
	'durable_object_instance',
	{
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		doType: text('do_type').notNull().$type<DoType>(),
		resourceName: text('resource_name').notNull(),
		doName: text('do_name').primaryKey(),
		status: text('status')
			.notNull()
			.$type<RemoteStorageStatus>()
			.default('active'),
		generation: integer('generation').notNull().default(1),
		storageBytes: bigint('storage_bytes', { mode: 'number' }),
		createdAt: timestamp('created_at').defaultNow().notNull(),
		lastAccessedAt: timestamp('last_accessed_at').defaultNow().notNull(),
		storageMeasuredAt: timestamp('storage_measured_at'),
		deleteRequestedAt: timestamp('delete_requested_at'),
		deletedAt: timestamp('deleted_at'),
		cleanupConfirmedAt: timestamp('cleanup_confirmed_at'),
		lastCleanupError: text('last_cleanup_error'),
	},
	(table) => [
		index('doi_user_status_idx').on(table.userId, table.status),
		index('doi_user_type_resource_idx').on(
			table.userId,
			table.doType,
			table.resourceName,
		),
	],
);
```

`doName` remains the primary key because it is the exact Durable Object identity. The `(userId, doType, resourceName)` index makes account inventory and route lookups fast without changing the existing identity model.

Avoid partial-index-dependent upserts in v1. If this schema later moves to SQLite or Turso, partial-index conflict behavior is a known migration trap.

## Registry Helper

Replace `upsertDoInstance()` with `apps/api/src/remote-storage-registry.ts`.

The helper should expose named operations instead of one generic upsert.

```typescript
type RemoteStorageRoom = {
	userId: string;
	doType: 'workspace' | 'document';
	resourceName: string;
	doName: string;
};

type ActiveRemoteStorageRoom = RemoteStorageRoom & {
	status: 'active';
	generation: number;
};

async function ensureRoomForSync(
	db: Db,
	room: RemoteStorageRoom,
): Promise<
	| { status: 'active'; generation: number }
	| { status: 'blocked'; statusCode: 410; code: 'remote_storage_deleted' }
>;

async function recordMeasurementIfActive(
	db: Db,
	room: RemoteStorageRoom,
	params: { generation: number; storageBytes: number },
): Promise<void>;

async function tombstoneRoomForDelete(
	db: Db,
	room: RemoteStorageRoom,
): Promise<{ generation: number }>;

async function markCleanupConfirmed(
	db: Db,
	room: RemoteStorageRoom,
	params: { generation: number },
): Promise<void>;

async function reactivateRoomForRecreate(
	db: Db,
	room: RemoteStorageRoom,
): Promise<{ generation: number }>;
```

The rule: sync writes may update active rows, but they must never turn a deleted row back into an active row. Recreate is the only operation that can reactivate a row.

## Sync Gate

Every workspace and document sync route must check the registry before touching the Durable Object.

```txt
HTTP GET or POST /workspaces/:workspace
  -> requireSession
  -> derive doName from c.var.user.id and workspace param
  -> ensureRoomForSync()
  -> blocked: return 410 JSON
  -> active: call Durable Object
  -> recordMeasurementIfActive()
```

Deleted HTTP response:

```json
{
	"code": "remote_storage_deleted",
	"type": "workspace",
	"resourceName": "epicenter.tab-manager",
	"generation": 4
}
```

WebSocket deleted response should match the existing short-lived socket pattern, but the client must understand it before this ships.

```txt
close code: 4410
close reason: {"code":"remote_storage_deleted","type":"workspace","resourceName":"epicenter.tab-manager","generation":4}
```

The close code is in the application-defined range. Add it to `packages/sync` instead of scattering `4410` as a magic number.

## Client Contract

This is a required phase, not a follow-up.

Current `attachSync()` treats only close `4401` as terminal auth failure. A deleted remote room needs a different terminal state: local data still exists, but remote sync is off.

Add a status shape like this:

```typescript
// from packages/sync (defined in Phase 1.1)
export type RemoteStorageDeletedReason = {
	code: 'remote_storage_deleted' | 'unknown';
	type?: 'workspace' | 'document';
	resourceName?: string;
	generation?: number;
};

export type SyncStatus =
	| { phase: 'offline' }
	| { phase: 'connecting'; retries: number; lastError?: SyncError }
	| { phase: 'connected' }
	| { phase: 'failed'; reason: SyncFailedReason }
	| { phase: 'disabled'; reason: RemoteStorageDeletedReason };
```

The reason fields after `code` are optional because the Phase 1.1 parser must accept malformed close payloads from a buggy or future server without throwing. UI code can render a useful "remote sync is off" state on `code` alone; the other fields are best-effort context.

Client requirements:

1. Treat HTTP `410` and WebSocket close `4410` as terminal.
2. Stop reconnect loops after `remote_storage_deleted`.
3. Preserve local IndexedDB data.
4. Store enough local state to show "remote sync is off" without alarming the user.
5. Send the current accepted generation when sync is enabled.
6. Require an explicit user action before accepting a new generation after recreate.

Do not clear local IndexedDB automatically. Signal-style local preservation is the right model here: old local state remains readable, but it should not be sent to the server unless the user explicitly re-enables sync.

## Delete Flow

Deletion is idempotent, but idempotent does not mean "do nothing".

```txt
DELETE active room:
  -> write delete_pending tombstone
  -> increment generation
  -> close active sockets in Durable Object
  -> clear Durable Object storage
  -> mark deleted and cleanup confirmed
  -> return 204

DELETE already delete_pending or deleted room:
  -> keep tombstone
  -> retry Durable Object cleanup if cleanupConfirmedAt is null
  -> return 204

DELETE missing registry row:
  -> create tombstone row using deterministic doName
  -> increment or initialize generation
  -> attempt Durable Object cleanup
  -> return 204
```

The user-visible promise is "remote sync is blocked now". If physical cleanup fails after the tombstone, future sync is still rejected and cleanup can retry.

## Durable Object Runtime Reset

Replace `deleteStorage()` with a method that resets disk and memory.

```typescript
async deleteForUserRequest(): Promise<void> {
	this.isTearingDown = true;
	try {
		this.closeAllConnections(4410, {
			code: 'remote_storage_deleted',
		});
		this.teardownAllConnections();
		this.detachPersistenceListener();
		this.destroyRuntimeDocAndAwareness();
		await this.ctx.storage.deleteAll();
		this.initializeRuntimeDoc();
		this.initializeSqlSchema();
		this.initializeSubclassStorage();
		this.attachPersistenceListener();
		this.resetSubclassRuntime();
	} finally {
		this.isTearingDown = false;
	}
}
```

`storageBytes` is intentionally absent from the return type. After reset, `ctx.storage.sql.databaseSize` is non-zero (SQLite metadata pages), and reporting that number to the registry would conflict with the tombstone semantics. The registry stores `null` for cleaned-up rows. See `markCleanupConfirmed` above.

The exact implementation can differ, but it must preserve these invariants:

```txt
Before deleteAll:
  close accepted WebSockets
  remove per-connection doc and awareness listeners
  detach the persistence listener from the old Y.Doc
  destroy Awareness
  destroy the old Y.Doc

After deleteAll:
  recreate the updates table
  recreate subclass tables, including DocumentRoom snapshots
  create a fresh Y.Doc
  create fresh Awareness
  attach exactly one persistence listener

During teardown:
  webSocketClose must not call onAllDisconnected() or setAlarm()
  the existing webSocketClose path schedules a compaction alarm and
  triggers DocumentRoom's snapshot autosave when the last socket leaves;
  both are wrong inside deleteForUserRequest because the snapshots table
  is about to be dropped and the alarm would fire against missing tables
  if it raced ahead of the runtime reset.
  Use a private isTearingDown flag set for the duration of
  deleteForUserRequest. Gate the connections.size === 0 branch in
  webSocketClose on !this.isTearingDown.
```

Why this is strict:

```txt
deleteAll() clears storage
old this.doc can still exist in warm memory
old update listeners can still point at the deleted SQL schema
old awareness intervals can still run
next mutation can persist stale data or fail because tables are gone
```

`DocumentRoom` needs subclass hooks. Its `snapshots` table is created in the constructor today, and `lastSavedSv` is an in-memory field. After reset, it must recreate `snapshots` and clear `lastSavedSv`.

## Recreate Flow

Recreate means "allow remote sync again". It does not mean "restore deleted server bytes".

```txt
POST /api/storage/workspaces/:workspace/recreate
  -> requireSession
  -> load tombstone row
  -> set status = active
  -> increment generation
  -> storageBytes = null
  -> deletedAt = null
  -> deleteRequestedAt = null
  -> cleanupConfirmedAt = null
  -> return generation to client
```

The next sync may upload local data, but only from a client that has accepted the new generation. That acceptance should be explicit in the UI or app flow. A stale tab with the old generation should keep receiving a terminal rejection.

## Account Deletion

Account deletion must clean remote storage. Do not rely on the foreign key cascade alone, because cascade deletes the registry rows and loses the list of Durable Objects that need cleanup.

Add account deletion work before the user row is deleted:

```txt
Before deleting user row:
  -> select durableObjectInstance rows for user
  -> for each row, call Durable Object cleanup
  -> best-effort log failures with enough information for retry
  -> delete R2 assets
  -> zero Autumn storage balance
  -> continue user deletion
```

If the cleanup cannot be made fully reliable in the Better Auth hook, add an explicit cleanup job or admin repair command before shipping account deletion in production.

## API Contract

### `GET /api/storage`

Returns active and deleted registry rows for the signed-in user.

```typescript
type RemoteStorageEntry = {
	type: 'workspace' | 'document';
	resourceName: string;
	status: 'active' | 'delete_pending' | 'deleted';
	generation: number;
	storageBytes: number | null;
	storageMeasuredAt: string | null;
	lastAccessedAt: string;
	deleteRequestedAt: string | null;
	deletedAt: string | null;
	cleanupConfirmedAt: string | null;
};

type StorageListResponse = {
	activeBytes: number;
	cleanupPendingBytes: number;
	entries: RemoteStorageEntry[];
};
```

`activeBytes` sums active rows only. Deleted rows can remain visible for the user's understanding, but they should not count toward active remote storage once cleanup is confirmed.

Default sort:

```txt
active first
delete_pending second
deleted last
storageBytes desc with nulls last
lastAccessedAt desc
```

### `POST /api/storage/refresh`

Refresh byte measurements for a specific active room known in the registry.

Refresh is always scoped to one row in v1. The unbounded "refresh all" shape is intentionally rejected: calling `getDoc()` wakes a Durable Object and pays its cold-start cost, so an unscoped refresh would thunder-herd a user's full inventory on every dashboard mount.

```typescript
type StorageRefreshRequest = {
	type: 'workspace' | 'document';
	resourceName: string;
};
```

The normal sync path already updates bytes for active rooms. Refresh is a user action triggered from the dashboard row, not a background sweep.

### Delete Routes

```txt
DELETE /api/storage/workspaces/:workspace
DELETE /api/storage/documents/:document
```

Both return `204` when the remote copy is blocked or cleanup has been requested, including already-deleted rows and missing registry rows.

### Recreate Routes

```txt
POST /api/storage/workspaces/:workspace/recreate
POST /api/storage/documents/:document/recreate
```

Return the new generation:

```typescript
type RecreateRemoteStorageResponse = {
	generation: number;
};
```

## Dashboard UI

Add a "Remote data" tab or section to `apps/dashboard`.

Minimum viable UI:

```txt
Remote data

Active remote storage: 18.4 MB

Type       Name                   Storage   Last used      Status
workspace  epicenter.tab-manager  220 KB    May 11, 2026   Active
document   doc_abc123             18.2 MB   May 10, 2026   Active
workspace  zhongwen                         May 8, 2026    Deleted
```

Actions:

```txt
Active row:
  Delete remote data

Delete pending row:
  Retry cleanup

Deleted row:
  Re-enable remote sync
```

Delete confirmation copy:

```txt
Delete remote data for this workspace?

This removes the copy stored on Epicenter's sync server. Local data on your devices is not deleted. Devices that still have this workspace open will stop syncing until remote sync is re-enabled.
```

Re-enable confirmation copy:

```txt
Re-enable remote sync for this workspace?

Your local copy can sync to Epicenter again. Only continue from a device with the version you want to keep.
```

Avoid presenting this as "delete workspace" unless local data is also deleted.

Use core `@epicenter/ui` or shadcn-svelte style primitives for v1: table, alert dialog, button, badge, tabs, spinner or skeleton, and toast. Do not add TanStack Table unless the implementation needs sorting, filtering, pagination, or column visibility controls that would otherwise become awkward.

## Implementation Plan

### Phase 1: Shared Sync Protocol

- [ ] **1.1** Add to `packages/sync`:
  - `REMOTE_STORAGE_DELETED_CLOSE_CODE = 4410` constant.
  - `RemoteStorageDeletedReason` type for the JSON payload sent in the close reason and 410 HTTP body (`code`, `type`, `resourceName`, `generation`).
  - `encodeRemoteStorageDeletedReason()` and `parseRemoteStorageDeletedReason()` helpers, mirroring the existing `parsePermanentFailure` pattern in `attach-sync.ts`. The parser must accept malformed JSON without throwing and fall back to a `code: 'unknown'` shape so a buggy server cannot crash the client.
- [ ] **1.2** Extend `attachSync()` so close `4410` becomes terminal `phase: 'disabled'` with the parsed reason payload attached.
- [ ] **1.3** Stop reconnect loops after `remote_storage_deleted`.
- [ ] **1.4** Add tests for close `4410`, malformed close reasons, and reconnect behavior.
- [ ] **1.5** Add a client-facing way to surface "remote sync is off, local data remains".

### Phase 2: Registry Contract

- [ ] **2.1** Add `status`, `generation`, `deletedAt`, `deleteRequestedAt`, `cleanupConfirmedAt`, and `lastCleanupError` to `durableObjectInstance`.
- [ ] **2.2** Add a Drizzle migration.
- [ ] **2.3** Create `apps/api/src/remote-storage-registry.ts`.
- [ ] **2.4** Replace `upsertDoInstance()` with helper operations that preserve tombstones.
- [ ] **2.5** Add tests for active, missing, delete_pending, and deleted registry states.

### Phase 3: Sync Gate

- [ ] **3.1** Add a shared `resolveRemoteStorageRoom()` helper for workspace and document routes.
- [ ] **3.2** Gate HTTP workspace and document routes before touching Durable Objects.
- [ ] **3.3** Return `410` JSON for deleted or generation-mismatched HTTP sync.
- [ ] **3.4** Return a short-lived WebSocket close with code `4410` for deleted or generation-mismatched WebSocket sync.
- [ ] **3.5** Record storage bytes only when the row is still active and generation matches.

### Phase 4: Durable Object Deletion

- [ ] **4.1** Refactor `BaseSyncRoom` initialization into helper methods.
- [ ] **4.2** Store the Yjs persistence listener so it can be detached.
- [ ] **4.3** Add teardown for all active connections.
- [ ] **4.4** Destroy old `Awareness` and old `Y.Doc`.
- [ ] **4.5** Add `deleteForUserRequest()` that closes sockets, detaches listeners, calls `deleteAll()`, recreates SQL schema, and installs a blank runtime.
- [ ] **4.6** Add subclass hooks so `DocumentRoom` recreates `snapshots` and clears `lastSavedSv`.
- [ ] **4.7** Add focused tests around listener cleanup and `DocumentRoom` reset where the codebase supports it.

### Phase 5: Storage API

- [ ] **5.1** Create `apps/api/src/storage-routes.ts`.
- [ ] **5.2** Add `GET /api/storage`.
- [ ] **5.3** Add `POST /api/storage/refresh`.
- [ ] **5.4** Add delete routes that create tombstones even for missing rows.
- [ ] **5.5** Add recreate routes that increment generation.
- [ ] **5.6** Mount routes under `/api/storage/*` after `requireSession`.

### Phase 6: Account Deletion

- [ ] **6.1** Update Better Auth user delete hook or add a cleanup job that enumerates registry rows before cascade.
- [ ] **6.2** Call Durable Object cleanup for each remote room.
- [ ] **6.3** Keep enough failure logging to retry cleanup.
- [ ] **6.4** Verify R2 cleanup and Autumn zeroing still run.

### Phase 7: Dashboard

- [ ] **7.1** Add storage API methods to `apps/dashboard/src/lib/api.ts`.
- [ ] **7.2** Add storage query keys and mutations.
- [ ] **7.3** Add a Remote Data tab or section.
- [ ] **7.4** Add delete confirmation, retry cleanup, and re-enable actions.
- [ ] **7.5** Verify desktop and mobile layout with the in-app browser.

## Edge Cases

### Stale Client Reconnects After Delete

```txt
1. User deletes remote data from the dashboard.
2. API writes a tombstone and increments generation.
3. A stale client reconnects with old local Yjs state.
4. API sees deleted status or old generation.
5. API returns 410 or closes WebSocket with 4410.
6. Client enters remote-sync-disabled state and keeps local data.
```

### Recreate While Old Tabs Are Open

```txt
1. User re-enables remote sync from the dashboard.
2. API increments generation.
3. Current client accepts the new generation.
4. Old tabs still send the previous generation.
5. API rejects old-generation sync.
```

This is why generation is required in v1.

### Delete Fails After Tombstone

```txt
1. API marks the row delete_pending.
2. Durable Object cleanup fails.
3. Future sync is still blocked.
4. Dashboard can show cleanup pending.
5. Retry calls the same cleanup method again.
```

### Warm Durable Object After `deleteAll()`

```txt
1. Durable Object storage is deleted.
2. The live object can still hold doc, awareness, listeners, and sockets.
3. If runtime state is not reset, old data can be persisted again.
```

Expected outcome: `deleteForUserRequest()` must reset memory and recreate SQL schema before the object can handle future sync.

### Missing Registry Row With Existing Durable Object

This can happen for old data or failed telemetry writes.

```txt
First active sync:
  -> create registry row as active
  -> measure storageBytes through getDoc or sync

Delete request:
  -> create tombstone row
  -> attempt Durable Object cleanup
```

Do not treat missing row as proof that remote bytes are missing.

## Verification Plan

Run focused checks first:

```txt
bun test packages/workspace/src/document/attach-sync.test.ts
bun test apps/api/src/sync-handlers.test.ts
bun run --cwd apps/api check
bun run --cwd apps/dashboard check
```

Then smoke the flows locally:

```txt
1. Sign in.
2. Sync a workspace.
3. Confirm it appears in /api/storage.
4. Delete remote data.
5. Confirm existing WebSocket clients enter remote-sync-disabled state.
6. Confirm HTTP sync returns 410.
7. Re-enable remote sync.
8. Confirm only a client that accepted the new generation can sync.
9. Confirm bytes are measured again.
```

## Handoff Prompt

Use this prompt for implementation:

```txt
Implement specs/20260511T115110-remote-storage-control-plane.md.

Start by reading apps/api/src/app.ts, apps/api/src/base-sync-room.ts, apps/api/src/document-room.ts, apps/api/src/db/schema.ts, packages/workspace/src/document/attach-sync.ts, packages/workspace/src/document/attach-indexed-db.ts, apps/dashboard/src/lib/api.ts, and apps/dashboard/src/routes/+page.svelte.

Keep the Durable Object data plane intact. Add a Postgres-backed remote storage control plane that lists, tombstones, deletes, refreshes, and recreates user-owned workspace and document remote storage.

Important constraints:

- Use bun commands only.
- Do not use em dashes or en dashes in source, docs, comments, UI copy, or commit messages.
- Ship client handling for 4410 before server delete routes.
- Do not let sync upserts reactivate deleted registry rows.
- Missing registry rows must not make delete a no-op. Create a tombstone and attempt cleanup.
- Recreate must increment generation. Old-generation clients must stay blocked.
- Do not rely on ctx.storage.deleteAll() alone. The Durable Object must close connections, detach persistence listeners, destroy awareness, destroy the old Y.Doc, recreate SQL schema, and install a blank runtime.
- DocumentRoom must recreate the snapshots table and clear lastSavedSv after reset.
- HTTP sync against deleted remote storage should return 410 JSON.
- WebSocket sync against deleted remote storage should close with app code 4410 and JSON reason code remote_storage_deleted.
- Keep deletion idempotent.
- Preserve local client data when remote sync is disabled.
- Add focused API, registry, and sync-client tests.
- Update apps/dashboard with a small Remote Data surface that lists entries and lets users delete, retry cleanup, or re-enable remote sync.

After implementation, run the focused tests and type checks. Update this spec's checklist as work lands.
```
