# Browser Document Family Identity And Sync Topology

**Date**: 2026-05-02
**Status**: Draft
**Author**: AI-assisted
**Branch**: `codex/explicit-daemon-host-config`

## One Sentence

A browser document family should own one live per-row `Y.Doc` per guid inside an app runtime, while `attachSync` owns same-origin and remote sync topology for docs that sync.

## Overview

This spec separates three concerns that are currently drifting together: app-local live identity, browser persistence cleanup, and sync topology. `createDisposableCache` remains the primitive for sharing one live object per id. A higher-level browser document family owns live child document identity and active child sync fanout. Child document modules own their storage address helpers and local data cleanup. `attachSync` later absorbs same-origin fanout for synced docs so browser callers stop wiring BroadcastChannel by hand.

## Motivation

### Current State

Per-row content docs are opened through `createChildDocumentRegistry`:

```ts
const fileContentDocs = createChildDocumentRegistry(
	(fileId: FileId) =>
		createFileContentDoc({
			fileId,
			workspaceId: doc.ydoc.guid,
			filesTable: doc.tables.files,
			attachPersistence: (d) => attachIndexedDb(d),
		}),
	{ gcTime: 5_000 },
);
```

The registry is currently a small wrapper around `createDisposableCache` plus active sync fanout:

```ts
return {
	open(id) {
		return cache.open(id);
	},
	has(id) {
		return cache.has(id);
	},
	syncControl: {
		pause() {
			for (const control of activeSyncControls) control.pause();
		},
		reconnect() {
			for (const control of activeSyncControls) control.reconnect();
		},
	},
};
```

But auth reset now reconstructs child document persistence addresses in app client files:

```ts
async function clearFileContentLocalData() {
	await Promise.all(
		opensidian.tables.files.getAllValid().map((file) =>
			clearDocument(
				docGuid({
					workspaceId: opensidian.ydoc.guid,
					collection: 'files',
					rowId: file.id,
					field: 'content',
				}),
			),
		),
	);
}
```

This creates problems:

1. **The registry lost a real responsibility**: It still owns opened child docs, but no longer owns cleanup for persisted child docs that are not open.
2. **App auth files know storage internals**: `client.ts` should not rebuild `docGuid({ collection, rowId, field })` for a child doc family.
3. **The cache is being mistaken for a performance hack**: It is actually the same-runtime live identity rule for editor, filesystem, indexer, and actions.
4. **Sync topology is split across callers**: Browser root docs call `attachBroadcastChannel(ydoc)` beside `attachSync(ydoc, ...)`, while synced content docs call `attachSync` without local fanout.

### Concrete Tension

The motivating example is Opensidian:

```txt
ContentEditor has file A open
fs.writeFile("/A.md") opens file A
sqliteIndex reads file A
```

If those all open separate `Y.Doc` instances with the same guid, `y-indexeddb` will not keep them live-synced. The updates will eventually merge after another fetch, reload, or provider fanout, but same-tick reads can observe stale state. Sharing one object inside the SPA avoids that class of bug.

### Desired State

Per-row docs should read like this:

```ts
const fileContentDocs = createBrowserDocumentFamily({
	create(fileId) {
		const document = createFileContentDoc({
			fileId,
			workspaceId: doc.ydoc.guid,
			filesTable: doc.tables.files,
			attachPersistence: (ydoc) => attachIndexedDb(ydoc),
		});

		return { document, syncControl: null };
	},
	async clearLocalData() {
		await Promise.all(
			doc.tables.files.getAllValid().map((file) =>
				clearDocument(
					fileContentDocGuid({
						workspaceId: doc.ydoc.guid,
						fileId: file.id,
					}),
				),
			),
		);
	},
	gcTime: 5_000,
});
```

Consumers keep using the simple opening API:

```ts
await using handle = fileContentDocs.open(fileId);
await handle.whenReady;
```

Reset can clear the whole app-local storage graph without leaking child storage addresses:

```ts
await opensidian.clearLocalData();
```

Auth lifecycle should receive one app-scope sync capability, not an array of
resources:

```ts
bindAuthWorkspaceScope({
	auth,
	syncControl: opensidian.syncControl,
	applyAuthSession(session) {
		opensidian.encryption.applyKeys(session.encryptionKeys);
	},
	async resetLocalClient() {
		try {
			await opensidian.clearLocalData();
			window.location.reload();
		} catch (error) {
			toast.error('Could not clear local data', {
				description: extractErrorMessage(error),
			});
		}
	},
});
```

## Research Findings

### `y-indexeddb` Is Persistence, Not Live Coordination

`IndexeddbPersistence` opens an IndexedDB database named by the document id. On construction it fetches stored updates and applies them to the supplied `Y.Doc`. After that it listens to `doc.on('update')` and appends updates to IndexedDB.

It does not subscribe to IndexedDB writes from other live `Y.Doc` instances. Two live docs with the same IndexedDB name can diverge in memory until a manual fetch, reload, or provider applies missing updates.

Reproduction against `y-indexeddb@9.0.12` and `yjs@13.6.30`:

```txt
doc1 writes: doc1 ["from doc1"], doc2 []
doc2 writes: doc1 ["from doc1"], doc2 ["from doc2"]
manual fetchUpdates: both ["from doc2", "from doc1"]
destroy and reopen: reopened doc has both
```

Yjs updates are safe to merge. The problem is not data loss. The problem is live observation inside one running app.

References:

- https://docs.yjs.dev/ecosystem/database-provider/y-indexeddb
- https://docs.yjs.dev/api/document-updates
- https://github.com/yjs/y-indexeddb/blob/master/src/y-indexeddb.js
- https://github.com/yjs/y-indexeddb/blob/master/tests/y-indexeddb.tests.js

### Long-Lived SPA Singleton Is Valid For Root Docs

The root workspace doc is already a module-scope singleton in browser clients:

```ts
export const opensidian = openOpensidian({ auth, peer });
```

That is enough for the root doc because the app has one root workspace in the current JS runtime. A second root workspace object in the same runtime would be a construction bug, not normal use.

Per-row docs are different. There can be thousands of possible row docs, but only a few are active. Keeping every row doc alive for the whole SPA would make navigation simple but would load too much state and attach too many persistence or sync resources. Opening on demand still matters.

### `createDisposableCache` Earns Itself For Per-Row Docs

`createDisposableCache` is not only avoiding load cost. It provides this invariant:

```txt
For one app runtime and one row id, all active consumers share one live object.
```

That invariant matters when multiple consumers can touch the same row doc:

```txt
editor
filesystem operation
SQLite index rebuild
AI tool call
second pane
route transition grace window
```

Without shared identity, each consumer either needs same-origin fanout or accepts stale reads. A cache is the simplest same-runtime owner.

### BroadcastChannel Is A Provider, Not A Replacement For Identity

BroadcastChannel can keep duplicate same-guid docs coherent, but it is async message passing. That is a good fit across browser tabs or windows. It is weaker than object identity inside one app runtime.

Same-runtime object identity:

```txt
write -> same Y.Doc -> next read sees it
```

BroadcastChannel fanout:

```txt
write -> postMessage -> event loop -> other Y.Doc applies update
```

Both are useful. They belong at different layers.

## Design Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Same-runtime per-row identity | Keep explicit one-live-doc-per-id ownership | It gives immediate coherence between editor, actions, filesystem, and indexers. |
| Primitive cache | Keep `createDisposableCache` | It owns refcounting and grace-period teardown without knowing Yjs, IndexedDB, or auth. |
| Current registry | Replace or rename `createChildDocumentRegistry` | The current name and shape only describe open children plus sync fanout. Callers need a browser document family that also owns persistence cleanup. |
| Browser cleanup | Put `clearLocalData()` on the family, backed by a caller-supplied operation | The family exposes one cleanup capability. Child doc modules own guid helpers, while app factories own row enumeration and the inline cleanup loop. |
| Sync fanout | Keep `syncControl` on families with synced children | Auth needs to pause and reconnect active child syncs. Unopened child docs have no live sync to control. |
| App sync lifecycle | Expose one composed `syncControl` from browser app clients | Auth controls one app lifecycle scope. It should not compose root and child resource inventories. |
| Auth binding input | Change from `syncControls: SyncControl[]` to `syncControl: SyncControl | null` | The binding needs one capability: pause or reconnect this scope. No-sync apps should make that explicit with `null`. |
| App local data lifecycle | Expose `clearLocalData()` from browser app clients | The app factory owns the root plus child persistence graph. `client.ts` still owns reload and toast policy. |
| Child document addresses | Keep a guid helper in each child doc module | Live construction and local cleanup must share one source of truth for the child document storage id without adding pass-through cleanup helpers. |
| Same-origin sync topology | Move into `attachSync` later | Callers should say "sync this doc" once. They should not wire BroadcastChannel and future leader election beside sync. |
| Global `Y.Doc` singleton registry | Reject for now | Hidden guid reuse makes attachment ownership unclear and makes construction order matter in surprising ways. |
| Raw open and immediate destroy | Allow only for isolated tasks | It is fine when no concurrent live consumer needs immediate state. It is not safe as the default for app content docs. |

## Architecture

### Layer Ownership

```txt
+------------------------------+
| App client singleton          |
| openOpensidian()              |
|                              |
| root ydoc                     |
| root idb                      |
| root sync                     |
| fileContentDocs               |
| syncControl                   |
| clearLocalData()              |
+--------------+---------------+
               |
               v
+------------------------------+
| Browser document family       |
|                              |
| create(id)                    |
| cache.open(id)                |
| clearLocalData()              |
| syncControl                   |
+--------------+---------------+
               |
               v
+------------------------------+
| createDisposableCache         |
|                              |
| one live object per id        |
| refcount handles              |
| gcTime delayed teardown       |
+--------------+---------------+
               |
               v
+------------------------------+
| Per-row document builder      |
|                              |
| *ContentDocGuid()             |
| new Y.Doc({ guid })           |
| attachIndexedDb or attachSync |
| attachRichText or timeline    |
| onLocalUpdate row writeback   |
+------------------------------+
```

### Runtime Boundaries

```txt
same JS runtime
  share one live Y.Doc per guid through a document family

same origin, different tab or window
  fan out updates through BroadcastChannel inside attachSync

different device or server
  sync over the WebSocket provider

browser storage
  load and save updates through IndexedDB
```

### Recommended API Shape

Document family:

```ts
export type BrowserDocumentFamily<
	Id extends string | number,
	TDocument extends Disposable,
> = Disposable & {
	open(id: Id): TDocument & Disposable;
	has(id: Id): boolean;
	syncControl: SyncControl;
	clearLocalData(): Promise<void>;
};
```

Document family options:

```ts
export type BrowserDocumentFamilyMember<TDocument extends Disposable> = {
	document: TDocument;
	syncControl: SyncControl | null;
};

export type BrowserDocumentFamilyOptions<
	Id extends string | number,
	TDocument extends Disposable,
> = {
	create(id: Id): BrowserDocumentFamilyMember<TDocument>;
	clearLocalData(): Promise<void>;
	gcTime?: number;
};
```

Implementation sketch:

```ts
export function createBrowserDocumentFamily<
	Id extends string | number,
	TDocument extends Disposable,
>(
	options: BrowserDocumentFamilyOptions<Id, TDocument>,
): BrowserDocumentFamily<Id, TDocument> {
	const activeSyncControls = new Set<SyncControl>();
	const cache = createDisposableCache((id) => {
		const { document, syncControl } = options.create(id);
		if (syncControl) activeSyncControls.add(syncControl);

		return {
			...document,
			[Symbol.dispose]() {
				if (syncControl) activeSyncControls.delete(syncControl);
				document[Symbol.dispose]();
			},
		};
	}, { gcTime: options.gcTime });

	return {
		open: (id) => cache.open(id),
		has: (id) => cache.has(id),
		syncControl: {
			pause() {
				for (const control of activeSyncControls) control.pause();
			},
			reconnect() {
				for (const control of activeSyncControls) control.reconnect();
			},
		},
		async clearLocalData() {
			for (const control of activeSyncControls) control.pause();
			await options.clearLocalData();
		},
		[Symbol.dispose]() {
			cache[Symbol.dispose]();
		},
	};
}
```

Auth binding:

```ts
export type AuthWorkspaceScopeOptions = {
	auth: AuthClient;
	syncControl: SyncControl | null;
	applyAuthSession(session: SignedInSession): void;
	resetLocalClient(): Promise<void>;
};
```

App client:

```ts
return {
	...doc,
	idb,
	fileContentDocs,
	sync,
	syncControl: composeSyncControls(sync, fileContentDocs.syncControl),
	async clearLocalData() {
		await fileContentDocs.clearLocalData();
		await idb.clearLocal();
	},
	[Symbol.dispose]() {
		fileContentDocs[Symbol.dispose]();
		doc[Symbol.dispose]();
	},
};
```

## API Comparison

| Approach | What It Buys | What It Costs | Verdict |
| --- | --- | --- | --- |
| Raw open every time | Smallest code at call sites | Duplicate live docs, stale reads, duplicate syncs | Only for isolated tasks. |
| Keep all row docs alive for SPA lifetime | Simple references after first open | Loads too much state and holds too many resources | Not acceptable for large workspaces. |
| `createDisposableCache` only | Strong same-runtime identity | No family-level cleanup or sync aggregation | Good primitive, not full product surface. |
| Current `createChildDocumentRegistry` | Same-runtime identity plus active sync fanout | Lost local cleanup, weak name | Too narrow for browser row docs. |
| `createBrowserDocumentFamily` with `ids()` and `guid(id)` | Identity, cleanup, active sync fanout | Splits cleanup into callback plumbing and duplicates child document address ownership | Rejected. |
| `createBrowserDocumentFamily` with `create(id)` member and supplied cleanup | Identity, active sync fanout, explicit cleanup ownership | Caller writes a cleanup function per family | Recommended. |
| Hidden global guid singleton | Fewer explicit caches | Attachment ownership becomes unclear | Reject. |
| Duplicate docs plus BroadcastChannel | Allows independent docs to converge | Async fanout and extra topology | Useful across browser contexts, not primary same-runtime strategy. |

## Implementation Plan

### Phase 1: Restore The Browser Document Family Boundary

- [ ] **1.1** Rename or replace `packages/workspace/src/cache/child-document-registry.ts` with `browser-document-family.ts`.
- [ ] **1.2** Add `create`, `clearLocalData`, and `gcTime` options. `create(id)` returns `{ document, syncControl }`.
- [ ] **1.3** Keep `open(id)` and `has(id)` behavior backed by `createDisposableCache`.
- [ ] **1.4** Expose `syncControl` as a property, not top-level `pause()` and `reconnect()`.
- [ ] **1.5** Add `clearLocalData()` that pauses active child sync controls, then runs the caller-supplied cleanup operation.
- [ ] **1.6** Move generic `composeSyncControls` to a sync-focused module, not the cache module.

### Phase 2: Migrate Current Apps Back To Family-Owned Cleanup

- [ ] **2.1** Update Fuji `entryContentDocs` to use `createBrowserDocumentFamily`.
- [ ] **2.2** Update Honeycrisp `noteBodyDocs` to use `createBrowserDocumentFamily`.
- [ ] **2.3** Update Opensidian `fileContentDocs` to use `createBrowserDocumentFamily`.
- [ ] **2.4** Move `entryContentDocGuid`, `noteBodyDocGuid`, and `fileContentDocGuid` into child doc modules, then inline each family cleanup loop in the app factory.
- [ ] **2.5** Remove direct `clearDocument` and `docGuid` imports from app client files where they only exist for reset cleanup.
- [ ] **2.6** Keep auth reset explicit through the app-level cleanup method:

```ts
await opensidian.clearLocalData();
window.location.reload();
```

### Phase 3: Expose App-Scope Lifecycle Capabilities

- [ ] **3.1** Add a small `composeSyncControls(...controls)` helper if no existing helper fits.
- [ ] **3.2** Update browser open functions to return `syncControl` composed from root sync plus child families.
- [ ] **3.3** Update browser open functions to return `clearLocalData()` composed from child families plus root persistence.
- [ ] **3.4** Update auth call sites to pass a singular app-scope control:

```ts
bindAuthWorkspaceScope({
	auth,
	syncControl: opensidian.syncControl,
	applyAuthSession(session) {
		opensidian.encryption.applyKeys(session.encryptionKeys);
	},
	resetLocalClient,
});
```

- [ ] **3.5** Update reset hooks to clear through the app client:

```ts
await opensidian.clearLocalData();
window.location.reload();
```

- [ ] **3.6** Keep reload and toast policy in `client.ts`, not in workspace construction.
- [ ] **3.7** Change `bindAuthWorkspaceScope` to accept `syncControl: SyncControl | null` instead of `syncControls: readonly SyncControl[]`.
- [ ] **3.8** Update no-sync apps to pass `syncControl: null`.

### Phase 4: Move Same-Origin Fanout Into `attachSync`

- [ ] **4.1** Implement the same-origin fanout work from `packages/workspace/specs/20260430T104326-attach-sync-supervisor-evolution.md`.
- [ ] **4.2** Ensure synced docs no longer need explicit `attachBroadcastChannel(ydoc)` beside `attachSync`.
- [ ] **4.3** Decide whether content docs with `attachSync` get the same default fanout.
- [ ] **4.4** Remove explicit root `attachBroadcastChannel` calls where `attachSync` owns browser fanout.

### Phase 5: Re-Audit Whether Any Caches Can Collapse

- [ ] **5.1** After `attachSync` owns same-origin fanout, test duplicate same-guid synced content docs.
- [ ] **5.2** Keep document families for local-only docs unless a local-only fanout provider exists.
- [ ] **5.3** Delete a family only when its callers are proven isolated or covered by a provider that gives the required freshness.

## Edge Cases

### Editor And Filesystem Open The Same File

1. `ContentEditor` opens file A through `fileContentDocs.open(fileId)`.
2. `fs.writeFile` opens the same file id.
3. Both handles share one underlying `Y.Doc`.
4. The editor sees the write immediately because the write hit the same object.

### SQLite Index Reads A Mounted File

1. The indexer opens file A to read content.
2. The editor already has file A mounted.
3. The indexer gets a new handle but the same underlying document.
4. Disposing the indexer handle does not destroy the document while the editor handle is still open.

### Rapid Route Switching

1. The user opens file A.
2. The user switches to file B.
3. The user quickly returns to file A.
4. `gcTime` keeps file A alive briefly so the app does not tear down and rehydrate the doc during normal navigation jitter.

### Signed Out Reset

1. Auth binding calls the app-scope `syncControl.pause()`.
2. Reset calls `clearLocalData()`.
3. `clearLocalData()` clears child family local data, then clears root local data.
4. App reloads or rebuilds the client.

### Duplicate Docs Outside The Family

1. A caller manually creates `new Y.Doc({ guid: fileGuid })`.
2. It attaches IndexedDB with the same name.
3. It does not attach a live provider.
4. The doc may load persisted state, but it will not stay live-coherent with the family-owned doc.
5. Treat this as an unsupported escape hatch unless the caller explicitly wires fanout.

## Open Questions

1. **Should the name be `createBrowserDocumentFamily`, `createRowDocumentFamily`, or `createBrowserDocumentCollection`?**
   - Options: (a) `createBrowserDocumentFamily`, (b) `createRowDocumentFamily`, (c) restore `createBrowserDocumentCollection`.
   - **Recommendation**: Use `createBrowserDocumentFamily`. "Family" names a set of related row docs without implying every member is currently open.

2. **Should document families know about guid cleanup?**
   - Options: (a) family accepts `ids()` and `guid(id)`, (b) family accepts a supplied cleanup operation, (c) every app reset call site clears child docs manually.
   - **Recommendation**: Use a supplied cleanup operation. Child doc modules own storage address helpers, browser document families own live identity and active sync fanout, and app factories own graph composition.

3. **Should duplicate same-guid docs be detected in development?**
   - Options: (a) add dev-only warnings, (b) enforce through a global registry, (c) do nothing.
   - **Recommendation**: Consider dev-only warnings for accidental duplicate construction outside a family. Do not enforce runtime singleton reuse globally.

4. **Can local-only docs use BroadcastChannel instead of shared identity?**
   - Options: (a) add an explicit `attachLocalFanout(ydoc)`, (b) keep cache identity, (c) fold it into persistence.
   - **Recommendation**: Keep cache identity. Add local fanout only if a real multi-runtime local-only consumer appears.

## Success Criteria

- [ ] App client files no longer reconstruct per-row child doc guids for local data clearing.
- [ ] Per-row document docs have one obvious construction surface for ids, guids, live opening, active sync fanout, and local cleanup.
- [ ] `createDisposableCache` remains generic and free of browser, Yjs, auth, and persistence policy.
- [ ] Browser app clients expose one composed `syncControl` and one `clearLocalData()` capability.
- [ ] `bindAuthWorkspaceScope` accepts `syncControl: SyncControl | null`, not an array of sync controls.
- [ ] Opensidian editor, filesystem, and SQLite index still share active file content docs inside one app runtime.
- [ ] Fuji and Honeycrisp active child sync controls still pause and reconnect during auth transitions.
- [ ] Tests cover unopened child document cleanup, active sync fanout, disposal unregistering, and cache sharing.

## References

- `packages/workspace/src/cache/child-document-registry.ts`: current thin wrapper around `createDisposableCache`.
- `packages/workspace/src/cache/disposable-cache.ts`: primitive one-live-object-per-id cache.
- `apps/opensidian/src/lib/opensidian/browser.ts`: browser client that wires `fileContentDocs`, filesystem, SQLite index, and root sync.
- `apps/opensidian/src/lib/opensidian/client.ts`: current reset call site with leaked child guid cleanup.
- `apps/fuji/src/lib/fuji/browser.ts`: synced per-entry content family.
- `apps/honeycrisp/src/lib/honeycrisp/browser.ts`: synced per-note body family.
- `packages/filesystem/src/file-system.ts`: filesystem reads and writes content docs transiently.
- `packages/filesystem/src/extensions/sqlite-index/index.ts`: indexer reads file content through `contentDocs.open(id)`.
- `packages/workspace/specs/20260430T104326-attach-sync-supervisor-evolution.md`: planned `attachSync` ownership of same-origin fanout and leader election.
- https://docs.yjs.dev/ecosystem/database-provider/y-indexeddb
- https://docs.yjs.dev/api/document-updates
