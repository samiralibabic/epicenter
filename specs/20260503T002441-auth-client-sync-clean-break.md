# Auth Client Sync Clean Break

**Date**: 2026-05-03
**Status**: Implemented
**Author**: Epicenter
**Branch**: codex/explicit-daemon-host-config
**Implemented In**: `553e48b60 feat(auth)!: pass auth clients to sync`

**Supersedes**: `20260502T233446-sync-token-source-and-disposable-child-docs.md` for auth and sync API shape. The disposable child-doc direction still stands.

## One-Sentence Test

Workspace sync is authenticated by an Epicenter `AuthClient`; encryption key schemas live in a shared encryption package so auth and workspace can depend on each other in the right direction.

Everything in this spec should serve that sentence. If a surface only preserves a generic token-source seam, or keeps encryption key schemas under workspace just because they started there, it does not belong.

## Overview

Delete the `TokenSource` sync boundary and pass an `AuthClient` directly to `attachSync`. Break the current auth/workspace package cycle by moving `EncryptionKey`, `EncryptionKeys`, and `encryptionKeysFingerprint` out of `@epicenter/workspace` into a new `@epicenter/encryption` package. Keep `@epicenter/auth-svelte` as a thin Svelte projection of the same auth contract: only `snapshot` changes, everything else passes through.

The result is intentionally less generic. Epicenter workspace sync talks to Epicenter auth. That coupling should be real, typed, and visible.

## Implemented State

This spec has been executed. The source of truth is commit `553e48b60 feat(auth)!: pass auth clients to sync`.

The current implementation keeps the clean break:

- `attachSync` accepts `auth?: AuthClient`.
- `TokenSource`, `tokenSource`, `getToken`, and `createAuthTokenSource` are removed from source call sites.
- `@epicenter/encryption` owns `EncryptionKey`, `EncryptionKeys`, and `encryptionKeysFingerprint`.
- Browser, daemon, script, example, and test sync call sites pass auth clients directly.
- `@epicenter/auth-svelte` spreads the core auth client, then overrides only `snapshot` and `[Symbol.dispose]`.

The main thing to preserve from this spec is the Svelte wrapper ordering: `...base` must stay before `get snapshot()`. Object spread reads the base getter once, so the wrapper has to overwrite that copied value with the reactive getter.

## Motivation

### Current State

`attachSync` currently accepts either a one-off token getter or a token-source object:

```ts
export type TokenSource<TToken extends string | null = string | null> = {
	getToken(): Promise<TToken>;
	onTokenChange(listener: () => void): () => void;
};

export type SyncAttachmentConfig = {
	url: string;
	waitFor?: WaitForBarrier;
	getToken?: () => Promise<string | null>;
	tokenSource?: TokenSource;
};
```

Browser apps adapt auth into that shape:

```ts
const tokenSource = createAuthTokenSource(auth);

const sync = attachSync(doc, {
	url: websocketUrl(`${APP_URLS.API}/workspaces/${doc.ydoc.guid}`),
	waitFor: idb,
	tokenSource,
	awareness,
});
```

The adapter only re-expresses data that already lives on auth:

```ts
export function createAuthTokenSource(auth: AuthClient) {
	let currentToken =
		auth.snapshot.status === 'signedIn' ? auth.snapshot.session.token : null;

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

The current package graph blocks the obvious API because `@epicenter/auth` imports encryption key schemas from `@epicenter/workspace`:

```txt
@epicenter/auth
  imports @epicenter/workspace/encryption-key

@epicenter/workspace
  cannot import @epicenter/auth without a cycle
```

This creates four problems:

1. **The generic seam is fake**: Browser sync is not generic token sync. It is Epicenter authenticated sync. `tokenSource` names an implementation detail instead of the domain object.
2. **The adapter has no owned invariant**: `createAuthTokenSource()` waits for `auth.whenLoaded`, reads `auth.snapshot`, and listens to `auth.onSnapshotChange()`. Auth already owns all three.
3. **Encryption key schemas sit in the wrong package**: `EncryptionKeys` is shared crypto wire data. It is consumed by auth sessions, machine credentials, API auth responses, and workspace encryption. Workspace should not be the package that owns it.
4. **The Svelte wrapper is noisier than its job**: `@epicenter/auth-svelte` currently lists every auth method because spreading a getter would freeze `snapshot`. Once the wrapper overrides `snapshot` after spreading, only `snapshot` and `[Symbol.dispose]` need custom code.

### Desired State

Browser app setup should pass auth directly:

```ts
export const auth = createAuth({
	baseURL: APP_URLS.API,
	sessionStorage: createSessionStorageAdapter(session),
});

export const fuji = openFuji({
	auth,
	peer,
});
```

Browser workspace construction should also pass auth directly:

```ts
export function openFuji({
	auth,
	peer,
}: {
	auth: AuthClient;
	peer: PeerIdentity;
}) {
	const sync = attachSync(doc, {
		url: websocketUrl(`${APP_URLS.API}/workspaces/${doc.ydoc.guid}`),
		waitFor: idb,
		auth,
		awareness,
	});
}
```

`attachSync` should accept auth as a domain dependency:

```ts
import type { AuthClient, AuthSnapshot } from '@epicenter/auth';

export type SyncAttachmentConfig = {
	url: string;
	waitFor?: WaitForBarrier;
	auth?: AuthClient;
	webSocketImpl?: WebSocketImpl;
	log?: Logger;
	awareness?: AwarenessAttachment<AwarenessSchema>;
};
```

No `TokenSource`. No `createAuthTokenSource`. No `getToken` sync option.

## Research Findings

### Encryption Key Ownership

`EncryptionKeys` currently lives at `packages/workspace/src/document/encryption-key.ts`, but its own module doc says it is used by more than workspace:

```txt
Session response encryptionKeys field
workspace encryption applyKeys()
Auth session cache deserialization
Machine credential storage
```

Current import sites confirm that:

```txt
packages/auth/src/auth-types.ts
packages/auth/src/contracts/session.ts
packages/auth/src/node/machine-credential-secret-storage.ts
packages/auth/src/node/machine-auth.ts
apps/api/src/auth/encryption.ts
packages/workspace/src/document/attach-encryption.ts
packages/workspace/src/shared/crypto/index.ts
```

Key finding: this is not workspace-owned state. It is a shared crypto schema.

Implication: create `@epicenter/encryption`, move the schemas and fingerprint helper there, and make both auth and workspace depend on it.

### Auth Client Surface

The core `AuthClient` currently has the minimum session-observation surface needed by sync:

```ts
readonly snapshot: AuthSnapshot;
readonly whenLoaded: Promise<void>;
onSnapshotChange(fn: AuthSnapshotChangeListener): () => void;
```

It also has command and transport methods used by UI and API helpers:

```ts
signIn(...)
signUp(...)
signInWithSocialPopup()
signInWithSocialRedirect(...)
signOut()
fetch(...)
[Symbol.dispose]()
```

Key finding: sync does not need new auth methods. It can read token state from `snapshot` and subscribe to the same snapshot fan-out that every other lifecycle binding already uses.

Implication: do not add `getToken()` or `onTokenChange()` to auth. That would move the deleted `TokenSource` abstraction into the auth object instead of removing it.

### Svelte Wrapper Surface

Svelte UI reads need a reactive getter:

```svelte
const snapshot = $derived(auth.snapshot);
```

The vanilla core getter is not Svelte-reactive. The wrapper must keep a `$state` mirror for `snapshot`.

Everything else can pass through. `whenLoaded` is a stable promise. `onSnapshotChange` is an imperative listener. Commands like `signIn`, `signOut`, and `fetch` are functions that close over the core auth client internals.

Implication: `@epicenter/auth-svelte` should spread the core client, then override only `snapshot` and `[Symbol.dispose]`.

### Machine Sync Call Sites

Some script and example call sites still use `getToken`:

```txt
examples/notes-cross-peer/notes.ts
packages/cli/README.md
apps/*/src/lib/*/script.ts
apps/*/src/lib/*/integration.test.ts
```

The clean break should not keep `getToken` only for those sites. That preserves the old generic sync API and makes every reader ask which path is canonical.

Machine credentials already store enough data to reconstruct a session:

```ts
type MachineCredential = {
	serverOrigin: string;
	bearerToken: string;
	session: Session;
	savedAt: string;
	lastUsedAt: string;
};
```

Implication: move machine sync onto the same auth path. Add an auth package helper that constructs a normal `AuthClient` from machine credential storage, then pass that client to `attachSync`.

## Design Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Sync auth option | `auth?: AuthClient` | The caller is authenticating sync with Epicenter auth, not supplying a generic token source. |
| Token-source API | Delete `TokenSource`, `tokenSource`, `getToken`, and `createAuthTokenSource` | These preserve a generic seam that no longer matches the product. |
| Auth token helpers | Do not add `getToken()` or `onTokenChange()` to `AuthClient` | `snapshot`, `whenLoaded`, and `onSnapshotChange()` already express the needed lifecycle. |
| Encryption key package | New `@epicenter/encryption` package | Encryption key schemas are shared crypto data, not workspace-owned data. |
| Workspace dependency direction | `@epicenter/workspace` imports `AuthClient` from `@epicenter/auth` | The product truth is that workspace sync uses Epicenter auth. |
| Auth dependency direction | `@epicenter/auth` imports `EncryptionKeys` from `@epicenter/encryption`, not workspace | This removes the auth/workspace cycle. |
| Svelte auth wrapper | Spread core auth, override `snapshot` and `[Symbol.dispose]` | The wrapper is a projection. It should not hand-forward every method. |
| Machine sync | Use a normal `AuthClient` constructed from machine credentials | This avoids keeping a second sync auth API for scripts. |
| Backwards compatibility | Do not keep old public names | This repo is mid-migration. A hybrid API would make the canonical path ambiguous. |

## Architecture

Target package graph:

```txt
@epicenter/encryption
  EncryptionKey
  EncryptionKeys
  encryptionKeysFingerprint

@epicenter/auth
  imports @epicenter/encryption
  exports AuthClient
  exports createAuth()

@epicenter/auth-svelte
  imports @epicenter/auth
  exports createAuth() returning AuthClient
  only makes snapshot reactive

@epicenter/workspace
  imports @epicenter/auth
  imports @epicenter/encryption
  attachSync(..., { auth })
  attachEncryption(...).applyKeys(keys)

@epicenter/auth-workspace
  imports @epicenter/auth
  imports SyncControl type from @epicenter/workspace
  binds signed-out and user-switch reset policy
```

No package cycle:

```txt
encryption
  no internal package dependencies

auth -> encryption
workspace -> auth
workspace -> encryption
auth-svelte -> auth
auth-workspace -> auth + workspace
apps -> auth-svelte + auth-workspace + workspace
```

### Sync Auth Flow

```txt
STEP 1: attachSync starts
------------------------
It stores the initial token from auth.snapshot and subscribes to auth.onSnapshotChange().

STEP 2: first connection waits
------------------------------
The supervisor waits for config.waitFor and auth.whenLoaded before reading the token for the first connection attempt.

STEP 3: token changes
---------------------
Auth rotates the token by writing a new signed-in snapshot.

STEP 4: attachSync compares tokens
----------------------------------
The snapshot listener extracts the token and compares it with the last token seen by this sync attachment.

STEP 5: attachSync reconnects itself
------------------------------------
If the token changed, the attachment queues its own reconnect. The next WebSocket upgrade carries the new bearer subprotocol.
```

Use a microtask for the reconnect wake-up:

```ts
const unsubscribeAuthChange = auth?.onSnapshotChange((snapshot) => {
	const nextToken = tokenFromSnapshot(snapshot);
	if (nextToken === currentToken) return;

	currentToken = nextToken;
	queueMicrotask(reconnect);
});
```

The microtask avoids making sync reconnect run inside auth's listener loop. It also lets `bindAuthWorkspaceScope` listeners apply encryption keys before the new socket connects.

### Svelte Auth Projection

Only two properties should be custom:

```ts
export function createAuth(config: CreateAuthConfig): AuthClient {
	const base = createBaseAuthClient(config);
	let snapshot = $state(base.snapshot);

	const unsubscribe = base.onSnapshotChange((next) => {
		snapshot = next;
	});

	return {
		...base,
		get snapshot() {
			return snapshot;
		},
		[Symbol.dispose]() {
			unsubscribe();
			base[Symbol.dispose]();
		},
	} satisfies AuthClient;
}
```

Pass through unchanged:

```txt
whenLoaded
onSnapshotChange
signIn
signUp
signInWithSocialPopup
signInWithSocialRedirect
signOut
fetch
```

Replace:

```txt
snapshot
[Symbol.dispose]
```

Do not add:

```txt
getToken
onTokenChange
tokenSource
```

## API Design

### New Package

Create `packages/encryption`:

```txt
packages/encryption/
  package.json
  tsconfig.json
  src/index.ts
```

`src/index.ts` should contain the moved schema:

```ts
import { type } from 'arktype';

export const EncryptionKey = type({
	version: 'number.integer > 0',
	userKeyBase64: 'string',
});

export const EncryptionKeys = type([
	EncryptionKey,
	'...',
	EncryptionKey.array(),
]);

export type EncryptionKey = typeof EncryptionKey.infer;
export type EncryptionKeys = typeof EncryptionKeys.infer;

export function encryptionKeysFingerprint(keys: EncryptionKeys): string {
	return [...keys]
		.sort((a, b) => a.version - b.version)
		.map((k) => `${k.version}:${k.userKeyBase64}`)
		.join(',');
}
```

Package dependencies:

```json
{
	"name": "@epicenter/encryption",
	"version": "0.1.0",
	"private": true,
	"type": "module",
	"main": "./src/index.ts",
	"types": "./src/index.ts",
	"exports": {
		".": "./src/index.ts"
	},
	"dependencies": {
		"arktype": "catalog:"
	},
	"devDependencies": {
		"typescript": "catalog:"
	},
	"scripts": {
		"typecheck": "tsc --noEmit"
	}
}
```

### Auth Package

Update all auth imports:

```diff
- import { EncryptionKeys } from '@epicenter/workspace/encryption-key';
+ import { EncryptionKeys } from '@epicenter/encryption';
```

Update `packages/auth/package.json`:

```diff
 "dependencies": {
-  "@epicenter/workspace": "workspace:*",
+  "@epicenter/encryption": "workspace:*",
   "arktype": "catalog:",
   "better-auth": "catalog:",
   "wellcrafted": "catalog:"
 }
```

Do not change the core `AuthClient` shape for token sourcing. The existing `snapshot`, `whenLoaded`, and `onSnapshotChange()` members are the source.

### Auth Svelte Package

Change `packages/auth-svelte/src/create-auth.svelte.ts` to spread the core client and override the reactive getter:

```diff
 export function createAuth(config: CreateAuthConfig): AuthClient {
	const base = createBaseAuthClient(config);
	let snapshot = $state(base.snapshot);

	const unsubscribe = base.onSnapshotChange((next) => {
		snapshot = next;
	});

	return {
+		...base,
		get snapshot() {
			return snapshot;
		},
-		get whenLoaded() {
-			return base.whenLoaded;
-		},
-		onSnapshotChange: base.onSnapshotChange,
-		signIn: base.signIn,
-		signUp: base.signUp,
-		signInWithSocialPopup: base.signInWithSocialPopup,
-		signInWithSocialRedirect: base.signInWithSocialRedirect,
-		signOut: base.signOut,
-		fetch: base.fetch,
		[Symbol.dispose]() {
			unsubscribe();
			base[Symbol.dispose]();
		},
-	};
+	} satisfies AuthClient;
 }
```

Object spread invokes the base `snapshot` getter once, but the later `get snapshot()` overrides that copied value. Keep the override after the spread.

### Workspace Package

Update `attachSync` config:

```ts
import type { AuthClient, AuthSnapshot } from '@epicenter/auth';

function tokenFromSnapshot(snapshot: AuthSnapshot): string | null {
	return snapshot.status === 'signedIn' ? snapshot.session.token : null;
}

export type SyncAttachmentConfig = {
	url: string;
	waitFor?: WaitForBarrier;
	auth?: AuthClient;
	webSocketImpl?: WebSocketImpl;
	log?: Logger;
	awareness?: AwarenessAttachment<AwarenessSchema>;
};
```

Delete the dual config check:

```ts
if (config.getToken && config.tokenSource) {
	throw new Error('[attachSync] pass getToken or tokenSource, not both');
}
```

Replace token reads:

```ts
async function readToken(): Promise<string | null> {
	const auth = config.auth;
	if (!auth) return null;

	await auth.whenLoaded;
	return tokenFromSnapshot(auth.snapshot);
}
```

`requiresToken` should become:

```ts
const requiresToken = config.auth !== undefined;
```

Subscribe to token changes directly:

```ts
let currentToken = config.auth ? tokenFromSnapshot(config.auth.snapshot) : null;
const unsubscribeAuthChange = config.auth?.onSnapshotChange((snapshot) => {
	const nextToken = tokenFromSnapshot(snapshot);
	if (nextToken === currentToken) return;

	currentToken = nextToken;
	queueMicrotask(reconnect);
});
```

Unsubscribe in the `ydoc.once('destroy', ...)` cleanup.

Update workspace package dependencies:

```diff
 "dependencies": {
+  "@epicenter/auth": "workspace:*",
+  "@epicenter/encryption": "workspace:*",
   ...
 }
```

Update encryption imports in workspace:

```diff
- import { type EncryptionKeys, encryptionKeysFingerprint } from './encryption-key.js';
+ import { type EncryptionKeys, encryptionKeysFingerprint } from '@epicenter/encryption';
```

Delete `packages/workspace/src/document/encryption-key.ts` after all imports move.

Remove workspace exports:

```diff
- "./encryption-key": "./src/document/encryption-key.ts",
```

and:

```diff
- export {
-  EncryptionKey,
-  type EncryptionKey as EncryptionKeyData,
-  EncryptionKeys,
-  type EncryptionKeys as EncryptionKeysData,
-  encryptionKeysFingerprint,
- } from './document/encryption-key.js';
```

Do not re-export encryption schemas from `@epicenter/workspace`. Consumers should import from `@epicenter/encryption`.

### Auth Workspace Package

Delete `createAuthTokenSource` and its tests.

Keep `bindAuthWorkspaceScope`. Its role is still valid:

```txt
cold signed-out pauses sync
cold signed-in applies encryption keys
same-user key refresh applies keys
signed-out after applied user resets local client
user switch resets local client
```

Token-change reconnect should not live here anymore.

### Browser Apps

Update app browser modules:

```diff
- import type { AuthClient } from '@epicenter/auth-svelte';
- import { createAuthTokenSource } from '@epicenter/auth-workspace';
+ import type { AuthClient } from '@epicenter/auth';
```

Remove adapter construction:

```diff
 const doc = openFujiDoc();
-const tokenSource = createAuthTokenSource(auth);
```

Pass auth to every sync attachment:

```diff
 const childSync = attachSync(ydoc, {
	url: websocketUrl(`${APP_URLS.API}/docs/${ydoc.guid}`),
	waitFor: childIdb.whenLoaded,
-	tokenSource,
+	auth,
 });
```

and:

```diff
 const sync = attachSync(doc, {
	url: websocketUrl(`${APP_URLS.API}/workspaces/${doc.ydoc.guid}`),
	waitFor: idb,
-	tokenSource,
+	auth,
	awareness,
 });
```

Remove token-source disposal:

```diff
 [Symbol.dispose]() {
-	tokenSource[Symbol.dispose]();
	entryContentDocs[Symbol.dispose]();
	doc[Symbol.dispose]();
 }
```

Target browser files:

```txt
apps/fuji/src/lib/fuji/browser.ts
apps/honeycrisp/src/lib/honeycrisp/browser.ts
apps/opensidian/src/lib/opensidian/browser.ts
apps/tab-manager/src/lib/tab-manager/extension.ts
```

### Machine And Script Sync

Remove `createMachineTokenGetter` after call sites migrate.

Add a helper in `@epicenter/auth/node` that creates a normal `AuthClient` from the stored machine session:

```ts
export function createMachineAuthClient(): AuthClient {
	const sessionStorage = createKeychainMachineAuthSessionStorage();
	return createAuth({
		baseURL: EPICENTER_API_URL,
		sessionStorage: {
			load: sessionStorage.load,
			save: sessionStorage.save,
		},
	});
}
```

The inline storage object implements the durable part of the core `SessionStorage` shape:

```ts
load(): Promise<Session | null>
save(value: Session | null): Promise<void>
watch?(fn: (next: Session | null) => void): () => void
```

Recommended behavior:

```txt
load()
  reads the current machine AuthSession
  returns null if absent

save(null)
  clears the stored machine session

save(session)
  saves the same AuthSession shape used by browser clients
```

Script call sites should then use:

```ts
const auth = createMachineAuthClient();

const sync = attachSync(doc, {
	url,
	waitFor,
	auth,
});
```

This is more work than keeping `getToken`, but it gives the repo one authenticated sync path.

## Rejected Alternatives

### Keep `TokenSource`, But Rename The Key To `auth`

```ts
attachSync(doc, {
	auth: {
		getToken,
		onTokenChange,
	},
});
```

Rejected. It hides the token-source abstraction under a better name. The implementation would still be generic token sync, not Epicenter auth sync.

### Add `getToken()` And `onTokenChange()` To `AuthClient`

```ts
auth.getToken()
auth.onTokenChange(...)
```

Rejected. This moves the adapter into auth instead of deleting it. Auth already exposes the more complete state transition with `snapshot` and `onSnapshotChange()`.

### Keep `getToken` For Machine Scripts

```ts
attachSync(doc, {
	getToken: createMachineTokenGetter(...),
});
```

Rejected. This creates a hybrid API. Browser apps would use `auth`, scripts would use `getToken`, and both would be first-class enough to confuse future call sites.

### Move `EncryptionKeys` Into `@epicenter/auth`

Rejected. Auth sessions carry encryption keys, but auth does not own the crypto schema. Workspace encryption and API key derivation also consume it. A shared `@epicenter/encryption` package is the clearer owner.

### Keep Re-Exports From `@epicenter/workspace`

Rejected for the clean break. Re-exporting `EncryptionKeys` from workspace keeps the old ownership story alive and invites new imports from the wrong package.

## Implementation Plan

### Phase 1: Extract Encryption Package

- [x] **1.1** Create `packages/encryption` with `package.json`, `tsconfig.json`, and `src/index.ts`.
- [x] **1.2** Move `EncryptionKey`, `EncryptionKeys`, and `encryptionKeysFingerprint` into `@epicenter/encryption`.
- [x] **1.3** Update `@epicenter/auth` imports from `@epicenter/workspace/encryption-key` to `@epicenter/encryption`.
- [x] **1.4** Update `@epicenter/workspace` imports from local `encryption-key.ts` to `@epicenter/encryption`.
- [x] **1.5** Update `apps/api`, app tests, scripts, and docs imports to `@epicenter/encryption`.
- [x] **1.6** Remove `packages/workspace/src/document/encryption-key.ts`.
- [x] **1.7** Remove the `@epicenter/workspace/encryption-key` package export and root barrel re-exports.

### Phase 2: Make attachSync Auth-Aware

- [x] **2.1** Add `@epicenter/auth` as a dependency of `@epicenter/workspace`.
- [x] **2.2** Replace `getToken?: ...` and `tokenSource?: ...` with `auth?: AuthClient` in `SyncAttachmentConfig`.
- [x] **2.3** Delete `TokenSource` from `attach-sync.ts` and the workspace barrel.
- [x] **2.4** Add `tokenFromSnapshot()` and make the supervisor await `auth.whenLoaded` before token reads.
- [x] **2.5** Subscribe to `auth.onSnapshotChange()` and queue reconnect only when the token value changes.
- [x] **2.6** Unsubscribe from auth changes during Y.Doc destroy cleanup.
- [x] **2.7** Update attach-sync tests to use fake `AuthClient` objects instead of token-source helpers.

### Phase 3: Remove Auth Token Adapter

- [x] **3.1** Delete `createAuthTokenSource` from `packages/auth-workspace/src/index.ts`.
- [x] **3.2** Delete token-source tests from `packages/auth-workspace/src/index.test.ts`.
- [x] **3.3** Keep and update `bindAuthWorkspaceScope` tests around reset sequencing and key application.
- [x] **3.4** Remove imports of `TokenSource` from `@epicenter/auth-workspace`.

### Phase 4: Simplify Auth Svelte Projection

- [x] **4.1** Change `packages/auth-svelte/src/create-auth.svelte.ts` to spread the base auth object.
- [x] **4.2** Override only `snapshot` and `[Symbol.dispose]`.
- [x] **4.3** Keep the exported `AuthClient` type equal to the core `AuthClient`.
- [x] **4.4** Verify Svelte UI callers still get reactive `auth.snapshot`.

### Phase 5: Update Browser Workspaces

- [x] **5.1** Update Fuji browser sync to pass `auth` directly to root and child `attachSync`.
- [x] **5.2** Update Honeycrisp browser sync to pass `auth` directly to root and child `attachSync`.
- [x] **5.3** Update Opensidian browser sync to pass `auth` directly to root sync.
- [x] **5.4** Update Tab Manager browser sync to pass `auth` directly to root sync.
- [x] **5.5** Remove token-source disposal from returned browser workspace objects.
- [x] **5.6** Import `AuthClient` from `@epicenter/auth` in non-Svelte browser construction modules.

### Phase 6: Update Machine And Script Sync

- [x] **6.1** Add `createMachineAuthClient()` and supporting machine session storage in `@epicenter/auth/node`.
- [x] **6.2** Update examples and scripts that currently pass `getToken` to construct a machine auth client and pass `auth`.
- [x] **6.3** Replace integration-test `getToken: async () => 'fake-token'` call sites with fake `AuthClient` fixtures.
- [x] **6.4** Delete `createMachineTokenGetter` after call sites migrate.

### Phase 7: Docs And Straggler Sweep

- [x] **7.1** Update workspace README and document README examples from `getToken` or `tokenSource` to `auth`.
- [x] **7.2** Update auth skill docs after implementation so they no longer recommend sync token callbacks.
- [x] **7.3** Run straggler searches and delete all old names.

## Edge Cases

### Token Changes Before waitFor Resolves

If auth emits a token change before IndexedDB hydration resolves, `attachSync` must not connect early. The reconnect wake-up can restart the pending supervisor cycle, but the first actual socket must still wait for `waitFor`.

Expected test:

```txt
create auth with token-1
create attachSync({ waitFor: unresolvedPromise, auth })
emit token-2
assert no WebSocket exists
resolve waitFor
assert first WebSocket uses token-2
```

### Signed Out At Startup

If `auth.whenLoaded` resolves and `auth.snapshot` is signed out, authenticated sync should park in the existing auth-error retry state. It should not connect unauthenticated.

### Auth Reset And Token Reconnect

When auth signs out after a session was applied, `bindAuthWorkspaceScope` pauses sync and runs app reset. `attachSync` may also observe the token going to null. That is acceptable. `pause()` and reconnect cycle aborts are already idempotent.

### Svelte Wrapper Spread

Object spread calls the base `snapshot` getter. The wrapper must define `get snapshot()` after `...base` so the stale copied value is overwritten.

### Machine Credential Rotation

If machine-auth-backed `AuthClient` receives a new session token via `auth.fetch`, `SessionStorage.save(session)` must persist the rotated token. Do not implement a save path that only updates memory while leaving the credential file stale.

## Success Criteria

- [x] No source file imports `createAuthTokenSource`.
- [x] No source file imports or exports `TokenSource`.
- [x] `SyncAttachmentConfig` has `auth?: AuthClient` and no `getToken` or `tokenSource` fields.
- [x] No source file imports `@epicenter/workspace/encryption-key`.
- [x] `packages/workspace/src/document/encryption-key.ts` is removed.
- [x] `@epicenter/auth` no longer depends on `@epicenter/workspace`.
- [x] `@epicenter/workspace` depends on `@epicenter/auth` and `@epicenter/encryption`.
- [x] `@epicenter/auth-svelte` overrides only `snapshot` and `[Symbol.dispose]`.
- [x] Browser app sync call sites pass `auth`.
- [x] Machine and script sync call sites pass `auth`.
- [x] Targeted tests and typechecks pass.

## Files To Inspect

```txt
packages/workspace/src/document/attach-sync.ts
packages/workspace/src/document/attach-sync.test.ts
packages/workspace/src/document/attach-encryption.ts
packages/workspace/src/shared/crypto/index.ts
packages/workspace/src/index.ts
packages/workspace/package.json
packages/auth/src/create-auth.ts
packages/auth/src/auth-types.ts
packages/auth/src/contracts/session.ts
packages/auth/src/node/machine-auth.ts
packages/auth/src/node/machine-credential-repository.ts
packages/auth/src/node/machine-credential-secret-storage.ts
packages/auth/src/node.ts
packages/auth/package.json
packages/auth-svelte/src/create-auth.svelte.ts
packages/auth-workspace/src/index.ts
packages/auth-workspace/src/index.test.ts
apps/fuji/src/lib/fuji/browser.ts
apps/honeycrisp/src/lib/honeycrisp/browser.ts
apps/opensidian/src/lib/opensidian/browser.ts
apps/tab-manager/src/lib/tab-manager/extension.ts
examples/notes-cross-peer/notes.ts
apps/*/src/lib/*/script.ts
apps/*/src/lib/*/integration.test.ts
apps/api/src/auth/encryption.ts
packages/workspace/README.md
packages/workspace/src/document/README.md
```

## Verification Commands

```sh
bun test packages/workspace/src/document/attach-sync.test.ts
bun test packages/auth-workspace/src/index.test.ts
bun test packages/auth/src/create-auth.test.ts
bun test packages/auth/src/node/machine-auth.test.ts
bun run --filter @epicenter/encryption typecheck
bun run --filter @epicenter/auth typecheck
bun run --filter @epicenter/auth-svelte typecheck
bun run --filter @epicenter/auth-workspace typecheck
bun run --filter @epicenter/workspace typecheck
```

Run app typechecks where practical after the package-level checks pass. If existing unrelated Svelte or UI diagnostics remain, report them separately with the first failing file and keep this migration scoped.

## Straggler Searches

```sh
rg -n "createAuthTokenSource|TokenSource|tokenSource|getToken:" apps packages examples docs specs -S
rg -n "@epicenter/workspace/encryption-key|document/encryption-key|EncryptionKeys" apps packages examples docs specs -S
rg -n "attachSync\\(" apps packages examples -S
```

The first command should return only historical specs after implementation. The second command may still find `EncryptionKeys`, but imports should point at `@epicenter/encryption`.
