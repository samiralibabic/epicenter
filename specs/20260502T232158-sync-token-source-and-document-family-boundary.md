# Sync Token Source And Document Family Boundary

**Date**: 2026-05-02
**Status**: Implemented
**Author**: AI-assisted
**Branch**: codex/explicit-daemon-host-config

## One-Sentence Test

Sync attachments own credential freshness; browser document families only own live child document identity.

Every surface in this spec is judged against that sentence. If a surface does not help a sync attachment keep its own socket fresh, or help a document family cache live children by id, it does not belong in this change.

## Overview

Move credential-change reconnect behavior into `attachSync`, and remove sync knowledge from `createBrowserDocumentFamily`. A child document family should cache and dispose child documents; it should not require `ydoc`, `sync`, `sync: null`, or a composed `syncControl`.

This is a clean boundary change, not a security hardening project. Existing WebSockets remain authenticated at upgrade. Server-side live revocation is intentionally out of scope unless it becomes a product requirement.

## Motivation

### Current State

`createBrowserDocumentFamily` currently requires each child document to expose both a `ydoc` and a `sync` field:

```ts
export type BrowserDocumentInstance = Disposable & {
	ydoc: Y.Doc;
	sync: SyncControl | null;
};
```

The family tracks active child sync controls and exposes a composed control:

```ts
const activeSyncControls = new Set<SyncControl>();

const cache = createDisposableCache((id) => {
	const document = source.create(id);
	const { sync } = document;

	if (sync !== null) {
		activeSyncControls.add(sync);
	}

	return {
		...document,
		[Symbol.dispose]() {
			if (sync !== null) {
				activeSyncControls.delete(sync);
			}
			document[Symbol.dispose]();
		},
	};
});
```

Call sites then compose root sync with child family sync:

```ts
syncControl: composeSyncControls(sync, noteBodyDocs.syncControl),
```

Local-only child docs have to participate in the shape by writing `sync: null`:

```ts
return {
	...contentDoc,
	persistence: contentDoc.persistence as ReturnType<typeof attachIndexedDb>,
	sync: null,
};
```

This creates problems:

1. **Document families know too much**: A family needs to know which child docs are open. It does not need to know whether those docs sync over WebSocket.
2. **Local-only docs carry fake state**: `sync: null` is a smell. It tells us the type is enforcing a concern that some children do not have.
3. **Auth policy leaks through a cache**: The family became the place where auth token changes reach active child sockets only because the family already tracks open children.
4. **`ydoc` is not used by the family**: Requiring `ydoc` on `BrowserDocumentInstance` overstates the family contract.

### Desired State

`createBrowserDocumentFamily` should accept any disposable child document:

```ts
export type BrowserDocumentFamilySource<
	Id extends string | number,
	TDocument extends Disposable,
> = {
	create(id: Id): TDocument;
	clearLocalData(): Promise<void>;
};
```

The family should return only cache and cleanup operations:

```ts
export type BrowserDocumentFamily<
	Id extends string | number,
	TDocument extends Disposable,
> = Disposable & {
	open(id: Id): TDocument & Disposable;
	has(id: Id): boolean;
	clearLocalData(): Promise<void>;
};
```

`attachSync` should own credential freshness:

```ts
type TokenSource = {
	getToken(): Promise<string | null>;
	onTokenChange(listener: () => void): () => void;
};
```

Sync call sites should pass a token source instead of a one-off `getToken` closure:

```ts
const tokenSource = createAuthTokenSource(auth);

const sync = attachSync(doc, {
	url: websocketUrl(`${APP_URLS.API}/workspaces/${doc.ydoc.guid}`),
	waitFor: idb,
	tokenSource,
	awareness,
});
```

Child docs use the same source:

```ts
const childSync = attachSync(ydoc, {
	url: websocketUrl(`${APP_URLS.API}/docs/${ydoc.guid}`),
	waitFor: childIdb.whenLoaded,
	tokenSource,
});
```

Now each live sync connection responds to token changes by itself. The family never sees sync.

## Research Findings

### Better Auth Session Refresh

The API config uses Better Auth with session refresh once per day after use:

```ts
session: {
	expiresIn: 60 * 60 * 24 * 7,
	updateAge: 60 * 60 * 24,
	storeSessionInDatabase: true,
	cookieCache: {
		enabled: true,
		maxAge: 60 * 5,
		strategy: 'jwe',
	},
},
```

Better Auth documents `updateAge` as the interval after which using the session extends expiration. The default is also 24 hours. The bearer plugin documents `set-auth-token` as the response header clients capture for future bearer-authenticated requests.

References:

- Better Auth Session Management: https://better-auth.com/docs/concepts/session-management
- Better Auth Bearer Plugin: https://better-auth.com/docs/plugins/bearer

Implication: token change is possible and the client already tracks it, but ordinary refresh is not a constant event on every request.

### WebSocket Auth In This Repo

`attachSync` reads the token before each connect attempt and sends it through the WebSocket subprotocol:

```ts
const subprotocols = [MAIN_SUBPROTOCOL];
if (token) subprotocols.push(`${BEARER_SUBPROTOCOL_PREFIX}${token}`);
const ws = new WebSocketConstructor(wsUrl, subprotocols);
```

The API extracts that bearer subprotocol and synthesizes an `Authorization` header before calling Better Auth:

```ts
const token = extractBearerToken(c.req.raw.headers);
let headers = c.req.raw.headers;
if (token) {
	headers = new Headers(headers);
	headers.set('authorization', `Bearer ${token}`);
}
const result = await c.var.auth.api.getSession({ headers });
```

After the Worker accepts the user, the Durable Object trusts that boundary. `BaseSyncRoom` does not revalidate every sync message. That is the right hot-path design for CRDT updates.

Implication: when a token changes, an already-open socket does not automatically pick it up. The right client-side response is for the sync attachment that owns the socket to reconnect itself.

### Why Not Server-Side Live Revocation Now

Server-side live revocation is a different feature. It would mean the server can terminate already-accepted sockets after a session is revoked elsewhere.

That feature needs:

```txt
session identity per socket
revocation or auth epoch source of truth
Durable Object checks against that source
close-code semantics for revoked vs expired vs transient auth
tests across Worker, Durable Object, and attachSync
```

Passing `expiresAt` into the Durable Object is not enough. It would close sockets at expiry, but it would not handle sign-out on another device, admin revocation, password-change revocation, or account deletion unless the Durable Object also checks a shared revocation source.

Implication: do not add Durable Object auth metadata as part of this cleanup. It would add protocol surface without buying the full security property.

### What Existing Family Sync Fanout Actually Solves

The current family sync fanout solves only this local-tab case:

```txt
auth token changes in this tab
auth-workspace calls syncControl.reconnect()
root sync reconnects
active child syncs reconnect too
```

It does not solve remote session revocation. It does not cause the Durable Object to revalidate already-open sockets. It only propagates known token changes to active child WebSockets.

Implication: keep the behavior, but move it to `attachSync`, where it belongs.

## Decision

Implement token-change reconnect at the `attachSync` layer and remove sync from the browser document family contract.

Do not add Durable Object live revocation in this change.

Do not keep a tactical `getSyncControl` option on `createBrowserDocumentFamily`. That option would make sync optional, but it would still keep network lifecycle attached to a child-cache abstraction. The cleaner boundary is for every sync attachment to subscribe to credential changes directly.

## Rejected Alternatives

### Keep Current Family Sync Fanout

```txt
BrowserDocumentFamily
  owns open children
  tracks child sync controls
  exposes syncControl
```

Rejected because it makes the family own a network concern. It also forces local-only docs to carry `sync: null`.

### Add `getSyncControl` To The Family

```ts
createBrowserDocumentFamily(source, {
	gcTime: 5_000,
	getSyncControl: (doc) => doc.sync,
});
```

Rejected as a partial cleanup. It removes `sync: null`, but the family still becomes the fanout layer for auth reconnect policy.

### Delete Child Reconnect Entirely

```txt
only root sync reconnects on token change
child sockets reconnect naturally later
```

Rejected because it accepts a stale-token downside for no reason. A child sync attachment already has the WebSocket and the token getter. It can reconnect itself when the token changes.

### Add Durable Object Live Revocation Now

```txt
Worker passes session metadata to Durable Object
Durable Object checks revocation state
stale sockets are closed server-side
```

Rejected for this spec. It is a real security feature, not a cleanup. It requires a separate design around session epochs, revocation storage, and close-code semantics. It should not be bundled with removing sync from a cache.

## Architecture

Target ownership:

```txt
AuthClient
  owns current session token
  emits token changes

TokenSource
  adapts AuthClient to getToken plus onTokenChange

attachSync
  owns one WebSocket for one Y.Doc
  reads token before connecting
  reconnects when TokenSource says the token changed
  tears down permanently when the Y.Doc is destroyed

createBrowserDocumentFamily
  owns child document identity by id
  deduplicates live children
  refcounts and disposes children
  delegates storage cleanup to the source

BaseSyncRoom
  owns Yjs room state
  trusts Worker auth at upgrade
```

### Token Change Flow

```txt
STEP 1: Better Auth response rotates bearer token
-------------------------------------------------
createAuth sees set-auth-token and writes a new signed-in snapshot.

STEP 2: TokenSource observes the snapshot
-----------------------------------------
createAuthTokenSource compares the token field and notifies listeners.

STEP 3: Each attachSync reconnects itself
-----------------------------------------
Root sync and each open child sync receive the token-change event directly.
Each sync closes its current socket and reconnects with the new token.

STEP 4: BrowserDocumentFamily does nothing
------------------------------------------
The child family has no role in token freshness.
```

### Auth Reset Flow

```txt
STEP 1: User signs out or switches user in this tab
---------------------------------------------------
bindAuthWorkspaceScope marks the client scope terminal.

STEP 2: App reset runs
----------------------
The app calls workspace.clearLocalData() and reloads.

STEP 3: Family cleanup clears storage
-------------------------------------
The family delegates child storage cleanup to its source.

STEP 4: App reload constructs a fresh workspace scope
-----------------------------------------------------
Old live handles do not need to be kept usable across the reset.
```

Whether `family.clearLocalData()` should dispose cached children first is a separate implementation detail. The current refcounted cache contract does not expose per-entry force-close, and forcing disposal under mounted UI is sharper than this spec needs. The important boundary change is that storage cleanup no longer needs to pause child sync through the family.

## API Design

### Token Source

Add a token-source contract near sync, not near auth-specific packages:

```ts
export type TokenSource = {
	getToken(): Promise<string | null>;
	onTokenChange(listener: () => void): () => void;
};
```

The name can be `CredentialSource` if implementation finds token too narrow, but the first implementation is bearer-token based. Keep the shape small.

### Auth Adapter

Add an adapter in the auth package or auth-workspace package:

```ts
export function createAuthTokenSource(auth: AuthClient): TokenSource {
	let currentToken =
		auth.snapshot.status === 'signedIn' ? auth.snapshot.session.token : null;
	const listeners = new Set<() => void>();

	const unsubscribe = auth.onSnapshotChange((snapshot) => {
		const nextToken =
			snapshot.status === 'signedIn' ? snapshot.session.token : null;
		if (nextToken === currentToken) return;
		currentToken = nextToken;
		for (const listener of listeners) listener();
	});

	return {
		async getToken() {
			await auth.whenLoaded;
			const snapshot = auth.snapshot;
			return snapshot.status === 'signedIn' ? snapshot.session.token : null;
		},
		onTokenChange(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		[Symbol.dispose]() {
			unsubscribe();
			listeners.clear();
		},
	};
}
```

If `TokenSource` remains non-disposable, the owner of the adapter must keep the unsubscribe. Prefer making the returned adapter disposable if it is created once per browser workspace.

### attachSync

Extend `SyncAttachmentConfig`:

```ts
export type SyncAttachmentConfig = {
	url: string;
	waitFor?: WaitForBarrier;
	getToken?: () => Promise<string | null>;
	tokenSource?: TokenSource;
	webSocketImpl?: WebSocketImpl;
	log?: Logger;
	awareness?: AwarenessAttachment<AwarenessSchema>;
};
```

During migration, support both `getToken` and `tokenSource`, but reject both together:

```ts
if (config.getToken && config.tokenSource) {
	throw new Error('attachSync accepts getToken or tokenSource, not both');
}
```

Then normalize:

```ts
const getToken = config.tokenSource?.getToken ?? config.getToken;
const requiresToken = typeof getToken === 'function';
```

Subscribe after listeners are attached and before the first supervisor starts:

```ts
const unsubscribeTokenChange = config.tokenSource?.onTokenChange(() => {
	reconnect();
});

ydoc.once('destroy', async () => {
	unsubscribeTokenChange?.();
	// existing teardown
});
```

Use care to avoid reconnecting before `waitFor` has loaded if the token source fires during startup. The simplest safe behavior is acceptable: `reconnect()` aborts the current cycle, and the supervisor still gates on `waitForPromise` before the first connection attempt.

### createBrowserDocumentFamily

Collapse the required document instance shape:

```ts
export type BrowserDocumentFamilySource<
	Id extends string | number,
	TDocument extends Disposable,
> = {
	create(id: Id): TDocument;
	clearLocalData(): Promise<void>;
};
```

Remove:

```ts
BrowserDocumentInstance
BrowserDocumentFamily.syncControl
activeSyncControls
sync: SyncControl | null requirements
```

Keep:

```ts
open(id)
has(id)
clearLocalData()
[Symbol.dispose]()
```

### Browser App Call Sites

Before:

```ts
const noteBodyDocs = createBrowserDocumentFamily({
	create(noteId) {
		const childSync = attachSync(ydoc, {
			url,
			waitFor: childIdb.whenLoaded,
			getToken: async () => {
				await auth.whenLoaded;
				const snapshot = auth.snapshot;
				return snapshot.status === 'signedIn'
					? snapshot.session.token
					: null;
			},
		});

		return {
			ydoc,
			body,
			idb: childIdb,
			sync: childSync,
			whenLoaded: childIdb.whenLoaded,
			[Symbol.dispose]() {
				ydoc.destroy();
			},
		};
	},
	async clearLocalData() {
		// source-owned cleanup
	},
});

return {
	...doc,
	syncControl: composeSyncControls(sync, noteBodyDocs.syncControl),
};
```

After:

```ts
const tokenSource = createAuthTokenSource(auth);

const noteBodyDocs = createBrowserDocumentFamily({
	create(noteId) {
		const childSync = attachSync(ydoc, {
			url,
			waitFor: childIdb.whenLoaded,
			tokenSource,
		});

		return {
			ydoc,
			body,
			idb: childIdb,
			sync: childSync,
			whenLoaded: childIdb.whenLoaded,
			[Symbol.dispose]() {
				ydoc.destroy();
			},
		};
	},
	async clearLocalData() {
		// source-owned cleanup
	},
});

const sync = attachSync(doc, {
	url,
	waitFor: idb,
	tokenSource,
	awareness,
});

return {
	...doc,
	syncControl: sync,
	[Symbol.dispose]() {
		tokenSource[Symbol.dispose]?.();
		noteBodyDocs[Symbol.dispose]();
		doc[Symbol.dispose]();
	},
};
```

For local-only child docs, remove `sync: null` entirely:

```ts
return {
	...contentDoc,
	persistence: contentDoc.persistence as ReturnType<typeof attachIndexedDb>,
};
```

## Implementation Plan

### Phase 1: Token Source

- [x] **1.1** Add `TokenSource` type in `packages/workspace/src/document/attach-sync.ts` or a sibling sync file.
- [x] **1.2** Add `createAuthTokenSource(auth)` in the auth integration layer. Prefer `@epicenter/auth-workspace` if the adapter is only used by workspace sync clients.
- [x] **1.3** Add tests for token-change notification: same token does not notify, changed token notifies, signed-out changes token to null.

### Phase 2: attachSync Owns Token Changes

- [x] **2.1** Extend `SyncAttachmentConfig` with `tokenSource`.
- [x] **2.2** Reject configs that pass both `getToken` and `tokenSource`.
- [x] **2.3** Normalize token reads through one local `getToken` function.
- [x] **2.4** Subscribe to `tokenSource.onTokenChange()` and call `reconnect()`.
- [x] **2.5** Unsubscribe on `ydoc.destroy`.
- [x] **2.6** Add attachSync tests proving token changes reconnect an active socket and token-source cleanup runs on destroy.

### Phase 3: Browser Apps Use TokenSource

- [x] **3.1** Update Honeycrisp browser workspace construction to create one token source and pass it to root and child `attachSync`.
- [x] **3.2** Update Fuji the same way.
- [x] **3.3** Update Opensidian root sync. Opensidian child docs are local-only today.
- [x] **3.4** Update Tab Manager and Zhongwen if their sync setup can use the same adapter.
  > **Note**: Tab Manager now uses `createAuthTokenSource`. Zhongwen browser remains local-only, so there is no auth-backed sync setup to migrate.
- [x] **3.5** Keep daemon and script surfaces on `getToken` unless they have an auth snapshot source. They can migrate later or stay on the fallback API.

### Phase 4: Purify BrowserDocumentFamily

- [x] **4.1** Remove `BrowserDocumentInstance`.
- [x] **4.2** Change `BrowserDocumentFamilySource` to use `TDocument extends Disposable`.
- [x] **4.3** Remove `activeSyncControls` and `syncControl` from `createBrowserDocumentFamily`.
- [x] **4.4** Remove `sync: null` from local-only child document call sites.
- [x] **4.5** Update tests to cover only cache identity, refcounted disposal, and source-owned cleanup.
- [x] **4.6** Update `packages/workspace/src/index.ts` example to show token-source sync at app level and pure document-family construction.

### Phase 5: Auth Workspace Scope

- [x] **5.1** Decide whether `bindAuthWorkspaceScope` still needs `syncControl.reconnect()` on token change once `attachSync` owns token-source reconnect.
  > **Note**: `bindAuthWorkspaceScope` no longer reconnects for same-user token changes. That responsibility lives in `attachSync`.
- [x] **5.2** Keep root `syncControl.pause()` for signed-out initial state and terminal reset if it still maps cleanly to app behavior.
- [x] **5.3** Remove token-change reconnect tests from `auth-workspace` if the behavior moves fully to `attachSync`; replace with tests that auth sessions are applied and terminal resets are sequenced.

## Edge Cases

### Token Changes Before First Sync Connect

1. Workspace constructs `tokenSource`.
2. Auth snapshot changes before IndexedDB `waitFor` resolves.
3. `attachSync` receives token-change notification.

Expected: no duplicate live socket. It is acceptable for the current cycle to abort and restart. The first real connect must still read the latest token after `waitFor`.

### Token Changes To Null

1. Auth snapshot becomes signed-out.
2. Token source notifies.
3. `attachSync` reconnects and `getToken()` returns null.

Expected: authenticated sync parks in an auth/offline retry state without sending a token. The terminal reset path should normally reload the app soon after.

### Existing Socket With Revoked Token From Another Device

1. A socket was accepted with a valid token.
2. Another device revokes the session.
3. This tab receives no auth snapshot change.

Expected in this spec: the socket remains accepted until it closes naturally or the server closes it for another reason. This is existing behavior. Server-side live revocation is out of scope.

### Child Doc Open During Auth Reset

1. A child editor is mounted and holds a handle.
2. Auth reset starts.
3. App clears local data and reloads.

Expected: reload ends the workspace scope. Do not add child sync pause behavior back to the family to support this. If implementation chooses to dispose the family before storage cleanup, audit active UI handles carefully.

## Success Criteria

- [x] `createBrowserDocumentFamily` has no `ydoc`, `sync`, `syncControl`, `BrowserDocumentInstance`, or `SyncControl` imports.
- [x] Local-only child docs no longer return `sync: null`.
- [x] Root and child `attachSync` calls in browser apps use one shared `TokenSource` where an auth client exists.
- [x] A token change in `AuthClient` causes each live `attachSync` using that token source to reconnect without family involvement.
- [x] `bindAuthWorkspaceScope` no longer owns same-user token reconnect if that behavior has moved to `attachSync`.
- [x] Existing `getToken` call sites for daemon/script code still compile or have a deliberate migration path.
- [x] Tests cover `attachSync` token-source reconnect and document-family cache behavior separately.
- [x] `bun run --filter @epicenter/workspace typecheck` passes.
- [x] Targeted package tests pass for `packages/workspace` and `packages/auth-workspace`.

## Review

**Completed**: 2026-05-03
**Branch**: codex/explicit-daemon-host-config

### Summary

`attachSync` now accepts a generic `TokenSource`, reads tokens through one normalized path, and reconnects its own WebSocket when that source reports a token change. `createBrowserDocumentFamily` now only owns child identity, refcounted caching, disposal, and source-owned storage cleanup.

### Verification

- `bun test packages/workspace/src/cache/browser-document-family.test.ts`
- `bun test packages/workspace/src/document/attach-sync.test.ts`
- `bun test packages/auth-workspace/src/index.test.ts`
- `bun run --filter @epicenter/workspace typecheck`
- `bun run --filter @epicenter/auth-workspace typecheck`

### App Checks

The touched app checks were run and still fail on existing unrelated diagnostics outside this change:

- `bun run --filter @epicenter/honeycrisp typecheck`: first errors are in `packages/svelte-utils/src/from-table.svelte.ts` and `packages/ui/src/sonner/toast-on-error.ts`.
- `bun run --filter @epicenter/fuji typecheck`: first errors are in `packages/svelte-utils/src/from-table.svelte.ts` and `packages/ui/src/sonner/toast-on-error.ts`.
- `bun run --filter @epicenter/tab-manager typecheck`: first errors are missing `#/utils.js` and other `#/...` aliases in `packages/ui`.
- `bun run --filter opensidian check`: first errors are in `packages/svelte-utils/src/from-table.svelte.ts`, `packages/ui/src/sonner/toast-on-error.ts`, and existing Opensidian skill/chat state files.
- `bun run --filter skills check`: first errors are in `packages/svelte-utils/src/from-table.svelte.ts` and missing `#/...` aliases in `packages/ui`.

## Files To Inspect

```txt
packages/workspace/src/document/attach-sync.ts
packages/workspace/src/document/sync-control.ts
packages/workspace/src/cache/browser-document-family.ts
packages/workspace/src/cache/browser-document-family.test.ts
packages/workspace/src/index.ts
packages/auth-workspace/src/index.ts
packages/auth-workspace/src/index.test.ts
packages/auth/src/create-auth.ts
apps/api/src/app.ts
apps/api/src/base-sync-room.ts
apps/honeycrisp/src/lib/honeycrisp/browser.ts
apps/honeycrisp/src/lib/honeycrisp/client.ts
apps/fuji/src/lib/fuji/browser.ts
apps/fuji/src/lib/fuji/client.ts
apps/opensidian/src/lib/opensidian/browser.ts
apps/opensidian/src/lib/opensidian/client.ts
apps/skills/src/lib/skills/browser.ts
apps/tab-manager/src/lib/tab-manager/extension.ts
apps/tab-manager/src/lib/tab-manager/client.ts
apps/zhongwen/src/lib/zhongwen/browser.ts
apps/zhongwen/src/lib/zhongwen/client.ts
```

## References

- Better Auth Session Management: https://better-auth.com/docs/concepts/session-management
- Better Auth Bearer Plugin: https://better-auth.com/docs/plugins/bearer
- Prior cleanup commit: `a27d99728 refactor: delegate browser child cleanup to sources`
