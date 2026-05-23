# Workspace Auth Lifecycle Binding Clean Break

**Date**: 2026-05-01
**Status**: Implemented
**Author**: AI-assisted

## One Sentence

Auth exposes current state and future changes. `@epicenter/auth-workspace` binds those snapshots to workspace lifecycle effects, while app code supplies only product policy.

## Overview

Replace `auth.subscribe(next, previous)` with a smaller auth surface: `auth.snapshot`, `auth.whenLoaded`, and `auth.onSnapshotChange(next)`. Replace `attachAuthSnapshotToWorkspace(...)` with `bindWorkspaceAuthLifecycle(...)` from `@epicenter/auth-workspace`.

This is a clean break: no compatibility alias, no replay callback, no public previous snapshot, no flat callback list, no UI component clearing persistence, and no `attach` name for a helper that is not a Y.Doc attachment.

The binding is short, but it owns sharp invariants. Inlining it in each app would bring back the same bug class this cleanup just removed: loading treated as signed-out, cold signed-out boot clearing local data, child document sync handles missed on reconnect, user switches treated as token refreshes, and UI components owning destructive cleanup.

## Motivation

### Current State

The helper currently lives in `packages/auth-svelte/src/workspace.ts`:

```ts
attachAuthSnapshotToWorkspace({
	auth,
	workspace: fuji,
	afterSignedOutCleanup: () => window.location.reload(),
	onSignedOutCleanupError: (error) => {
		toast.error('Could not clear local data', {
			description: extractErrorMessage(error),
		});
	},
});
```

Tab Manager also registers a signed-in policy:

```ts
attachAuthSnapshotToWorkspace({
	auth,
	workspace: tabManager,
	afterSignedOutCleanup: () => window.location.reload(),
	onSignedOutCleanupError: showSignedOutCleanupError,
	onSignedInSnapshot: () => {
		void registerDevice();
	},
});
```

This works, but the shape still carries the old model:

1. **Wrong verb**: `attach` implies a subject-first workspace primitive. This helper binds two existing app singletons and subscribes immediately.
2. **Flat hooks**: `onSignedInSnapshot`, `afterSignedOutCleanup`, and `onSignedOutCleanupError` are lifecycle policy, but the API exposes them as adjacent implementation callbacks.
3. **Type trick smell**: `Pick<AuthClient, 'subscribe'>` is technically narrow, but it makes the public API read like a generic event utility. This binding is specifically for an Epicenter auth client.
4. **Replay smell**: `auth.subscribe(next, previous)` immediately replays the current snapshot and invents `{ status: 'loading' }` as the previous value. The caller has to know whether `previous` is real or synthetic.
5. **Wrong owner for history**: auth exposes transition history even though only workspace lifecycle needs it. Auth should report current state and future changes; the binding should track the small amount of lifecycle memory it needs.
6. **Over-inlining risk**: the subscriber body is not long, but each branch encodes auth/workspace invariants that should not vary per app.

### Desired State

Auth reads as a state source, not a transition policy engine:

```ts
export const auth = createAuth({
	baseURL: APP_URLS.API,
	sessionStorage: createSessionStorageAdapter(session),
});

const snapshot = auth.snapshot;
await auth.whenLoaded;

const unsubscribe = auth.onSnapshotChange((snapshot) => {
	// future snapshots only
});
```

The call site should read as a lifecycle binding with grouped app policy:

```ts
bindWorkspaceAuthLifecycle({
	auth,
	workspace: fuji,
	leavingUser: {
		afterCleanup: () => window.location.reload(),
		onCleanupError: (error) => {
			toast.error('Could not clear local data', {
				description: extractErrorMessage(error),
			});
		},
	},
});
```

Tab Manager keeps device registration in the signed-in group:

```ts
bindWorkspaceAuthLifecycle({
	auth,
	workspace: tabManager,
	leavingUser: {
		afterCleanup: () => window.location.reload(),
		onCleanupError: (error) => {
			toast.error('Could not clear local data', {
				description: extractErrorMessage(error),
			});
		},
	},
	signedIn: {
		onSnapshot: () => {
			void registerDevice();
		},
	},
});
```

The cleanup error toast can be inline. A named `showSignedOutCleanupError` helper is fine when it improves a file, but the API should not require or imply another abstraction.

`AccountPopover` remains only a command and rendering component:

```svelte
<AccountPopover
	{auth}
	sync={fuji.sync}
	syncNoun="entries"
	onSocialSignIn={() =>
		auth.signInWithSocialRedirect({
			provider: 'google',
			callbackURL: window.location.origin,
		})}
/>
```

`AccountPopover` must never receive `clearLocalData`, `workspace.idb`, or reload callbacks.

## Ownership

```txt
current auth snapshot           @epicenter/auth
auth storage load barrier       @epicenter/auth
future auth snapshot changes    @epicenter/auth
Svelte snapshot reactivity      @epicenter/auth-svelte
auth to workspace lifecycle     @epicenter/auth-workspace
active user/token memory        bindWorkspaceAuthLifecycle
sync target inventory           workspace object
cleanup failure UI policy       app client module
post-cleanup navigation policy  app client module
sign-out command UI             AccountPopover
```

The binding owns transition mechanics. The app owns product policy. The UI component owns prompts, local command state, and rendering.

The binding should not live in `@epicenter/auth`: auth should not know workspace persistence, sync handles, or encryption activation. It should not live in `@epicenter/workspace`: workspace primitives should not know `AuthClient` or auth snapshot semantics. Keeping it in `@epicenter/auth-svelte` works mechanically, but it makes a Svelte wrapper own a framework-agnostic integration. The cleaner boundary is a small adapter package:

```txt
packages/auth-workspace
  package name: @epicenter/auth-workspace
  exports: bindWorkspaceAuthLifecycle
  depends on: @epicenter/auth
```

This package composes two peer domains at the app edge. It must not import Svelte, app UI, or app singletons.

## Design Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Auth state read | `auth.snapshot` | Auth tells consumers what is true now. The discriminated union keeps loading, signed-out, and signed-in reads explicit. |
| Auth load barrier | `auth.whenLoaded` | The promise resolves once persisted auth storage has loaded and `auth.snapshot.status` is no longer `loading`. `whenSessionLoaded` is too easy to read as "there is a signed-in session". |
| Auth change listener | `auth.onSnapshotChange(next)` | Future changes only. No replay, no synthetic previous value, no public transition history. |
| Removed auth primitive | `auth.subscribe(next, previous)` | It mixes current-state replay with future transitions and makes callers reason about fake previous snapshots. |
| Helper verb | `bindWorkspaceAuthLifecycle` | The helper binds two existing app singletons and starts lifecycle side effects. It is not a Y.Doc attachment. |
| Package | `@epicenter/auth-workspace` | The helper is framework-agnostic integration glue between auth snapshots and workspace lifecycle effects. |
| API shape | one grouped options object | `auth` and `workspace` are both dependencies. `leavingUser` and `signedIn` are policy groups. A single object keeps those roles named at the call site. |
| Chain API | reject | `.leavingUser(...).signedIn(...)` adds a builder object for two optional groups and hides that subscription happens immediately. |
| Two arguments | reject for now | `bindWorkspaceAuthLifecycle(workspace, options)` makes `workspace` look like an attach subject. This binding has two peers: auth source and workspace target. |
| Auth type | `AuthClient` | Publicly this binds an Epicenter auth client. The binding needs `snapshot` for bootstrap and `onSnapshotChange` for future updates. |
| Binding memory | `activeUserId` and `activeToken` | These are the only transition facts the binding needs: whether it is leaving an authenticated user and whether sync credentials changed. |
| Cleanup policy group | `leavingUser` | Cleanup happens when leaving an applied user, which includes sign-out and direct user switch. `signedOut` is too narrow. |
| Error policy | required `leavingUser.onCleanupError` | Cleanup failure affects user state. Apps must choose how to report it. |
| Cleanup success policy | optional `leavingUser.afterCleanup` | Reload, navigation, or doing nothing is app policy. |
| Signed-in policy | optional `signedIn.onSnapshot` | Runs after every applied signed-in snapshot, including bootstrap, key refresh, and token refresh. |
| Cold signed-out boot | offline only | A signed-out bootstrap snapshot is not proof that the user just signed out. Do not clear local persistence unless this binding has already applied a signed-in user. |
| User switch | clear before applying new user | `signedIn user A -> signedIn user B` must not be treated as token refresh. Take sync offline, clear local data, then apply B's keys and reconnect. |
| Cleanup retry | out of scope | If the product needs retry-after-failed-cleanup on next boot, add an explicit pending-cleanup marker. Do not infer that policy from signed-out bootstrap. |
| Compatibility | none | Delete the old helper and type names in one sweep. Compatibility is not a product requirement here. |

## Proposed API

### Auth

```ts
export type AuthSnapshot =
	| { status: 'loading' }
	| { status: 'signedOut' }
	| { status: 'signedIn'; session: Session };

export type AuthSnapshotChangeListener = (snapshot: AuthSnapshot) => void;

export type AuthClient = {
	readonly snapshot: AuthSnapshot;
	readonly whenLoaded: Promise<void>;
	onSnapshotChange(fn: AuthSnapshotChangeListener): () => void;

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
	fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;

	[Symbol.dispose](): void;
};
```

`onSnapshotChange` does not replay. Consumers that need the current value read `auth.snapshot`. Consumers that need an initial barrier await `auth.whenLoaded`.

### Workspace Auth Binding

```ts
export type WorkspaceAuthSyncTarget = {
	goOffline(): void;
	reconnect(): void;
};

export type WorkspaceAuthTarget = {
	sync: WorkspaceAuthSyncTarget;
	idb: {
		clearLocal(): Promise<unknown>;
	};
	encryption: {
		applyKeys(keys: Session['encryptionKeys']): void;
	};
	getAuthSyncTargets?(): Iterable<WorkspaceAuthSyncTarget>;
};

export type WorkspaceAuthLifecycleOptions = {
	auth: AuthClient;
	workspace: WorkspaceAuthTarget;
	leavingUser: {
		onCleanupError(error: unknown): void;
		afterCleanup?(): void;
	};
	signedIn?: {
		onSnapshot?(): void;
	};
};

export function bindWorkspaceAuthLifecycle(
	options: WorkspaceAuthLifecycleOptions,
): () => void;
```

### JSDoc Target

The public function should explain when to use it and what it owns:

```ts
/**
 * Bind auth snapshots to a workspace bundle.
 *
 * Use this once in an app client module after constructing the app's auth and
 * workspace singletons. The binding owns shared transition mechanics:
 * ignore loading, bootstrap from the current auth snapshot, take sync offline
 * for signed-out snapshots, avoid destructive cold signed-out cleanup, clear
 * local persistence when leaving an applied user, apply encryption keys before
 * reconnect, and reconnect every auth-backed sync target when the token changes.
 *
 * App code supplies product policy only: how cleanup errors are reported, what
 * happens after cleanup succeeds, and any idempotent signed-in snapshot work.
 *
 * @returns Unsubscribe function from the auth snapshot change listener.
 *
 * @example
 * ```ts
 * bindWorkspaceAuthLifecycle({
 *   auth,
 *   workspace: fuji,
 *   leavingUser: {
 *     afterCleanup: () => window.location.reload(),
 *     onCleanupError: reportCleanupError,
 *   },
 * });
 * ```
 */
export function bindWorkspaceAuthLifecycle(
	options: WorkspaceAuthLifecycleOptions,
): () => void;
```

The types should also carry short JSDoc because they are exported. Do not restate field names. Explain the contract:

```ts
/**
 * Minimal workspace surface needed for auth-driven lifecycle effects.
 *
 * App workspace bundles satisfy this structurally by exposing their primary
 * sync handle, local persistence handle, encryption coordinator, and optional
 * child sync inventory.
 */
export type WorkspaceAuthTarget = { ... };
```

## Transition Rules

```txt
loading
  no side effects

cold signedOut boot
  go offline for all auth sync targets
  do not clear local persistence
  do not run leavingUser.afterCleanup
  do not run leavingUser.onCleanupError

signedIn snapshot
  apply encryption keys
  reconnect all auth sync targets when there is no active token or token changes
  run signedIn.onSnapshot if provided

signedIn -> signedOut
  go offline for all auth sync targets
  clear local persistence
  on success, run leavingUser.afterCleanup if provided
  on failure, run leavingUser.onCleanupError

signedIn user A -> signedIn user B
  go offline for all auth sync targets
  clear local persistence
  apply user B encryption keys
  reconnect all auth sync targets
  run signedIn.onSnapshot if provided
  on cleanup success, run leavingUser.afterCleanup if provided
  on cleanup failure, run leavingUser.onCleanupError and do not apply user B
```

### Bootstrap And Change Handling

`auth.onSnapshotChange(fn)` is future-only. The binding performs bootstrap by reading `auth.snapshot` once, then registers the listener:

```ts
let activeUserId: string | null = null;
let activeToken: string | null = null;

function applySignedIn(snapshot: Extract<AuthSnapshot, { status: 'signedIn' }>) {
	workspace.encryption.applyKeys(snapshot.session.encryptionKeys);

	if (activeToken !== snapshot.session.token) {
		for (const sync of getSyncTargets()) sync.reconnect();
	}

	activeUserId = snapshot.session.user.id;
	activeToken = snapshot.session.token;
	signedIn?.onSnapshot?.();
}

function apply(snapshot: AuthSnapshot) {
	if (snapshot.status === 'loading') return;

	if (snapshot.status === 'signedOut') {
		for (const sync of getSyncTargets()) sync.goOffline();

		if (activeUserId !== null) {
			activeUserId = null;
			activeToken = null;
			void clearLocalData()
				.then(() => leavingUser.afterCleanup?.())
				.catch(leavingUser.onCleanupError);
		}

		return;
	}

	const sameUser = activeUserId === snapshot.session.user.id;

	if (!sameUser && activeUserId !== null) {
		for (const sync of getSyncTargets()) sync.goOffline();
		activeUserId = null;
		activeToken = null;
		void clearLocalData()
			.then(() => {
				applySignedIn(snapshot);
				leavingUser.afterCleanup?.();
			})
			.catch(leavingUser.onCleanupError);
		return;
	}

	applySignedIn(snapshot);
}

apply(auth.snapshot);
return auth.onSnapshotChange(apply);
```

The mutable values are private lifecycle memory, not source of truth. They mean only this binding instance has applied this user and token to this workspace. If a tab reloads, the binding is recreated from `auth.snapshot`. If a future product requirement says failed sign-out cleanup must retry on the next boot, model that as explicit durable state:

```txt
auth signOut succeeds
  set pendingWorkspaceCleanup = true
  clear local data
  unset pendingWorkspaceCleanup

cold boot signedOut + pendingWorkspaceCleanup
  retry clear local data
```

Do not infer durable pending cleanup from signed-out bootstrap alone.

## Auth Boundary

Auth should not expose transition history. `auth.subscribe(next, previous)` asks every subscriber to understand replay, synthetic previous snapshots, and transition policy. The new auth surface is smaller:

```txt
auth.snapshot
  current truth

auth.whenLoaded
  initial storage load barrier

auth.onSnapshotChange(next)
  future snapshots only
```

`@epicenter/auth-svelte` mirrors `auth.snapshot` into `$state`:

```ts
const core = createBaseAuthClient(config);
let snapshot = $state(core.snapshot);

const unsubscribe = core.onSnapshotChange((next) => {
	snapshot = next;
});
```

Workspace lifecycle history belongs in `@epicenter/auth-workspace`, because that is the only layer deciding when auth state should cause workspace side effects.

A deeper package cleanup remains: `@epicenter/auth` currently imports workspace encryption key helpers to define and compare sessions. `AuthClient` can still carry `session.encryptionKeys`, but the schema and fingerprint helper should move to a shared contract package or an auth-owned contract module that workspace consumes.

## Why Not Inline

Inlining looks attractive because the implementation is short. It is still the wrong default because the repeated code would encode shared invariants at every app boundary:

```txt
ignore loading
do not clear on cold signedOut boot
go offline before clearing persistence
apply keys before reconnecting
reconnect every auth-backed sync target, including child docs
run signed-in snapshot policy on every signed-in snapshot
report cleanup failure as app policy
```

Apps should vary policy, not transition mechanics. If a future app genuinely needs a different transition protocol, that app can choose not to use the binding. The common path should be one audited implementation.

## Alternative APIs Considered

### Inline `auth.subscribe`

```ts
auth.subscribe((next, previous) => {
	// app owns every branch
});
```

Rejected. This makes mechanics visible, but it recreates the duplication that caused the review findings. It also preserves replay and synthetic previous snapshots as public API concepts.

### Event Names

```ts
auth.onAuthStateChange((event, snapshot) => {
	if (event === 'INITIAL_SESSION') return;
	if (event === 'SIGNED_OUT') clearLocalData();
});
```

Rejected. Supabase distinguishes initial session from later auth events, but that model still makes callers interpret broad event names. `SIGNED_IN` can mean first sign-in, session re-establishment, or another confirmation of the same user. This repo needs identity and token-sensitive workspace effects, so the binding should compare the current auth snapshot with its own applied user and token instead of exposing an event vocabulary from auth.

### `attachWorkspaceAuthLifecycle(workspace, options)`

```ts
attachWorkspaceAuthLifecycle(workspace, {
	auth,
	leavingUser,
	signedIn,
});
```

Rejected. It follows `attach*` shape superficially, but the helper is not attaching to a Y.Doc or attachment. The subject is not only the workspace. The binding has two dependencies: auth and workspace.

### Raw `Y.Doc` Subject

```ts
attachWorkspaceAuthLifecycle(fuji.ydoc, {
	auth,
	sync: fuji.sync,
	idb: fuji.idb,
	encryption: fuji.encryption,
	getAuthSyncTargets: fuji.getAuthSyncTargets,
});
```

Rejected. `Y.Doc` does not own sync inventory, local persistence cleanup, or encryption key application. This shape forces callers to explode the workspace bundle into parts and makes the API less safe.

### Method Chaining

```ts
bindWorkspaceAuthLifecycle({ auth, workspace })
	.leavingUser({ afterCleanup, onCleanupError })
	.signedIn({ onSnapshot });
```

Rejected. Chaining adds a builder lifecycle to a one-shot subscription. It also hides the moment when subscription starts: construction, first chain call, or finalizer. This API only has two policy groups, so an object is clearer than a builder.

### Workspace Method

```ts
workspace.bindAuthLifecycle(auth, policy);
```

Rejected. That makes workspace objects aware of auth as a domain concept. Workspaces should expose sync, persistence, encryption, and sync inventory. The binding module composes those with auth at the app edge.

## Implementation Plan

### Phase 1: Create Integration Package

- [x] **1.1** Create `packages/auth-workspace` with package name `@epicenter/auth-workspace`.
- [x] **1.2** Add package exports for `bindWorkspaceAuthLifecycle` and its public types.
- [x] **1.3** Depend on `@epicenter/auth`. Do not depend on Svelte, app packages, or `@epicenter/ui`.
- [x] **1.4** Wire monorepo scripts and package metadata to match existing private packages.

### Phase 2: Simplify Auth Change API

- [x] **2.1** Rename `whenSessionLoaded` to `whenLoaded`.
- [x] **2.2** Replace `subscribe(fn: AuthSnapshotSubscriber)` with `onSnapshotChange(fn: AuthSnapshotChangeListener)`.
- [x] **2.3** Remove `AuthSnapshotSubscriber` from public exports.
- [x] **2.4** Add `AuthSnapshotChangeListener`.
- [x] **2.5** Ensure `onSnapshotChange` never replays. It only receives future calls from `setSnapshot(next)`.
- [x] **2.6** Update `auth.fetch` and sync token callbacks to await `auth.whenLoaded`.
- [x] **2.7** Update `@epicenter/auth-svelte` to mirror `core.snapshot` and listen with `core.onSnapshotChange`.

### Phase 3: Rename and Group the Workspace API

- [x] **3.1** Move `attachAuthSnapshotToWorkspace` from `packages/auth-svelte/src/workspace.ts` into `packages/auth-workspace/src/index.ts` as `bindWorkspaceAuthLifecycle`.
- [x] **3.2** Rename `AuthWorkspaceSyncTarget` to `WorkspaceAuthSyncTarget`.
- [x] **3.3** Rename `AuthWorkspaceTarget` to `WorkspaceAuthTarget`.
- [x] **3.4** Add `WorkspaceAuthLifecycleOptions` with grouped `leavingUser` and `signedIn` policy.
- [x] **3.5** Accept `AuthClient` in the public options. Do not expose `Pick<AuthClient, 'subscribe'>`.
- [x] **3.6** Remove old flat option names. Do not export compatibility aliases from `@epicenter/auth-svelte`.
- [x] **3.7** Add JSDoc for the function and exported types.

### Phase 4: Add Focused Tests

- [x] **4.1** Add core auth tests for `onSnapshotChange`: no replay, future changes only, subscriber failures do not stop other listeners.
- [x] **4.2** Add core auth tests for `whenLoaded`: resolves once initial storage load settles, including signed-out load and load failure.
- [x] **4.3** Add `packages/auth-workspace/src/index.test.ts`.
- [x] **4.4** Use fake auth and fake workspace objects. Do not use Svelte, real IndexedDB, or real WebSockets.
- [x] **4.5** Cover loading bootstrap: no side effects.
- [x] **4.6** Cover cold signed-out boot: all auth sync targets go offline, local persistence is not cleared, and cleanup policy callbacks do not run.
- [x] **4.7** Cover cold signed-in boot: encryption keys are applied, all auth sync targets reconnect, and `signedIn.onSnapshot` runs.
- [x] **4.8** Cover `signedIn -> signedOut`: all auth sync targets go offline, local persistence clears, and `leavingUser.afterCleanup` runs only after clear succeeds.
- [x] **4.9** Cover cleanup failure: `leavingUser.onCleanupError` runs and `leavingUser.afterCleanup` does not.
- [x] **4.10** Cover token refresh for same user: encryption keys are applied, all auth sync targets reconnect, and `signedIn.onSnapshot` runs.
- [x] **4.11** Cover key refresh without token change: encryption keys are applied, sync targets do not reconnect, and `signedIn.onSnapshot` runs.
- [x] **4.12** Cover user switch: all auth sync targets go offline, local persistence clears, new keys apply, sync reconnects, and `signedIn.onSnapshot` runs.
- [x] **4.13** Cover duplicate sync targets: `getAuthSyncTargets()` results are deduped before `goOffline()` or `reconnect()`.
- [x] **4.14** Cover unsubscribe: later auth emissions do nothing.

### Phase 5: Update Call Sites

- [x] **5.1** Update Fuji, Honeycrisp, Opensidian, and Tab Manager imports and call sites to import from `@epicenter/auth-workspace`.
- [x] **5.2** Decide whether Zhongwen should use the binding or keep its manual non-sync listener. If it keeps the manual path, document why in the file or in the app workspace notes.
- [x] **5.3** Keep cleanup error toast policy in each app client. Inline it unless a local helper improves readability.
- [x] **5.4** Keep `window.location.reload()` under `leavingUser.afterCleanup`.
- [x] **5.5** Move Tab Manager `registerDevice` callback under `signedIn.onSnapshot`.
- [x] **5.6** Confirm no `AccountPopover` call site passes persistence cleanup props.

### Phase 6: Update Docs and Specs

- [x] **6.1** Update `docs/guides/consuming-epicenter-api.md`.
- [x] **6.2** Update `docs/encryption.md`.
- [x] **6.3** Update `specs/20260501T013208-auth-snapshot-api.md`.
- [x] **6.4** Update `.agents/skills/auth/SKILL.md`.
- [x] **6.5** Search for old helper, type, and option names. Historical specs may mention them, but live docs and source should not.

### Phase 7: Verify

- [x] **7.1** `bun test` in `packages/auth`.
- [x] **7.2** `bun test` in `packages/auth-workspace`.
- [x] **7.3** `bun run typecheck` in `packages/auth`.
- [x] **7.4** `bun run typecheck` in `packages/auth-workspace`.
- [x] **7.5** `bun run typecheck` in `packages/auth-svelte`.
- [x] **7.6** Run one affected app typecheck, preferably Fuji, and record any baseline failures separately.
- [x] **7.7** Run targeted grep checks:

```sh
rg -n "attachAuthSnapshotToWorkspace|AuthWorkspaceTarget|AuthWorkspaceSyncTarget|afterSignedOutCleanup|onSignedOutCleanupError|attachWorkspaceAuthLifecycle|auth\\.subscribe|AuthSnapshotSubscriber|whenSessionLoaded" apps packages docs specs .agents/skills
```

Expected result: old helper and auth subscription names disappear from live code and docs. Historical specs may keep old names only when explicitly discussing prior behavior. `attachWorkspaceAuthLifecycle` should not appear because the final name is `bindWorkspaceAuthLifecycle`.

## Edge Cases

### Cold Signed-Out Boot

1. Binding starts while `auth.snapshot.status` is `signedOut`.
2. The lifecycle binding takes auth sync targets offline.
3. The lifecycle binding must not clear local persistence.

### Cleanup Failure

1. User signs out successfully.
2. Lifecycle binding takes sync offline.
3. `workspace.idb.clearLocal()` rejects.
4. `leavingUser.onCleanupError(error)` runs.
5. `leavingUser.afterCleanup` does not run.

### Token Refresh

1. Snapshot stays `signedIn`.
2. Token changes.
3. Binding applies encryption keys and reconnects auth sync targets.
4. `signedIn.onSnapshot` runs.

### Key Refresh Without Token Change

1. Snapshot stays `signedIn`.
2. Encryption keys change but token stays the same.
3. Binding applies keys.
4. Binding does not reconnect sync targets.
5. `signedIn.onSnapshot` runs.

### User Switch

1. Binding has applied signed-in user A.
2. Auth snapshot changes to signed-in user B.
3. Binding takes sync offline.
4. Binding clears local persistence.
5. Binding applies user B encryption keys.
6. Binding reconnects all auth sync targets.
7. `signedIn.onSnapshot` runs.

## Handoff Prompt For Spec Review

Use this prompt to ask another agent to review the spec before implementation:

```txt
You are reviewing a draft spec in a TypeScript/Svelte monorepo.

Spec file:
specs/20260501T145113-workspace-auth-lifecycle-api-clean-break.md

Task:
Review the spec for architecture quality before implementation. Do not edit files. Give findings only.

Context:
The current API is `attachAuthSnapshotToWorkspace` in `packages/auth-svelte/src/workspace.ts`. It relies on `auth.subscribe(next, previous)`, which replays immediately and uses synthetic previous snapshots. The proposed API removes replay from auth, moves this concern to `@epicenter/auth-workspace`, reads `auth.snapshot` for bootstrap, listens to future snapshots with `auth.onSnapshotChange(next)`, and performs workspace side effects:
- ignore `loading`
- on signed-out boot: `sync.goOffline()`, no local cleanup
- on signed-out after this binding has applied a user: `sync.goOffline()`, clear local IndexedDB persistence, then optionally run app cleanup policy
- on signed-in for a new user: clear previous local data if needed, apply keys, reconnect
- on signed-in for the same user: apply encryption keys, reconnect sync targets when the token changes, and optionally run an idempotent signed-in callback

Recent review found that the helper name is now too narrow, the `attach` verb is misleading, and the flat callback list mirrors implementation steps. The proposed clean-break API is:

bindWorkspaceAuthLifecycle({
	auth,
	workspace,
	leavingUser: {
		afterCleanup: () => window.location.reload(),
		onCleanupError: (error) => {
			toast.error('Could not clear local data', {
				description: extractErrorMessage(error),
			});
		},
	},
	signedIn: {
		onSnapshot: () => {
			void registerDevice();
		},
	},
});

Review lens:
1. Inline the proposed binding mentally. Does the abstraction still earn its keep?
2. Does the grouped `leavingUser` and `signedIn` policy shape improve the API, or does it add ceremony?
3. Is `bind` the right verb, or should this be inlined in app clients?
4. Is `auth.onSnapshotChange(next)` a cleaner auth primitive than `auth.subscribe(next, previous)`?
5. Are there hidden ownership leaks between `@epicenter/auth`, `@epicenter/auth-svelte`, app UI policy, and workspace sync?
6. Is `@epicenter/auth-workspace` the right package boundary, or is there a stronger place for this adapter?
7. Is `auth.whenLoaded` the right name, or should the load barrier keep the old `whenSessionLoaded` name?
8. What would you change before implementation?

Output:
- Lead with findings, highest impact first.
- Include file/section references to the spec.
- Separate "must fix before implementation" from "nice to improve".
- Do not propose compatibility aliases unless you can justify compatibility as a product requirement.
```

## Review

**Completed**: 2026-05-01
**Branch**: `codex/explicit-daemon-host-config`

### Summary

Implemented the clean-break auth lifecycle API. `@epicenter/auth` now exposes `snapshot`, `whenLoaded`, and future-only `onSnapshotChange`; `@epicenter/auth-svelte` mirrors that future-only stream into Svelte state; `@epicenter/auth-workspace` owns workspace lifecycle transitions through `bindWorkspaceAuthLifecycle`.

App call sites now use grouped `leavingUser` and `signedIn` policy. Zhongwen keeps a documented manual listener because it has encrypted local persistence but no auth-backed sync target.

### Deviations From Spec

- `getAuthSyncTargets()` is treated as optional additional inventory while `workspace.sync` is always included. This keeps the primary sync handle covered even if a workspace only returns child targets.
- `specs/20260501T013208-auth-snapshot-api.md` was marked as superseded instead of rewritten line by line. It is a historical implementation record for the intermediate API.

### Verification

- `bun test` in `packages/auth`: passed.
- `bun test` in `packages/auth-workspace`: passed.
- `bun run typecheck` in `packages/auth`: passed.
- `bun run typecheck` in `packages/auth-workspace`: passed.
- `bun run typecheck` in `packages/auth-svelte`: passed with the existing warning that no Svelte input files were found.
- `bun run typecheck` in `apps/fuji`: failed on baseline issues in `packages/svelte-utils`, `packages/ui`, and Fuji UI components, unrelated to this auth lifecycle change.
- Targeted grep found no old auth lifecycle names in live apps, packages, docs, or skills. Historical specs still contain old names when discussing prior behavior.

### Follow-Up Work

- The encryption key package cleanup remains separate, as planned.
- Fuji app typecheck still needs its existing shared UI and Svelte utility failures fixed outside this spec.
