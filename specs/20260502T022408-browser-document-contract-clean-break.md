# Browser Document Contract Clean Break

**Date**: 2026-05-02
**Status**: Draft
**Author**: AI-assisted
**Branch**: `codex/explicit-daemon-host-config`

## One Sentence

A browser document owns the lifecycle of one live `Y.Doc`, while a browser document set owns row id enumeration, unopened local-data cleanup, and construction of those live documents.

## Overview

The current browser document family restored the right high-level boundary: apps expose one `syncControl` and one `clearLocalData()` method, while keyed child docs keep one live `Y.Doc` per row id. The remaining friction is inside each family setup. The app still passes a separate `syncControl` beside each created document, and it still supplies a family-level cleanup callback that repeats row enumeration plus guid clearing.

This spec proposes a stricter contract:

1. Every live browser document exposes its own `sync` field, typed `SyncControl | null` (rich docs narrow it to `SyncAttachment`).
2. Every keyed browser document set exposes `ids()`, `create(id)`, and `clearLocalData(id)`.
3. `createBrowserDocumentFamily()` consumes that set directly and stops accepting separate `create(...): { document, syncControl }` and `clearLocalData()` options.

The result is less callback plumbing at app call sites without losing the important behavior: reset must clear unopened child document stores without opening those documents.

### Naming convention for sync surfaces

To keep the doubling-prone `sync` vs `syncControl` distinction honest, this spec adopts one rule:

```
.sync         "I have a sync attachment (or null)."
              type:  SyncControl | null  (often narrows to SyncAttachment)
              used on: live documents, root workspaces

.syncControl  "I'm a fanout/composed control surface, not backed by a single attachment."
              type:  SyncControl  (always non-null, always narrow)
              used on: families, composed workspace surfaces
```

The two field names are not interchangeable. `.sync` exists because a real `attachSync` ran; `.syncControl` exists because a fanout was composed. A reader looking at a field name knows which world they are in.

## Relationship To The Current Spec

This spec follows `specs/20260502T011321-browser-document-family-identity-and-sync-topology.md`.

That earlier spec answers why browser document families exist at all:

```txt
same JS runtime
  one live object per row id

same browser origin
  provider fanout across tabs or windows

remote devices
  sync over WebSocket
```

This spec narrows the next clean break:

```txt
live document lifecycle
  belongs on the document returned by createEntryContentDoc()

keyed child graph lifecycle
  belongs on a document set consumed by createBrowserDocumentFamily()

app graph lifecycle
  belongs on openFuji(), openHoneycrisp(), openOpensidian(), and similar browser factories
```

It should supersede only the API shape section of the earlier spec. The identity and topology reasoning still stands.

## Motivation

### Current State

The current family setup in Fuji and Honeycrisp looks like this:

```ts
const entryContentDocs = createBrowserDocumentFamily({
	create(entryId: EntryId) {
		const document = createEntryContentDoc({
			entryId,
			workspaceId: doc.ydoc.guid,
			entriesTable: doc.tables.entries,
			auth,
			apiUrl: APP_URLS.API,
		});

		return { document, syncControl: document.sync };
	},
	async clearLocalData() {
		await Promise.all(
			doc.tables.entries.getAllValid().map((entry) =>
				clearDocument(
					entryContentDocGuid({
						workspaceId: doc.ydoc.guid,
						entryId: entry.id,
					}),
				),
			),
		);
	},
	gcTime: 5_000,
});
```

The app-level reset is good:

```ts
async clearLocalData() {
	await entryContentDocs.clearLocalData();
	await idb.clearLocal();
}
```

The family setup still has three smells:

1. **Sync is passed beside the document even though the document already owns it.** `createEntryContentDoc()` returns `sync`, then the caller restates `syncControl: document.sync`. The same value is referenced through two channels.
2. **The live document doubles up on `.sync` and `.syncControl`.** Some doc shapes expose both: `sync: SyncAttachment` for rich access plus `syncControl: SyncControl` for the contract. They are aliases of the same value with different types. Two field names, one source.
3. **Cleanup is supplied as a family callback even though row docs already have all the pieces.** The app factory enumerates rows, imports `clearDocument`, and calls a guid helper. That is correct behavior, but it spreads the browser document contract across the app and the child module.

### The Hidden Constraint

Reset must clear rows that are not open:

```txt
entries table
  entry A open in editor
  entry B not open, but has IndexedDB data
  entry C not open, but has IndexedDB data

resetLocalClient()
  must clear A, B, and C
```

Opening B and C only to clear them is the wrong move. It constructs `Y.Doc` objects, attaches IndexedDB, may attach sync, and then tears everything down. The family needs a by-id cleanup path that can clear unopened storage without constructing the document.

That is why `clearLocalData` does not belong on the live document. A live-doc method only knows how to clear its own already-attached persistence. The set's `clearLocalData(id)` clears unopened storage by deterministic guid without ever building the document. Active documents need one extra step first: the family pauses active sync, disposes cached live documents, waits for their persistence connections to close, then runs the same by-id cleanup over the full id set.

### Desired State

The family setup should collapse to a document set:

```ts
const entryContentDocs = createBrowserDocumentFamily(
	createEntryContentDocuments({
		workspaceId: doc.ydoc.guid,
		entriesTable: doc.tables.entries,
		auth,
		apiUrl: APP_URLS.API,
	}),
	{ gcTime: 5_000 },
);
```

The document set owns the keyed child graph:

```ts
export function createEntryContentDocuments({
	workspaceId,
	entriesTable,
	auth,
	apiUrl,
}: {
	workspaceId: string;
	entriesTable: Table<Entry>;
	auth: Pick<AuthClient, 'snapshot' | 'whenLoaded'>;
	apiUrl: string;
}): BrowserDocumentSet<EntryId, EntryContentDoc> {
	return {
		ids() {
			return entriesTable.getAllValid().map((entry) => entry.id);
		},
		create(entryId) {
			return createEntryContentDoc({
				entryId,
				workspaceId,
				entriesTable,
				auth,
				apiUrl,
			});
		},
		clearLocalData(entryId) {
			return clearDocument(entryContentDocGuid({ workspaceId, entryId }));
		},
	};
}
```

The live document owns its single-document lifecycle:

```ts
export function createEntryContentDoc(...): EntryContentDoc {
	const ydoc = new Y.Doc({ guid: entryContentDocGuid(...), gc: false });
	const body = attachRichText(ydoc);
	const idb = attachIndexedDb(ydoc);
	const sync = attachSync(ydoc, { ... });

	return {
		ydoc,
		body,
		idb,
		sync,
		whenLoaded: idb.whenLoaded,
		whenDisposed: Promise.all([idb.whenDisposed, sync.whenDisposed]),
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
}
```

Note: only one `sync` field. `EntryContentDoc.sync: SyncAttachment` is a subtype of `BrowserDocument.sync: SyncControl | null`, so the rich type satisfies the contract without an aliased `syncControl` field. Local-only docs (e.g. file content docs) return `sync: null`.

## Vocabulary

`BrowserDocument` is one live browser-backed `Y.Doc` bundle. It may be a root workspace document or a keyed child document. It must expose enough lifecycle for the family to pause sync and await teardown: a single `sync` field typed `SyncControl | null`, plus a `whenDisposed` promise. Storage cleanup is not on the live doc; it lives on the set, by id.

`BrowserDocumentSet` is a keyed collection of possible browser documents. It can create a live document for one id, list all ids that should be cleared on reset, and clear local data for one id without opening that document.

`BrowserDocumentFamily` is the runtime cache around a `BrowserDocumentSet`. It owns one live object per id, refcounted handles, active child sync fanout, and family-wide cleanup.

`BrowserWorkspace` is the top-level app graph returned from `openFuji()`, `openHoneycrisp()`, `openOpensidian()`, and similar browser factories. It composes root persistence plus child families into one app-scoped `syncControl` and one app-scoped `clearLocalData()`.

### Vocabulary Decision: Set, Family, Not Asset

The split should stay:

```txt
BrowserDocument
  one live Y.Doc bundle

BrowserDocumentSet
  enumerable keyed document contract

BrowserDocumentFamily
  runtime cache and fanout around a set
```

`BrowserDocumentAsset` is not the right name for this contract. An asset sounds
like a persisted blob, media object, file, or server-side storage address. This
surface is not just stored content. It has three verbs: list ids, create one
live document, and clear one document's local browser storage without opening
it. "Asset" hides two of those verbs and makes the boundary sound more passive
than it is.

`BrowserDocumentFamily` should also not replace `BrowserDocumentSet`. A family
is the live runtime object with a cache, active handles, and sync fanout. The set
is the construction-time dependency the family consumes. Keeping both names
makes the ownership line visible:

```txt
set
  possible keyed docs plus by-id storage cleanup

family
  currently open docs plus active sync control
```

If the name still feels too mathematical, `BrowserDocumentSource` is the best
alternative. It reads well at the call site, but it is less exact: `Source`
suggests creation and underplays reset enumeration. `Set` is stricter because
reset needs the complete set of valid child ids, not just a factory.

### What `ids()` Means

`ids()` is not an IndexedDB index and not a local database discovery mechanism.
It is the app's authoritative row enumeration from the root workspace table:

```ts
ids() {
	return entriesTable.getAllValid().map((entry) => entry.id);
}
```

Those ids let the family derive every child document's deterministic Yjs
storage name and clear that storage without constructing the child document:

```txt
entry id
  -> entryContentDocGuid({ workspaceId, entryId })
  -> y-indexeddb database name
  -> clearDocument(name)
```

This is why `ids()` belongs on the set. The set already owns the row table and
the guid helper used by `create(id)`. If the app factory supplies ids and the
child module supplies guids, the cleanup address rule is split across two
owners.

This does not mean "clear every IndexedDB database for this origin." It means
"clear the y-indexeddb databases for valid child documents in this workspace,
then let the app factory clear root persistence separately." Browser site data,
auth storage, and tombstoned child rows are outside this contract.

### How Clearing Works

There are two y-indexeddb clearing paths:

```txt
attached provider
  idb.clearData()
  destroys that provider, then deletes its named IndexedDB database

unopened document
  clearDocument(name)
  deletes the named IndexedDB database directly
```

`attachIndexedDb(ydoc).clearLocal()` wraps the attached-provider path. That is
the right tool when a caller already has the live document and its persistence
attachment.

`BrowserDocumentSet.clearLocalData(id)` uses the unopened-document path. It
recomputes the same deterministic name that `new IndexeddbPersistence(name,
ydoc)` would use and calls `clearDocument(name)` directly. That is the only
path that can wipe child documents which are not currently open.

For active child documents, the family must not call `clearDocument(name)` while
the active `IndexeddbPersistence` still has that database open. The clean reset
sequence is:

```txt
pause active sync controls
dispose cached live documents
await live document whenDisposed promises
call documents.clearLocalData(id) for every id
```

The pause prevents remote sync from writing new updates during reset. The
dispose and wait step closes active IndexedDB connections before the direct
database delete runs. The app-level reset still clears child families before
root persistence because the root tables are what enumerate child ids.

## Ownership Rules

| Thing | Owner | Why |
| --- | --- | --- |
| One live document's `Y.Doc` | `create*Doc()` | Construction, attachments, and disposal live together. |
| One live document's `sync` field | The returned document | If the document attaches sync, the value flows through `.sync` directly. Otherwise `sync: null`. No aliasing. |
| Child document guid mapping | Child document module | Construction and cleanup must share one storage address rule. |
| Row id enumeration for a child doc set | `create*Documents()` | It already receives the table needed for construction and `updatedAt` writeback. |
| Unopened child cleanup by id | `BrowserDocumentSet.clearLocalData(id)` | Clears storage by deterministic guid without constructing a document. |
| Active child cleanup before by-id delete | `BrowserDocumentFamily` | Pauses active sync, disposes cached docs, and awaits `document.whenDisposed` so IndexedDB connections are closed before `clearDocument(name)`. |
| Active child sync fanout | `BrowserDocumentFamily` | It knows which child docs are currently live. |
| App-wide reset order | Browser app factory | It owns root persistence plus child families. |
| Reload and toast policy | Browser `client.ts` | That is UI policy, not document lifecycle. |

## Proposed API

### `BrowserDocument`

The minimum shared lifecycle shape should live in `@epicenter/workspace`.

```ts
import type * as Y from 'yjs';
import type { SyncControl } from './attach-sync.js';

export type BrowserDocument = Disposable & {
	ydoc: Y.Doc;
	sync: SyncControl | null;
	whenDisposed: Promise<unknown>;
};
```

This type intentionally does not require fields named `idb`, `persistence`, `body`, `content`, `whenLoaded`, or `whenReady`. Those are domain-specific fields. The family only needs identity (`ydoc`), the sync handle for fanout (`sync`), synchronous disposal (`Symbol.dispose`), and an async teardown barrier (`whenDisposed`).

It also intentionally does not require a `clearLocalData()` method on the live document. The family's reset path disposes active live documents, waits for `whenDisposed`, then goes through the set's `clearLocalData(id)` for every id. Direct one-off consumers can call `doc.idb.clearLocal()` or `doc.persistence?.clearLocal()` themselves.

Documents can still expose richer fields:

```ts
export type EntryContentDoc = BrowserDocument & {
	body: ReturnType<typeof attachRichText>;
	idb: ReturnType<typeof attachIndexedDb>;
	sync: SyncAttachment;          // narrows BrowserDocument's sync; same field, richer type
	whenLoaded: Promise<unknown>;
	whenDisposed: Promise<unknown>;
};

export type FileContentDoc = BrowserDocument & {
	content: ReturnType<typeof attachTimeline>;
	persistence: BrowserDocPersistence | undefined;
	sync: null;                     // narrows the contract; files don't sync remotely
	whenReady: Promise<unknown>;
	whenDisposed: Promise<unknown>;
};
```

The same `.sync` field appears once on the live document. Subtypes narrow its type without renaming or aliasing.

### `BrowserDocPersistence`

The existing `DocPersistence` type describes load and teardown readiness. Browser cleanup needs one more method.

```ts
export type BrowserDocPersistence = DocPersistence & {
	clearLocal(): Promise<void>;
};
```

Do not replace `DocPersistence` globally. `attachSqlite()` currently does not expose `clearLocal()`, and the filesystem content doc builder is used outside the browser. Browser-only wrappers should opt into `BrowserDocPersistence`.

`clearLocal()` is what root workspaces use directly (`idb.clearLocal()` in `app.clearLocalData()`) and what one-off direct consumers reach for if they really need to clear a single live doc's persistence. The family's reset path does not call this; it clears by deterministic guid through the set.

### `BrowserDocumentSet`

The set is the important missing concept.

```ts
export type BrowserDocumentSet<
	Id extends string | number,
	TDocument extends BrowserDocument,
> = {
	ids(): Iterable<Id>;
	create(id: Id): TDocument;
	clearLocalData(id: Id): Promise<void>;
};
```

This is the clean split:

```txt
create(id)
  opens one live document

clearLocalData(id)
  clears one document's browser storage without opening it

ids()
  lists every row id that reset should clear
```

### `createBrowserDocumentFamily`

The family should consume a set and options:

```ts
export type BrowserDocumentFamilyOptions = {
	gcTime?: number;
};

export function createBrowserDocumentFamily<
	Id extends string | number,
	TDocument extends BrowserDocument,
>(
	documents: BrowserDocumentSet<Id, TDocument>,
	options?: BrowserDocumentFamilyOptions,
): BrowserDocumentFamily<Id, TDocument>;
```

The returned family stays close to the current shape:

```ts
export type BrowserDocumentFamily<
	Id extends string | number,
	TDocument extends BrowserDocument,
> = Disposable & {
	open(id: Id): TDocument & Disposable;
	has(id: Id): boolean;
	syncControl: SyncControl;
	clearLocalData(): Promise<void>;
};
```

Implementation sketch:

```ts
export function createBrowserDocumentFamily<
	Id extends string | number,
	TDocument extends BrowserDocument,
>(
	documents: BrowserDocumentSet<Id, TDocument>,
	{ gcTime }: BrowserDocumentFamilyOptions = {},
): BrowserDocumentFamily<Id, TDocument> {
	const activeSyncControls = new Set<SyncControl>();
	const activeDocuments = new Set<TDocument>();
	const cache = createDisposableCache((id) => {
		const document = documents.create(id);
		const { sync } = document;
		activeDocuments.add(document);

		if (sync !== null) {
			activeSyncControls.add(sync);
		}

		return {
			...document,
			[Symbol.dispose]() {
				if (sync !== null) {
					activeSyncControls.delete(sync);
				}
				activeDocuments.delete(document);
				document[Symbol.dispose]();
			},
		};
	}, { gcTime });

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
		async clearLocalData() {
			for (const control of activeSyncControls) control.pause();
			const whenActiveDocumentsDisposed = Array.from(
				activeDocuments,
				(document) => document.whenDisposed,
			);
			cache[Symbol.dispose]();
			await Promise.all(whenActiveDocumentsDisposed);
			await Promise.all(
				Array.from(documents.ids(), (id) => documents.clearLocalData(id)),
			);
		},
		[Symbol.dispose]() {
			cache[Symbol.dispose]();
		},
	};
}
```

The family reads `document.sync` (one field, possibly null) to decide whether to register fanout. It still exposes `family.syncControl: SyncControl` because that field is a fanout, not an attached primitive: the naming convention from the overview holds.

## Before And After

### Fuji

Before:

```ts
const entryContentDocs = createBrowserDocumentFamily({
	create(entryId: EntryId) {
		const document = createEntryContentDoc({
			entryId,
			workspaceId: doc.ydoc.guid,
			entriesTable: doc.tables.entries,
			auth,
			apiUrl: APP_URLS.API,
		});

		return { document, syncControl: document.sync };
	},
	async clearLocalData() {
		await Promise.all(
			doc.tables.entries.getAllValid().map((entry) =>
				clearDocument(entryContentDocGuid({
					workspaceId: doc.ydoc.guid,
					entryId: entry.id,
				})),
			),
		);
	},
	gcTime: 5_000,
});
```

After:

```ts
const entryContentDocs = createBrowserDocumentFamily(
	createEntryContentDocuments({
		workspaceId: doc.ydoc.guid,
		entriesTable: doc.tables.entries,
		auth,
		apiUrl: APP_URLS.API,
	}),
	{ gcTime: 5_000 },
);
```

The app factory no longer imports `clearDocument` or `entryContentDocGuid`.

### Honeycrisp

Before:

```ts
const noteBodyDocs = createBrowserDocumentFamily({
	create(noteId: NoteId) {
		const document = createNoteBodyDoc({
			noteId,
			workspaceId: doc.ydoc.guid,
			notesTable: doc.tables.notes,
			auth,
			apiUrl: APP_URLS.API,
		});

		return { document, syncControl: document.sync };
	},
	async clearLocalData() {
		await Promise.all(
			doc.tables.notes.getAllValid().map((note) =>
				clearDocument(noteBodyDocGuid({
					workspaceId: doc.ydoc.guid,
					noteId: note.id,
				})),
			),
		);
	},
	gcTime: 5_000,
});
```

After:

```ts
const noteBodyDocs = createBrowserDocumentFamily(
	createNoteBodyDocuments({
		workspaceId: doc.ydoc.guid,
		notesTable: doc.tables.notes,
		auth,
		apiUrl: APP_URLS.API,
	}),
	{ gcTime: 5_000 },
);
```

### Opensidian

Opensidian is the important cross-package case. `createFileContentDoc()` lives in `packages/filesystem`, and that package is not browser-only.

The browser app should not force the generic file content builder to import `y-indexeddb`. The filesystem package exposes a browser document set factory with injected browser persistence:

```ts
export function createFileContentDocuments({
	workspaceId,
	filesTable,
	attachPersistence,
	clearLocalDataForGuid,
}: {
	workspaceId: string;
	filesTable: Table<FileRow>;
	attachPersistence(ydoc: Y.Doc): BrowserDocPersistence;
	clearLocalDataForGuid(guid: string): Promise<void>;
}): BrowserDocumentSet<FileId, FileContentDoc> {
	return {
		ids() {
			return filesTable.getAllValid().map((file) => file.id);
		},
		create(fileId) {
			const doc = createFileContentDoc({
				fileId,
				workspaceId,
				filesTable,
				attachPersistence,
			});
			return {
				...doc,
				sync: null,                          // satisfies BrowserDocument; files don't sync
				whenDisposed: doc.persistence?.whenDisposed ?? Promise.resolve(),
			};
		},
		clearLocalData(fileId) {
			return clearLocalDataForGuid(
				fileContentDocGuid({ workspaceId, fileId }),
			);
		},
	};
}
```

The set wraps the generic builder and adds the browser-shaped fields the family needs. `createFileContentDoc` itself stays browser-agnostic (no `sync` field). Then the app call site becomes:

```ts
const fileContentDocs = createBrowserDocumentFamily(
	createFileContentDocuments({
		workspaceId: doc.ydoc.guid,
		filesTable: doc.tables.files,
		attachPersistence: (ydoc) => attachIndexedDb(ydoc),
		clearLocalDataForGuid: clearDocument,
	}),
	{ gcTime: 5_000 },
);
```

This keeps browser-only storage deletion injected at the edge, while the reusable filesystem package still owns the file content document address.

### Root Browser Workspaces

Root browser workspaces follow the naming convention from the overview: `.sync` is the workspace's own attached sync; `.syncControl` is a fanout (only present when there are child families).

Workspace with no child families:

```ts
return {
	...doc,
	idb,
	sync,                                    // SyncAttachment, callers can pause it directly
	async clearLocalData() {
		await idb.clearLocal();
	},
	whenLoaded: idb.whenLoaded,
};
```

No `.syncControl` field: there is nothing to fan out across. Callers wanting pause/reconnect just call `workspace.sync.pause()`.

Workspace with child families needs both fields, because they answer different questions: `.sync.status` is about the workspace's own connection; `.syncControl.pause()` is about everything:

```ts
return {
	...doc,
	idb,
	entryContentDocs,
	sync,                                                                       // own attachSync result
	syncControl: composeSyncControls(sync, entryContentDocs.syncControl),       // fanout across self + family
	async clearLocalData() {
		await entryContentDocs.clearLocalData();
		await idb.clearLocal();
	},
	whenLoaded: idb.whenLoaded,
};
```

The two fields are different values. `workspace.sync.pause()` only pauses the workspace's own sync; `workspace.syncControl.pause()` pauses workspace + all open child docs. Callers that want global pause must use `.syncControl`. (Whether to collapse the workspace-level pair into one field is a separate clean break, scoped out of this spec.)

That composition should stay at the browser app factory. `client.ts` should still own reload and toast policy:

```ts
async resetLocalClient() {
	try {
		await fuji.clearLocalData();
		window.location.reload();
	} catch (error) {
		toast.error('Could not clear local data', {
			description: extractErrorMessage(error),
		});
	}
}
```

## Architecture

```txt
Browser app factory
  openFuji()
  |
  | owns app graph composition
  | returns syncControl and clearLocalData
  v
Browser document family
  createBrowserDocumentFamily(documents, options)
  |
  | owns cache, active child sync fanout, family cleanup
  v
Browser document set
  createEntryContentDocuments(...)
  |
  | owns ids(), create(id), clearLocalData(id)
  v
Live browser document
  createEntryContentDoc(...)
  |
  | owns ydoc, idb, sync, rich text, disposal
  v
Attachments
  attachIndexedDb()
  attachSync()
  attachRichText()
```

Reset flow:

```txt
auth snapshot becomes signedOut
  |
  v
bindAuthWorkspaceScope
  |
  | syncControl.pause()
  v
app.clearLocalData()
  |
  | childFamily.clearLocalData()
  |   |
  |   | pause active child sync controls
  |   | dispose cached live child documents
  |   | await active child whenDisposed promises
  |   | documents.ids()
  |   | documents.clearLocalData(id) for each id
  |
  | root idb.clearLocal()
  v
client reload policy
```

Open flow:

```txt
editor opens entry A
  |
  v
entryContentDocs.open(entryA)
  |
  | cache miss
  v
documents.create(entryA)
  |
  v
createEntryContentDoc(entryA)
  |
  | returns sync
  v
family registers active sync control
```

## Design Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Live document sync field | One field named `sync`, typed `SyncControl \| null` | Eliminates the `.sync` vs `.syncControl` doubling. Subtypes (e.g. `EntryContentDoc.sync: SyncAttachment`) narrow the type without renaming. |
| Live document cleanup method | Not on the contract | The family's reset path disposes active documents, awaits `whenDisposed`, then uses set's `clearLocalData(id)` for every id. A live-doc cleanup method would still not cover unopened docs. |
| Unopened cleanup | By-id cleanup on the document set | Reset must not open every child document. |
| ID enumeration | `BrowserDocumentSet.ids()` from root table rows | Reset must clear valid child documents by deterministic guid. This is not IndexedDB discovery. |
| Family input shape | Accept a `BrowserDocumentSet` and options | Removes callback bags from app factories and names the keyed graph. |
| "Asset" vocabulary | Do not use it for this surface | The contract is active and keyed: ids, create, and clear. "Asset" sounds like passive stored content. |
| Field-name asymmetry `.sync` vs `.syncControl` | Keep both names; they signal different sources | `.sync` is an attached primitive (or null); `.syncControl` is a composed fanout. The names tell the reader which world they are in. |
| Async disposal barrier | Require `BrowserDocument.whenDisposed` | Direct IndexedDB deletion can be blocked by open connections. The family needs an awaitable signal after disposing active docs. |
| Readiness naming | Do not force `whenLoaded` in `BrowserDocument` yet | Existing docs use `whenLoaded` and `whenReady`; family does not need either. Normalize later if it proves useful. |
| Cross-runtime docs | Keep generic builders generic | `packages/filesystem` should not import browser-only persistence just to satisfy a browser contract. The set wrapper injects browser shape. |
| Browser persistence type | Add `BrowserDocPersistence` instead of changing `DocPersistence` | SQLite-backed and browser-backed persistence do not have the same cleanup surface today. |
| App cleanup order | Child families first, root persistence second | Root tables enumerate child ids, so root IndexedDB must remain available until child cleanup is done. |
| Sync pause before cleanup | Family pauses active child sync before clearing storage | Active sync should not repopulate IndexedDB while reset is deleting it. |
| Root workspace lifecycle | Keep app-level `clearLocalData()` explicit | It is the readable place to see the graph reset order. |
| Workspace-level `.sync` vs `.syncControl` | Out of scope: keep both for now | Different values (own sync vs composed fanout). Whether to collapse is a separate clean break with caller migration cost. |

## Non-Goals

Do not introduce a hidden global `Y.Doc` registry. The document family is explicit construction-time ownership, not an ambient singleton.

Do not make reset open every row document. If the cleanup path constructs `Y.Doc` objects, it has lost the main reason for a document set.

Do not move reload, navigation, or toast behavior into document factories. Those are app policy.

Do not force node or daemon persistence into `BrowserDocument`. A browser document is a browser runtime contract.

Do not solve same-origin BroadcastChannel or leader election here. That belongs to the `attachSync` topology work.

## Implementation Plan

### Phase 1: Add The Browser Document Contract

- [ ] **1.1** Add `BrowserDocument`, `BrowserDocumentSet`, and `BrowserDocumentFamilyOptions` to `packages/workspace/src/cache/browser-document-family.ts` or a nearby browser document contract file.
- [ ] **1.2** Change `BrowserDocumentFamilyOptions` so the family accepts a `BrowserDocumentSet` plus `{ gcTime }`, not `create(...): { document, syncControl }` plus `clearLocalData()`.
- [ ] **1.3** Update family implementation to read `document.sync` from the created document (one field, possibly null).
- [ ] **1.4** Update `clearLocalData()` to pause active child sync controls, dispose cached live documents, await their `whenDisposed` promises, then call `documents.clearLocalData(id)` for every id from `documents.ids()`.
- [ ] **1.5** Update `browser-document-family.test.ts` to cover `documents.ids()`, by-id cleanup, active sync pause, null sync controls, and unopened document cleanup.
- [ ] **1.6** Export the new types from `packages/workspace/src/index.ts`.

### Phase 2: Migrate App-Local Rich Text Docs

- [ ] **2.1** Update `EntryContentDoc` to extend `BrowserDocument` (narrows `sync: SyncAttachment`).
- [ ] **2.2** `createEntryContentDoc()` already returns `sync`; no aliased `syncControl` field added, no `clearLocalData()` method on the live doc.
- [ ] **2.3** Add `createEntryContentDocuments(...)` returning `BrowserDocumentSet<EntryId, EntryContentDoc>`.
- [ ] **2.4** Update Fuji browser setup to call `createBrowserDocumentFamily(createEntryContentDocuments(...), { gcTime })`.
- [ ] **2.5** Repeat the same migration for Honeycrisp note body docs.
- [ ] **2.6** Remove direct `clearDocument`, `entryContentDocGuid`, and `noteBodyDocGuid` imports from Fuji and Honeycrisp browser factories if they are no longer needed there.

### Phase 3: Migrate Filesystem Content Docs Without Browser Leakage

- [ ] **3.1** Add `BrowserDocPersistence` to `packages/workspace`.
- [ ] **3.2** Keep `createFileContentDoc` browser-agnostic; its returned shape does not include `sync`.
- [ ] **3.3** Add `createFileContentDocuments(...)` to `packages/filesystem` with injected `attachPersistence: (ydoc) => BrowserDocPersistence` and `clearLocalDataForGuid`. The set wraps the live doc and injects `sync: null` to satisfy `BrowserDocument`.
- [ ] **3.4** Update Opensidian browser setup to use `createBrowserDocumentFamily(createFileContentDocuments(...), { gcTime })`.
- [ ] **3.5** Keep daemon, script, and e2e file content usages on `createDisposableCache` unless they need browser document lifecycle.

### Phase 4: Re-Audit Root Browser Workspaces

- [ ] **4.1** Check Fuji, Honeycrisp, Opensidian, Tab Manager, and Zhongwen all expose app-scoped `syncControl` and `clearLocalData()`.
- [ ] **4.2** Ensure each app-level `clearLocalData()` clears child families before root IndexedDB.
- [ ] **4.3** Ensure `client.ts` files call only `app.clearLocalData()` and do not reach into child families or root `idb`.
- [ ] **4.4** Update README or architecture docs only after the code shape lands.

### Phase 5: Clean Up Names And Old Surfaces

- [ ] **5.1** Delete `BrowserDocumentFamilyMember`.
- [ ] **5.2** Delete any remaining `create(...): { document, syncControl }` examples.
- [ ] **5.3** Delete pass-through cleanup helpers that only wrap `clearDocument(guid(id))` if the document set now owns them.
- [ ] **5.4** Verify no live document still exposes both `.sync` and `.syncControl` as aliases. The only legitimate `.syncControl` field on a returned bundle is on a family or a composed workspace.
- [ ] **5.5** Run `rg "createBrowserDocumentFamily\\(|BrowserDocumentFamilyMember|syncControl: document"` and resolve every leftover.

## Test Plan

Run focused unit tests:

```bash
bun test packages/workspace/src/cache/browser-document-family.test.ts
bun test packages/workspace/src/document/sync-control.test.ts
bun test packages/auth-workspace/src/index.test.ts
```

Add or update family tests:

```txt
open same id
  builds once and returns shared nested state

pause
  calls only currently active child sync controls

reconnect
  calls only currently active child sync controls

clearLocalData
  pauses active child sync controls first
  disposes active cached documents
  awaits active document whenDisposed promises
  calls documents.ids()
  calls documents.clearLocalData(id) for opened and unopened ids
  does not call documents.create(id)

dispose
  unregisters active sync controls
  disposes cached documents
```

Add app-level compile checks where practical:

```bash
bun run typecheck
```

If full app typecheck still fails on existing shared Svelte issues, record those failures separately and verify the changed packages with focused tests.

## Edge Cases

### Active Child Sync And Persistence During Reset

The family must pause active child sync controls and close active persistence
connections before clearing local data:

```txt
entry A sync active
reset starts
family pauses entry A sync
family disposes active entry A
family awaits entry A whenDisposed
family clears entry A IndexedDB by id
family clears unopened entry B IndexedDB
root IndexedDB clears
client reloads
```

If sync remains active during deletion, a remote update can repopulate the store
during the reset window. If the active IndexedDB connection remains open,
`clearDocument(name)` can be blocked by that open connection. `whenDisposed` is
the barrier that keeps the by-id delete path honest for active documents.

### Unopened Rows

The document set must clear unopened rows by id:

```txt
documents.ids() returns [A, B, C]
cache currently has A only
clearLocalData()
  disposes A and awaits A.whenDisposed
  clears A by id
  clears B by id
  clears C by id
```

The test should assert `documents.create(B)` and `documents.create(C)` are not called.

### Deleted Rows

`ids()` should use `getAllValid()`, matching current behavior. Deleted or invalid rows should not be cleared through the root table scan. If tombstoned child docs need cleanup later, that is a separate retention policy and should not be smuggled into this refactor.

### File Content Docs In Node

`createFileContentDoc()` is shared by browser and non-browser consumers. Do not force node callers to provide `clearLocal()`.

Acceptable split:

```txt
createFileContentDoc()
  generic document builder

createFileContentDocuments()
  browser document set wrapper with injected browser persistence cleanup
```

### Direct One-Off Document Use

If a test or isolated script creates one browser document directly, persistence cleanup goes through the attachment handle the document already exposes:

```ts
const document = createEntryContentDoc(...);
await document.idb.clearLocal();
document[Symbol.dispose]();
```

For file content docs:

```ts
const document = createFileContentDoc({ ..., attachPersistence: attachIndexedDb });
await document.persistence?.clearLocal();
document[Symbol.dispose]();
```

There is no `document.clearLocalData()` method. The live doc does not need a wrapper around `idb.clearLocal()` since the field is already there. The family reset path uses the live doc only for teardown, via `[Symbol.dispose]()` plus `whenDisposed`, then uses the set's by-id cleanup for storage deletion.

## Open Questions

1. **Should the type be named `BrowserDocumentSet`, `BrowserDocumentSource`, or `BrowserDocumentFactory`?**
   - Recommendation: `BrowserDocumentSet`. It names the whole keyed graph: ids, creation, and cleanup. `Factory` overemphasizes construction and underemphasizes reset. `Asset` should not be used here because this is not just stored content.

2. **Should `BrowserDocument` require `whenLoaded`?**
   - Recommendation: not in this pass. Family lifecycle does not need readiness, and current docs differ between `whenLoaded` and `whenReady`.

3. **Should `BrowserDocumentSet` own `ids()` or should the app still pass row enumeration?**
   - Recommendation: the set owns it. The set already receives the table needed to create docs and update `updatedAt`, so row enumeration belongs there too.

4. **Should the live document have a `clearLocalData()` method at all?**
   - Resolved: no. The family's reset disposes active live documents, awaits `whenDisposed`, then uses the set's `clearLocalData(id)` for every id. Direct consumers can call `doc.idb.clearLocal()` or `doc.persistence?.clearLocal()` on the attachment field they already have.

5. **Should the live document expose both `.sync` and `.syncControl`?**
   - Resolved: no. One field, named `.sync`, typed `SyncControl | null` on the contract. Rich subtypes (e.g. `EntryContentDoc.sync: SyncAttachment`) narrow the type without renaming. The `.syncControl` name is reserved for fanout/composed surfaces (families, composed workspaces).

6. **Should package-level file docs expose a browser-only set factory?**
   - Recommendation: yes, but keep browser persistence injected. This keeps `packages/filesystem` reusable while removing storage address code from Opensidian's app factory.

7. **Should the root workspace also be typed as `BrowserDocument`?**
   - Recommendation: maybe later. Root workspaces already expose app-specific fields and graph lifecycle, and the workspace-level `.sync` vs `.syncControl` pair is a separate clean break. Do not force alignment until child docs are clean.

## Expected Outcome

After this spec lands, the repeated family setup should shrink:

```txt
Before
  app factory imports child guid helper
  app factory imports clearDocument
  app factory maps table rows during family cleanup
  app factory unwraps document.sync into syncControl

After
  app factory imports create*Documents()
  create*Documents() owns ids(), create(id), clearLocalData(id)
  live document exposes one .sync field (SyncControl | null)
  no .clearLocalData() method on the live doc
  family composes the keyed set
```

The app-level lifecycle remains explicit and readable:

```ts
syncControl: composeSyncControls(sync, entryContentDocs.syncControl),
async clearLocalData() {
	await entryContentDocs.clearLocalData();
	await idb.clearLocal();
}
```

That is the right amount of composition. The app owns the graph. The family owns the keyed children. The live document owns one `Y.Doc`.
