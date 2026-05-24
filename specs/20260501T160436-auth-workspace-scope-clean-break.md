# Auth Workspace Scope Clean Break

**Date**: 2026-05-01
**Status**: Superseded
**Author**: AI-assisted
**Branch**: `codex/explicit-daemon-host-config`

> Superseded by `specs/20260501T221831-auth-workspace-lifecycle-inversion.md`.
> This document describes the earlier `BrowserWorkspace` proposal and is kept
> as historical context, not current implementation guidance.

## One Sentence

One auth client drives lifecycle transitions for a set of browser workspaces, and each browser workspace owns the full browser resource graph behind a small lifecycle contract.

## Overview

Replace the single-workspace auth binding with `bindAuthWorkspaceScope(...)`.
The binding tracks one auth session state for one or more browser workspaces.
It decides when to pause sync, apply encryption keys, reconnect sync, and clear
local browser data.

This is a clean break. Do not keep `bindWorkspaceAuthLifecycle` as a
compatibility alias. Do not add `workspace.authLifecycle` or
`workspace.authBinding`.

The important design move is separating single-document attachments from
whole-workspace lifecycle. Raw attachments like `idb` and `sync` describe one
Y.Doc. Browser workspace lifecycle methods describe the whole browser graph:
the root workspace document plus any child document collections.

```txt
Single root document only

  root ydoc
    idb
    sync
    encryption

  auth can call sync.goOffline(), sync.reconnect(), idb.clearLocal()


Workspace graph

  root ydoc
    idb
    sync
    encryption

  child docs
    entry A ydoc
      idb
      sync
    entry B ydoc
      idb
      sync
    unopened entry C ydoc
      IndexedDB exists, but no live object exists

  auth cannot safely compose this by reading root idb and root sync
```

So the final rule is:

```txt
Raw attachments describe one Y.Doc.
BrowserWorkspace lifecycle methods describe the whole browser workspace graph.
```

## Vocabulary

`Y.Doc` is raw CRDT state and identity. It has no browser persistence policy,
no auth policy, and no product tables by itself.

`Workspace` is the root domain bundle around one Y.Doc. It owns the root
document identity, encryption coordinator, domain operations, batching, and
root disposal.

`BrowserWorkspace` is a `Workspace` opened in a browser runtime. It exposes a
root local-load promise and three aggregate lifecycle methods. It does not
require callers to know which root and child attachments exist.

`BrowserDocumentCollection` is a keyed child document collection such as Fuji
entry content docs, Honeycrisp note body docs, or Opensidian file content docs.
It owns child document caching, active child sync control, active child
disposal, and local data clearing for unopened child docs.

`FileBackedWorkspace` is a possible future local file runtime concept. Do not
introduce it in this auth clean break unless a generic file-backed consumer
actually needs it.

`DaemonRouteRuntime` is the long-running process surface returned by daemon
route definitions. It is not a `BrowserWorkspace`, and it should not be forced
through a file-backed workspace type just because it uses file persistence.

`Auth lifecycle` is the transition processor that reacts to auth snapshots. It
applies encryption keys, moves browser sync resources offline or online, clears
local browser data, and runs app policy callbacks.

## Public Runtime Shapes

The shared workspace types should live in `@epicenter/workspace`.

```ts
import type * as Y from 'yjs';

export type Workspace = {
	readonly ydoc: Y.Doc;
	readonly encryption: EncryptionAttachment;
	batch(fn: () => void): void;
	[Symbol.dispose](): void;
};

export type BrowserWorkspace = Workspace & {
	/**
	 * Resolves when root browser persistence has loaded into the root Y.Doc.
	 *
	 * This does not mean remote sync has converged. It also does not mean child
	 * documents have loaded.
	 */
	readonly whenLoaded: Promise<unknown>;

	/** Stop every live browser sync resource owned by this workspace graph. */
	goOffline(): void;

	/** Restart every live browser sync resource owned by this workspace graph. */
	reconnect(): void;

	/**
	 * Clear every browser persistence store owned by this workspace graph.
	 *
	 * Implementations should call goOffline() first. For current browser apps,
	 * app policy should reload or reopen fresh workspace objects after this
	 * succeeds because the old Y.Doc state remains in memory.
	 */
	clearLocalData(): Promise<void>;
};

// Deferred. Add only when a generic file-backed consumer exists.
// export type FileBackedWorkspace = Workspace;
```

`BrowserWorkspace` deliberately does not require `idb` or `sync` fields.
Concrete app workspaces may still return them. Generic lifecycle consumers do
not need them.

```txt
BrowserWorkspace contract
  ydoc
  encryption
  batch()
  whenLoaded
  goOffline()
  reconnect()
  clearLocalData()
  dispose

Fuji concrete object
  all BrowserWorkspace fields
  idb
  sync
  awareness
  rpc
  remote
  entryContentDocs
```

Do not export app-specific intersection types like
`FujiBrowserWorkspace = BrowserWorkspace & ...` unless a real external caller
needs that named type. Let the return type of `openFuji(...)` carry the richer
concrete shape.

```ts
export function openFuji(...) {
	return {
		...doc,
		idb,
		sync,
		awareness,
		rpc,
		remote,
		entryContentDocs,
		whenLoaded: idb.whenLoaded,
		goOffline() {
			// root plus children
		},
		reconnect() {
			// root plus children
		},
		async clearLocalData() {
			// root plus children
		},
		[Symbol.dispose]() {
			// children before root
		},
	} satisfies BrowserWorkspace;
}
```

The `satisfies BrowserWorkspace` check gives the shared guarantee without
erasing the concrete inferred return type.

## Why Not Composite Attachments

Composite `sync` looks attractive:

```ts
workspace.sync.goOffline();
workspace.sync.reconnect();
```

But a root sync attachment also has root-specific semantics: status, awareness,
RPC attachment, and `whenConnected`. Those do not compose cleanly across root
and child documents.

```txt
Composite sync.status
  Is it connected if root is connected but one child is offline?

Composite sync.attachRpc()
  Which document owns the RPC action surface?

Composite sync.whenConnected
  Root connected, every open child connected, or every possible child?
```

Composite `idb` has the same problem:

```txt
Composite idb.whenLoaded
  Root loaded?
  All currently open child docs loaded?
  Every child doc listed in the root table loaded?

Composite idb.clearLocal
  This actually must include unopened child docs.
```

The result is an object that looks like an attachment but no longer behaves
like one. Keep raw attachments single-document. Put graph-level behavior on
the browser workspace lifecycle methods.

## Browser Child Document Collections

`createDisposableCache` should remain unchanged and generic. It shares one live
disposable value per id, refcounts handles, and disposes the underlying value
after the grace period or cache disposal.

Browser document collection is the wrapper that earns a domain-specific name.
It owns three browser graph facts that `createDisposableCache` should not know:

1. Which active child sync resources exist.
2. Which child document GUIDs exist even when the documents are not open.
3. How to clear local browser persistence for those GUIDs.

Recommended exported shape:

```ts
export type BrowserDocumentCollection<
	Id extends string | number = string,
	TDocument extends Disposable = Disposable,
> = Disposable & {
	open(id: Id): TDocument & Disposable;
	has(id: Id): boolean;
	goOffline(): void;
	reconnect(): void;
	clearLocalData(): Promise<void>;
};

export type BrowserDocumentCollectionOptions<
	Id extends string | number,
	TDocument extends Disposable,
> = {
	ids(): Iterable<Id>;
	guid(id: Id): string;
	build(id: Id): TDocument;
	sync?(document: TDocument): SyncAttachment | null;
	clearLocalDataForGuid?(guid: string): Promise<void>;
	gcTime?: number;
};

export function createBrowserDocumentCollection<
	Id extends string | number,
	TDocument extends Disposable,
>(
	options: BrowserDocumentCollectionOptions<Id, TDocument>,
): BrowserDocumentCollection<Id, TDocument>;
```

Default `clearLocalDataForGuid` should clear the IndexedDB database for that
document GUID. If a future collection uses a different browser persistence
store, it can supply its own clear function.

Child document builders may expose `idb` and `sync` as concrete fields, but
they do not need to implement the full browser workspace contract.

```ts
export type EntryContentDoc = {
	readonly ydoc: Y.Doc;
	readonly body: RichTextAttachment;
	readonly idb: IndexedDbAttachment;
	readonly sync: SyncAttachment;
	readonly whenLoaded: Promise<unknown>;
	[Symbol.dispose](): void;
};
```

The collection handles active sync registration internally by calling
`options.sync(document)` when a document is built and removing that sync when
the underlying cached document is disposed.

## Fuji Shape

Fuji should wire the graph once inside `openFuji(...)`.

```ts
export function openFuji({
	auth,
	peer,
}: {
	auth: AuthClient;
	peer: PeerIdentity;
}) {
	const doc = openFujiDoc();

	const idb = attachIndexedDb(doc.ydoc);
	attachBroadcastChannel(doc.ydoc);

	const entryContentDocs = createBrowserDocumentCollection({
		ids: () => doc.tables.entries.getAllValid().map((entry) => entry.id),
		guid: (entryId: EntryId) =>
			docGuid({
				workspaceId: doc.ydoc.guid,
				collection: 'entries',
				rowId: entryId,
				field: 'content',
			}),
		build: (entryId: EntryId) =>
			createEntryContentDoc({
				entryId,
				workspaceGuid: doc.ydoc.guid,
				entriesTable: doc.tables.entries,
				auth,
				apiUrl: APP_URLS.API,
			}),
		sync: (entryDoc) => entryDoc.sync,
		gcTime: 5_000,
	});

	const childCollections = [entryContentDocs] as const;

	const awareness = attachAwareness(doc.ydoc, {
		schema: { peer: PeerIdentity },
		initial: { peer },
	});

	const sync = attachSync(doc, {
		url: websocketUrl(`${APP_URLS.API}/workspaces/${doc.ydoc.guid}`),
		waitFor: idb,
		getToken: async () => {
			await auth.whenLoaded;
			const snapshot = auth.snapshot;
			return snapshot.status === 'signedIn' ? snapshot.session.token : null;
		},
		awareness,
	});

	const rpc = sync.attachRpc(doc.actions);
	const remote = createRemoteClient({ awareness, rpc });

	return {
		...doc,
		idb,
		sync,
		awareness,
		rpc,
		remote,
		entryContentDocs,
		whenLoaded: idb.whenLoaded,

		goOffline() {
			sync.goOffline();
			for (const child of childCollections) child.goOffline();
		},

		reconnect() {
			sync.reconnect();
			for (const child of childCollections) child.reconnect();
		},

		async clearLocalData() {
			this.goOffline();

			for (const child of childCollections) {
				await child.clearLocalData();
			}

			await idb.clearLocal();
		},

		[Symbol.dispose]() {
			for (const child of childCollections) {
				child[Symbol.dispose]();
			}

			doc[Symbol.dispose]();
		},
	} satisfies BrowserWorkspace;
}
```

`childCollections` is the single source of truth for graph-level child
lifecycle in the Fuji browser runtime. Add another child collection once, and
all three lifecycle methods plus disposal include it.

Honeycrisp follows the same pattern with `noteBodyDocs`.

Opensidian follows the same pattern with `fileContentDocs`. Its child documents
currently have IndexedDB persistence and no child sync, so the collection can
omit the `sync` option or return `null`.

Tab Manager has no child collections:

```ts
return {
	...doc,
	idb,
	sync,
	whenLoaded: idb.whenLoaded,
	goOffline: () => sync.goOffline(),
	reconnect: () => sync.reconnect(),
	clearLocalData: async () => {
		sync.goOffline();
		await idb.clearLocal();
	},
	[Symbol.dispose]() {
		doc[Symbol.dispose]();
	},
} satisfies BrowserWorkspace;
```

Zhongwen has no auth-backed sync target:

```ts
return {
	...doc,
	idb,
	whenLoaded: idb.whenLoaded,
	goOffline() {},
	reconnect() {},
	clearLocalData: () => idb.clearLocal(),
} satisfies BrowserWorkspace;
```

## Auth API

`@epicenter/auth-workspace` should depend on `BrowserWorkspace` from
`@epicenter/workspace`.

```ts
import type { AuthClient } from '@epicenter/auth';
import type { BrowserWorkspace } from '@epicenter/workspace';

export type AuthWorkspaceClearFailure = {
	workspaceGuid: string;
	error: unknown;
};

export type LeavingUserDestination =
	| { status: 'signedOut' }
	| { status: 'signedIn'; userId: string };

export type LeavingUserContext = {
	fromUserId: string;
	to: LeavingUserDestination;
	workspaceGuids: readonly string[];
};

export type LocalDataClearErrorContext = LeavingUserContext & {
	failures: readonly AuthWorkspaceClearFailure[];
};

export type SignedInWorkspacesAppliedContext = {
	userId: string;
	tokenChanged: boolean;
	workspaceGuids: readonly string[];
};

export type AuthWorkspaceScopeOptions = {
	auth: AuthClient;
	workspaces: Iterable<BrowserWorkspace>;
	onClearLocalDataError(context: LocalDataClearErrorContext): void;
	afterClearLocalData(context: LeavingUserContext): void;
	afterApplyAuthSession(context: SignedInWorkspacesAppliedContext): void;
};

export function bindAuthWorkspaceScope(
	options: AuthWorkspaceScopeOptions,
): () => void;
```

Example app call site:

```ts
bindAuthWorkspaceScope({
	auth,
	workspaces: [fuji],
	onClearLocalDataError: ({ failures }) => {
		toast.error('Could not clear local data', {
			description: failures.map(formatClearFailure).join('\n'),
		});
	},
	afterClearLocalData: () => window.location.reload(),
	afterApplyAuthSession: () => {},
});
```

Tab Manager uses the signed-in policy for device registration:

```ts
bindAuthWorkspaceScope({
	auth,
	workspaces: [tabManager],
	onClearLocalDataError: ({ failures }) => {
		toast.error('Could not clear local data', {
			description: failures.map(formatClearFailure).join('\n'),
		});
	},
	afterClearLocalData: () => window.location.reload(),
	afterApplyAuthSession: () => {
		void registerDevice();
	},
});
```

## Auth State Machine

The binding owns two auth lifecycle facts:

```ts
let activeUserId: string | null = null;
let activeToken: string | null = null;
```

It also owns serialized async processing:

```ts
let latestSnapshot = auth.snapshot;
let revision = 0;
let processing = false;
let disposed = false;
```

Snapshots must drain through one latest-snapshot loop. Cleanup and apply
operations must not overlap. After any awaited cleanup, check whether a newer
snapshot arrived before applying anything else.

### Loading

```txt
snapshot is loading

no side effects
```

### Cold Signed-Out Boot

```txt
activeUserId is null
snapshot is signedOut

for each workspace:
  workspace.goOffline()

do not clear local data
do not run cleanup policy
```

Cold signed-out boot should not wipe old local data. The app has not left an
applied user in this process.

### Cold Signed-In Boot

```txt
activeUserId is null
snapshot is signedIn user A

for each workspace:
  workspace.encryption.applyKeys(A.keys)

for each workspace:
  workspace.reconnect()

activeUserId = A
activeToken = A.token
afterApplyAuthSession()
```

### Same User Token Change

```txt
activeUserId is A
activeToken is token 1
snapshot is signedIn user A with token 2

for each workspace:
  workspace.encryption.applyKeys(A.keys)

for each workspace:
  workspace.reconnect()

activeToken = token 2
afterApplyAuthSession()
```

### Same User Key Change Without Token Change

```txt
activeUserId is A
activeToken is token 1
snapshot is signedIn user A with token 1 and new keys

for each workspace:
  workspace.encryption.applyKeys(A.keys)

do not reconnect
afterApplyAuthSession()
```

### Signed-In To Signed-Out

```txt
activeUserId is A
snapshot is signedOut

for each workspace:
  workspace.goOffline()

clear local data for every workspace

if every clear succeeds:
  activeUserId = null
  activeToken = null
  afterClearLocalData()

if any clear fails:
  keep activeUserId = A
  activeToken = null
  onClearLocalDataError()
```

### Signed-In User A To Signed-In User B

```txt
activeUserId is A
snapshot is signedIn user B

for each workspace:
  workspace.goOffline()

clear local data for every workspace

if every clear succeeds:
  activeUserId = null
  activeToken = null
  afterClearLocalData()
  do not apply B to old live workspace objects

if any clear fails:
  keep activeUserId = A
  activeToken = null
  onClearLocalDataError()
  do not apply B
```

Browser apps should reload or reopen fresh workspace objects after successful
cleanup. Clearing IndexedDB does not clear old in-memory Y.Doc state.

## File-Backed And Daemon Boundaries

File-backed runtimes are not part of the browser auth contract. Do not add a
shared `FileBackedWorkspace` type in this spec just to make the noun parallel
with `BrowserWorkspace`.

The useful distinction is lifecycle owner:

```txt
BrowserWorkspace
  owner: browser auth client
  local data: browser profile IndexedDB
  auth transition: user can sign out or switch users inside the same process
  required lifecycle: goOffline, reconnect, clearLocalData

DaemonRouteRuntime
  owner: daemon host
  local data: project files and materialized projections
  auth transition: machine credentials can disappear outside the route
  required lifecycle: daemon host decides whether to reconnect, go offline, or stop

Script or snapshot surface
  owner: caller scope
  local data: project files read during open
  auth transition: no long-running listener
  required lifecycle: dispose at the end of the script
```

A future file-backed workspace open can still be async:

```ts
export async function openFujiFileBacked(...) {
	const doc = openFujiDoc();
	const sqlite = attachSqlite(doc.ydoc, { filePath });
	await sqlite.whenLoaded;
	return {
		...doc,
		sqlite,
	};
}
```

That surface does not need `whenLoaded` because callers receive it after local
replay. It also does not need `clearLocalData()` by default. Browser sign-out
should clear browser profile data. Machine logout should not delete project
files unless the product explicitly adds a destructive project-clean command.

Daemon routes already have a different contract:

```ts
defineFujiDaemon().start({ projectDir })
// returns actions, awareness, sync, remote, asyncDispose
```

If `epicenter auth logout` must immediately affect already-running daemons,
that is daemon host behavior, not workspace shape:

```txt
epicenter auth logout
  clear machine credentials
  optionally notify local daemon host
    for each route:
      route.sync.goOffline()
      maybe stop route or wait for explicit restart
```

Without daemon-host notification, the current sync behavior is still coherent:
an existing websocket may remain open until the server closes it, and the next
reconnect calls `getToken()`. If credentials are gone, `getToken()` returns
null or fails and sync parks instead of authenticating.

## Implementation Plan

### Phase 1: Workspace Types

- [x] Export `Workspace` and `BrowserWorkspace` from `@epicenter/workspace`.
- [x] Keep `Workspace.ydoc`, `Workspace.encryption`, `Workspace.batch(fn)`, and `Workspace[Symbol.dispose]()`.
- [x] Add `BrowserWorkspace.whenLoaded`.
- [x] Add `BrowserWorkspace.goOffline()`.
- [x] Add `BrowserWorkspace.reconnect()`.
- [x] Add `BrowserWorkspace.clearLocalData()`.
- [x] Do not export `FileBackedWorkspace` in this auth clean break.
- [x] Do not require `BrowserWorkspace.idb`.
- [x] Do not require `BrowserWorkspace.sync`.
- [x] Do not add `BrowserWorkspace.documentCollections`.
- [x] Do not add `workspace.authLifecycle` or `workspace.authBinding`.

### Phase 2: Browser Document Collections

- [x] Add `createBrowserDocumentCollection(...)`.
- [x] Keep `createDisposableCache` generic and unchanged.
- [x] Make the collection own active child sync registration.
- [x] Make the collection clear unopened child IndexedDB stores from `ids()` and `guid(id)`.
- [x] Make collection disposal dispose all active cached child docs.
- [x] Prove the collection against Fuji, Honeycrisp, and Opensidian.

### Phase 3: Auth Binding

- [x] Rename `bindWorkspaceAuthLifecycle` to `bindAuthWorkspaceScope`.
- [x] Replace the single `workspace` option with `workspaces`.
- [x] Replace `WorkspaceAuthTarget` with `BrowserWorkspace`.
- [x] Remove `WorkspaceAuthSyncTarget`.
- [x] Remove support for `getAuthSyncTargets()`.
- [x] Snapshot the workspace iterable once at bind time.
- [x] Throw if the workspace list is empty.
- [x] Throw if `workspace.ydoc.guid` values are duplicated.
- [x] Process snapshots through a serialized latest-snapshot drain loop.
- [x] Aggregate clear failures with `workspaceGuid`.

### Phase 4: App Workspace Construction

- [x] Update Fuji to return `whenLoaded`, `goOffline`, `reconnect`, and `clearLocalData`.
- [x] Update Honeycrisp the same way.
- [x] Update Opensidian the same way.
- [x] Update Tab Manager with no child collections.
- [x] Update Zhongwen with no-op `goOffline` and `reconnect`.
- [x] Keep raw `idb`, `sync`, `awareness`, `rpc`, `remote`, and app-specific child collections as concrete app fields where useful.
- [x] Rename app-level `whenReady` exports to `whenLoaded`.

### Phase 5: App Auth Bindings

- [x] Update Fuji to call `bindAuthWorkspaceScope({ auth, workspaces: [fuji], ... })`.
- [x] Update Honeycrisp to call `bindAuthWorkspaceScope({ auth, workspaces: [honeycrisp], ... })`.
- [x] Update Opensidian to call `bindAuthWorkspaceScope({ auth, workspaces: [opensidian], ... })`.
- [x] Update Tab Manager to call `bindAuthWorkspaceScope({ auth, workspaces: [tabManager], ... })`.
- [x] Replace Zhongwen manual auth cleanup with `bindAuthWorkspaceScope`.
- [x] Move Tab Manager device registration to `afterApplyAuthSession`.
- [x] Keep toast and reload policy inline at app call sites.

### Phase 6: Tests

- [x] Cover empty workspace list rejection.
- [x] Cover duplicate `ydoc.guid` rejection.
- [x] Cover cold signed-out boot calls `goOffline` but not `clearLocalData`.
- [x] Cover cold signed-in boot applies keys and reconnects.
- [x] Cover same-user token change reconnects.
- [x] Cover same-user key change does not reconnect.
- [x] Cover signed-in to signed-out clears all workspaces.
- [x] Cover user switch clears all workspaces and does not apply user B to old objects.
- [x] Cover cleanup failure aggregation.
- [x] Cover snapshots emitted during cleanup use latest-snapshot semantics.
- [x] Cover browser document collection clears unopened child docs.
- [x] Cover collection disposal unregisters active child syncs.
- [x] Cover non-sync BrowserWorkspace such as Zhongwen.

### Phase 7: Docs And Skills

- [x] Update `docs/guides/consuming-epicenter-api.md`.
- [x] Update `docs/encryption.md`.
- [x] Update `.agents/skills/auth/SKILL.md`.
- [x] Update app READMEs that mention `whenReady`.
- [x] Grep for old names and stale fields.

## Non Goals

- Do not redesign file-backed workspace construction beyond naming the future direction.
- Do not introduce a shared `FileBackedWorkspace` type without a generic file-backed consumer.
- Do not force daemon route runtimes through a workspace type.
- Do not move encryption key package ownership.
- Do not make workspace core import `AuthClient`.
- Do not extract app toast or reload policy into `@epicenter/auth-workspace`.
- Do not add compatibility aliases for old auth binding names.
- Do not introduce durable pending-cleanup retry state.
- Do not make composite `idb` or composite `sync` attachments.

## Success Criteria

- [x] One auth binding controls one or many browser workspaces.
- [x] `BrowserWorkspace` exposes only the shared browser lifecycle contract and root local-load gate.
- [x] Concrete app workspaces can still expose raw root attachments and app-specific child collections by inference.
- [x] Fuji, Honeycrisp, and Opensidian clear local data for unopened child documents.
- [x] Tab Manager and Zhongwen satisfy the same auth binding without special adapters.
- [x] Auth never inspects root `idb`, root `sync`, child collections, or sync inventories.
- [x] Failed cleanup cannot make a later signed-in snapshot look like cold boot.
- [x] A different signed-in user is not applied to old live Y.Doc objects after cleanup.
- [x] No compatibility alias for `bindWorkspaceAuthLifecycle` exists.

## Review

**Completed**: 2026-05-01
**Branch**: `codex/explicit-daemon-host-config`

### Summary

The browser auth binding now works over a snapshot of one or more `BrowserWorkspace` bundles. The shared binding validates non-empty and unique workspace lists, serializes auth snapshot handling, clears all workspace local data through the graph contract, and reports clear failures by workspace guid.

Browser workspace construction now owns graph lifecycle in Fuji, Honeycrisp, Opensidian, Tab Manager, and Zhongwen. Fuji, Honeycrisp, and Opensidian use `createBrowserDocumentCollection(...)` so active child syncs, active child disposal, and unopened child IndexedDB clearing live with the child collection.

### Verification

- `bun test packages/auth-workspace/src/index.test.ts`: passed.
- `bun test packages/workspace/src/cache/browser-document-collection.test.ts`: passed.
- `bun run --cwd packages/auth-workspace typecheck`: passed.
- `bun run --cwd packages/workspace typecheck`: passed.
- `bun run --cwd apps/fuji typecheck`: failed on existing shared Svelte/UI diagnostics unrelated to this change. The new Fuji browser workspace error was fixed.
- `bun run --cwd apps/honeycrisp typecheck`: failed on existing shared Svelte/UI diagnostics unrelated to this change. The new Honeycrisp browser workspace error was fixed.
- `bun run --cwd apps/opensidian check`: failed on existing shared Svelte/UI diagnostics and unrelated app diagnostics. No remaining Opensidian browser workspace contract error was reported.
- `bun run --cwd apps/tab-manager typecheck`: failed on existing shared UI diagnostics and unrelated chat typing. No remaining Tab Manager browser workspace contract error was reported.
- `bun run --cwd apps/zhongwen typecheck`: failed on existing shared UI diagnostics and unrelated AI package typing. No remaining Zhongwen browser workspace contract error was reported.

### Deviations

- App typecheck commands could not be made green without fixing unrelated shared UI and app diagnostics outside this spec.
- Existing unrelated `whenReady` conventions remain for non-workspace browser state, storage state, and content documents that are not root browser workspace bundles.
