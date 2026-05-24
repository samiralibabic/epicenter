# Readonly Table Primitives And Fuji Script Surfaces

**Date**: 2026-04-30
**Status**: Superseded (script-surfaces portion)
**Superseded by**: `20260514T160000-script-surfaces-resolution.md`
**Still live**: the readonly-table-primitives concept (the `encryption.attachTables` / `attachKv` split) is unchanged. The script-surfaces direction (per-app `openXSnapshot` + `openXScript` recipes) is replaced: scripts read SQLite directly and write through `connectDaemonActions`; there is no per-app script recipe.
**Author**: AI-assisted

> **Path note (2026-05-22):** Any `$EPICENTER_HOME/auth/credentials.json` references in this spec are stale. Current machine auth is stored through the active auth path resolver, not a top-level `~/.epicenter` home.

## Overview

Split table attachment into read-only and writable layers, then use that split to make Fuji script reads honest. This spec supports a fast local `snapshot` and raw daemon `actions`. `fuji.snapshot` is local, read-only, and allowed to be stale. Durable writes go through daemon actions. Sync-peer writes and table-shaped daemon facades are deferred until they have named, tested contracts.

One sentence: Fuji scripts use snapshots for fast local inspection and daemon actions for durable commands.

## Motivation

### Current State

`apps/fuji/src/lib/fuji/script.ts` opens a Y.Doc, hydrates it from the daemon's Yjs log reader, attaches sync, attaches RPC, and returns the full document bundle:

```ts
const doc = openFujiDoc({ clientID });
const yjsLog = attachYjsLogReader(doc.ydoc, {
	filePath: yjsPath(projectDir, doc.ydoc.guid),
});
const sync = attachSync(doc, {
	url: websocketUrl(`${apiUrl}/workspaces/${doc.ydoc.guid}`),
	getToken,
	webSocketImpl,
});
const rpc = sync.attachRpc(doc.actions);

return { ...doc, yjsLog, sync, rpc };
```

That gives script callers this surface:

```ts
using fuji = openFuji({ projectDir, getToken });

fuji.tables.entries.getAllValid();
fuji.actions.entries.create({ title: 'Draft' });
fuji.tables.entries.set(row);
```

This creates problems:

1. **The same object has two durability stories**: reads come from a local Yjs log snapshot plus optional sync. Local writes mutate the script Y.Doc and persist only if sync carries them somewhere durable before the script exits.
2. **TypeScript can hide writes, but runtime still has them**: `Pick<Table<T>, ...>` can present a read-only type, but the object still has `set`, `update`, `delete`, and `clear`.
3. **The script `openFuji()` name is overloaded**: it can mean snapshot, peer, or daemon-adjacent scripting depending on how the caller uses it.
4. **Offline writes are easy to misunderstand**: a script-local table write does not hit the daemon log while offline. A daemon action does, if the daemon is running.

### Desired State

Read-only table attachment should be a first-class primitive:

```ts
const tables = encryption.attachReadonlyTables(ydoc, fujiTables);
```

Writable tables should compose from read-only tables:

```ts
export function createTable(store, definition, name) {
	const readonly = createReadonlyTable(store, definition, name);
	return {
		...readonly,
		set(row) {
			store.set(row.id, row);
		},
		update(id, partial) {
			const current = readonly.get(id);
			// validate, then set
		},
		delete(id) {
			store.delete(id);
		},
	};
}
```

Fuji scripts should expose a read-only snapshot and raw daemon actions:

```ts
using snapshot = await openFujiSnapshot({ projectDir });
const rows = snapshot.tables.entries.getAllValid();

const actions = await connectFujiDaemonActions({ projectDir });
const created = await actions.entries.create({ title: 'Draft' });
if (created.error) throw created.error;

await using fuji = await openFujiScript({ projectDir });
const fastSnapshotRows = fuji.snapshot.entries.getAllValid();
await fuji.actions.entries.create({ title: 'Raw action access stays available' });
```

Do not add `openFujiPeer()`, `flush()`, or a daemon-backed table facade in this spec. If a future script needs direct peer writes or table-shaped daemon calls, introduce that in a separate spec and name the guarantee precisely.

## Research Findings

### Current Table Shape

`packages/workspace/src/document/attach-table.ts` already has a natural split:

| Method group | Methods | Writes to Yjs |
| --- | --- | --- |
| Metadata and parsing | `name`, `definition`, `parse` | No |
| Reads | `get`, `getAll`, `getAllValid`, `getAllInvalid`, `filter`, `find`, `count`, `has` | No |
| Observation | `observe` | No, but subscribes to changes |
| Writes | `set`, `bulkSet`, `update`, `delete`, `bulkDelete`, `clear` | Yes |

The original implementation defined local `parseRow()` and then returned one object containing both groups. The writable table can be built by composing the read object and adding write methods, with `update()` writing through the captured store instead of depending on a method receiver.

### Encryption Coordinator

Encrypted tables currently call `createTable(store, definition, name)` after creating and registering an encrypted store. The same coordinator can expose `attachReadonlyTable()` and `attachReadonlyTables()` by calling `createReadonlyTable(store, definition, name)` over the same encrypted store.

This keeps the encryption model unchanged. The only difference is which methods the caller receives.

### Yjs Provider Semantics

Yjs writes are valid from any peer. A local mutation emits an update event, and a provider decides whether to send or store that update.

Grounding:

- Yjs document updates are commutative, associative, and idempotent. Peers converge when they eventually receive all updates.
- `ydoc.on('update', ...)` is the hook providers use to send updates to other peers or store them in a database.
- Yjs docs explicitly separate network providers from database providers. Network providers sync updates over a transport. Database providers store updates locally.
- Offline support requires a database provider or some other durable writer. A network provider alone does not make a short-lived script's local edits durable.

References:

- https://docs.yjs.dev/api/document-updates
- https://docs.yjs.dev/api/y.doc
- https://docs.yjs.dev/getting-started/allowing-offline-editing
- https://docs.yjs.dev/ecosystem/database-provider/y-indexeddb

### Current Sync Flush Machinery

`flush()` does not exist today. The current sync implementation has ingredients for a future server-ack save barrier:

1. `localVersion` increments on each local `updateV2`.
2. After a 100 ms debounce, the client sends `SYNC_STATUS(localVersion)`.
3. The API sync handler echoes that status frame.
4. The client stores the echoed value as `ackedVersion`.
5. `hasLocalChanges` becomes false when `ackedVersion >= localVersion`.

Because WebSocket frames are ordered on one connection, an echoed status sent after an update means the server received the earlier update frame on that connection. In the API room, applying the update mutates the room Y.Doc, whose update listener persists the update to room storage.

This only proves server receipt and server-side persistence. It does not prove that the local daemon received the update, wrote its Yjs log, or ran SQLite and Markdown materializers. A separate daemon-materialized ack would require another mechanism.

### Daemon Action Durability

The local `/run` path is daemon-only and action-only:

```txt
script or CLI
  -> connectDaemonActions() or epicenter run
  -> local Unix socket
  -> daemon /run
  -> invokeAction(workspace.actions, ...)
```

`/run` does not wait for generic persistence, sync, materializers, or readiness. It resolves the action and returns after `invokeAction(...)` resolves.

For normal Fuji entry actions, local durability is effectively synchronous because the daemon attaches `attachYjsLog` before actions run. The table write mutates the daemon Y.Doc, `attachYjsLog` observes `updateV2`, and the update is inserted into the Yjs log in-process.

Limits:

1. The Yjs log SQLite writer uses WAL with `PRAGMA synchronous = NORMAL`. This is a reasonable local durability tradeoff, but not a strict power-loss fsync guarantee.
2. SQLite and Markdown materializers are projections. `/run` can return before these projections finish.
3. Fuji `bulkCreate` currently calls `tables.entries.bulkSet(rows)` without `await`. For more than one chunk, `/run` can return before all rows are written.

### Deferred Daemon-Backed Table Facade

A short-lived script could have a table-shaped API if the authoritative methods are daemon-backed and async:

```ts
await using fuji = await openFujiScript({ projectDir });

const rows = await fuji.actions.entries.getAllValid({});
if (rows.error) throw rows.error;
await fuji.actions.entries.update({
	id: rows.data[0].id,
	title: 'Revised title',
});
await fuji.actions.entries.delete({ id: rows.data[0].id });

const fastRows = fuji.snapshot.entries.getAllValid();
```

This is not the same as exposing the script-local `Table` object. The local snapshot remains read-only. The facade's read and write methods route to daemon actions over `/run`, so the daemon answers reads from its own Y.Doc and owns writes to the source-of-truth Yjs log.

The facade should be app-specific, not a blind generic wrapper around `Table`. Generic read methods are fine when their inputs are serializable. Generic write methods such as raw `set`, hard `delete`, `bulkDelete`, or `clear` can bypass Fuji semantics such as generated IDs, `updatedAt`, soft delete, restore, and future side effects.

Methods that accept functions need a named rule. A predicate cannot cross `/run`, so a future `fuji.tables.entries.filter(predicate)` should either call `getAllValid()` through the daemon and filter client-side, or stay only on `fuji.snapshot.entries`. The current default favors clarity: expose daemon actions for serializable reads, and use snapshots for local predicate-heavy work.

The authoritative facade can still feel table-shaped, but the backing methods should map to Fuji actions:

| Facade method | Backing action | Notes |
| --- | --- | --- |
| `get(id)` | `actions.entries.get({ id })` | Requires a new query action. Reads daemon state. |
| `getAllValid()` | `actions.entries.getAllValid()` | Requires a new query action. Reads daemon state. |
| `count()` | `actions.entries.count()` | Requires a new query action. |
| `has(id)` | `actions.entries.has({ id })` | Requires a new query action. |
| `create(input)` | `actions.entries.create(input)` | App-level creation with generated ID and defaults. |
| `set(row)` | `actions.entries.upsert(row)` | Requires a new action. It should validate the row and own timestamp policy. |
| `update(id, partial)` | `actions.entries.update({ id, ...partial })` | Existing action. Preserves `updatedAt` behavior. |
| `delete(id)` | `actions.entries.delete({ id })` | Soft delete, not raw `Table.delete`. |
| `restore(id)` | `actions.entries.restore({ id })` | Existing action. |
| `bulkCreate(input)` | `actions.entries.bulkCreate(input)` | Existing action, but handler must await `bulkSet`. |

Do not implement this facade in the current script surface. The previous `createFujiScriptEntryTable()` shape was a one-off adapter that made daemon actions look like a table without creating a reusable contract. If this comes back, it should be a generic table-action bridge or an app-level facade with its own spec, not Fuji-local glue.

## Option Matrix

| Option | Short-lived script failure mode | Offline behavior | Complexity | Verdict |
| --- | --- | --- | --- | --- |
| Daemon action writes | Fails clearly if daemon is not running. Once accepted, daemon owns local durability. | Good local offline if daemon is up. No internet required. | Low. Already built. | Best default. |
| Snapshot plus raw daemon actions | Reads are local and possibly stale. Writes are durable through daemon. | Good if daemon is up. | Low. Already built. | Best primitive. |
| Daemon-backed tables plus snapshot | Authoritative reads and writes go through daemon. Fast reads use a named snapshot. | Good if daemon is up. | Medium. Needs daemon read queries and a thin Fuji wrapper. | Best script UX. |
| Sync peer plus future `flush()` | Without flush, process can exit before server ack. With flush, server receipt is explicit. | Weak offline unless paired with local persistence. | Medium. Existing counters almost support it. | Defer. |
| Per-script writable persistence | Survives process exit, but every script becomes a durable writer that must drain later. | Good for script-local offline, but needs a later sync runner. | Medium to high. Needs paths, cleanup, drain, and stale state policy. | Useful later, not default. |
| Append-only action outbox | Crash recovery is strong if intent is recorded before execution. | Good, but replay needs daemon and action compatibility. | High. Needs idempotency, schema versioning, retries, status. | Too much machinery now. |
| Direct shared Yjs log writer from scripts | Durable locally if the write commits. | Good on paper. | High risk. Current file design assumes one writer plus many readers. | Avoid. |

## Design Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Read-only table primitive | Add `ReadonlyTable` and `attachReadonlyTable(s)` | Runtime object has no write methods. This is stronger than a type-only `Pick`. |
| Writable table composition | `createTable()` spreads `createReadonlyTable()` and adds writes | Keeps one parse and read implementation. Writable tables are a superset. |
| Encrypted read-only tables | Add methods on the encryption coordinator | Mirrors existing `attachTable` and `attachTables` coordinator pattern. |
| Fuji snapshot | Return read-only tables and no local actions | Snapshots are for inspection, export, and predicate-heavy local reads. They may be stale. |
| Daemon actions | Keep `connectFujiDaemonActions()` separate | This is the durable write surface for scripts. The daemon owns the source-of-truth Yjs log. |
| Daemon-backed tables | Defer table-shaped reads and writes | A one-off Fuji adapter is misleading. Raw daemon actions are honest until a reusable table-action contract exists. |
| High-level script helper | Compose flattened snapshot tables and raw actions | Gives scripts local reads plus durable daemon commands without a fake table API. |
| Snapshot naming in `openFujiScript()` | Expose `fuji.snapshot.entries`, not `fuji.snapshot.tables.entries` | Keeps the common local-read path short. Standalone `openFujiSnapshot()` still returns `{ tables, yjsLog }` for lower-level metadata. |
| Fuji peer | Defer `openFujiPeer()` | Peer writes are Yjs-valid, but this spec is about honest offline scripting. |
| Sync flush | Defer `flush()` | The current ack can support a future server-save API, not a local daemon durability API. |
| Async open functions | Make both `openFujiSnapshot()` and `openFujiScript()` async | Snapshots may load saved session keys before replaying the local Yjs log. The daemon proxy remains async because it connects to the socket. |

## Architecture

### Workspace Table Primitives

```txt
ObservableKvStore
  |
  |-- createReadonlyTable(store, def, name)
  |     |-- parse
  |     |-- get / getAll / getAllValid
  |     |-- filter / find / count / has
  |     `-- observe
  |
  `-- createTable(store, def, name)
        |-- ...createReadonlyTable(...)
        |-- set / bulkSet
        |-- update
        |-- delete / bulkDelete
        `-- clear
```

### Fuji Script Surfaces

```txt
openFujiSnapshot()
  |-- openFujiDoc internals
  |-- attachYjsLogReader
  |-- attachReadonlyTables
  `-- returns read-only tables, yjsLog, dispose

connectFujiDaemonActions()
  `-- connectDaemonActions({ route, projectDir })

openFujiScript()
  |-- snapshot: openFujiSnapshot().tables
  |-- actions: connectFujiDaemonActions()
  `-- dispose: closes the underlying snapshot attachment and daemon client resources
```

## Target APIs

### Workspace Package

```ts
export type ReadonlyTable<TRow extends BaseRow> = {
	name: string;
	definition: TableDefinition<any>;
	parse(id: string, input: unknown): Result<TRow, TableParseError>;
	get(id: string): Result<TRow | null, TableParseError>;
	getAll(): Array<Result<TRow, TableParseError>>;
	getAllValid(): TRow[];
	getAllInvalid(): TableParseError[];
	filter(predicate: (row: TRow) => boolean): TRow[];
	find(predicate: (row: TRow) => boolean): TRow | undefined;
	observe(
		callback: (
			changedIds: ReadonlySet<TRow['id']>,
			origin?: unknown,
		) => void,
	): () => void;
	count(): number;
	has(id: string): boolean;
};

export type ReadonlyTables<TDefs extends TableDefinitions> = {
	[K in keyof TDefs]: ReadonlyTable<InferTableRow<TDefs[K]>>;
};

export function attachReadonlyTable<TDef extends TableDefinition<any>>(
	ydoc: Y.Doc,
	name: string,
	definition: TDef,
): ReadonlyTable<InferTableRow<TDef>>;

export function attachReadonlyTables<TDefs extends TableDefinitions>(
	ydoc: Y.Doc,
	definitions: TDefs,
): ReadonlyTables<TDefs>;
```

`Table<TRow>` remains the writable superset:

```ts
export type Table<TRow extends BaseRow> = ReadonlyTable<TRow> & {
	set(row: TRow): void;
	bulkSet(rows: TRow[], options?: BulkOptions): Promise<void>;
	update(
		id: string,
		partial: Partial<Omit<TRow, 'id'>>,
	): Result<TRow | null, TableParseError>;
	delete(id: string): void;
	bulkDelete(ids: string[], options?: BulkDeleteOptions): Promise<void>;
	clear(): void;
};
```

### Fuji Script Package

```ts
export type OpenFujiSnapshotOptions = {
	projectDir?: ProjectDir;
	clientID?: number;
};

export async function openFujiSnapshot(options?: OpenFujiSnapshotOptions): Promise<{
	tables: ReadonlyTables<typeof fujiTables>;
	yjsLog: YjsLogReaderAttachment;
	[Symbol.dispose](): void;
}>;

export function connectFujiDaemonActions(options?: {
	route?: string;
	projectDir?: ProjectDir;
}): Promise<DaemonActions<ReturnType<typeof createFujiActions>>>;

export async function openFujiScript(options?: {
	route?: string;
	projectDir?: ProjectDir;
	clientID?: number;
}): Promise<{
	snapshot: ReadonlyTables<typeof fujiTables>;
	actions: DaemonActions<ReturnType<typeof createFujiActions>>;
	[Symbol.asyncDispose](): Promise<void>;
}>;
```

The script surface intentionally keeps the two shapes separate: fast local reads live on `snapshot`; durable commands live on `actions`.

`openFujiScript()` still owns the full snapshot attachment internally so it can dispose the Y.Doc and close the Yjs log reader. It only exposes the attachment's tables as `snapshot`:

```ts
fuji.snapshot.entries.getAllValid();
await fuji.actions.entries.create({ title: 'Draft' });
```

Do not add `openFujiPeer()`, `flush()`, or a daemon-backed table facade in this spec.

Call sites:

```ts
using snapshot = await openFujiSnapshot({ projectDir });

const drafts = snapshot.tables.entries.filter((entry) =>
	entry.tags.includes('draft'),
);
```

```ts
const actions = await connectFujiDaemonActions({ projectDir });

await actions.entries.create({ title: 'Offline local draft' });
```

```ts
await using fuji = await openFujiScript({ projectDir });

const existing = await fuji.actions.entries.getAllValid({});
if (existing.error) throw existing.error;
await fuji.actions.entries.create({
	title: `Imported ${existing.data.length}`,
});
const first = existing.data[0];
if (first) await fuji.actions.entries.update({ id: first.id, tags: ['imported'] });
const fastRows = fuji.snapshot.entries.getAllValid();
```

## Implementation Plan

### Phase 1: Table Primitive Split

- [x] **1.1** Add `ReadonlyTable` and `ReadonlyTables` types in `attach-table.ts`.
- [x] **1.2** Extract `createReadonlyTable(ykv, definition, name)` from the read methods currently inside `createTable()`.
- [x] **1.3** Change `createTable()` to compose `const readonly = createReadonlyTable(...)` and add write methods.
- [x] **1.4** Add `attachReadonlyTable()` and `attachReadonlyTables()` for plaintext stores.
- [x] **1.5** Export the new types and functions from `packages/workspace/src/index.ts`.
- [x] **1.6** Add unit tests that read-only tables do not expose write methods at runtime.

### Phase 2: Encryption Coordinator Support

- [x] **2.1** Add `attachReadonlyTable()` and `attachReadonlyTables()` to `EncryptionAttachment`.
- [x] **2.2** Implement both methods with `createReadonlyTable()` over encrypted stores.
- [x] **2.3** Add tests proving encrypted read-only tables can read, observe, and parse without exposing writes.

### Phase 3: Fuji Script Split

- [x] **3.1** Replace the ambiguous script `openFuji()` with `openFujiSnapshot()`.
- [x] **3.2** `openFujiSnapshot()` returns read-only tables, `yjsLog`, and disposal. It does not return `actions`, `ydoc`, `batch`, `sync`, `rpc`, or writable tables.
- [x] **3.3** Keep `connectFujiDaemonActions()` in `daemon.ts` as the durable write surface.
- [x] **3.4** Add daemon query actions for serializable reads such as `get`, `getAllValid`, `count`, and `has`.
- [x] **3.5** Defer the daemon-backed Fuji table facade until a reusable table-action contract exists.
- [x] **3.6** Keep `entries.upsert` as a raw daemon action for import and repair scripts.
- [x] **3.7** Add `openFujiScript()` as `{ snapshot, actions }`.
- [x] **3.8** Make `openFujiScript().snapshot` expose readonly tables directly as `fuji.snapshot.entries`, while disposing the underlying snapshot attachment internally.
- [x] **3.9** Update Fuji script and integration tests to use raw daemon `actions` plus read-only `snapshot`.

### Phase 4: Daemon Action Return Guarantees

- [x] **4.1** Fix Fuji `bulkCreate` so the handler awaits `tables.entries.bulkSet(rows)`.
- [x] **4.2** Document that `/run` success means the daemon action handler returned, not that projections are flushed.
- [x] **4.3** Decide whether a separate projection flush contract is needed for SQLite and Markdown materializers.
  Decision: not for this script API. Raw daemon actions promise action completion and Yjs log ownership, not projection visibility.
- [x] **4.4** If projection visibility is required, add a named contract such as `workspace.projections.flush()` and have callers opt into it.
  Decision: deferred until a caller needs projection visibility rather than table/action visibility.

### Deferred: Sync Peer Save Barrier

Do not implement `flush()` here.

The current `attachSync()` status echo can indicate that the server echoed a `SYNC_STATUS` frame after earlier frames on the same WebSocket. That is useful, but it is not the same as a documented save barrier API. It also says nothing about a local daemon receiving the update, writing its Yjs log, or running SQLite and Markdown materializers.

A future spec can add one of these APIs after tests define the contract:

- `sync.whenSaved(options?)`
- `sync.flush(options?)`
- `openFujiPeer()` with a wrapper around that sync API

That future contract must say exactly what was saved: server room only, local daemon materialization, or both.

## Edge Cases

### Snapshot Still Observes Applied Writes

1. A snapshot opens read-only tables.
2. Another peer writes a row.
3. The snapshot receives an update by reading a refreshed log or by a future sync-backed snapshot mode.
4. `observe()` fires and `getAllValid()` reflects the new row.

This is expected. Read-only means this handle does not expose local write methods. It does not mean the underlying document cannot receive remote updates.

### Snapshot Is Stale After Daemon Write

```ts
await using fuji = await openFujiScript(options);
await fuji.actions.entries.create({ title: 'Fresh daemon row' });

const fresh = await fuji.actions.entries.getAllValid({});
const maybeStale = fuji.snapshot.entries.getAllValid();
```

This is expected. `fuji.actions` is the source-of-truth API. `fuji.snapshot` is a fast local replay and can lag until the caller opens a new snapshot or a future live snapshot mode exists.

### Caller Imports Raw `openFujiDoc`

`openFujiDoc()` still returns writable tables because it is the isomorphic document factory. This is acceptable. The read-only guarantee applies to the snapshot surface, not to every possible internal import.

### Encrypted Snapshot Keys

If the daemon log contains encrypted rows, `openFujiSnapshot()` and `openFujiScript()` read the saved Node credentials from `$EPICENTER_HOME/auth/credentials.json` and apply the saved encryption keys for the Epicenter API. Without saved credentials, the snapshot can still read plaintext rows, but encrypted rows remain unreadable.

### Script Wants Direct Peer Writes

Deferred. Direct peer writes are not exposed by the Fuji script package yet. They are valid Yjs operations, but the process lifetime contract is unresolved. Use daemon actions for durable script writes.

### Script Needs Local Durable Writes While Offline

Use raw daemon actions, not peer actions:

```ts
await using fuji = await openFujiScript(options);
await fuji.actions.entries.create({ title: 'Offline local draft' });
```

This requires the local daemon to be running, but it does not require internet. The daemon owns `attachYjsLog`, SQLite, and Markdown materializers. The Yjs log is the source of truth; SQLite and Markdown are projections.

### Daemon Is Not Running

Daemon actions should fail clearly with the existing daemon-required error. Do not fall back to local peer writes. A fallback would turn a durable command into a best-effort in-memory edit.

## Open Questions

1. **Should `parse()` live on `ReadonlyTable`?**
   - Options: include it, or reserve it for writable tables.
   - Recommendation: include it. Parsing does not write, and materializers/readers may need schema validation without mutation.

2. **Should read-only tables expose `definition`?**
   - Options: expose it, or hide it and force materializers to use writable tables.
   - Recommendation: expose it. SQLite and Markdown materializers read definitions; the definition itself is not a write capability.

3. **Should `openFujiSnapshot()` connect sync by default?**
   - Options: no sync in this spec, always connect, connect only when requested.
   - Recommendation: no sync in this spec. Start with a true local snapshot. Add sync-backed snapshots only when a real use case needs live read observation.

4. **Should `openFujiScript()` expose table-shaped writes?**
   - Options: expose only raw actions now, or add a reusable table-action bridge later.
   - Recommendation: expose only raw actions now. A Fuji-local table wrapper is too easy to confuse with a real table. Add table-shaped writes later only with a generic contract.

5. **Should per-script local persistence exist later?**
   - Options: add per-script Yjs logs, add an action outbox, or require daemon actions.
   - Recommendation: require daemon actions now. Per-script persistence needs a drain protocol, cleanup rules, conflict policy, and user-visible status.

6. **Should the Yjs source-of-truth log use stricter SQLite sync?**
   - Options: keep `synchronous = NORMAL`, switch source log to stricter sync, or make it configurable.
   - Recommendation: defer. The current setting is a performance/durability tradeoff. If stronger power-loss guarantees matter, decide that separately from script API shape.

## Verification

- `bun run --cwd packages/workspace typecheck`
- `bun test packages/workspace/src/document/create-table.test.ts packages/workspace/src/document/attach-encryption.test.ts apps/fuji/src/lib/fuji/integration.test.ts`
- `bun run --cwd apps/fuji typecheck`
- Type-level checks that `openFujiSnapshot().tables.entries.set` is not callable.
- Runtime tests that `'set' in snapshot.tables.entries` is false.
- Integration test proving `openFujiScript().actions.entries.create(...)` writes through the daemon and is visible to a fresh `openFujiSnapshot()`.

## Review

Implemented the core split:

- Workspace now has first-class read-only table primitives for plaintext and encrypted stores.
- Writable tables compose from read-only tables, so runtime capabilities match the type surface.
- Fuji scripts now expose async `openFujiSnapshot()` for local read-only replay and `openFujiScript()` for raw daemon actions plus a local snapshot. Both auto-load saved session keys by default.
- Fuji daemon actions now include serializable read queries plus `upsert`, and `bulkCreate` awaits the actual table write.
- The daemon integration test proves a script action create call goes through the daemon and is visible from a fresh snapshot.

Verification status:

- `packages/workspace` typecheck passed.
- Focused workspace and Fuji integration tests passed.
- `apps/fuji` typecheck still reports unrelated existing failures outside this script/table split, including Svelte component and package typing issues.
