# Bearer auth accepts session storage

**Date**: 2026-05-07
**Status**: Implemented
**Author**: AI-assisted (Codex)
**Backwards compatibility**: none. Hard rename from `initialSession` and `saveSession` to `sessionStorage`.

## One-sentence thesis

```txt
Bearer auth owns the live runtime session; callers only provide durable
session storage with `get()` and `set()`.
```

If a caller has to read storage before calling `createBearerAuth`, the boundary
is still leaking the boot protocol. If `createBearerAuth` accepts both the old
shape and the new shape, the clean break failed.

## Overview

Replace `createBearerAuth({ initialSession, saveSession })` with
`createBearerAuth({ sessionStorage })`. The new field accepts the same
structural shape returned by `createPersistedState`: a synchronous `get()` and a
`set(value)` sink. `createBearerAuth` reads storage once during construction,
then owns the in-memory bearer session and writes back when Better Auth
validates, rotates, or clears it.

The ideal browser call site becomes one expression:

```ts
export const auth = createBearerAuth({
	baseURL: APP_URLS.API,
	sessionStorage: createPersistedState({
		key: 'opensidian.auth.session',
		schema: BearerSession.or('null'),
		defaultValue: null,
	}),
});
```

## Motivation

### Current state

Bearer auth currently asks every caller to split durable storage into two
separate options:

```ts
const authSession = createPersistedState({
	key: 'opensidian.auth.session',
	schema: BearerSession.or('null'),
	defaultValue: null,
});

export const auth = createBearerAuth({
	baseURL: APP_URLS.API,
	initialSession: authSession.get(),
	saveSession: (next) => authSession.set(next),
});
```

This works, but the API makes the caller narrate internals:

```txt
durable storage
  -> caller reads initial value
  -> auth copies it into memory
  -> Better Auth verifies it against /get-session
  -> auth writes future changes back
```

The caller should not own that sequence. The caller owns a storage adapter. The
auth client owns when storage is read, what counts as live auth state, and when
new state is persisted.

This creates problems:

1. **The words imply two sources of truth**: `initialSession` and `saveSession`
   sound like peers, but one is a one-time boot seed and the other is a future
   persistence sink.
2. **The call site hides the actual boundary**: the real dependency is durable
   bearer-session storage, not two independent values.
3. **JSDoc has nowhere natural to explain the lifecycle**: the important note
   spans both fields, so readers can miss it unless they read both comments.
4. **`createPersistedState` already has the right shape**: callers have a
   `{ get, set }` object, then immediately unpack it into two options.

### Desired state

The caller passes durable session storage as one thing:

```ts
export const auth = createBearerAuth({
	baseURL: APP_URLS.API,
	sessionStorage: createPersistedState({
		key: 'opensidian.auth.session',
		schema: BearerSession.or('null'),
		defaultValue: null,
	}),
});
```

The config type says the lifecycle directly:

```ts
export type BearerSessionStorage = {
	/**
	 * Reads the durable bearer session once during auth client construction.
	 *
	 * This value seeds the in-memory bearer credential used by Better Auth's
	 * first /get-session request. Storage is not the live source of truth after
	 * construction.
	 */
	get(): BearerSession | null;

	/**
	 * Persists the current bearer session for the next boot.
	 *
	 * The auth client calls this when Better Auth validates, rotates, or clears
	 * the session. The auth client remains the live runtime owner.
	 */
	set(value: BearerSession | null): MaybePromise<void>;
};

export type CreateBearerAuthConfig = {
	/** Resolved once at construction; recreate the client if the origin changes. */
	baseURL?: string;
	sessionStorage: BearerSessionStorage;
};
```

## Research findings

### Better Auth bearer model

Better Auth's bearer docs describe a storage-backed transport:

```ts
createAuthClient({
	fetchOptions: {
		auth: {
			type: 'Bearer',
			token: () => localStorage.getItem('bearer_token') || '',
		},
		onSuccess: (ctx) => {
			const token = ctx.response.headers.get('set-auth-token');
			if (token) localStorage.setItem('bearer_token', token);
		},
	},
});
```

The installed bearer plugin confirms the server side: it converts
`Authorization: Bearer <token>` into the internal Better Auth session cookie,
then exposes the session token back through the `set-auth-token` response
header. See
`node_modules/better-auth/dist/plugins/bearer/index.mjs`.

Implication: bearer storage is a transport credential cache. The server remains
truth for whether the session is valid. Local storage is only the first
credential source and the next-boot cache.

### Better Auth live session fetch

Better Auth's client builds a `/get-session` query in
`node_modules/better-auth/dist/client/session-atom.mjs`. Its refresh manager
refetches on focus, broadcast, online events, and optional polling. Those
requests use the configured bearer token function.

```txt
sessionStorage.get()
  -> in-memory `session`
  -> Better Auth fetchOptions.auth.token()
  -> /auth/get-session
  -> Better Auth useSession emission
  -> Epicenter auth.state
```

Implication: the storage read is not competing with Better Auth. It feeds the
first authenticated `/get-session` call. After that, Better Auth's server session
emissions and `set-auth-token` headers drive the live client.

### `createPersistedState` already matches

`createPersistedState` returns:

```ts
{
	get(): T;
	set(value: T): void;
	watch(listener): () => void;
	get current(): T;
	set current(value: T);
}
```

The new `sessionStorage` contract only depends on `get` and `set`. It does not
couple auth to Svelte, runes, localStorage, or cross-tab syncing. It is just a
structural adapter.

Implication: browser apps can inline `createPersistedState(...)` directly.
Node-side storage can wrap keychain load results in the same shape if the read
has already happened.

## Design decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Bearer config shape | 2 coherence | `sessionStorage: { get, set }` | The caller owns durable storage. Auth owns when storage is read and written. |
| Old `initialSession` and `saveSession` options | 2 coherence | Delete, no compatibility alias | Supporting both preserves the ambiguous mental model. |
| Storage read timing | 1 evidence | Read once at construction | Better Auth needs a synchronous bearer token function for the first `/get-session`; current `createPersistedState.get()` is sync. |
| Runtime owner after construction | 2 coherence | Auth owns the in-memory session | `auth.bearerToken`, `auth.fetch`, Better Auth `fetchOptions.auth.token`, and token rotation all read the same closure. |
| `createPersistedState` integration | 3 taste | Inline it at app call sites | The call site becomes the product sentence: bearer auth with durable session storage. |
| Async storage reads | Deferred | Keep out of `createBearerAuth` | Machine auth already performs async loading before construction. This spec keeps the factory synchronous. |
| Rename `BearerSession` | Deferred | Keep name for this change | `StoredBearerSession` is more precise, but it is a larger naming migration and not required for the boundary fix. |

## Architecture

### Before

```txt
apps/opensidian auth.ts
  |-- createPersistedState(...)
  |-- authSession.get()
  |-- createBearerAuth({
  |     initialSession,
  |     saveSession,
  |   })
  `-- authSession.set(next)

packages/auth
  `-- copies initialSession into live in-memory session
```

The app participates in the auth boot sequence.

### After

```txt
apps/opensidian auth.ts
  `-- createBearerAuth({
        sessionStorage: createPersistedState(...),
      })

packages/auth
  |-- sessionStorage.get()
  |-- live in-memory session
  |-- Better Auth /get-session and set-auth-token handling
  `-- sessionStorage.set(next)
```

The app provides storage. Auth owns the auth lifecycle.

### Boot flow

```txt
STEP 1: Construct auth
----------------------
createBearerAuth calls sessionStorage.get() once and stores the value in its
private `session` variable.

STEP 2: Configure Better Auth
-----------------------------
Better Auth receives `fetchOptions.auth.token`, which reads the private
`session` closure.

STEP 3: Verify with server
--------------------------
Better Auth calls /auth/get-session. If the stored token is valid, the server
returns a session. If it is stale or absent, the server returns no session.

STEP 4: Apply live state
------------------------
Epicenter maps Better Auth session data to `auth.state`. If the session differs
from the private session, auth updates memory and calls sessionStorage.set().

STEP 5: Rotate token
--------------------
Any response with `set-auth-token` updates the private session token and writes
the rotated session to storage.
```

## API changes

### Core package

```diff
--- packages/auth/src/create-auth.ts
+++ packages/auth/src/create-auth.ts
@@
 export type CreateBearerAuthConfig = {
   /** Resolved once at construction; recreate the client if the origin changes. */
   baseURL?: string;
-  initialSession: BearerSession | null;
-  saveSession: (value: BearerSession | null) => MaybePromise<void>;
+  sessionStorage: BearerSessionStorage;
 };
+
+export type BearerSessionStorage = {
+  get(): BearerSession | null;
+  set(value: BearerSession | null): MaybePromise<void>;
+};
```

```diff
--- packages/auth/src/create-auth.ts
+++ packages/auth/src/create-auth.ts
@@
 export function createBearerAuth({
   baseURL,
-  initialSession,
-  saveSession,
+  sessionStorage,
 }: CreateBearerAuthConfig): AuthClient {
+  const initialSession = sessionStorage.get();
   let session: BearerSession | null = initialSession;
 
   function persistSession(next: BearerSession | null) {
-    void Promise.resolve(saveSession(next)).catch((error) => {
+    void Promise.resolve(sessionStorage.set(next)).catch((error) => {
       console.error('[auth] failed to save session:', error);
     });
   }
```

### Svelte wrapper

`@epicenter/auth-svelte` should re-export the new config type unchanged. The
wrapper does not need special storage logic.

```ts
export function createBearerAuth(config: CreateBearerAuthConfig): AuthClient {
	return createReactiveAuth(createCoreBearerAuth(config));
}
```

### Browser app call sites

```diff
--- apps/opensidian/src/lib/auth.ts
+++ apps/opensidian/src/lib/auth.ts
@@
-const authSession = createPersistedState({
-  key: 'opensidian.auth.session',
-  schema: BearerSession.or('null'),
-  defaultValue: null,
-});
-
 export const auth = createBearerAuth({
   baseURL: APP_URLS.API,
-  initialSession: authSession.get(),
-  saveSession: (next) => authSession.set(next),
+  sessionStorage: createPersistedState({
+    key: 'opensidian.auth.session',
+    schema: BearerSession.or('null'),
+    defaultValue: null,
+  }),
 });
```

Tab Manager should follow the same shape if its storage wrapper already exposes
`get()` and `set()`. If extension storage has an async readiness gate, keep that
gate outside `createBearerAuth`, then pass the ready storage object:

```ts
export const whenReady = authSessionStorage.whenReady.then(() => {
	authClient = createBearerAuth({
		baseURL: APP_URLS.API,
		sessionStorage: authSessionStorage,
	});
	workspaceSession = createWorkspaceSession(authClient);
});
```

### Node machine auth

Machine auth performs async storage before construction. Preserve that property
with a small synchronous adapter around the loaded value:

```ts
const loadedSession = initialSession;

return createBearerAuth({
	baseURL: EPICENTER_API_URL,
	sessionStorage: {
		get: () => loadedSession,
		set: (next) => saveMachineSession(next),
	},
});
```

If the implementation needs the adapter to reflect writes for later reads, use a
local mutable cell:

```ts
let storedSession = initialSession;

return createBearerAuth({
	baseURL: EPICENTER_API_URL,
	sessionStorage: {
		get: () => storedSession,
		set: async (next) => {
			storedSession = next;
			await saveMachineSession(next);
		},
	},
});
```

## Implementation plan

### Phase 1: Change the core contract

- [x] **1.1** Add `BearerSessionStorage` in `packages/auth/src/create-auth.ts`.
- [x] **1.2** Replace `initialSession` and `saveSession` with `sessionStorage` in `CreateBearerAuthConfig`.
- [x] **1.3** Make `createBearerAuth` call `sessionStorage.get()` once at construction.
- [x] **1.4** Make `persistSession()` call `sessionStorage.set(next)`.
- [x] **1.5** Export the new type from `packages/auth/src/index.ts` if needed.

> **Implementation note**: `BearerSessionStorage` is exported from `@epicenter/auth`. Its JSDoc names the one-time read and the in-memory runtime owner directly.

### Phase 2: Migrate all callers

- [x] **2.1** Inline `createPersistedState(...)` in `apps/opensidian/src/lib/auth.ts`.
- [x] **2.2** Update `apps/tab-manager/src/lib/session.svelte.ts` to pass `authSessionStorage` as `sessionStorage`.
- [x] **2.3** Update `packages/auth/src/node/machine-auth.ts` with a synchronous adapter around the loaded machine session.
- [x] **2.4** Update tests in `packages/auth/src/create-auth.test.ts` and `packages/auth/src/contract.test.ts`.
- [x] **2.5** Update any local test helpers named around `initialSession` only where the old name now confuses the setup.

> **Implementation note**: Machine auth keeps async keychain loading before construction, then wraps the loaded session in a mutable synchronous adapter so rotations update the adapter before persistence runs.

### Phase 3: Documentation and skill alignment

- [x] **3.1** Update `.agents/skills/auth/SKILL.md` so the factory example uses `sessionStorage`.
- [x] **3.2** Update auth package docs or READMEs that mention `initialSession` and `saveSession`.
- [x] **3.3** Add JSDoc to `BearerSessionStorage` explaining the one-time read and live in-memory ownership.
- [x] **3.4** Search for `initialSession` and `saveSession`; only node-internal local variables may remain if they describe a loaded value before adapter construction.

> **Implementation note**: There is no auth package README in the repository. The stale public documentation mention was in `.agents/skills/auth/SKILL.md`, and it now documents both persisted browser storage and async preloaded storage adapters.

### Phase 4: Verify

- [x] **4.1** Run `bun test packages/auth/src/create-auth.test.ts packages/auth/src/contract.test.ts`.
- [x] **4.2** Run the package typecheck command used by the monorepo for auth and auth-svelte.
- [x] **4.3** Run a repository search for `createBearerAuth({` and confirm every call site passes `sessionStorage`.
- [x] **4.4** Manually inspect Opensidian and Tab Manager auth call sites for the ideal inline shape.

> **Verification note**: Targeted auth tests pass with 22 tests. `packages/auth` typecheck, `packages/auth-svelte` typecheck, `apps/opensidian` check, and `apps/tab-manager` typecheck pass. `packages/auth-svelte` reports the existing warning that no Svelte input files are present in its `tsconfig`.

## Test plan

Core tests should prove these behaviors:

1. `sessionStorage.get()` is called exactly once during construction.
2. A non-null stored session drives the initial signed-in identity.
3. Better Auth signed-in emission updates identity and calls `sessionStorage.set(next)` when user data or encryption keys change.
4. Better Auth signed-out emission clears memory and calls `sessionStorage.set(null)`.
5. `set-auth-token` rotates the private session token and calls `sessionStorage.set(rotatedSession)`.
6. `auth.bearerToken` returns the rotated token after rotation.
7. `auth.fetch()` sends `Authorization: Bearer <current token>` and `credentials: 'omit'`.
8. A storage write rejection is caught and logged without breaking auth state.

Add one contract-level assertion for the new boundary:

```ts
const sessionStorage = {
	get: () => session(),
	set: () => {},
};

const auth = createBearerAuth({
	baseURL: 'http://localhost:8787',
	sessionStorage,
});
```

Do not add a test for compatibility with `initialSession` or `saveSession`.
Those fields should be gone.

## Edge cases

### Stored session is stale

1. `sessionStorage.get()` returns an old bearer session.
2. `auth.state` starts signed in from the stored identity.
3. Better Auth `/get-session` returns null.
4. Auth clears its private session, emits signed out, and writes `null` to storage.

This preserves the existing cold-boot behavior.

### Storage write fails

1. Better Auth rotates or clears the session.
2. `sessionStorage.set(next)` throws or rejects.
3. Auth logs `[auth] failed to save session:` and keeps the in-memory state.

The app should not sign the user out because local persistence failed.

### Cross-tab writes

`createPersistedState` can update itself on storage events and focus events, but
`createBearerAuth` only reads `sessionStorage.get()` once. That is intentional.
Auth owns the live runtime session after construction. Cross-tab sign-out or
identity changes should flow through Better Auth session broadcast and
`useSession`, not through re-reading storage behind the auth client's back.

### Async storage

`sessionStorage.get()` is synchronous by contract. Runtimes with async storage
must load before constructing auth and pass a synchronous adapter around the
loaded value. This keeps `createBearerAuth` synchronous and keeps Better Auth's
`auth.token()` callback synchronous.

## Migration notes

This is a clean break. Do not keep overloads like:

```ts
createBearerAuth({
	initialSession,
	saveSession,
});
```

Do not support:

```ts
createBearerAuth({
	sessionStorage,
	initialSession,
	saveSession,
});
```

The new API has one construction sentence:

```txt
Create bearer auth with durable session storage.
```

Compatibility aliases would make every future reader ask which source wins.
There should be no source-selection rule because there should only be one
source-shaped option.

## Open questions

### Should `BearerSession` become `StoredBearerSession`?

Probably, but not in this spec. The new `sessionStorage` field removes the
largest ambiguity without forcing a type rename across the auth package,
machine auth, app storage, and tests. A follow-up rename would be coherent:

```txt
BearerSessionStorage.get(): StoredBearerSession | null
```

### Should cookie auth also accept `identityStorage`?

Maybe later. Cookie auth's `initialIdentity` is mostly flash prevention because
the browser cookie jar is the real credential source. Bearer auth's storage is
both flash prevention and the first credential source. The asymmetry is real, so
this spec should not force cookie auth into the same shape just for symmetry.

### Should storage expose `watch()`?

No for this change. `createPersistedState` has `watch()`, but auth should not
follow durable storage changes after construction. Better Auth session refresh
is the live server-backed path. Reading storage reactively would create a second
runtime source of truth.

## Success criteria

- Every `createBearerAuth` call site passes `sessionStorage`.
- `apps/opensidian/src/lib/auth.ts` has the inline shape shown in this spec.
- The public config names no longer expose `initialSession` or `saveSession`.
- Tests prove storage is read once and written on validation, rotation, and clear.
- Auth docs describe storage as the durable boot cache, not the live source of truth.

## Review

**Completed**: 2026-05-07
**Branch**: `codex/bearer-auth-session-storage`

### Files read

```txt
.agents/
`-- skills/
    `-- auth/
        `-- SKILL.md
apps/
|-- opensidian/
|   `-- src/lib/auth.ts
`-- tab-manager/
    `-- src/lib/session.svelte.ts
packages/
`-- auth/
    `-- src/
        |-- contract.test.ts
        |-- create-auth.test.ts
        |-- create-auth.ts
        |-- index.ts
        `-- node/machine-auth.ts
specs/
`-- 20260507T150000-bearer-auth-session-storage-adapter.md
```

### Summary

`createBearerAuth` now accepts one durable storage adapter, reads it once during construction, and persists through the same adapter when Better Auth validates, clears, or rotates the bearer session. App and machine call sites now pass `sessionStorage`, with Opensidian using the inline `createPersistedState(...)` shape.

Tests cover the new storage boundary, including one-time reads, validation writes, clear writes, token rotation writes, rotated `bearerToken`, fetch credentials, rejected storage writes, and compile-time rejection of the old config shape.

### Deviations from spec

- The machine auth adapter returns an async `set()` that updates the local session cell before awaiting keychain persistence. This preserves the spec's mutable-cell option and keeps unexpected persistence rejections visible to the core auth persistence catch.
- There was no auth package README to update. The stale public guidance lived in `.agents/skills/auth/SKILL.md`, so that is the relevant documentation update.

### Verification

- `bun test packages/auth/src/create-auth.test.ts packages/auth/src/contract.test.ts`: 22 pass.
- `bun run typecheck` in `packages/auth`: pass.
- `bun run typecheck` in `packages/auth-svelte`: pass with the existing no-Svelte-input warning.
- `bun run check` in `apps/opensidian`: pass.
- `bun run typecheck` in `apps/tab-manager`: pass.
- `rg -n "createBearerAuth\\(\\{" packages apps`: every factory call site passes `sessionStorage`.
- `rg -n "initialSession|saveSession" packages apps .agents/skills/auth docs`: only the negative compile-time test mentions the old names outside this spec.
- Unicode dash search on touched files: no em dashes or en dashes found.

### Follow-up work

- Consider a separate rename from `BearerSession` to `StoredBearerSession` if the storage-focused name would make future API reads clearer.
