# Auth Workspace Lifecycle Inversion

**Date**: 2026-05-01
**Status**: Draft
**Author**: AI-assisted
**Branch**: `codex/explicit-daemon-host-config`

## One Sentence

`bindAuthWorkspaceScope` should sequence auth transitions for one concrete app lifecycle scope, while the app client file states how that scope pauses sync, applies auth session material, reconnects sync, and clears local browser data.

## Overview

This spec replaces the `BrowserWorkspace` contract with call-site supplied auth lifecycle hooks. App open functions like `openFuji()` return the concrete client shape product code consumes. Auth binding no longer requires those clients to implement shared lifecycle methods.

## Motivation

### Current State

The browser open functions currently build product clients and attach auth lifecycle methods to the same object:

```ts
const workspace = {
	...doc,
	idb,
	entryContentDocs,
	awareness,
	sync,
	remote,
	rpc,
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
		for (const child of childCollections) await child.clearLocalData();
		await idb.clearLocal();
	},
	[Symbol.dispose]() {
		for (const child of childCollections) child[Symbol.dispose]();
		doc[Symbol.dispose]();
	},
};

return workspace satisfies BrowserWorkspace;
```

The auth binding then receives the client object:

```ts
bindAuthWorkspaceScope({
	auth,
	workspaces: [fuji],
	afterClearLocalData: () => window.location.reload(),
	onClearLocalDataError: reportClearError,
	afterApplyAuthSession: () => {},
});
```

This creates problems:

1. **Client shape and auth lifecycle are collapsed**: `openFuji()` must return lifecycle verbs because auth needs them, not because product code naturally consumes them.
2. **`BrowserWorkspace` is a leaky shared contract**: it describes browser auth cleanup, but it sits on the client object as if it were part of the product API.
3. **The low-level verbs are not all independent**: `reconnect()` only makes sense after applying a signed-in auth session, and `clearLocalData()` should only run after sync has been paused.
4. **Inline `satisfies BrowserWorkspace` fights TypeScript**: the concrete client has app-specific fields like `idb`, `sync`, and `entryContentDocs`, while `BrowserWorkspace` only names the lifecycle subset.

### Desired State

App open functions return concrete app clients:

```ts
export const fuji = openFuji({ auth, peer });
```

The app client file passes auth lifecycle behavior explicitly:

```ts
bindAuthWorkspaceScope({
	auth,
	sync: {
		pause() {
			fuji.sync.pause();
			fuji.entryContentDocs.pause();
		},
		reconnect() {
			fuji.sync.reconnect();
			fuji.entryContentDocs.reconnect();
		},
	},
	applyAuthSession(session) {
		fuji.encryption.applyKeys(session.encryptionKeys);
	},
	async resetLocalClient() {
		try {
			await fuji.entryContentDocs.clearLocalData();
			await fuji.idb.clearLocal();
			window.location.reload();
		} catch (error) {
			reportClearError(error);
		}
	},
});
```

The binding owns sequencing. The call site owns concrete resource composition.

## Lifecycle Verb Audit

The old surface had three workspace methods plus implicit encryption application in the binding. They are not four equal operations.

### Old `goOffline()` -> `sync.pause()`

Mechanics:

```txt
Stop live sync supervisors so they do not fetch tokens, open sockets, or write remote updates.
```

When auth needs it:

```txt
1. Cold signed-out boot: stop authenticated sync resources.
2. Leaving a signed-in user: pause sync before local stores are cleared.
```

Composition requirement:

```txt
Compose root sync and every active child sync that exists today.
Unopened child docs have no live sync to pause.
```

Deeper clean break:

```txt
Rename sync lifecycle APIs from goOffline()/reconnect() to pause()/reconnect().
```

`goOffline()` and `reconnect()` are an uneven pair: one names a mode, the other names an action. `pause()` and `reconnect()` are both commands issued to the sync supervisor. `pause()` is also the word auth wants: stop sync work without implying the whole app is offline.

Lifecycle hook:

```ts
sync: {
	pause(): void;
	reconnect(): void;
} | null;
```

The capability name should say what auth is controlling: authenticated sync. The call site can pass a single `SyncAttachment` directly when no child syncs need to be composed.

### `applyAuthSession()`

Mechanics:

```txt
Apply signed-in session data that in-memory resources need before remote work resumes.
```

Current concrete work:

```txt
Root document encryption keys are applied from `session.encryptionKeys`.
```

Composition requirement:

```txt
Compose every in-memory resource that needs session material.
Today that is the root document encryption attachment.
Future encrypted child docs could be added here without changing auth binding.
```

Lifecycle hook:

```ts
applyAuthSession(session: SignedInSession): void;
```

### `reconnect()` / `sync.reconnect()`

Mechanics:

```txt
Restart live sync supervisors so they fetch the current token and reconnect.
```

When auth needs it:

```txt
Only after a signed-in session has been applied, and only when the auth token changed.
```

Composition requirement:

```txt
Compose root sync and every active child sync.
Unopened child docs reconnect when they are opened later.
```

Lifecycle hook:

```ts
sync: {
	pause(): void;
	reconnect(): void;
} | null;
```

The binding should decide whether to call `sync.reconnect()`. The call site should only know how to reconnect its concrete sync resources.

### `clearLocalData()` / `resetLocalClient()`

Mechanics:

```txt
Delete browser persistence stores for the root document and every known child document, then perform the terminal success policy.
```

When auth needs it:

```txt
Only when leaving a previously applied user, either to signed out or to another signed-in user.
```

Composition requirement:

```txt
Compose root local persistence and child local persistence.
This includes unopened child docs because their IndexedDB stores can exist without live objects.
```

Lifecycle hook:

```ts
resetLocalClient(): Promise<void>;
```

The binding should call `sync?.pause()` before `resetLocalClient()`. The app hook should clear the stores and then reload or rebuild the client. Do not name this hook `clearLocalData()` once reload moves inside it. That name would hide the terminal app policy inside a deletion verb.

## Proposed API

`@epicenter/auth-workspace` should stop importing `BrowserWorkspace` from `@epicenter/workspace`.

```ts
export type SignedInSession = Extract<
	AuthSnapshot,
	{ status: 'signedIn' }
>['session'];

export type AuthenticatedSyncLifecycle = {
	pause(): void;
	reconnect(): void;
};

export type AuthWorkspaceScopeOptions = {
	auth: AuthClient;
	sync: AuthenticatedSyncLifecycle | null;
	applyAuthSession(session: SignedInSession): void;
	resetLocalClient(): Promise<void>;
};
```

`bindAuthWorkspaceScope` keeps a serialized auth transition loop until local reset starts. At that point, the current client is terminal and `resetLocalClient()` owns both success and failure recovery.

## Design Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Auth binding input | Lifecycle hooks, not `BrowserWorkspace` objects | The app owns concrete resource composition. The binding owns auth sequencing. |
| Scope model | One app lifecycle scope per `bindAuthWorkspaceScope` call | Current app call sites bind one concrete client. `targets` and guid plumbing would preserve a multi-workspace abstraction the product does not use. |
| Sync lifecycle | Standardize on `pause()` and `reconnect()` | They target the same resource family and can be passed directly from `attachSync()` when no composition is needed. |
| No sync apps | Use `sync: null` | This avoids no-op hook functions while forcing each call site to make the no-sync decision explicit. |
| Signed-in session application | Keep `applyAuthSession(session)` | Encryption is only one consumer of a signed-in session. Tab Manager also registers a device, and future apps may apply other session material. |
| Encryption singleton passing | Do not make binding take `encryption` directly | That would make `@epicenter/auth-workspace` know the workspace encryption attachment again and would reintroduce a second callback for app-specific signed-in work. |
| Cleanup result | Terminal for the current client | Once local stores are being deleted, applying newer auth snapshots to the same in-memory client is not a clean recovery path. |
| Success callback | Collapse into `resetLocalClient()` | If cleanup is terminal, the success policy belongs at the end of the reset hook. A separate `onLocalDataCleared()` callback keeps a two-step model we do not need. |
| Apply callback | Fold `afterApplyAuthSession` into `applyAuthSession` | Four apps use a no-op. Tab Manager's device registration is signed-in app work and can live beside key application. |
| Reset error callback | Collapse into `resetLocalClient()` | Reset failure is app policy too. A separate error callback would make the binding own an app-level catch block without adding a real invariant. |
| Local data singleton passing | Do not make binding take `idb` or clearable stores directly | Reset success and failure both belong to app policy. Passing stores would force the binding to grow reload and error hooks again. |
| Disposal | Keep outside auth binding | Disposal is object lifetime, not an auth transition. |

## Naming Audit

| Name | Decision | Why it earns itself |
| --- | --- | --- |
| `sync.pause()` | Rename underlying sync API to match | Auth needs to stop live sync on cold signed-out boot and before local reset. `goOffline()` sounds like a whole app mode; `pause()` names the capability auth actually needs. |
| `applyAuthSession(session)` | Keep | The signed-in session has material the app must apply before remote work resumes. Today that is encryption keys; Tab Manager also registers the device here. |
| `sync.reconnect()` | Keep under `sync` | The binding owns the `tokenChanged` invariant. Collapsing this into `applyAuthSession(session, tokenChanged)` would make every app repeat the same conditional. |
| `resetLocalClient()` | Use instead of `clearLocalData()` plus `onLocalDataCleared()` | Reload belongs at the end of the terminal reset path. The name should admit that this clears stores and resets the running client. |

## Callback Audit

### `resetLocalClient`

Keep one terminal reset hook and move reload into it.

All current apps reload after local data is cleared. Since local clearing is terminal, the app should make that terminal policy explicit in the same hook:

```ts
async resetLocalClient() {
	try {
		await fuji.entryContentDocs.clearLocalData();
		await fuji.idb.clearLocal();
		window.location.reload();
	} catch (error) {
		toast.error('Could not clear local data', {
			description: extractErrorMessage(error),
		});
	}
}
```

The binding still owns ordering:

```txt
bindAuthWorkspaceScope()
  sync?.pause()
  call resetLocalClient()
  do not apply newer auth snapshots to this client
```

This replaces the old stale-snapshot guard with a stronger invariant: once local client reset starts, the current client is no longer a safe place to process future auth snapshots. A newer auth snapshot should be handled by the reload or rebuild that follows cleanup.

### `afterApplyAuthSession`

Remove this callback.

Four current app call sites pass a no-op. Tab Manager uses it to register the browser device after sign-in, and that can move into `applyAuthSession()`:

```ts
applyAuthSession(session) {
	tabManager.encryption.applyKeys(session.encryptionKeys);
	void registerDevice();
}
```

The binding still owns `tokenChanged` and reconnect sequencing. `applyAuthSession()` should do app-specific signed-in work that does not need a separate lifecycle moment.

`resetLocalClient()` should catch expected clear failures itself. That keeps the recovery policy beside the destructive work and avoids a second callback whose only job is to continue the same terminal operation.

`bindAuthWorkspaceScope` can still guard against an unexpected rejected promise so the drain loop does not produce an unhandled rejection, but that guard should not be part of the public API.

## Architecture

Current ownership:

```txt
openFuji()
  builds product client
  builds auth lifecycle methods
  returns BrowserWorkspace-compatible object

bindAuthWorkspaceScope()
  calls generic workspace lifecycle methods
  applies encryption keys directly
```

Proposed ownership:

```txt
openFuji()
  builds product client only

apps/fuji/client.ts
  composes Fuji resources into bindAuthWorkspaceScope hooks

bindAuthWorkspaceScope()
  sequences auth transitions
  calls app-provided hooks
```

New vision:

```txt
openFoo()
  returns the concrete product client
  does not know auth lifecycle policy

apps/foo/client.ts
  owns the inventory of root and child resources
  tells auth binding how to control sync, apply session material, and reset the client

bindAuthWorkspaceScope()
  owns auth transition order
  stops using the current client once local clearing starts
```

Transition flow:

```txt
COLD SIGNED OUT
  auth snapshot signedOut
  sync?.pause()

SIGNED IN
  auth snapshot signedIn
  tokenChanged = previous token differs from session.token
  applyAuthSession(session)
  if tokenChanged, sync?.reconnect()

LEAVING USER
  auth snapshot leaves applied user
  sync?.pause()
  resetLocalClient()
```

## App Call-Site Shapes

These call sites are intentionally explicit. They should read like the app's resource inventory, not like an attempt to satisfy a shared workspace interface.

## Sync Composition Candidates

The recommended first pass is direct pass-through for single sync supervisors and inline composition for root plus child syncs. That keeps the resource inventory visible while removing the top-level callback pair:

```ts
sync: {
	pause() {
		fuji.sync.pause();
		fuji.entryContentDocs.pause();
	},
	reconnect() {
		fuji.sync.reconnect();
		fuji.entryContentDocs.reconnect();
	},
}
```

If repetition becomes noisy after implementation, these are the composition candidates:

| Candidate | Shape | Verdict |
| --- | --- | --- |
| Pass-through sync | `sync: tabManager.sync` | Best when there is exactly one sync supervisor. This is why the deeper `pause()` rename is worth doing. |
| Inline composed `sync` object | `sync: { pause() {}, reconnect() {} }` | Best first pass for root plus child syncs. Explicit and no new abstraction. |
| App-local helper | `const sync = composeSyncLifecycle(fuji.sync, fuji.entryContentDocs)` | Good if Fuji, Honeycrisp, and Opensidian repeat exactly. Keep it local until repetition proves stable. |
| Shared helper | `composeSyncLifecycle(...)` from a package | Defer. It is only worth it if multiple apps converge on the same method names and error behavior. |
| App lifecycle singleton | `const fujiAuthLifecycle = createFujiAuthLifecycle(fuji)` | Avoid for now. It hides the call-site inventory and creates a single-use wrapper. |
| Return lifecycle from `openFuji()` | `const { client, authLifecycle } = openFuji(...)` | Reject. It re-collapses product client formation and auth lifecycle formation. |

The app-local helper would look like this if it earns itself:

```ts
function composeSyncLifecycle(...syncs: AuthenticatedSyncLifecycle[]) {
	return {
		pause() {
			for (const sync of syncs) sync.pause();
		},
		reconnect() {
			for (const sync of syncs) sync.reconnect();
		},
	};
}
```

After the deeper sync rename, simple call sites do not need a wrapper:

```ts
bindAuthWorkspaceScope({
	auth,
	sync: tabManager.sync,
	applyAuthSession(session) {
		tabManager.encryption.applyKeys(session.encryptionKeys);
		void registerDevice();
	},
	resetLocalClient,
});
```

Root plus child syncs still compose explicitly:

```ts
sync: composeSyncLifecycle(fuji.sync, fuji.entryContentDocs)
```

## Session And Reset Composition Candidates

`applyAuthSession` and `resetLocalClient` look like candidates for singleton passing, but they do not line up the same way as `sync`.

Signed-in session application candidates:

| Candidate | Shape | Verdict |
| --- | --- | --- |
| Inline method | `applyAuthSession(session) { encryption.applyKeys(...); }` | Best first pass. It keeps all signed-in app effects in one lifecycle moment. |
| Pass encryption directly | `encryption: fuji.encryption` | Reject. It makes the binding know `session.encryptionKeys` and brings back a separate hook for `registerDevice()`. |
| Make encryption session-aware | `authSession: fuji.encryption` | Reject. `EncryptionAttachment` should not know auth session shape. It should keep accepting keys. |
| Local helper | `applyAuthSession: composeAuthSession(...)` | Defer. Useful only if several apps add more signed-in work beyond encryption. |
| Capability object | `session: { apply(session) {} }` | Not worth it now. A single-method wrapper does not enable direct passing. |

Reset candidates:

| Candidate | Shape | Verdict |
| --- | --- | --- |
| Inline method | `resetLocalClient: async () => { clear; reload; catch; }` | Best first pass. It keeps destructive work and recovery policy together. |
| Pass `idb` directly | `localData: fuji.idb` | Reject. Root IDB is not the whole reset for child-doc apps, and reload/error policy still has to live somewhere. |
| Pass clearable stores | `localData: [fuji.entryContentDocs, fuji.idb]` | Reject for now. It recreates the cleared-success and clear-error callback problem. |

Do not introduce a reset helper in this pass. The reset path should stay inline at each app call site so the destructive stores, reload policy, and error policy are visible together.

### Fuji

```ts
bindAuthWorkspaceScope({
	auth,
	sync: {
		pause() {
			fuji.sync.pause();
			fuji.entryContentDocs.pause();
		},
		reconnect() {
			fuji.sync.reconnect();
			fuji.entryContentDocs.reconnect();
		},
	},
	applyAuthSession(session) {
		fuji.encryption.applyKeys(session.encryptionKeys);
	},
	async resetLocalClient() {
		try {
			await fuji.entryContentDocs.clearLocalData();
			await fuji.idb.clearLocal();
			window.location.reload();
		} catch (error) {
			toast.error('Could not clear local data', {
				description: extractErrorMessage(error),
			});
		}
	},
});
```

Honeycrisp is the same shape with `noteBodyDocs`.

### Opensidian

```ts
bindAuthWorkspaceScope({
	auth,
	sync: {
		pause() {
			opensidian.sync.pause();
			opensidian.fileContentDocs.pause();
		},
		reconnect() {
			opensidian.sync.reconnect();
			opensidian.fileContentDocs.reconnect();
		},
	},
	applyAuthSession(session) {
		opensidian.encryption.applyKeys(session.encryptionKeys);
	},
	async resetLocalClient() {
		try {
			await opensidian.fileContentDocs.clearLocalData();
			await opensidian.idb.clearLocal();
			window.location.reload();
		} catch (error) {
			toast.error('Could not clear local data', {
				description: extractErrorMessage(error),
			});
		}
	},
});
```

### Tab Manager

```ts
bindAuthWorkspaceScope({
	auth,
	sync: tabManager.sync,
	applyAuthSession(session) {
		tabManager.encryption.applyKeys(session.encryptionKeys);
		void registerDevice();
	},
	async resetLocalClient() {
		try {
			await tabManager.idb.clearLocal();
			window.location.reload();
		} catch (error) {
			toast.error('Could not clear local data', {
				description: extractErrorMessage(error),
			});
		}
	},
});
```

### Zhongwen

Zhongwen has no auth-backed sync resource today.

```ts
bindAuthWorkspaceScope({
	auth,
	sync: null,
	applyAuthSession(session) {
		zhongwen.encryption.applyKeys(session.encryptionKeys);
	},
	async resetLocalClient() {
		try {
			await zhongwen.idb.clearLocal();
			window.location.reload();
		} catch (error) {
			toast.error('Could not clear local data', {
				description: extractErrorMessage(error),
			});
		}
	},
});
```

If Zhongwen should not participate in auth lifecycle at all, remove its `bindAuthWorkspaceScope` call instead of passing no-op hooks. The current client binds auth, so this spec preserves that behavior.

## Open Function Shapes

Browser open functions should stop importing `BrowserWorkspace`.

```ts
export function openFuji(...) {
	const doc = openFujiDoc();
	const idb = attachIndexedDb(doc.ydoc);
	const entryContentDocs = createBrowserDocumentCollection(...);
	const sync = attachSync(...);

	return {
		...doc,
		idb,
		entryContentDocs,
		awareness,
		sync,
		remote,
		rpc,
		/**
		 * Resolves when IndexedDB has hydrated the root document.
		 *
		 * This does not imply remote sync convergence or child document hydration.
		 */
		whenLoaded: idb.whenLoaded,
		[Symbol.dispose]() {
			entryContentDocs[Symbol.dispose]();
			doc[Symbol.dispose]();
		},
	};
}
```

`whenLoaded` stays on the client because UI and chat state consume it. It is not an auth lifecycle hook.

## Deliberately Deferred

### `createBrowserDocumentCollection`

Do not split `createBrowserDocumentCollection` in this change.

It still exposes:

```ts
open(id)
has(id)
pause()
reconnect()
clearLocalData()
```

That is acceptable for now because the app call site needs those methods to compose child document behavior. The important clean break is that auth no longer treats the whole app client as a `BrowserWorkspace`.

### Disposal

Do not move disposal into `bindAuthWorkspaceScope`.

Disposal is not an auth transition. It belongs to the concrete client lifetime:

```ts
fuji[Symbol.dispose]();
```

Auth binding should return only its unsubscribe function.

## Implementation Plan

### Phase 1: Change Auth Binding Types

- [ ] Replace `workspaces: Iterable<BrowserWorkspace>` with `sync`, `applyAuthSession`, and `resetLocalClient`.
- [ ] Remove the `BrowserWorkspace` import from `@epicenter/auth-workspace`.
- [ ] Remove exported clear context types that only existed to describe multiple workspace objects.
- [ ] Remove duplicate guid validation because the binding no longer accepts a workspace list.

### Phase 1.5: Standardize Sync Lifecycle Naming

- [ ] Rename `SyncAttachment.goOffline()` to `SyncAttachment.pause()`.
- [ ] Rename `BrowserDocumentCollection.goOffline()` to `BrowserDocumentCollection.pause()`.
- [ ] Update `attachSync()` internals, JSDoc, tests, app sync call sites, daemon fakes, CLI fixtures, and UI references.
- [ ] Do not keep `goOffline()` as a compatibility alias unless a published API compatibility requirement blocks the clean break.

### Phase 2: Change Auth Binding Sequencing

- [ ] On cold signed-out boot, call `sync?.pause()`.
- [ ] Before resetting the local client, call `sync?.pause()`.
- [ ] During signed-in processing, call `applyAuthSession(session)`.
- [ ] When `tokenChanged` is true, call `sync?.reconnect()` after `applyAuthSession(session)`.
- [ ] Stop calling `workspace.encryption.applyKeys(...)` in the binding.
- [ ] Stop reaching into `workspace.reconnect()` in the binding.
- [ ] Remove the stale-snapshot guard.
- [ ] Treat local reset as terminal for the current client. `resetLocalClient()` owns success and failure recovery. The binding should ignore queued snapshots after reset starts.

### Phase 3: Update App Client Call Sites

- [ ] Update Fuji to pass inline lifecycle hooks.
- [ ] Update Honeycrisp to pass inline lifecycle hooks.
- [ ] Update Opensidian to pass inline lifecycle hooks.
- [ ] Update Tab Manager to pass inline lifecycle hooks and call `registerDevice()` from `applyAuthSession`.
- [ ] Update Zhongwen to pass inline lifecycle hooks or remove auth binding if it should not participate.

### Phase 4: Simplify Browser Open Functions

- [ ] Remove `BrowserWorkspace` imports from browser open files.
- [ ] Remove `pause`, `reconnect`, and `clearLocalData` from returned app clients.
- [ ] Keep app-specific fields like `idb`, `sync`, `entryContentDocs`, `remote`, and `rpc`.
- [ ] Keep `[Symbol.dispose]` on the concrete client.
- [ ] Add concise JSDoc to `whenLoaded`.

### Phase 5: Remove Shared Workspace Lifecycle Types

- [ ] Remove `BrowserWorkspace` if no external consumers remain.
- [ ] Remove `Workspace` only if no package still needs the public type.
- [ ] Remove exports from `packages/workspace/src/index.ts`.
- [ ] Update tests that used `satisfies BrowserWorkspace`.

### Phase 6: Verify

- [ ] Run `bun test packages/auth-workspace`.
- [ ] Run focused app type checks for Fuji, Honeycrisp, Opensidian, Tab Manager, and Zhongwen.
- [ ] Run `bun typecheck` and report unrelated failures separately.

## Edge Cases

### Signed Out On Cold Boot

1. Auth snapshot is `signedOut`.
2. No session has been applied.
3. Binding calls `sync?.pause()` and stops live authenticated sync if the app provided sync.
4. No local data is cleared because there is no known previous user.

### Same User Token Rotation

1. Auth snapshot is `signedIn`.
2. `appliedSession.userId` matches the new session user id.
3. `tokenChanged` is true.
4. Binding calls `applyAuthSession(session)`.
5. Binding calls `sync?.reconnect()`.

### Same User Key Refresh Without Token Change

1. Auth snapshot is `signedIn`.
2. User id matches and token is unchanged.
3. Binding calls `applyAuthSession(session)`.
4. Binding does not call `sync?.reconnect()`.

### Switching Users

1. Auth snapshot is `signedIn` for a different user.
2. Binding calls `sync?.pause()`.
3. Binding calls `resetLocalClient()`.
4. The app reset hook clears local stores and reloads after success.
5. Fresh startup applies the new user session.

If an app wants user switching without reload, that is a separate design. It would need a client rebuild path after clearing local in-memory state.

### Reset Failure

1. `resetLocalClient()` throws.
2. The expected path is that the app catches clear failures inside `resetLocalClient()` and shows recovery UI.
3. If an unexpected rejection escapes, the binding swallows it after marking the client terminal.
4. Binding leaves sync paused and does not process more snapshots on this client.

### Snapshot During Cleanup

Current code has a stale-snapshot guard:

```ts
if (isDisposed || pendingSnapshot !== null) return;
```

That guard tries to avoid running callbacks for an older cleanup result when auth emits a newer snapshot while local data clearing is still awaiting. In practice, it keeps the current client alive after its local stores were already cleared, then asks the drain loop to interpret the newest snapshot against that same in-memory client.

The new invariant is stricter:

```txt
resetLocalClient() starts
  current client is terminal
  later auth snapshots are not applied to this client
  success reloads or rebuilds inside resetLocalClient()
  failure is handled inside resetLocalClient()
```

This avoids the weird case where a user switch can clear the same old user's data twice. It also avoids applying a newer signed-in snapshot after persistence was deleted but before the app rebuilt the client.

Implementation shape:

```ts
let isTerminal = false;

async function leaveUser() {
	sync?.pause();
	isTerminal = true;

	try {
		await resetLocalClient();
	} catch (error) {
		// resetLocalClient owns expected failure handling.
		return;
	}
}

function schedule(snapshot: AuthSnapshot) {
	if (isTerminal) return;
	pendingSnapshot = snapshot;
	void drain();
}
```

## Reflection

This design removes the main conflict: product clients no longer need to implement auth lifecycle methods just to be accepted by the auth binding.

The stale-snapshot guard is not worth keeping in the inverted model. Its old job was to keep the auth binding acting like a live latest-snapshot queue during async cleanup. That sounds resilient, but the object it keeps alive is the wrong unit: the local stores are already being deleted, while the in-memory Y.Doc and app client still contain the old runtime. A cleaner system does not try to recover that client in place.

The resilient path is to make reset terminal. The binding pauses sync through `sync?.pause()` and calls the app's reset hook. The app clears local stores and then reloads or rebuilds. A future app that wants no-reload switching can still do it, but it should provide an explicit rebuild path inside `resetLocalClient()`, not rely on queued auth snapshots flowing through a half-cleared client.

The remaining repetition at app call sites is intentional for this pass. Fuji, Honeycrisp, Opensidian, Tab Manager, and Zhongwen do not have identical resource graphs. Writing each lifecycle hook inline makes those differences visible:

```txt
Fuji        root sync + entry content child syncs
Honeycrisp  root sync + note body child syncs
Opensidian  root sync + file content child persistence
Tab Manager root sync only
Zhongwen    no sync today
```

There is still one tension: `sync.pause()` and `resetLocalClient()` both talk about leaving a session. The split is worth keeping because cold signed-out boot needs the first but not the second. The binding must own their order.

There is another small tension around `applyAuthSession()` and `sync.reconnect()`: reconnect is not meaningful until session material has been applied, but they should stay separate lifecycle operations because the binding already owns the `tokenChanged` decision. Grouping reconnect under `sync` removes top-level callback noise without moving the token-change branch into every app.

This is good to implement before splitting `createBrowserDocumentCollection`. Once the call sites are explicit, any useful extraction will be obvious from repeated code rather than guessed up front.
