# Auth state machine cleanup and provider migration

**Date**: 2026-05-05
**Status**: Reconciled, mostly superseded
**Author**: AI-assisted, grounded against the predecessor spec, the current `packages/auth` and `packages/auth-workspace` source, and the four `apps/*/src/lib/*/client.ts` modules
**Branch**: feat/regex-improvements (continues the work started on feat/encrypted-local-workspace-storage)
**Follows**: `specs/20260505T080000-auth-state-machine-and-gated-identity-context.md`

## Current Reconciliation (2026-05-07)

Do not execute this draft as a live implementation plan. Most of the intended
cleanup landed through later specs, but with a smaller abstraction than the
provider migration described here.

Current canonical shape for cookie browser apps:

```ts
export const session = createSession({
	auth,
	build(identity) {
		const workspace = openApp({
			userId: identity.user.id,
			encryptionKeys: () => requireSignedIn(auth).encryptionKeys,
			bearerToken: () => auth.bearerToken,
		});

		return {
			userId: identity.user.id,
			workspace,
			[Symbol.dispose]() {
				workspace[Symbol.dispose]();
			},
		};
	},
});
```

The important invariant is now:

```txt
auth.state owns authentication status
createSession owns the signed-in app payload lifecycle
app modules expose one narrowed getSignedInSession helper when a route needs it
```

Landed or superseded pieces:

| Original concern | Current status |
| --- | --- |
| Top-level signed-in waits in cookie apps | Fixed for `fuji`, `honeycrisp`, and `zhongwen` by `createSession` plus per-app `getSignedInSession` helpers. |
| `@epicenter/auth-workspace` ceremony | Superseded by deletion. Workspace lifecycle is now owned by app session builders rather than a shared bridge package. |
| Protected provider wrapper | Superseded. The newer pattern avoids route-local provider ceremony for the shared app session path. |
| Sign-in render branching | Addressed in the later route-loader and session-state specs. |
| Nullable identity helpers in core | Mostly reduced. Core still has small projection helpers such as `identityFromSession`, but it no longer has the earlier backwards `AuthState -> AuthIdentity | null -> AuthState` drain machine. |

Remaining actionable:

1. `apps/opensidian/src/lib/opensidian/client.ts` still waits at module scope
   for signed-in auth before opening the workspace.
2. `apps/tab-manager/src/lib/tab-manager/client.ts` still waits at module
   scope for signed-in auth before opening the workspace.
3. If those two apps need signed-out UI, migrate them to a session-style
   lifecycle. If they are intentionally signed-in-only runtimes, write that
   invariant down near the top-level await so future agents do not keep
   rediscovering it as a smell.
4. A smaller core cleanup remains possible in `packages/auth/src/create-auth.ts`:
   inline or rename `identityFromSession` only if a broader pass touches that
   file. It is not worth a standalone abstraction hunt now.

## One-sentence thesis

The state-machine refactor landed in zhongwen and dashboard, but the other four apps still top-level-await on a "must-be-signed-in" predicate (which deadlocks signed-out users), the core still routes everything through nullable-identity helpers, and the (protected) identity context lives in the wrong file with a redundant wrapper type; this spec finishes the migration to a single canonical pattern (render-branch + provider) and collapses the remaining helpers.

## Why this spec exists

The predecessor spec defined the right primitives (`auth.state`, `auth.onStateChange`, `waitForAuthState`, the protected provider pattern in zhongwen) but only finished the migration for two apps. The intermediate state has three concrete bugs and three taste smells.

### Bug 1: top-level-await on `signed-in` deadlocks signed-out users

```ts
// apps/fuji/src/lib/fuji/client.ts:11 (and honeycrisp, opensidian, tab-manager identical)
const signedInState = await waitForAuthState(
    auth,
    (state) => state.status === 'signed-in',
);
if (signedInState.status !== 'signed-in') {
    throw new Error('Cannot open Fuji workspace: signed-in auth required.');
}

export const fuji = openFuji({ auth, identity: signedInState.identity, ... });
```

If `auth` settles to `signed-out` (every cold-boot for a logged-out user, every sign-out without a reload), this promise never resolves. Top-level await means the module never finishes loading. Every importer of `fuji`, including the layout that wants to render `<AuthForm />`, blocks forever. The only escape is full-page reload.

The dead `if` branch underneath confirms the type-narrowing motivation, but the predicate already guarantees the narrow. The dead branch is the smell; the deadlock is the bug.

### Bug 2: `{#key}` in the layout AND `window.location.reload()` in the provider

```svelte
<!-- apps/zhongwen/src/routes/(protected)/+layout.svelte -->
{:else if authState.status === 'signed-in'}
    {#key authState.identity.user.id}
        <ZhongwenWorkspaceProvider identity={authState.identity}>
```

```ts
// apps/zhongwen/src/routes/(protected)/ZhongwenWorkspaceProvider.svelte
const unsubscribe = auth.onStateChange((state) => {
    if (state.status === 'pending') return;
    if (state.status === 'signed-out') return;
    if (state.identity.user.id !== identity.user.id)
        return window.location.reload();
    ...
});
```

User-switch fires both: `{#key}` remounts the provider (which disposes the workspace and constructs a new one) AND `window.location.reload()` discards the entire page. The reload wins by milliseconds; the remount work is wasted. Two policies for one transition.

### Bug 3: sign-in page flashes the form when already signed-in

```svelte
<!-- apps/zhongwen/src/routes/sign-in/+page.svelte -->
<main class="flex h-dvh flex-col">
    {/* sign-in form, rendered unconditionally */}
</main>
```

The `$effect` schedules `goto('/')` when status flips to `signed-in`, but the form renders one frame first. The protected layout render-branches on status; this page doesn't. Inconsistent and visible.

### Smell 1: `auth-workspace` converts state backwards

```ts
// packages/auth-workspace/src/index.ts
function scheduleState(state: AuthState) {
    if (state.status === 'pending') return;
    schedule(state.status === 'signed-in' ? state.identity : null);  // AuthState -> AuthIdentity | null
}

await processState(
    identity === null
        ? { status: 'signed-out' }
        : { status: 'signed-in', identity },                          // AuthIdentity | null -> AuthState
);
```

The package receives `AuthState`, projects it to nullable identity, queues that, then rebuilds `AuthState` to dispatch. Pure ceremony. The drain machine exists because the predecessor's `onChange(identity)` callback couldn't distinguish cold-boot from sign-out; with `onStateChange`, the discriminator is in the value. The whole drain layer is now unnecessary.

### Smell 2: `ProtectedAuth` wrapper around a single field

```ts
// apps/zhongwen/src/lib/auth.ts
export type ProtectedAuth = {
    identity: AuthIdentity;
};
export const [getProtectedAuth, setProtectedAuth] = createContext<ProtectedAuth>();
```

The context value has one field. Consumers write `protectedAuth.identity.user.name`. The wrapper exists only because the provider mutates `protectedAuth.identity = state.identity` on same-user key refresh. A reactive cell is the right idea; `ProtectedAuth` is the wrong name. Worse, the context lives in `$lib/auth.ts` even though it only makes sense inside the `(protected)` route group.

### Smell 3: core internals still think in `AuthIdentity | null`

```ts
// packages/auth/src/create-auth.ts
type GetAuthIdentity = () => AuthIdentity | null;

function authStateFromIdentity(
    identity: AuthIdentity | null,
    { nullState }: { nullState: 'pending' | 'signed-out' } = { nullState: 'signed-out' },
): AuthState { ... }

function identityFromAuthState(state: AuthState): AuthIdentity | null { ... }

handleBetterAuthSession(data, setState, getIdentity) {
    const nextIdentity = identityFromSession(next);
    const identityChanged = !identitiesEqual(getIdentity(), nextIdentity);
    setState(authStateFromIdentity(nextIdentity));
    if (identityChanged) persistIdentity(nextIdentity);
}
```

Public surface is `AuthState`; private surface still routes through nullable identity. The `nullState` options-bag parameter exists because the helper needs different defaults for "boot" vs "session emission." Three trivial helpers, one passed-through callback, one options-bag discriminator: all symptoms of the type drift between the inside and the outside.

## Asymmetric refusals

```
Refusal 1: top-level await on a signed-in predicate
  Deletes:
    - await waitForAuthState(..., status === 'signed-in') in 4 client.ts files
    - dead `if (state.status !== 'signed-in') throw` blocks under each
    - top-level export const <workspace> = open<App>(...)
  Replaces: each app exports a pure factory `open<App>ForIdentity(identity)`
            and a thin `<App>Provider` Svelte component constructs it inside
            the signed-in branch of a protected layout.
  User loss: signed-out users now see an AuthForm instead of a hung page.
            Net positive.

Refusal 2: @epicenter/auth-workspace as a shared package
  Deletes:
    - packages/auth-workspace/ (entire directory)
    - bindAuthWorkspaceScope imports in fuji, honeycrisp, opensidian, tab-manager
    - the drain state machine
  Replaces: inline auth.onStateChange handler inside each app's *Provider
            component. Each handler is 6 to 10 lines, app-specific.
  User loss: ~10 lines duplicated across 4 apps, but each app's policy is
            small and may diverge (zhongwen rotates keys; tab-manager
            re-registers device; reload-only apps just reload).

Refusal 3: parallel internal "identity" type inside core
  Deletes:
    - authStateFromIdentity (3 callers, all trivial)
    - identityFromAuthState (1 caller: getIdentity())
    - getIdentity callback parameter on handleBetterAuthSession + clearCredential
    - GetAuthIdentity type
    - the `nullState` options-bag parameter
    - the unread `boolean` return on setState
  Replaces: core passes AuthState end to end; cookie factory keeps a
            `lastPersisted` closure for change detection.
  User loss: none. ~40 line reduction in create-auth.ts.

Refusal 4: ProtectedAuth wrapper type
  Deletes:
    - ProtectedAuth type
    - getProtectedAuth/setProtectedAuth names
  Replaces: createContext<{ current: AuthIdentity }>() with
            getIdentityState/setIdentityState in
            apps/zhongwen/src/routes/(protected)/identity.ts.
            Consumers read `identityState.current.user.name`.
  User loss: rename churn at one consumer site.

Refusal 5: window.location.reload() inside ZhongwenWorkspaceProvider
  Deletes:
    - the reload branch on user-switch
  Replaces: trust {#key user.id} in the parent layout to remount.
  User loss: none. The {#key} already handles user-switch correctly.

Refusal 6: sign-in/+page.svelte rendering the form during pending
  Deletes:
    - unconditional <main>...</main> render
  Replaces: render-branch on auth.state.status with the same three arms
            the protected layout uses.
  User loss: none. Removes a brief flash.
```

## Grounding

### Other coding agent's review (verified)

A second agent independently flagged five of the six smells. Key agreements:

```
Agent A (this spec)            Agent B (independent)
─────────────────────────────  ──────────────────────────────────
TLA in 4 client.ts files       "Top-Level Wait Can Hang"
auth-workspace ceremony        "Auth-Workspace Converts State Backwards"
ProtectedAuth wrapper noise    "ProtectedAuth Wrapper Adds Noise"
sign-in page flash             "Sign-In Page Shows During Pending"
nullable-identity internals    "Core Auth Still Thinks In Identity"
```

Two minor disagreements:

- Cookie factory cleanup: Agent A favors a `lastPersisted` closure inside `createCookieAuth` (drops the callback entirely); Agent B favors keeping the callback but renaming `getIdentity` -> `getState` (state-native callback). Both eliminate the `AuthIdentity | null` projection. Agent A's option is one fewer indirection; Agent B's preserves the factory contract symmetry. Recorded as Open Question 1.

- `{#key}` vs reload: only Agent A flagged this. Independent verification still needed: confirm that `{#key user.id}` actually disposes the workspace via the provider's `onDestroy(() => zhongwen[Symbol.dispose]())`. Recorded as Open Question 2.

### DeepWiki on Svelte 5 `{#key}` blocks

```
Q: Does {#key} re-mount children, calling onDestroy and onMount on each
   key change?
A: Yes. The keyed block treats children as a new component instance per
   key; onDestroy fires for the previous instance, then onMount fires for
   the new one. State inside the children resets.
```

This confirms Refusal 5: `{#key user.id}` already provides "tear down workspace, build new workspace" on user switch, making the in-provider reload redundant.

### DeepWiki on Better Auth `useSession` settle behavior

(Inherited from predecessor spec, no change.) The atom emits a non-pending state on every cold-boot, signed-in or signed-out. So `await waitForAuthState(auth, status === 'signed-in')` only resolves for actually-signed-in users; signed-out users hang forever.

### Internal precedent: `WorkspaceGate`

`apps/fuji/src/routes/+layout.svelte:106` already shows the "wait on a workspace's `whenLoaded`" pattern via `<WorkspaceGate whenReady={fuji.whenLoaded}>`. The provider component pattern this spec adopts is the same shape, scaled up to own construction in addition to readiness.

## Design decisions

| Decision | Class | Choice | Rationale |
|---|---|---|---|
| Workspace construction location | 1 evidence | inside an `<AppProvider>` Svelte component, never at module top level | TLA on a signed-in predicate deadlocks signed-out users; the bug is observable with a logged-out cold boot |
| `client.ts` exports for each app | 2 coherence | `auth` (singleton), `open<App>ForIdentity(identity)` factory, optional `forget<App>Device` | Matches the zhongwen split: auth lives at module scope; workspace lives at component scope |
| Provider component shape | 2 coherence | takes `identity: AuthIdentity` prop, constructs workspace, sets context, owns `auth.onStateChange` listener and `onDestroy` | Same shape as `ZhongwenWorkspaceProvider`. Each app may diverge on the listener body |
| Apps that reload on every transition | 3 taste | still go through provider component, but the listener body is just `window.location.reload()` on signed-out / user-switch | Consistency wins over "we could have skipped the provider for these." One fewer pattern to learn |
| `auth-workspace` package | 2 coherence | delete after every consumer migrates to inline listener | Single shared utility for two different policies (key rotation vs reload) is a forced abstraction |
| Identity context (zhongwen) | 3 taste | move to `apps/zhongwen/src/routes/(protected)/identity.ts`; rename to `getIdentityState/setIdentityState`; value is `{ current: AuthIdentity }` | Context belongs to the route group that scopes it; wrapper name should describe shape, not "protected" |
| Cookie factory persist gate | Deferred | see Open Question 1 | Two viable shapes; pick after Wave 3 prototype |
| `{#key user.id}` vs reload | 2 coherence | keep `{#key}`, drop reload | DeepWiki confirms `{#key}` triggers onDestroy/onMount cleanly; reload is redundant |
| Sign-in page render branches | 2 coherence | three-arm render-branch matching protected layout | Same primitive, same shape; visible flash today |
| Drop `authStateFromIdentity` | 3 taste | delete; inline two trivial expressions at the three call sites | Helper carries a `nullState` discriminator that papers over the boot/emission distinction |
| Drop `identityFromAuthState` and `getIdentity()` | 3 taste | delete; let the cookie factory own its own change-detection state | Single caller, exists only to feed factory callbacks |
| Drop `setState`'s boolean return | 1 evidence | delete; verify no caller reads it | Verified: 0 readers in the current source |
| `openWebSocket` `state` getter parameter | 2 coherence | drop; cookie factory closes over its own auth state tracker | Same asymmetry as `getIdentity` callback; both transports should own their own credential state |

## Architecture

### Per-app file shape after migration

```
apps/<name>/src/
├── lib/
│   ├── auth.ts                      auth singleton + (zhongwen only) identity context
│   └── <name>/
│       ├── client.ts                exports `auth`, `open<Name>ForIdentity()`, hot-dispose
│       └── browser.ts               unchanged
└── routes/
    └── (protected)/                 (zhongwen pattern)
        ├── identity.ts              (zhongwen only) getIdentityState/setIdentityState
        ├── +layout.svelte           render-branch + goto on signed-out
        ├── <Name>WorkspaceProvider.svelte
        └── +page.svelte             reads identity via getIdentityState()
```

For apps WITHOUT a separate sign-in route (fuji, honeycrisp, opensidian, dashboard), the render-branch lives in the top-level `+layout.svelte` and the signed-out arm renders an `<AuthForm />` inline. No separate `(protected)` group needed unless the app grows one.

For apps that are not SvelteKit (tab-manager extension), the render-branch lives in the top-level `App.svelte` (`apps/tab-manager/src/entrypoints/sidepanel/App.svelte`).

### Top-level state flow

```
auth singleton (module scope, $lib/auth.ts)
   │
   │ auth.state: AuthState
   │ auth.onStateChange()
   ▼
+layout.svelte (or App.svelte)
   │
   ├─ pending  -> <Loading />
   ├─ signed-out -> goto('/sign-in')  OR inline <AuthForm />
   └─ signed-in -> <AppProvider identity={state.identity}>
                       │
                       │ workspace = open<App>ForIdentity(identity)
                       │ setIdentityState({ current: identity })  (zhongwen only)
                       │ onDestroy(() => workspace[Symbol.dispose]())
                       │ onStateChange listener for key rotation / device reload
                       ▼
                   children (read workspace via getWorkspace, identity via getIdentityState)
```

### Per-app provider listener policy

```
zhongwen           same-user-key-refresh: identityState.current = state.identity
                                          workspace.encryption.applyKeys(...)
                   user-switch:           {#key} handles it (no listener action)
                   sign-out:              layout's $effect goto('/sign-in')

fuji               sign-out:    window.location.reload()
honeycrisp         user-switch: window.location.reload()
opensidian
   (cookie apps with no key-rotation surface)

tab-manager        same-user:   workspace.encryption.applyKeys(...)
                                void registerDevice()
                   user-switch: window.location.reload()
                   sign-out:    window.location.reload()
                   (peer descriptor resolution moves into a loader component
                    upstream of the provider; see Open Question 3)
```

### Core internals after cleanup

```
type AuthCoreConfig = {
    baseURL?: string;
    initialIdentity: AuthIdentity | null;
    fetchOptions?: ...;
    handleBetterAuthSession(data: unknown, setState: SetAuthState): void;
    clearCredential(setState: SetAuthState): void;
    fetch(...): Promise<Response>;
    openWebSocket(url, protocols): WebSocket | null;
};

function createAuthCore({ initialIdentity, ... }): AuthClient {
    let state: AuthState = initialIdentity
        ? { status: 'signed-in', identity: initialIdentity }
        : { status: 'pending' };
    // ... no helpers, no getIdentity, no nullState param
}
```

Cookie factory closes over its own change-detection state:

```ts
function createCookieAuth({ baseURL, initialIdentity = null, saveIdentity }) {
    let lastPersisted: AuthIdentity | null = initialIdentity;
    function maybePersist(next: AuthIdentity | null) {
        if (identitiesEqual(lastPersisted, next)) return;
        lastPersisted = next;
        void Promise.resolve(saveIdentity?.(next)).catch(...);
    }

    return createAuthCore({
        baseURL,
        initialIdentity,
        handleBetterAuthSession(data, setState) {
            const next = bearerSessionFromBetterAuthSessionResponse(data);
            const identity = next ? { user: next.user, encryptionKeys: next.encryptionKeys } : null;
            setState(identity ? { status: 'signed-in', identity } : { status: 'signed-out' });
            maybePersist(identity);
        },
        clearCredential(setState) {
            setState({ status: 'signed-out' });
            maybePersist(null);
        },
        fetch(input, init) { ... },
        openWebSocket(url, protocols) {
            // close over auth state via a local tracker, OR check `state` via
            // a getter the core exposes back (see Open Question 1)
        },
    });
}
```

## Implementation plan

This spec follows Build, Prove, Remove. Waves 1 to 4 build the new pattern across all apps. Wave 5 verifies. Wave 6 deletes.

### Wave 1: zhongwen completes (low-risk warm-up)

- [ ] **1.1** Move identity context to `apps/zhongwen/src/routes/(protected)/identity.ts`. Export `getIdentityState`, `setIdentityState`. Value type: `{ current: AuthIdentity }`.
- [ ] **1.2** Update `ZhongwenWorkspaceProvider.svelte` to import from the new location. Rename `protectedAuth` -> `identityState`. Keep mutation pattern (`identityState.current = state.identity` on key refresh).
- [ ] **1.3** Update `apps/zhongwen/src/routes/(protected)/+page.svelte` import + read site (`identityState.current.user.name`).
- [ ] **1.4** Delete `ProtectedAuth`, `getProtectedAuth`, `setProtectedAuth` from `apps/zhongwen/src/lib/auth.ts`. The file shrinks to: import, `createCookieAuth(...)`, hot-dispose.
- [ ] **1.5** Drop `window.location.reload()` branch from the provider's `onStateChange` listener. Trust `{#key}` for user-switch.
- [ ] **1.6** Update `apps/zhongwen/src/routes/sign-in/+page.svelte` to render-branch on `auth.state.status` (pending / signed-out arms; no signed-in arm because the `$effect` redirects).

### Wave 2: cookie apps (fuji, honeycrisp, opensidian)

For each of these three apps:

- [ ] **2.x.1** In `client.ts`, replace TLA + throw + top-level `export const <app> = ...` with `export function open<App>ForIdentity(identity: AuthIdentity)`. Drop `bindAuthWorkspaceScope` import.
- [ ] **2.x.2** Create `apps/<app>/src/lib/components/<App>Provider.svelte`. Take `identity: AuthIdentity` and `children: Snippet` props. Construct workspace via `open<App>ForIdentity(identity)`. Set workspace context. `onDestroy(() => workspace[Symbol.dispose]())`. Inline `auth.onStateChange` listener with reload-on-anything-changed policy.
- [ ] **2.x.3** In `+layout.svelte`, render-branch on `auth.state.status`. Pending -> `<Loading />`. Signed-in -> `<<App>Provider identity={authState.identity}>{@render children()}</<App>Provider>`. Signed-out -> inline `<AuthForm />` (existing dashboard pattern).
- [ ] **2.x.4** Decide on `{#key}`. If user-switch is "reload anyway," skip `{#key}`. If user-switch should be "graceful in-tab," add `{#key authState.identity.user.id}` and drop reload from listener.

Apps in this wave: `fuji`, `honeycrisp`, `opensidian`.

### Wave 3: tab-manager (most complex; async peer descriptor)

- [ ] **3.1** In `apps/tab-manager/src/lib/tab-manager/client.ts`: drop TLA, drop throw, drop `bindAuthWorkspaceScope`, drop `await session.whenReady` at top level. Export `auth` and a factory that takes `identity` and an already-resolved `peer` descriptor.
- [ ] **3.2** Create a loader component (`TabManagerLoader.svelte`) that resolves `peer` and `await session.whenReady`, then renders `TabManagerProvider`. Use `{#await}`.
- [ ] **3.3** Create `TabManagerProvider.svelte`. Same shape as zhongwen's provider but with `void registerDevice()` in the same-user listener arm.
- [ ] **3.4** Update `apps/tab-manager/src/entrypoints/sidepanel/App.svelte` to render-branch on `auth.state.status`. Pending -> Spinner. Signed-in -> `<TabManagerLoader>`. Signed-out -> existing AuthForm-based UI.
- [ ] **3.5** Move `forgetTabManagerDevice` to inside the provider's setup (it needs `tabManager` in scope) or expose via the workspace context.

Open Question 3 covers the loader/provider split for the async peer.

### Wave 4: core internals (independent of waves 1-3, can land in parallel)

- [ ] **4.1** In `packages/auth/src/create-auth.ts`, delete `authStateFromIdentity`, `identityFromAuthState`, the `nullState` parameter pathway, the `GetAuthIdentity` type, the `getIdentity` callback parameter on `handleBetterAuthSession` and `clearCredential`. Inline initial state construction.
- [ ] **4.2** Drop the `boolean` return on `setState`. Verify with grep that no caller uses it.
- [ ] **4.3** Move cookie persist gate into `createCookieAuth` via a `lastPersisted` closure + `maybePersist(next)`. Drop the `getIdentity` arg.
- [ ] **4.4** Drop the `state: () => AuthState` parameter on `openWebSocket`. Cookie factory closes over its own auth state tracker (one approach) or core exposes a state-getter back to the factory at construction (another approach). See Open Question 1.
- [ ] **4.5** Update `packages/auth/src/contract.test.ts` and `packages/auth/src/create-auth.test.ts` for the new internal shape (public surface unchanged, so most tests stand).

### Wave 5: prove

- [ ] **5.1** Targeted typechecks: `@epicenter/auth`, `@epicenter/auth-svelte`, every migrated app.
- [ ] **5.2** Manual smoke matrix per app: cold-boot signed-out, cold-boot signed-in, sign-in flow, sign-out, key refresh (zhongwen + tab-manager only), user switch (across tabs), forget device.
- [ ] **5.3** `rg "bindAuthWorkspaceScope|waitForAuthState.*signed-in|getProtectedAuth|setProtectedAuth|ProtectedAuth"` in `apps/`. Expected: zero matches.

### Wave 6: remove

- [ ] **6.1** Confirm zero callers of `bindAuthWorkspaceScope`.
- [ ] **6.2** Delete `packages/auth-workspace/`.
- [ ] **6.3** Remove from monorepo workspace declarations and any `package.json` dependency lists.
- [ ] **6.4** Optionally narrow `waitForAuthState` to a `waitForSignedIn` helper if any non-app caller still uses the predicate pattern. If no such caller exists, leave `waitForAuthState` as a general primitive and delete `waitForAuthSettled` if unused.

## Edge cases

### Cold boot, signed-out user, was previously the deadlock

```
1. Module loads: $lib/<app>/client.ts evaluates immediately (no TLA).
   auth.state = { status: 'pending' }.
2. +layout.svelte mounts. Renders <Loading /> for the pending arm.
3. better-auth atom returns null. setState({ status: 'signed-out' }).
4. Layout re-renders. Signed-out arm: <AuthForm /> (or goto('/sign-in') for zhongwen).
5. User signs in. setState({ status: 'signed-in', identity }).
6. Layout re-renders. Signed-in arm constructs <AppProvider> and workspace.
```

### Sign-out from inside the app

```
1. await auth.signOut(). setState({ status: 'signed-out' }).
2. Provider's onDestroy fires (because layout's signed-in arm no longer matches).
   workspace[Symbol.dispose]() runs.
3. Layout's signed-out arm renders.
```

For reload-policy apps, the listener also fires `window.location.reload()`, which races with the natural unmount. The reload wins. Acceptable: same end state.

### User-switch in an in-tab session (cross-tab BroadcastChannel)

```
zhongwen flow (with {#key user.id}):
1. Tab B signs in as user-2.
2. Tab A's better-auth atom emits { user: user-2 }. setState fires.
3. Layout re-renders. {#key} sees a new key value.
4. Provider unmounts (onDestroy disposes user-1's workspace).
5. Provider remounts with identity={user-2}. Constructs user-2's workspace.

reload-policy app flow:
1-2. Same.
3. Provider's onStateChange listener detects user-id mismatch -> reload.
4. Page reloads with user-2.
```

Both flows correct. The choice between {#key} and reload is per-app, per Wave 2.x.4.

### Same-user key refresh (zhongwen)

```
1. better-auth emits same user, new encryption keys.
2. setState fires. {#key user.id} sees same key, no remount.
3. Provider's onStateChange listener: same user, different keys.
   identityState.current = state.identity.
   workspace.encryption.applyKeys(state.identity.encryptionKeys).
4. Components observing identityState see the new identity reactively.
```

This is the only flow where the mutable context cell `{ current: AuthIdentity }` matters.

### HMR on `client.ts`

```
1. import.meta.hot.dispose runs auth[Symbol.dispose]().
2. Module re-evaluates. New auth singleton created at pending.
3. better-auth atom replays cached session. setState fires.
4. Layout re-renders normally.
```

Workspace disposal is owned by the provider's onDestroy, not the module. So `client.ts` HMR no longer needs to dispose the workspace explicitly.

### HMR on a `<App>Provider.svelte`

```
1. Component remounts. onDestroy fires for old instance.
   Old workspace disposes.
2. New instance constructs a new workspace.
```

Brief flash of work but bounded. Same as today's zhongwen.

## Open questions

### Q1: Cookie factory's `openWebSocket` and persist gate, closure or callback?

Two options for breaking the `getIdentity` indirection:

- **(a) Closure:** Cookie factory keeps its own `lastPersisted` and tracks current auth identity via the factory callbacks (since they all flow through the cookie factory's bound `handleBetterAuthSession`). `openWebSocket` reads from the closure. Core has no `state` getter parameter.
- **(b) State-native callback:** Rename the callback `getIdentity` -> `getState`. Cookie factory still receives the getter, but now reads `AuthState` directly (no `AuthIdentity | null` projection).

**Recommendation:** (a). Removes one indirection entirely. The closure is a 5-line addition to `createCookieAuth` and removes 4 callback parameters across the core contract. (b) is a smaller diff but leaves the asymmetry between bearer (closure) and cookie (callback).

### Q2: Drop `{#key user.id}` in zhongwen, or keep it?

- (a) Keep `{#key}`, trust it for user-switch. Drop reload from listener (this spec's plan).
- (b) Drop `{#key}`, keep reload as the one user-switch policy.

**Recommendation:** (a). `{#key}` is the Svelte-native expression of "reset this subtree on identity change." It composes with provider's `onDestroy` for clean disposal. Reload is heavyweight and discards unrelated state.

Verify before choosing: does `{#key}`'s remount cleanly tear down the y-doc, idb connection, and sync attachment via the provider's `onDestroy(() => zhongwen[Symbol.dispose]())`? If any of those leak across remounts, fall back to (b).

### Q3: Tab-manager peer descriptor, loader component or factory parameter?

The tab-manager workspace needs `peer` (id + name + platform), which requires async chrome.storage and platform-info reads. Today these run at module scope before `openTabManager`.

- (a) Loader component (`TabManagerLoader.svelte`): does `await session.whenReady` and `await peerPromise` inside `{#await}`, then renders `TabManagerProvider` with both resolved values.
- (b) Factory accepts a peer-descriptor promise; provider awaits it via `whenLoaded` semantics.
- (c) Refactor `attachAwareness` to support a deferred peer descriptor.

**Recommendation:** (a). Same recommendation as the predecessor spec's Q4. Keeps the existing awareness invariant ("peer descriptor exists before presence publishes") intact and uses Svelte's `{#await}` block as the suspense primitive.

### Q4: Sign-in page in zhongwen, signed-in arm or just `$effect` redirect?

- (a) Three-arm render-branch: pending -> Loading, signed-out -> form, signed-in -> nothing (effect redirects). Brief blank frame for the signed-in case.
- (b) Two-arm render-branch as planned.

**Recommendation:** (b). The signed-in arm would render nothing useful; the `$effect` redirect handles it. Keeps the render-branch parallel with the protected layout.

### Q5: Should each app's "reload on transition" policy be a small shared utility?

Three of the four migrated apps will have the same listener body:

```ts
auth.onStateChange((state) => {
    if (state.status === 'pending') return;
    if (state.status === 'signed-out') return window.location.reload();
    if (state.identity.user.id !== identity.user.id) return window.location.reload();
    workspace.encryption.applyKeys(state.identity.encryptionKeys);
});
```

- (a) Inline in each provider (this spec's plan).
- (b) Extract a `reloadOnAuthChange(auth, identity, workspace)` helper into `@epicenter/svelte` or `@epicenter/auth-svelte`.

**Recommendation:** (a) for now. Three duplications are not yet a forced abstraction. Revisit when a 5th app appears or when a 4th wants to diverge.

## Decisions Log

- Keep `waitForAuthState` as a general primitive after Wave 6: the predicate-based shape may still be useful for tests and bootstrap modules even after the four TLA call sites are gone. Revisit when: it has zero callers across `packages/` and `apps/` for two weeks of normal development.

- Keep `usersEqual` in `packages/auth/src/create-auth.ts`: only called by `identitiesEqual`, but documents the per-field comparison shape and is short. Revisit when: a second comparator wants to share field-equality logic.

- Keep `auth-svelte` package separate from `auth` (don't fold the wrapper into `auth`): the Svelte rune dependency would force every consumer of `auth` to install Svelte. Revisit when: a non-Svelte consumer needs a reactive shadow.

## Success criteria

- [ ] No top-level `await waitForAuthState(...)` in any `apps/*/src/lib/**/client.ts`.
- [ ] No `bindAuthWorkspaceScope` imports anywhere in `apps/`.
- [ ] `packages/auth-workspace/` deleted.
- [ ] `apps/zhongwen/src/lib/auth.ts` contains no `ProtectedAuth` type or related context exports.
- [ ] `apps/zhongwen/src/routes/(protected)/identity.ts` exists and owns the identity context for the protected route group.
- [ ] `packages/auth/src/create-auth.ts` has no `authStateFromIdentity`, no `identityFromAuthState`, no `GetAuthIdentity`, no `nullState` parameter, no `getIdentity` callback parameter, no `boolean` return on `setState`.
- [ ] Sign-in page in zhongwen render-branches on `auth.state.status`.
- [ ] Signed-out cold boot in every migrated app shows an AuthForm or sign-in route within one frame, never hangs.
- [ ] User-switch in zhongwen triggers `{#key}` remount only (no `window.location.reload()` from the provider).
- [ ] Manual smoke matrix passes for cold-boot signed-out, cold-boot signed-in, sign-in, sign-out, key refresh, user switch, forget device, on each app.

## References

- `specs/20260505T080000-auth-state-machine-and-gated-identity-context.md` (predecessor; this spec finishes its waves 6 and 7 and adds the cleanups it deferred to "follow-up")
- `packages/auth/src/create-auth.ts` (core to simplify)
- `packages/auth-svelte/src/create-auth.svelte.ts` (unchanged by this spec; verifies the wrapper still spreads correctly after core changes)
- `packages/auth-workspace/src/index.ts` (deleted in wave 6)
- `apps/zhongwen/src/lib/auth.ts` (shrinks; identity context removed)
- `apps/zhongwen/src/routes/(protected)/+layout.svelte` (template for the render-branch + goto pattern)
- `apps/zhongwen/src/routes/(protected)/ZhongwenWorkspaceProvider.svelte` (template for the provider pattern; reload branch removed in wave 1.5)
- `apps/zhongwen/src/routes/sign-in/+page.svelte` (render-branch fix in wave 1.6)
- `apps/dashboard/src/routes/+layout.svelte` (template for inline AuthForm signed-out arm)
- `apps/fuji/src/lib/fuji/client.ts` (wave 2 migration)
- `apps/honeycrisp/src/lib/honeycrisp/client.ts` (wave 2)
- `apps/opensidian/src/lib/opensidian/client.ts` (wave 2)
- `apps/tab-manager/src/lib/tab-manager/client.ts` (wave 3)
- `apps/tab-manager/src/entrypoints/sidepanel/App.svelte` (wave 3 render-branch)
- `apps/fuji/src/routes/+layout.svelte:106` (`<WorkspaceGate>` precedent for component-scoped readiness)
