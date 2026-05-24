# Auth Snapshot API

**Date**: 2026-05-01
**Status**: Partially Implemented
**Author**: AI-assisted

> Superseded note, 2026-05-01: the follow-up clean-break spec
> `20260501T145113-workspace-auth-lifecycle-api-clean-break.md` replaces the
> public listener and load-barrier names from this implementation record.
> The current API is `auth.snapshot`, `auth.whenLoaded`, and
> `auth.onSnapshotChange(next)`. Historical references below to
> `whenSessionLoaded`, `subscribe`, and previous-snapshot replay describe the
> earlier intermediate design, not the live API.

## One Sentence

Auth exposes one synchronous snapshot that tells callers whether the local session is loading, signed out, or signed in, plus one narrow promise that resolves when persisted session storage has been loaded.

## Overview

Replace the current auth read surface with a single idiomatic read path: `auth.snapshot`. The snapshot is a synchronous readonly getter holding a three-state discriminated union: `loading | signedOut | signedIn`. Callers stop mixing `getToken()`, `getSession()`, `auth.user`, `auth.isAuthenticated`, and `auth.isBusy`.

The only async readiness surface is `auth.whenSessionLoaded`. It resolves when persisted auth storage has loaded and `auth.snapshot.status` is no longer `loading`. It does not mean the server verified the token, Better Auth refreshed the session, sync connected, or the UI finished rendering. It never rejects; storage load failures are normalized to `signedOut` after the adapter reports the error.

In-flight auth command state (sign-in, sign-up, sign-out spinners) lives on the call sites that initiate those commands, not on the public auth surface. See [Why Operation State Is Not Public](#why-operation-state-is-not-public).

Naming aligns with the CLI credential-store spec:

| Noun | Meaning |
| --- | --- |
| `Session` | Shared Better Auth-shaped data: user, Better Auth session, and Epicenter encryption keys. |
| `AuthClient` | Browser and extension holder with an in-memory `snapshot`, `subscribe`, and auth commands. |
| `SessionStorage` | Browser persistence boundary used to hydrate and save one local session. |
| `CredentialStore` | Node holder from `@epicenter/auth/node`, not used by UI code. |

The shared noun is `Session`, but the holders stay different. Browser code needs reactive, synchronous reads; CLI code needs async persistence for credentials keyed by server origin.

## Motivation

### Current State

Core auth currently exposes several sync read methods:

```ts
export type AuthClient = {
	getToken(): string | null;
	getSession(): Session | null;
	getUser(): StoredUser | null;
	isAuthenticated(): boolean;
	isBusy(): boolean;

	onSessionChange(
		fn: (next: Session | null, previous: Session | null) => void,
	): () => void;
	onTokenChange(fn: (token: string | null) => void): () => void;
	onLogin(fn: (session: Session) => void): () => void;
	onLogout(fn: () => void): () => void;
	onBusyChange(fn: (busy: boolean) => void): () => void;
};
```

The legacy session persistence contract is synchronous:

```ts
export type LegacySessionPersistence = {
	get(): Session | null;
	set(value: Session | null): void;
};
```

Svelte projects those separate reads into separate reactive getters:

```ts
let token = $state(core.getToken());
let session = $state(core.getSession());
let busy = $state(core.isBusy());

core.onTokenChange((next) => {
	token = next;
});
core.onSessionChange((next) => {
	session = next;
});
core.onBusyChange((next) => {
	busy = next;
});
```

Apps then consume projections:

```svelte
{#if auth.isAuthenticated}
	<span>{auth.user?.name}</span>
{:else if !auth.isAuthenticated}
	<AuthForm {auth} />
{/if}
```

Workspace sync adapts a sync token read into an async callback:

```ts
const sync = attachSync(doc, {
	url: websocketUrl(`${APP_URLS.API}/workspaces/${doc.ydoc.guid}`),
	waitFor: idb,
	getToken: async () => legacyTokenGetter(),
});
```

The Chrome extension has an explicit boot ordering requirement:

```ts
await session.whenReady;

export const auth = createAuthClient({
	baseURL: APP_URLS.API,
	session,
});
```

This creates problems:

1. **`null` has two meanings**: before async storage loads, `null` can mean either "signed out" or "not loaded yet." That can produce sign-in flicker and unauthenticated sync attempts.
2. **The read API is redundant**: token, session, user, authenticated state, and busy state are projections of one auth state, but callers read them through different surfaces.
3. **Operation state is mixed into identity state**: `isBusy()` is not part of being signed in or signed out. It is an overlay for in-flight auth commands.
4. **Boot order is hidden outside auth**: async stores require callers to remember `await session.whenReady` before `createAuthClient()`.
5. **Transport code has fake async reads**: the legacy token getter satisfies `attachSync`, but it does not wait for storage hydration.

### Desired State

Every auth read goes through one value:

```ts
const snapshot = auth.snapshot;

if (snapshot.status === 'signedIn') {
	const token = snapshot.session.token;
	const user = snapshot.session.user;
}
```

Async transport boundaries wait for the narrow storage barrier, then read the same snapshot:

```ts
getToken: async () => {
	await auth.whenSessionLoaded;

	const snapshot = auth.snapshot;
	return snapshot.status === 'signedIn' ? snapshot.session.token : null;
};
```

In-flight UX (button spinners, "Signing in..." labels) is handled with local component state at the call site that issued the command:

```svelte
<script>
	let busy = $state(false);
	const submit = async () => {
		busy = true;
		try {
			await auth.signIn({ email, password });
		} finally {
			busy = false;
		}
	};
</script>
```

## Target API

### Public Types

```ts
export type AuthSnapshot =
	| { status: 'loading' }
	| { status: 'signedOut' }
	| { status: 'signedIn'; session: Session };

export type AuthSnapshotSubscriber = (
	next: AuthSnapshot,
	previous: AuthSnapshot,
) => void;

export type AuthClient = {
	readonly snapshot: AuthSnapshot;
	readonly whenSessionLoaded: Promise<void>;

	subscribe(fn: AuthSnapshotSubscriber): () => void;

	signIn(input: {
		email: string;
		password: string;
	}): Promise<Result<undefined, AuthError>>;
	signUp(input: {
		email: string;
		password: string;
		name: string;
	}): Promise<Result<undefined, AuthError>>;
	signInWithSocialPopup(): Promise<Result<undefined, AuthError>>;
	signInWithSocialRedirect(input: {
		provider: string;
		callbackURL: string;
	}): Promise<Result<undefined, AuthError>>;
	signOut(): Promise<Result<undefined, AuthError>>;
	fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;

	[Symbol.dispose](): void;
};
```

The snapshot is one discriminated union with three variants. There is no parallel `operation` axis. See [Why Operation State Is Not Public](#why-operation-state-is-not-public) for the reasoning.

### Subscribe Semantics

`auth.subscribe(fn)` is the only public subscription primitive.

Rules:

1. It replays synchronously when called.
2. If the current snapshot is `loading`, replay with `(loading, loading)`.
3. If the current snapshot is `signedOut` or `signedIn`, replay with `(current, { status: 'loading' })`.
4. Future calls receive the real `(next, previous)` pair from `setSnapshot(next)`.
5. One subscriber throwing must not stop other subscribers.

The synthetic replay previous value is intentional. It preserves the useful part of today's `onSessionChange(fn)` replay: cold-boot signed-in sessions re-apply encryption keys and can reconnect sync. It does not make signed-out replay look like logout, because logout cleanup only runs when the previous snapshot was `signedIn`.

```ts
auth.subscribe((next, previous) => {
	if (next.status === 'loading') return;

	const previousSession =
		previous.status === 'signedIn' ? previous.session : null;

	if (next.status === 'signedOut') {
		if (previousSession !== null) {
			void workspace.idb
				.clearLocal()
				.then(afterSignedOutCleanup)
				.catch(onSignedOutCleanupError);
		}
		return;
	}

	applyKeys(next.session.encryptionKeys);
});
```

### Removed Public Reads

Remove these from the public core and Svelte client:

```ts
auth.getToken()
auth.getSession()
auth.getUser()
auth.isAuthenticated()
auth.isBusy()
auth.token
auth.session
auth.user
auth.isAuthenticated
auth.isBusy
auth.onSessionChange()
auth.onTokenChange()
auth.onLogin()
auth.onLogout()
auth.onBusyChange()
```

The replacement is always `auth.snapshot` plus `auth.subscribe()`.

### Why `auth.snapshot` Is A Getter

Use a property getter:

```ts
return {
	get snapshot() {
		return snapshot;
	},
	whenSessionLoaded,
	subscribe,
	signIn,
	signUp,
	signInWithSocialPopup,
	signInWithSocialRedirect,
	signOut,
	fetch,
};
```

This is intentionally not `getSnapshot()` and not `snapshot()`.

| Option | Choice | Rationale |
| --- | --- | --- |
| `auth.snapshot` | Chosen | Auth state is state. The getter is cheap, sync, and side-effect-free. It keeps the idiom short in Svelte and plain TypeScript. |
| `auth.getSnapshot()` | Rejected | Defensible for generic external stores, but it makes auth look like a command surface again. |
| `auth.snapshot()` | Rejected | Reads oddly, is less grep-friendly, and blurs whether a new snapshot is being created. |

The getter must never touch storage or network. It returns the current in-memory value only.

### Why The Read Is Synchronous

The snapshot read must be synchronous because these call sites need a current value immediately:

1. Better Auth fetch token injection.
2. Svelte initial state.
3. Subscription replay.
4. UI conditionals.
5. Workspace transition handlers.

Async storage is real, but async storage belongs at the hydration boundary. After hydration, auth owns an in-memory snapshot.

## Session Storage Contract

Rename the storage boundary to make ownership clearer:

```ts
export type MaybePromise<T> = T | Promise<T>;

export type SessionStorage = {
	load(): MaybePromise<Session | null>;
	save(value: Session | null): MaybePromise<void>;
};
```

`SessionStorage` is not the source of truth for current auth state. It is the persistence boundary. `createAuthClient()` owns the in-memory `AuthSnapshot`.

Invariants:

1. `load()` returns the persisted session or `null`.
2. If `load()` returns synchronously, `createAuthClient()` can leave `loading` before returning.
3. If `load()` returns a promise, `createAuthClient()` starts in `loading` and resolves `whenSessionLoaded` after applying the loaded value.
4. `whenSessionLoaded` never rejects. If `load()` throws or rejects, the adapter reports the error through its existing error hook or logger, auth treats the loaded value as `null`, and the snapshot becomes `signedOut`.
5. `save()` persists the session but does not drive the local snapshot. Auth updates its in-memory snapshot before it calls `save()`.
6. Live auth state flows through Better Auth session emissions and auth snapshot listeners, not through storage callbacks.
7. Snapshot equality is structural for auth purposes: same status, same token, same user fields, same encryption keys. Do not rely on object identity.

The existing generic storage helpers can either grow `load()` and `save()` aliases or be wrapped by small adapters:

```ts
function persistedStateSessionStorage(
	state: {
		get(): Session | null;
		set(value: Session | null): void | Promise<void>;
	},
): SessionStorage {
	return {
		load: () => state.get(),
		save: (value) => state.set(value),
	};
}
```

Chrome storage should not require callers to await before auth construction:

```ts
function chromeSessionStorage(
	state: {
		whenReady: Promise<unknown>;
		get(): Session | null;
		set(value: Session | null): Promise<void>;
	},
): SessionStorage {
	return {
		async load() {
			await state.whenReady;
			return state.get();
		},
		save: (value) => state.set(value),
	};
}
```

## State Model

The snapshot is one axis. Three states. Token rotation and Better Auth refetches all settle inside `signedIn` without producing a new status.

```txt
                 load null
loading ----------------------------> signedOut
   |
   | load session
   v
signedIn -- token rotation --------> signedIn
   |
   | signOut, external clear, or server revoke
   v
signedOut -- signIn success -------> signedIn
```

Rules:

1. `loading` means persisted session storage has not finished loading.
2. `signedOut` means storage loaded and there is no current local session.
3. `signedIn` means storage loaded and auth has a local session.
4. Token rotation stays in `signedIn` and replaces only `session.token`.
5. Better Auth session updates may update `user` and `encryptionKeys`, but must not overwrite a newer rotated token.
6. Better Auth emissions during `loading` do not move the snapshot directly. Store the latest non-pending Better Auth state internally, then reconcile it after persisted storage has loaded.
7. Response-header token rotation applies only when the current snapshot is `signedIn`. A rotation observed while `loading` is ignored until storage load establishes a session; after that, the next authenticated response can rotate the loaded token normally.

### Why Operation State Is Not Public

An earlier draft of this spec had a parallel `operation: idle | signingIn | signingUp | signingOut` axis on every snapshot, mirroring today's `auth.isBusy`. We dropped it.

#### The one-sentence test

> Auth snapshot answers whether local persisted auth has loaded, and which session is currently usable.

That sentence does not include "which auth form button is waiting on a promise." Anything that doesn't fit the sentence does not belong on the snapshot. `operation` is a UI workflow concern, not an identity concern.

#### Commands are not states

The snapshot is a graph of identity transitions:

```txt
loading -> signedIn / signedOut
signedIn <-> signedOut
signedIn -- token rotation --> signedIn
```

Auth commands sit outside that graph. They are *attempts to cause a future snapshot transition*:

```txt
signIn() promise
  |
  +--> pending state belongs to the caller
  |
  +--> Better Auth session state later moves the snapshot to signedIn

signOut() promise
  |
  +--> pending state belongs to the caller
  |
  +--> Better Auth session state later moves the snapshot to signedOut
```

Conflating the two means the snapshot starts answering two unrelated questions. The state graph stays clean by keeping commands on a separate plane.

#### No remote readers anyway

Today's `auth.isBusy` is read in exactly four places, and every read is in the same component that issued the command:

| Call site | What busy does | Initiator |
| --- | --- | --- |
| `auth-form.svelte` | disables submit + Google buttons, swaps button label | same form calls `signIn` / `signUp` |
| `account-popover.svelte` | spins trigger icon during sign-out | same component calls `signOut` then reloads |
| `zhongwen/+page.svelte` | shows full-page "Signing in..." | dead branch: only call is `signInWithSocialRedirect`, intentionally not wrapped in `runBusy` |

Cross-component publish gives nothing a local flag can't. The migration is one of two patterns at the call site.

Plain Svelte:

```svelte
<script>
	let busy = $state(false);
	const submit = async () => {
		busy = true;
		try {
			await auth.signIn({ email, password });
		} finally {
			busy = false;
		}
	};
</script>

<Button disabled={busy} onclick={submit}>
	{#if busy}Signing in...{:else}Sign in{/if}
</Button>
```

TanStack Query mutation (which this codebase uses heavily through `createMutation`):

```ts
const signIn = createMutation({ mutationFn: auth.signIn });
```

```svelte
<Button disabled={signIn.isPending} onclick={() => signIn.mutate({ email, password })}>
	{#if signIn.isPending}Signing in...{:else}Sign in{/if}
</Button>
```

Either way, the pending state is scoped to the workflow that owns the UX. That is where it belongs.

#### Why not a single flat union (Option B)

A tempting alternative is to merge the two axes into one flat union:

```ts
type AuthSnapshot =
	| { status: 'loading' }
	| { status: 'signedOut' }
	| { status: 'signingIn' }
	| { status: 'signingUp' }
	| { status: 'signedIn';   session: Session }
	| { status: 'signingOut'; session: Session };
```

Rejected. `signingOut` is still signed in enough to have a session, encryption keys, and an active sync token. Every caller that asks "do we have a session?" now has to remember `status === 'signedIn' || status === 'signingOut'`. Same for `signingIn` muddying signed-out checks. Option B trades a parallel axis for an identity check that has to enumerate workflow states. That is worse, not better.

#### Internal serialization stays private

There is one separate concern: should two overlapping auth commands serialize, queue, or reject? Today's core uses an in-flight counter (`busyCount`) that allows overlap. The earlier draft implied moving to `AuthError.AuthBusy` rejection. That is now an internal, private decision; the recommendation is to keep the existing counter behavior unchanged. If a stricter policy is wanted later, it can be implemented privately without touching the public surface.

## Architecture

### Current Shape

```txt
AuthClient
  |
  | reads and writes
  v
SessionStorage { load, save }
  |
  +--> getToken()
  +--> getSession()
  +--> getUser()
  +--> isAuthenticated()
  +--> isBusy()
  +--> onSessionChange()
  +--> onTokenChange()
  +--> onBusyChange()

Svelte wrapper mirrors separate fields:
  token, session, busy, user, isAuthenticated
```

### Target Shape

```txt
AuthClient
  |
  | owns
  v
AuthSnapshot
  |
  +--> status: loading | signedOut | signedIn
  +--> session: Session only when signedIn

SessionStorage
  |
  +--> load persisted session
  +--> save durable session

Svelte wrapper mirrors one field:
  snapshot
```

### Startup Flow

For synchronous localStorage:

```txt
createAuthClient()
  |
  | sessionStorage.load() returns Session | null
  v
snapshot = signedIn or signedOut
whenSessionLoaded = resolved promise
```

For async chrome.storage:

```txt
createAuthClient()
  |
  v
snapshot = loading
  |
  | await sessionStorage.load()
  v
snapshot = signedIn or signedOut
whenSessionLoaded resolves
```

### Better Auth Flow

```txt
Better Auth fetch token callback
  |
  | reads internal snapshot synchronously
  v
if snapshot.status === 'signedIn'
  use snapshot.session.token
else
  no bearer token
```

`useSession.subscribe` must not turn `loading` into `signedOut`. Persisted storage hydration owns the initial transition out of `loading`.

```txt
loading
  |
  | buffer Better Auth data while storage is loading
  v
signedIn or signedOut after sessionStorage.load()
  |
  | Better Auth updates after load
  v
signedIn or signedOut
```

During `loading`, Better Auth is advisory only:

| Better Auth state while loading | Auth behavior |
| --- | --- |
| `isPending` | Ignore. |
| `data === null` | Remember it if useful for diagnostics, but do not publish `signedOut`. |
| `data !== null` | Store it as the latest Better Auth candidate, but do not publish `signedIn`. |

After persisted storage loads, reconcile in this order:

1. Apply the persisted session or `null` as the first non-loading snapshot.
2. If Better Auth has a non-null candidate, merge `user` and `encryptionKeys` from that candidate.
3. Preserve the persisted token if there is already a signed-in session. Use the Better Auth token only when the persisted value is `null` and Better Auth is establishing the first session.
4. If Better Auth has a null candidate and persisted storage loaded a session, do not immediately clear the session during the same tick. Let the next post-load Better Auth emission or explicit sign-out settle that state, so a startup race cannot erase a valid persisted session.

## Internal Write Ownership

Keep the existing field-level ownership:

| Writer | Fields owned | Notes |
| --- | --- | --- |
| Persisted load | initial whole session | Moves `loading` to `signedIn` or `signedOut`. |
| Better Auth `onSuccess` | `session.token` only | Applies `set-auth-token` response header immediately. |
| Better Auth `useSession.subscribe` | `user`, `encryptionKeys`, initial token | Preserve current token when already signed in. |
| `signOut()` local completion | no direct final state if BA subscription clears | Prefer BA/store updates as source, but ensure local token is cleared promptly if BA does not. |
| Auth commands | nothing on the snapshot | Settled session state flows from the BA subscription. Commands return their own `Result`. |

Only one helper mutates the in-memory snapshot:

```ts
function setSnapshot(next: AuthSnapshot) {
	if (snapshotsEqual(snapshot, next)) return;
	const previous = snapshot;
	snapshot = next;
	for (const subscriber of subscribers) {
		safeRun(() => subscriber(next, previous));
	}
}
```

Local auth writes use this order:

```txt
setSnapshot(next)
  |
  v
sessionStorage.save(sessionFromSnapshot(next))
  |
  v
durable boot cache is updated
```

External storage writes use the same `setSnapshot()` path after converting `Session | null` into `signedIn | signedOut`.

Important invariant: a rotated token must not be overwritten by a stale Better Auth session refetch.

```ts
const current = sessionFromSnapshot(snapshot);

session = {
	token: current?.token ?? state.data.session.token,
	user: normalizeUser(state.data.user),
	encryptionKeys: state.data.encryptionKeys,
};
```

## Concrete Call-Site Changes

### Auth Construction

Current:

```ts
const session = createPersistedState({
	key: 'fuji.auth.session',
	schema: Session.or('null'),
	defaultValue: null,
});

export const auth = createAuthClient({
	baseURL: APP_URLS.API,
	session,
});
```

Target:

```ts
const session = createPersistedState({
	key: 'fuji.auth.session',
	schema: Session.or('null'),
	defaultValue: null,
});

export const auth = createAuthClient({
	baseURL: APP_URLS.API,
	sessionStorage: persistedStateSessionStorage(session),
});
```

For tab-manager, remove the top-level await:

```ts
const session = createStorageState('local:auth.session', {
	fallback: null,
	schema: Session.or('null'),
});

export const auth = createAuthClient({
	baseURL: APP_URLS.API,
	sessionStorage: chromeSessionStorage(session),
	socialTokenProvider,
});
```

### Workspace Session Wiring

Current:

```ts
auth.onSessionChange((next, previous) => {
	if (next === null) {
		fuji.sync.goOffline();
		if (previous !== null) void fuji.idb.clearLocal();
		return;
	}
	fuji.encryption.applyKeys(next.encryptionKeys);
	if (previous?.token !== next.token) fuji.sync.reconnect();
});
```

Target:

```ts
auth.subscribe((next, previous) => {
	if (next.status === 'loading') return;

	const previousSession =
		previous.status === 'signedIn' ? previous.session : null;

	if (next.status === 'signedOut') {
		fuji.sync.goOffline();
		if (previousSession !== null) void fuji.idb.clearLocal();
		return;
	}

	fuji.encryption.applyKeys(next.session.encryptionKeys);
	if (previousSession?.token !== next.session.token) fuji.sync.reconnect();
});
```

This same pattern applies to:

| File | Current use |
| --- | --- |
| `apps/fuji/src/lib/fuji/client.ts` | `auth.onSessionChange` |
| `apps/honeycrisp/src/lib/honeycrisp/client.ts` | `auth.onSessionChange` |
| `apps/opensidian/src/lib/opensidian/client.ts` | `auth.onSessionChange` |
| `apps/zhongwen/src/lib/zhongwen/client.ts` | `auth.onSessionChange` |
| `apps/tab-manager/src/lib/tab-manager/client.ts` | `auth.onSessionChange` plus `await session.whenReady` |

### Sync Token Callback

Current:

```ts
getToken: async () => legacyTokenGetter(),
```

Target:

```ts
getToken: async () => {
	await auth.whenSessionLoaded;

	const snapshot = auth.snapshot;
	return snapshot.status === 'signedIn' ? snapshot.session.token : null;
},
```

`auth.fetch()` should use the same readiness rule when a request needs the local bearer token:

```ts
async fetch(input, init) {
	await whenSessionLoaded;

	const headers = new Headers(init?.headers);
	const current = snapshot;
	if (current.status === 'signedIn') {
		headers.set('Authorization', `Bearer ${current.session.token}`);
	}
	return fetch(input, { ...init, headers, credentials: 'include' });
}
```

This avoids dashboard and billing requests racing ahead with no bearer token while async storage is still loading. If a future caller wants an intentionally anonymous request, it should use platform `fetch` directly instead of `auth.fetch`.

Affected files:

| File | Current use |
| --- | --- |
| `apps/fuji/src/lib/fuji/browser.ts` | workspace sync token |
| `apps/fuji/src/lib/entry-content-docs.ts` | per-entry content doc token |
| `apps/honeycrisp/src/lib/honeycrisp/browser.ts` | workspace sync token |
| `apps/honeycrisp/src/lib/note-body-docs.ts` | per-note body doc token |
| `apps/opensidian/src/lib/opensidian/browser.ts` | workspace sync token |
| `apps/tab-manager/src/lib/tab-manager/extension.ts` | workspace sync token |

Script and daemon code already accepts `getToken: () => Promise<string | null>` and can remain as a lower-level token provider unless it imports `AuthClient`.

### UI Reads

Current:

```svelte
{#if auth.isAuthenticated}
	<p>{auth.user?.name}</p>
{:else if !auth.isAuthenticated}
	<AuthForm {auth} />
{/if}
```

Target:

```svelte
{@const snapshot = auth.snapshot}

{#if snapshot.status === 'loading'}
	<!-- keep existing layout stable or render nothing if current UI has no loader -->
{:else if snapshot.status === 'signedIn'}
	<p>{snapshot.session.user.name}</p>
{:else}
	<AuthForm {auth} />
{/if}
```

Current:

```svelte
<Button disabled={auth.isBusy}>
	{#if auth.isBusy}
		Signing in...
	{:else}
		Sign in
	{/if}
</Button>
```

Target (local state at the call site):

```svelte
<script>
	let busy = $state(false);
	const submit = async () => {
		busy = true;
		try {
			await auth.signIn({ email, password });
		} finally {
			busy = false;
		}
	};
</script>

<Button disabled={busy} onclick={submit}>
	{#if busy}Signing in...{:else}Sign in{/if}
</Button>
```

If a single component issues two competing commands (like the auth form's email submit and Google button), one shared `busy` flag covers both.

Affected files:

| File | Current use | Migration |
| --- | --- | --- |
| `packages/svelte-utils/src/auth-form/auth-form.svelte` | `auth.isBusy` (covers both submit and Google) | one local `busy` flag wrapping both handlers |
| `packages/svelte-utils/src/account-popover/account-popover.svelte` | `auth.isBusy`, `auth.isAuthenticated`, `auth.user` | local `signingOut` flag in `handleSignOut`; snapshot for identity |
| `apps/zhongwen/src/routes/+page.svelte` | `auth.isAuthenticated`, `auth.user`, `auth.isBusy` | the `auth.isBusy` branch is dead today (only `signInWithSocialRedirect` is called, and it is intentionally not wrapped in `runBusy`); delete the branch |
| `apps/dashboard/src/routes/+layout.svelte` | `auth.isAuthenticated` | snapshot |
| `apps/dashboard/src/lib/components/UserMenu.svelte` | `auth.user` | snapshot |
| `apps/tab-manager/src/lib/components/AiDrawer.svelte` | `auth.isAuthenticated` | snapshot |
| `apps/opensidian/src/lib/components/AppShell.svelte` | `auth.isAuthenticated` | snapshot |

### Type References

Current:

```ts
auth: Pick<AuthClient, 'getToken'>;
```

Target:

```ts
auth: Pick<AuthClient, 'snapshot' | 'whenSessionLoaded'>;
```

Or define a local capability type:

```ts
type AuthTokenSource = Pick<AuthClient, 'snapshot' | 'whenSessionLoaded'>;
```

Affected files:

| File | Current use |
| --- | --- |
| `apps/fuji/src/lib/entry-content-docs.ts` | `Pick<AuthClient, 'getToken'>` |
| `apps/honeycrisp/src/lib/note-body-docs.ts` | `Pick<AuthClient, 'getToken'>` |

### Docs

Update examples that mention old projections:

| File | Current use |
| --- | --- |
| `docs/guides/consuming-epicenter-api.md` | `getToken: async () => auth.token`, old `onLogin` and `onLogout` example |
| `packages/workspace/src/document/README.md` | `getToken: async () => auth.token` |
| `apps/fuji/README.md` | older auth session wording |
| `.agents/skills/auth/SKILL.md` | package guidance must match the new API |

## Implementation Plan

### Phase 1: Types And Core State Machine

- [x] **1.1** Add `AuthSnapshot` and `AuthSnapshotSubscriber` types.
- [x] **1.2** Replace the legacy store name with `SessionStorage` and keep the clean break.
- [x] **1.3** Change `CreateAuthClientConfig` from `session` to `sessionStorage`.
- [x] **1.4** Rewrite `AuthClient` to expose only `snapshot`, `whenSessionLoaded`, `subscribe`, auth commands, `fetch`, and dispose.
- [x] **1.5** Remove the dead in-flight counter. No public `operation` field, no `AuthError.AuthBusy`. Overlapping commands continue to interleave the way they do today.
- [x] **1.6** Implement `setSnapshot(next)` with safe subscriber fan-out and synchronous replay in `subscribe`.
- [x] **1.7** Implement storage hydration so sync stores can leave `loading` before `createAuthClient()` returns and async stores start in `loading`.
- [x] **1.8** Gate Better Auth session subscription effects so Better Auth cannot turn `loading` into `signedOut` or `signedIn` before persisted storage loads.
- [x] **1.9** Keep token rotation ownership from `set-auth-token` headers and preserve rotated tokens across Better Auth session refetches.
- [x] **1.10** Update `auth.fetch` to wait for `whenSessionLoaded` before reading the snapshot token.

### Phase 2: Svelte Wrapper

- [x] **2.1** Replace the Svelte wrapper with a single reactive `snapshot` state.
- [x] **2.2** Do not spread `base` blindly if `base.snapshot` is a getter. Object spread invokes getters and would copy the initial snapshot value.
- [x] **2.3** Return a live `snapshot` getter from the Svelte client.
- [x] **2.4** Remove derived Svelte getters: `token`, `session`, `user`, `isAuthenticated`, and `isBusy`. Components that previously read `auth.isBusy` add a local `let busy = $state(false)` flag in Phase 4.

Target wrapper shape:

```ts
	import {
		createAuth as createBaseAuthClient,
		type AuthClient,
	} from '@epicenter/auth';

	export function createAuth(config: CreateAuthConfig): AuthClient {
		const base = createBaseAuthClient(config);
	let snapshot = $state(base.snapshot);

	const unsubscribe = base.subscribe((next) => {
		snapshot = next;
	});

	return {
		get snapshot() {
			return snapshot;
		},
		get whenSessionLoaded() {
			return base.whenSessionLoaded;
		},
		subscribe: base.subscribe,
		signIn: base.signIn,
		signUp: base.signUp,
		signInWithSocialPopup: base.signInWithSocialPopup,
		signInWithSocialRedirect: base.signInWithSocialRedirect,
		signOut: base.signOut,
		fetch: base.fetch,
		[Symbol.dispose]() {
			unsubscribe();
			base[Symbol.dispose]();
		},
	};
}
```

### Phase 3: Storage Adapters

- [x] **3.1** Add `createSessionStorageAdapter` so generic state helpers do not grow auth-specific methods.
- [x] **3.2** Update web apps to pass `sessionStorage`.
- [x] **3.3** Update tab-manager to remove `await session.whenReady` before `createAuthClient()`.
- [x] **3.4** Confirm chrome.storage startup leaves `auth.snapshot.status === 'loading'` until storage has loaded.

### Phase 4: App Call Sites

- [x] **4.1** Replace all `auth.onSessionChange` handlers with `auth.subscribe` snapshot handlers.
- [x] **4.2** Replace all legacy auth token getter uses with `auth.whenSessionLoaded` plus `auth.snapshot`.
- [x] **4.3** Replace all UI reads of `auth.user`, `auth.session`, `auth.token`, and `auth.isAuthenticated` with `auth.snapshot`. For `auth.isBusy`, add a local `let busy = $state(false)` flag wrapping the `await` in the issuing component (and delete the dead branch in `apps/zhongwen/src/routes/+page.svelte`).
- [x] **4.4** Update type capability picks from `Pick<AuthClient, 'getToken'>` to snapshot-based capability types.
- [x] **4.5** Update package docs and examples.

### Phase 5: Tests And Verification

- [ ] **5.1** Add core auth tests for sync storage startup: initial snapshot is immediately `signedIn` or `signedOut`, and `whenSessionLoaded` resolves.
- [ ] **5.2** Add core auth tests for async storage startup: initial snapshot is `loading`, no signed-out transition fires before load, and the loaded value becomes the first settled session status.
- [ ] **5.3** Add tests for `subscribe` replay and previous snapshot arguments.
- [ ] **5.4** Add tests for token rotation: header token replaces current token and Better Auth refetch does not overwrite it with a stale token.
- [ ] **5.5** Add tests for Better Auth emissions during `loading`: null and non-null data must not publish a signed-out or signed-in snapshot before storage load.
- [x] **5.6** Removed storage callback echo tests; storage is now a boot cache only.
- [ ] **5.7** Add tests for `auth.fetch`: it waits for `whenSessionLoaded` before attaching a bearer token.
- [ ] **5.8** Add a package test script if needed. `packages/auth` currently only has `typecheck`, so do not add tests without making them runnable.
- [ ] **5.9** Add or update Svelte wrapper tests if the package has test infrastructure. If not, rely on `svelte-check`.
- [ ] **5.10** Run targeted typechecks and app typechecks.

## Search Commands

Run these before and after implementation:

```sh
rg -n "getToken\\(|getSession\\(|getUser\\(|isAuthenticated\\(|isBusy\\(|onSessionChange\\(|onTokenChange\\(|onLogin\\(|onLogout\\(|onBusyChange\\(" packages apps docs specs
```

```sh
rg -n "auth\\.token|auth\\.session|auth\\.user|auth\\.isAuthenticated|auth\\.isBusy" packages apps docs specs
```

```sh
rg -n "Pick<AuthClient, .*getToken|session\\.whenReady|session:" packages apps docs specs
```

```sh
rg -n "getToken: async \\(\\) => auth\\.|getToken: \\(\\) => auth\\." packages apps docs specs
```

```sh
rg -n "auth\\.fetch\\(|\\.fetch\\(" apps/dashboard packages/auth packages/auth-svelte apps docs specs
```

Expected result after implementation: no old public auth read surfaces remain outside archived specs or intentional historical docs.

## Edge Cases

### Async Storage Loads A Session After Startup

1. `createAuthClient()` returns with `snapshot.status === 'loading'`.
2. UI can render a loading state or hold layout stable.
3. `sessionStorage.load()` resolves with a session.
4. Snapshot becomes `signedIn`.
5. Workspace subscription applies encryption keys and reconnects sync.

Expected: no signed-out transition fires before the session load completes.

### Async Storage Loads Null

1. `createAuthClient()` returns with `snapshot.status === 'loading'`.
2. `sessionStorage.load()` resolves with `null`.
3. Snapshot becomes `signedOut`.
4. `whenSessionLoaded` resolves.

Expected: sync token callbacks waiting on `whenSessionLoaded` return `null` and park as authenticated-but-no-token, not as a premature startup error.

### Storage Load Fails

Storage parse errors or load failures should not leave auth stuck in `loading`.

Recommended behavior:

1. Storage adapter reports the error through its existing error hook or logger.
2. Auth treats the loaded value as `null`.
3. Snapshot becomes `signedOut`.
4. `whenSessionLoaded` resolves.

Do not add a public auth error state unless a real UI flow needs it.

Expected: `whenSessionLoaded` does not reject.

### Better Auth Reports Null While Storage Is Loading

Ignore it for snapshot purposes until persisted storage has loaded. Better Auth network state is not the readiness boundary.

Expected: no `loading` to `signedOut` transition caused only by Better Auth before storage hydration.

### Better Auth Reports Session While Storage Is Loading

1. `createAuthClient()` returns with `snapshot.status === 'loading'`.
2. Better Auth emits non-null session data before `sessionStorage.load()` resolves.
3. Auth buffers that data internally.
4. Persisted storage load owns the first transition out of `loading`.
5. After load, auth may merge Better Auth `user` and `encryptionKeys` into the signed-in session, preserving the persisted token if one exists.

Expected: no `loading` to `signedIn` transition is caused only by Better Auth before storage hydration.

### Token Rotation While Storage Is Loading

Response-header token rotation applies only when the current snapshot is `signedIn`.

Expected: if a `set-auth-token` header appears while auth is still `loading`, auth does not invent a partial session. The header is ignored until persisted storage has loaded and a signed-in snapshot exists.

### Token Rotation During Signed-In State

1. Request uses the current snapshot token.
2. Response includes `set-auth-token`.
3. Auth updates only `session.token`.
4. Auth saves the new session.
5. Subscribers receive `signedIn` to `signedIn`.
6. Workspace reconnects only if the token changed.

Expected: `user` and `encryptionKeys` remain unchanged.

### Better Auth Refetch After Token Rotation

1. Token rotates through the response header.
2. Better Auth later emits session data with the older token.
3. Auth preserves the current rotated token and updates only `user` and `encryptionKeys`.

Expected: the stale token is ignored.

### External Tab Signs Out

1. Better Auth session state reports `null`.
2. Snapshot becomes `signedOut`.
3. Workspace goes offline.
4. If previous snapshot was `signedIn`, local IndexedDB is cleared.

Expected: cold boot signed-out state does not clear local data.

### Auth Command Overlap

The internal in-flight counter from the earlier auth client has been removed. There is no public operation field and no `AuthBusy` rejection. Overlapping commands continue to interleave the way they do today: the Better Auth subscription settles final session state, so the only race risk is a stale token write (already covered by the rotated-token preservation rule above).

If a future flow needs strict mutual exclusion, that is an internal change that does not affect the public API.

## Success Criteria

- [x] `auth.snapshot` is the only public auth read surface.
- [x] `auth.whenSessionLoaded` is the only public auth readiness promise.
- [x] The public API has no `getToken`, `getSession`, `getUser`, `isAuthenticated`, `isBusy`, `onSessionChange`, `onTokenChange`, `onLogin`, `onLogout`, or `onBusyChange`.
- [x] Snapshot is a flat 3-state union: `loading | signedOut | signedIn`. No `operation` field.
- [x] Svelte wrapper exposes a reactive `snapshot` getter and no separate auth projections.
- [x] Tab-manager no longer awaits `session.whenReady` before constructing auth.
- [x] `attachSync` call sites wait for `auth.whenSessionLoaded` before reading token from `auth.snapshot`.
- [x] `auth.fetch` waits for `auth.whenSessionLoaded` before reading token from `auth.snapshot`.
- [x] Workspace session handlers use `auth.subscribe`.
- [x] UI components derive signed-in state, user, and token from `auth.snapshot`. Components that issue auth commands derive busy state from a local flag wrapping the `await`.
- [x] Token rotation still persists and does not get overwritten by Better Auth refetch.
- [x] Cross-tab sign-in and sign-out still update subscribers.
- [ ] Targeted typechecks pass:
  - [x] `bun run --filter @epicenter/auth typecheck`
  - [x] `bun run --filter @epicenter/auth-svelte typecheck`
  - [ ] `bun run --filter @epicenter/svelte typecheck`
  - [ ] App typechecks for Fuji, Honeycrisp, Opensidian, Zhongwen, Dashboard, and Tab Manager where package scripts exist.

## Review

**Reviewed**: 2026-05-01

The core API is implemented in the current codebase. `packages/auth/src/create-auth.ts` exposes `snapshot`, `whenSessionLoaded`, `subscribe`, and `fetch`; it buffers Better Auth emissions during storage load, preserves rotated bearer tokens, and stores updates through `sessionStorage`. `packages/auth-svelte/src/create-auth.svelte.ts` mirrors the snapshot into Svelte state, and app sync token callbacks read `auth.snapshot` after `auth.whenSessionLoaded`.

The remaining unexecuted part is verification. Phase 5 now has focused tests for storage startup, token rotation, Better Auth emissions during loading, and signed-in or signed-out Better Auth emissions. Subscribe replay with previous snapshot arguments and `auth.fetch` bearer behavior are still follow-up coverage candidates.

Two targeted typechecks pass:

```sh
bun run --filter @epicenter/auth typecheck
bun run --filter @epicenter/auth-svelte typecheck
```

The broader app and `@epicenter/svelte` typechecks are still unchecked in this review.

## Execution Prompt

Use this prompt to hand the implementation to another agent.

````text
You are implementing the Auth Snapshot API redesign in the Epicenter monorepo.

Repository context:
- Monorepo root: /Users/braden/conductor/workspaces/epicenter/ottawa-v2
- Use bun only. Do not use npm, yarn, pnpm, or npx.
- Do not use em dash or en dash characters in source, markdown, comments, docs, or commit messages.
- Do not make unrelated refactors.
- Preserve user changes in the worktree. Do not reset or checkout files.

Read this spec first:
specs/20260501T013208-auth-snapshot-api.md

Task:
Replace the current auth read API with a single synchronous `auth.snapshot` getter and a narrow `auth.whenSessionLoaded` promise. Update core auth, the Svelte wrapper, storage adapters, app call sites, docs, and tests so there are no remaining public uses of `getToken`, `getSession`, `getUser`, `isAuthenticated`, `isBusy`, `onSessionChange`, `onTokenChange`, `onLogin`, `onLogout`, `onBusyChange`, `auth.token`, `auth.session`, `auth.user`, `auth.isAuthenticated`, or `auth.isBusy`.

Target public API:

```ts
export type AuthSnapshot =
	| { status: 'loading' }
	| { status: 'signedOut' }
	| { status: 'signedIn'; session: Session };

export type AuthClient = {
	readonly snapshot: AuthSnapshot;
	readonly whenSessionLoaded: Promise<void>;
	subscribe(
		fn: (next: AuthSnapshot, previous: AuthSnapshot) => void,
	): () => void;
	signIn(input: { email: string; password: string }): Promise<Result<undefined, AuthError>>;
	signUp(input: { email: string; password: string; name: string }): Promise<Result<undefined, AuthError>>;
	signInWithSocialPopup(): Promise<Result<undefined, AuthError>>;
	signInWithSocialRedirect(input: {
		provider: string;
		callbackURL: string;
	}): Promise<Result<undefined, AuthError>>;
	signOut(): Promise<Result<undefined, AuthError>>;
	fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
	[Symbol.dispose](): void;
};
```

The snapshot is one flat discriminated union with three variants. There is no `operation` field and no `AuthOperation` type. In-flight UX (button spinners, "Signing in..." labels) is handled by the component that issued the command using a local `let busy = $state(false)` flag wrapping the `await`. The internal in-flight counter from today's core is preserved as a private serialization aid only.

Target storage contract:

```ts
export type MaybePromise<T> = T | Promise<T>;

export type SessionStorage = {
	load(): MaybePromise<Session | null>;
	save(value: Session | null): MaybePromise<void>;
};
```

Implementation requirements:
1. `auth.snapshot` must be a synchronous readonly getter. It must only read in-memory state.
2. `auth.whenSessionLoaded` resolves after persisted session storage has loaded and snapshot status is no longer `loading`. It never rejects; load failures normalize to `signedOut` after being reported through the existing error or logger path.
3. Sync localStorage-backed stores may leave `loading` before `createAuthClient()` returns.
4. Async chrome.storage-backed stores must start in `loading` and transition after storage load.
5. `auth.subscribe(fn)` replays synchronously. Replay `(loading, loading)` when current is loading. Replay `(current, { status: 'loading' })` when current is signed out or signed in. Future notifications use real `(next, previous)` pairs.
6. Better Auth `useSession.subscribe` must not turn `loading` into `signedOut` or `signedIn` before persisted storage loads. Buffer non-pending Better Auth state during loading and reconcile after load.
7. Better Auth response header token rotation still owns `session.token`, but only when snapshot is `signedIn`.
8. Better Auth session refetch still owns `user` and `encryptionKeys`, while preserving an already rotated token.
9. Only one helper mutates the in-memory snapshot. Local writes update snapshot first, then save the durable boot cache.
10. `auth.fetch` waits for `whenSessionLoaded`, then reads the bearer token from `auth.snapshot`.
11. Do not add `auth.accessToken()`, `auth.getToken()`, or other projection helpers. The snapshot is the single read source.
12. Do not add a public `operation` field, `AuthOperation` type, or `AuthError.AuthBusy`. Keep today's `busyCount` internal counter as a private serialization aid; overlapping commands continue to interleave the way they do today.
13. In `@epicenter/auth-svelte`, do not spread a core object getter into the returned object. Object spread invokes getters and would copy the initial snapshot value. Return an explicit live `snapshot` getter.
14. In Svelte call sites, read `auth.snapshot` directly in templates, `$derived`, or `$effect`. Do not destructure it once at module scope or non-reactive setup, because that freezes the current value.

Important call-site conversions:

Workspace auth subscription:

```ts
auth.subscribe((next, previous) => {
	if (next.status === 'loading') return;

	const previousSession =
		previous.status === 'signedIn' ? previous.session : null;

	if (next.status === 'signedOut') {
		workspace.sync.goOffline();
		if (previousSession !== null) void workspace.idb.clearLocal();
		return;
	}

	workspace.encryption.applyKeys(next.session.encryptionKeys);
	if (previousSession?.token !== next.session.token) {
		workspace.sync.reconnect();
	}
});
```

Sync token callback:

```ts
getToken: async () => {
	await auth.whenSessionLoaded;

	const snapshot = auth.snapshot;
	return snapshot.status === 'signedIn' ? snapshot.session.token : null;
},
```

Authenticated fetch:

```ts
async fetch(input, init) {
	await whenSessionLoaded;

	const headers = new Headers(init?.headers);
	const current = snapshot;
	if (current.status === 'signedIn') {
		headers.set('Authorization', `Bearer ${current.session.token}`);
	}
	return fetch(input, { ...init, headers, credentials: 'include' });
}
```

UI reads:

```ts
const snapshot = auth.snapshot;
const signedIn = snapshot.status === 'signedIn';
const user = signedIn ? snapshot.session.user : null;
```

In-flight UX uses local component state at the issuing site, not auth:

```svelte
<script>
	let busy = $state(false);
	const submit = async () => {
		busy = true;
		try {
			await auth.signIn({ email, password });
		} finally {
			busy = false;
		}
	};
</script>
```

Hunt old API with these commands:

```sh
rg -n "getToken\\(|getSession\\(|getUser\\(|isAuthenticated\\(|isBusy\\(|onSessionChange\\(|onTokenChange\\(|onLogin\\(|onLogout\\(|onBusyChange\\(" packages apps docs specs
```

```sh
rg -n "auth\\.token|auth\\.session|auth\\.user|auth\\.isAuthenticated|auth\\.isBusy" packages apps docs specs
```

```sh
rg -n "Pick<AuthClient, .*getToken|session\\.whenReady|session:" packages apps docs specs
```

```sh
rg -n "getToken: async \\(\\) => auth\\.|getToken: \\(\\) => auth\\." packages apps docs specs
```

```sh
rg -n "auth\\.fetch\\(|\\.fetch\\(" apps/dashboard packages/auth packages/auth-svelte apps docs specs
```

Core files to update:
- packages/auth/src/create-auth.ts
- packages/auth/src/session-store.ts
- packages/auth/src/auth-types.ts if the snapshot types live there
- packages/auth/src/index.ts
- packages/auth-svelte/src/create-auth.svelte.ts
- packages/auth-svelte/src/index.ts

Known app and package call sites:
- apps/fuji/src/lib/fuji/client.ts
- apps/fuji/src/lib/fuji/browser.ts
- apps/fuji/src/lib/entry-content-docs.ts
- apps/honeycrisp/src/lib/honeycrisp/client.ts
- apps/honeycrisp/src/lib/honeycrisp/browser.ts
- apps/honeycrisp/src/lib/note-body-docs.ts
- apps/opensidian/src/lib/opensidian/client.ts
- apps/opensidian/src/lib/opensidian/browser.ts
- apps/opensidian/src/lib/components/AppShell.svelte
- apps/zhongwen/src/lib/zhongwen/client.ts
- apps/zhongwen/src/routes/+page.svelte
- apps/tab-manager/src/lib/auth.ts
- apps/tab-manager/src/lib/tab-manager/client.ts
- apps/tab-manager/src/lib/tab-manager/extension.ts
- apps/tab-manager/src/lib/components/AiDrawer.svelte
- apps/dashboard/src/lib/auth.ts
- apps/dashboard/src/routes/+layout.svelte
- apps/dashboard/src/lib/components/UserMenu.svelte
- packages/svelte-utils/src/auth-form/auth-form.svelte
- packages/svelte-utils/src/account-popover/account-popover.svelte

Docs to update:
- docs/guides/consuming-epicenter-api.md
- packages/workspace/src/document/README.md
- apps/fuji/README.md
- .agents/skills/auth/SKILL.md

Verification:
- Run the old API search commands until only intentional historical references remain.
- Run `bun run --filter @epicenter/auth typecheck`.
- Run `bun run --filter @epicenter/auth-svelte typecheck`.
- Run `bun run --filter @epicenter/svelte typecheck`.
- Run app typechecks for the affected apps where package scripts exist.
- Run targeted tests for packages or apps touched by auth and sync changes.

Stop and report if Better Auth types make the exact target shape impossible. Otherwise implement the clean break, update all call sites, and keep the snapshot as the single idiomatic read path.
````

## References

- `packages/auth/src/create-auth.ts`
- `packages/auth/src/session-store.ts`
- `packages/auth-svelte/src/create-auth.svelte.ts`
- `packages/workspace/src/document/attach-sync.ts`
- `apps/tab-manager/src/lib/state/storage-state.svelte.ts`
- `apps/tab-manager/src/lib/tab-manager/client.ts`
- `apps/fuji/src/lib/fuji/client.ts`
- `apps/fuji/src/lib/fuji/browser.ts`
- `packages/svelte-utils/src/auth-form/auth-form.svelte`
- `packages/svelte-utils/src/account-popover/account-popover.svelte`
