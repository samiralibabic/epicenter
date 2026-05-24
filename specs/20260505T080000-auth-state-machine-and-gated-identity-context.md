# Auth state machine and state adapters

**Date**: 2026-05-05
**Status**: Partially implemented (waves 1 to 5 landed for zhongwen and dashboard; waves 6 to 7 deferred and superseded)
**Author**: AI-assisted, grounded against DeepWiki (Svelte 5, SvelteKit, Better Auth), live code in `packages/auth`, `packages/auth-svelte`, `packages/auth-workspace`, `packages/workspace/src/document/attach-sync.ts`, and the consumer apps zhongwen, dashboard, tab-manager
**Branch**: feat/encrypted-local-workspace-storage
**Follows**: `specs/20260505T060000-zhongwen-context-and-listener-collapse.md`
**Superseded by (waves 6 to 7 + cleanup)**: `specs/20260505T100000-auth-state-machine-cleanup-and-provider-migration.md`

## One-sentence thesis

`@epicenter/auth` exposes one canonical store (`state: AuthState` discriminated union) with one subscriber (`onStateChange`); the Svelte wrapper shadows `state` with a runes-backed reactive getter; SvelteKit routes, imperative runtimes, and load-style gates use small adapters built from those two primitives.

## Why this spec exists

The current shape encodes three states in two values:

```
identity: AuthIdentity | null        null can mean "checking" OR "signed-out"
whenReady: Promise<void>             exists only to disambiguate the null
```

`whenReady` is not a Better Auth primitive. It is our adapter's translation of "the better-auth atom emitted a non-pending state" into a Promise. Once `state` is exposed directly, the Promise is redundant: branching on `state.status` is more explicit, and the `await whenReady; if (auth.identity) ...` route gate is two indirections for one decision.

The cost of the current shape, traced across the codebase:

```
where it leaks                                  what it forces
──────────────────────────────────────────────  ─────────────────────────────
(protected)/+layout.ts in zhongwen              await auth.whenReady before
                                                 the redirect check
sign-in/+page.ts                                 same await ceremony for the
                                                 inverse redirect
bindAuthWorkspaceScope (auth-workspace)          let appliedUserId tracker to
                                                 detect cold-boot vs sign-out
tab-manager client.ts                            await auth.whenReady; throw
                                                 if identity null (TLA)
dashboard +layout.svelte                         {#if identity} flickers
                                                 <AuthForm /> on cold boot
account-popover.svelte                           $derived(auth.identity) re-
                                                 narrowing inside signed-in arm
zhongwen ZhongwenWorkspace.svelte                {identity.user.name} reads
                                                 from data prop drilled
                                                 from load()
```

Each of these works. Together they are seven sites paying for one missing distinction (pending vs signed-out). The fix is one design move: make state the canonical thing.

## Asymmetric refusals

```
Refusal 1: whenReady promise on the public surface
  Deletes:
    - whenReady field on AuthClient
    - resolveReady plumbing in createAuthCore
    - await auth.whenReady in (protected)/+layout.ts and sign-in/+page.ts
    - the "what is whenReady" question every reader asks
  Replaces: state.status === 'pending' branch in markup; first non-pending
            emission updates state, render-branch responds reactively
  User loss: route guards previously awaited; now they render <Loading />
            during cold boot. Same wallclock duration, different UI nesting.

Refusal 2: identity projection on the vanilla core
  Deletes:
    - get identity() on AuthClient
    - identitiesEqual (folds into statesEqual)
    - the parallel-field invariant ("identity null iff status signed-out")
  Replaces: state.identity inside the signed-in arm of the discriminated
            union; type-narrowed non-null automatically
  User loss: every auth.identity read updates to state.status check;
            type system enforces narrowing, no optional chains needed.

Refusal 3: onChange(identity) callback shape
  Deletes:
    - onChange field on AuthClient
    - bindAuthWorkspaceScope's appliedUserId tracking
    - bindAuthWorkspaceScope's drain state machine for cold-boot detection
  Replaces: onStateChange((state: AuthState) => void); transitions are
            explicit by reading next.status (and prev cached locally if
            needed)
  User loss: existing onChange consumers update; in most cases code reads
            cleaner because the status discriminant is visible.

Refusal 4: identity getter and identity context as phase-1 primitives
  Deletes:
    - getAuthIdentity(auth) as a required helper
    - <SignedIn> and getIdentity() from the required migration
    - identity context as the default read path
  Replaces: explicit state.status narrowing at the boundary that needs
            identity; apps may pass identity as a prop or create an
            app-local context later if repetition proves real
  User loss: some signed-in descendants keep a prop. Acceptable because
            the primitive stays smaller and sharper helpers are avoided.

Refusal 5: route loader ceremony for the auth gate
  Deletes:
    - (protected)/+layout.ts (or shrinks to one synchronous status check, see Open Q3)
    - sign-in/+page.ts
    - the await ceremony shared between them
  Replaces: render-branch in (protected)/+layout.svelte and an
            $effect(onStateChange) that calls goto on signed-out
  User loss: brief frame of <Loading /> on cold boot before status settles
            (acceptable; today it shows whenReady-pending state for the
            same wallclock duration, just inside load() rather than render).

Refusal 6: whenReady as a core primitive, but not await helpers
  Deletes:
    - readonly whenReady on AuthClient
  Replaces: waitForAuthState(auth, predicate) and waitForAuthSettled(auth)
            helper functions built from auth.state + auth.onStateChange
  User loss: callers import a helper when they genuinely need await-style
            composition. The helper is explicit about waiting for state.

Refusal 7: bindAuthWorkspaceScope as a shared utility
  Deletes:
    - packages/auth-workspace entirely
  Replaces: inline auth.onStateChange listener in each app's *Provider
            component (zhongwen ZhongwenProvider, tab-manager
            TabManagerProvider, future apps follow suit)
  User loss: code duplication of about 10 lines per app for the
            same-user-key-refresh / user-switch / sign-out branches.
            Acceptable: each app's transition policy is small and may
            diverge (zhongwen reloads on user-switch; tab-manager could
            choose differently).
```

## Grounding

### DeepWiki on Better Auth's `useSession`

```
Q: When does the atom emit during background refresh?
A: Polling (refetchInterval), focus, online, BroadcastChannel, 401,
   needsRefresh, after sign-in/out. data flips null -> user -> null only
   on 401 or sign-out. Background revalidation preserves data
   (stale-while-revalidate). Bearer token rotation: atom emits on
   set-auth-token rotation.

Q: isPending vs isRefetching?
A: isPending = first fetch with data === null.
   isRefetching = any background refetch (data preserved).
```

Our existing wrapper already refuses to surface `error / isPending / isRefetching / refetch`. The new state machine adds back exactly one bit of information from the atom: a `pending` discriminant. This preserves the asymmetric refusal.

### DeepWiki on Svelte 5 `createContext`

```
Q: When can setContext be called?
A: Only during synchronous component initialization. NOT in $effect, event
   handlers, or after await. Throws set_context_after_init otherwise.

Q: What error does get throw if no parent has set it?
A: missing_context: "Context was not set in a parent component"
```

Implication: do not make context mutation the auth transition mechanism.
If a specific app wants identity context later, it must register the context
synchronously and expose reactive getters or app-owned provider state. Phase 1
does not need this.

### DeepWiki on SvelteKit static SPA route gating

```
Q: Best pattern for route gating in adapter-static + ssr=false?
A: redirect() inside +layout.ts load() is canonical; alternatives
   (render-branch, $effect+goto) work but have flash-of-content risk
   if you don't render a pending branch.

Q: Does load() rerun on internal navigation in an SPA?
A: Yes, on initial boot AND internal navigation.
```

Our refinement: render-branch with `{#if pending}<Loading />` IS the suspense boundary; no flash. The synchronous `+layout.ts` becomes optional for warm-nav URL accuracy (Open Question 3).

### Internal precedent: `SyncAttachment`

`packages/workspace/src/document/attach-sync.ts:87` already exposes the shape we are converging on:

```
type SyncStatus =
  | { phase: 'offline' }
  | { phase: 'connecting'; retries: number; lastError?: SyncError }
  | { phase: 'connected' }
  | { phase: 'failed'; reason: SyncFailedReason };

readonly status: SyncStatus;
onStatusChange: (listener: (status: SyncStatus) => void) => () => void;
```

The auth shape mirrors this: discriminated union, getter for current value, `onStateChange` for transitions.

## Design decisions

| Decision | Class | Choice | Rationale |
|---|---|---|---|
| State shape | 1 evidence | discriminated union (`status` discriminant + `identity` field on signed-in) | Type-narrows `identity` to non-null inside signed-in arm; no parallel-field invariants to document |
| `state` access on core | 2 coherence | readonly getter property (`auth.state`) | Idiomatic for state-machine snapshot; matches `SyncAttachment.status`; clean to shadow in Svelte wrapper |
| `state` access on Svelte wrapper | 2 coherence | shadow with `get state() { return $state-backed }` | Spread base methods, override `state` with reactive getter |
| `identity` projection on core | 3 taste | dropped | Redundant with `state.identity`; deletes ambiguity vector |
| `identity` projection on Svelte wrapper | 3 taste | dropped | Same reasoning; consumers can write a one-line `$derived` if they want |
| `onStateChange` shape | 2 coherence | `(state: AuthState) => void` | Whole-state callback enables transition detection (caller compares to prev cached value) |
| `whenReady` | 1 evidence | dropped | Derived from state machine; explicit branching is more honest |
| `onChange(identity)` | 3 taste | dropped | Redundant with onStateChange; transitions are explicit |
| Identity getter | 3 taste | do not add as required surface | It is intentionally sharp and not worth making a shared primitive. Consumers can narrow `auth.state` where identity is needed. |
| Identity context | 3 taste | defer | App-local context may be useful later, but phase 1 should prove the state model first. |
| Await helper | 2 coherence | add `waitForAuthState` and `waitForAuthSettled` as derived helpers | Keeps `whenReady` off the core surface while supporting `load.ts`, startup, and tests that naturally compose with `await`. |
| Route gate (SvelteKit apps) | 3 taste | render-branch in `+layout.svelte` + `$effect(onStateChange)` for goto | Pure component-side; sub-variant C2 keeps optional 1-line synchronous `+layout.ts` for warm-nav URL accuracy |
| Route gate (Tab Manager / extensions) | 1 evidence | render-branch only | No URL routing in side panels; goto is N/A |
| `auth-workspace` package | 2 coherence | deleted | Single consumer (Tab Manager); replaced by inline onStateChange listener in TabManagerProvider |

## Architecture

### Vanilla core (`packages/auth/src/create-auth.ts`)

```ts
export type AuthStatus = 'pending' | 'signed-in' | 'signed-out';

export type AuthState =
  | { status: 'pending' }
  | { status: 'signed-in'; identity: AuthIdentity }
  | { status: 'signed-out' };

export type AuthClient = {
  readonly state: AuthState;
  onStateChange(fn: (state: AuthState) => void): () => void;
  signIn(input): Promise<Result<undefined, AuthError>>;
  signUp(input): Promise<Result<undefined, AuthError>>;
  signOut(): Promise<Result<undefined, AuthError>>;
  signInWithIdToken(input): Promise<Result<undefined, AuthError>>;
  signInWithSocialRedirect(input): Promise<Result<undefined, AuthError>>;
  fetch(input, init?): Promise<Response>;
  openWebSocket(url, protocols?): WebSocket | null;
  [Symbol.dispose](): void;
};
```

Internal:

```ts
function createAuthCore({ ... }): AuthClient {
  let state: AuthState = { status: 'pending' };
  const stateListeners = new Set<(state: AuthState) => void>();

  function setState(next: AuthState) {
    if (statesEqual(state, next)) return;
    state = next;
    for (const fn of stateListeners) {
      try { fn(next); } catch (e) { console.error('[auth] subscriber threw:', e); }
    }
  }

  // bearer/cookie factories' handleBetterAuthSession adapters call
  // setState({ status: 'signed-in', identity }) or setState({ status: 'signed-out' })

  betterAuthClient.useSession.subscribe((s) => {
    if (s.isPending) return;
    handleBetterAuthSession(s.data, setState);
  });

  return {
    get state() { return state; },
    onStateChange(fn) {
      stateListeners.add(fn);
      return () => { stateListeners.delete(fn); };
    },
    // signIn, signOut, etc. (unchanged)
    [Symbol.dispose]() {
      unsubscribeBetterAuth();
      stateListeners.clear();
    },
  };
}

function statesEqual(a: AuthState, b: AuthState): boolean {
  if (a.status !== b.status) return false;
  if (a.status === 'signed-in' && b.status === 'signed-in') {
    return identitiesEqual(a.identity, b.identity);
  }
  return true;
}
```

### Svelte wrapper (`packages/auth-svelte/src/create-auth.svelte.ts`)

```ts
function createReactiveAuth(base: BaseAuthClient): AuthClient {
  let state = $state(base.state);

  const unsubscribe = base.onStateChange((next) => { state = next; });

  return {
    ...base,
    get state() { return state; },
    [Symbol.dispose]() {
      unsubscribe();
      base[Symbol.dispose]();
    },
  } satisfies AuthClient;
}
```

Spread copies `onStateChange`, `signIn`, `signOut`, `fetch`, `openWebSocket` unchanged. The getter override shadows `state` with a reactive value.

### Await helpers (`packages/auth/src/wait-for-auth-state.ts`)

```ts
import type { AuthClient, AuthState } from './create-auth';

export function waitForAuthState(
  auth: AuthClient,
  predicate: (state: AuthState) => boolean,
): Promise<AuthState> {
  if (predicate(auth.state)) return Promise.resolve(auth.state);

  return new Promise((resolve) => {
    const unsubscribe = auth.onStateChange((state) => {
      if (!predicate(state)) return;
      unsubscribe();
      resolve(state);
    });
  });
}

export function waitForAuthSettled(auth: AuthClient) {
  return waitForAuthState(auth, (state) => state.status !== 'pending');
}
```

These helpers are adapters, not core state. They are appropriate for
`load.ts`, bootstrap modules, tests, and vanilla entrypoints that need to
compose auth with other asynchronous work. Svelte components should usually
read the reactive `auth.state` getter instead.

### Zhongwen `(protected)/+layout.svelte`

```svelte
<script lang="ts">
  import { goto } from '$app/navigation';
  import { Spinner } from '@epicenter/ui/spinner';
  import { auth } from '$lib/auth';
  import ZhongwenProvider from './ZhongwenProvider.svelte';

  let { children } = $props();

  $effect(() => auth.onStateChange((state) => {
    if (state.status === 'signed-out') {
      void goto('/sign-in', { replaceState: true });
    }
  }));
</script>

{#if auth.state.status === 'pending'}
  <div class="flex h-dvh items-center justify-center"><Spinner /></div>
{:else if auth.state.status === 'signed-in'}
  <ZhongwenProvider identity={auth.state.identity}>
    {@render children()}
  </ZhongwenProvider>
{/if}
```

### Zhongwen `(protected)/ZhongwenProvider.svelte`

```svelte
<script lang="ts">
  import { onDestroy, type Snippet } from 'svelte';
  import { auth } from '$lib/auth';
  import type { AuthIdentity } from '@epicenter/auth';
  import { openZhongwen, setZhongwen } from '$lib/zhongwen/browser';

  let { identity, children }: {
    identity: AuthIdentity;
    children: Snippet;
  } = $props();

  const zhongwen = openZhongwen({ identity });
  setZhongwen(zhongwen);
  onDestroy(() => zhongwen[Symbol.dispose]());

  $effect(() => auth.onStateChange((state) => {
    if (state.status !== 'signed-in') return;
    if (state.identity.user.id !== identity.user.id) {
      window.location.reload();
      return;
    }
    zhongwen.encryption.applyKeys(state.identity.encryptionKeys);
  }));
</script>

{@render children()}
```

### Zhongwen `sign-in/+page.svelte`

```svelte
<script lang="ts">
  import { goto } from '$app/navigation';
  import { Button } from '@epicenter/ui/button';
  import { Spinner } from '@epicenter/ui/spinner';
  import { auth } from '$lib/auth';

  let submitError = $state<string | null>(null);

  $effect(() => auth.onStateChange((state) => {
    if (state.status === 'signed-in') {
      void goto('/', { replaceState: true });
    }
  }));

  async function signInWithGoogle() {
    const { error } = await auth.signInWithSocialRedirect({
      provider: 'google',
      callbackURL: window.location.origin,
    });
    if (error) submitError = error.message;
  }
</script>

{#if auth.state.status === 'pending'}
  <Spinner />
{:else if auth.state.status === 'signed-out'}
  <main>
    {/* sign-in form */}
  </main>
{/if}
```

### Tab Manager `client.ts`

```ts
import { createBearerAuth } from '@epicenter/auth-svelte';
import { APP_URLS } from '@epicenter/constants/vite';
import { session } from '$lib/auth';
import { openTabManager } from './extension';

await session.whenReady;  // chrome.storage hydration is genuinely async

export const auth = createBearerAuth({
  baseURL: APP_URLS.API,
  sessionStorage: session,
});

// no await auth.whenReady; no throw if identity null
// the App.svelte renders Loading/SignIn while pending/signed-out

if (import.meta.hot) {
  import.meta.hot.dispose(() => auth[Symbol.dispose]());
}
```

Workspace construction moves into a `<TabManagerProvider>` component that
receives `identity={auth.state.identity}` from the signed-in render branch.
See Open Question 4 for the exact shape.

### Tab Manager `App.svelte` (top-level)

```svelte
<script lang="ts">
  import { auth } from '$lib/tab-manager/client';
  import TabManagerProvider from '$lib/tab-manager/TabManagerProvider.svelte';
  import AuthForm from './AuthForm.svelte';
  import Loading from './Loading.svelte';
</script>

{#if auth.state.status === 'pending'}
  <Loading />
{:else if auth.state.status === 'signed-in'}
  <TabManagerProvider identity={auth.state.identity}>
    {/* the existing UnifiedTabList tree */}
  </TabManagerProvider>
{:else}
  <AuthForm {auth} ... />
{/if}
```

### Dashboard `+layout.svelte`

```svelte
<script lang="ts">
  import { AuthForm } from '@epicenter/svelte/auth-form';
  import { Spinner } from '@epicenter/ui/spinner';
  import { auth } from '$lib/auth';
  // ...
</script>

{#if auth.state.status === 'pending'}
  <Spinner />
{:else if auth.state.status === 'signed-in'}
  {@const identity = auth.state.identity}
  {/* header and content can pass identity.user where needed */}
{:else}
  <AuthForm {auth} ... />
{/if}
```

## Lifecycle flows

### Cold boot, signed-in user navigates to /

```
1. $lib/auth.ts evaluated -> const auth = createCookieAuth(...)
   auth.state = { status: 'pending' }
2. SvelteKit boots; (protected)/+layout.svelte mounts
3. Render: state.status === 'pending' -> <Spinner />
4. better-auth atom settles, returns session
5. setState({ status: 'signed-in', identity })
6. Svelte wrapper's $state updates; (protected)/+layout.svelte re-renders
7. Render hits {:else if signed-in}:
   <ZhongwenProvider identity={state.identity}>
     {@render children()}
   </ZhongwenProvider>
8. (protected)/+page.svelte mounts; getZhongwen() returns the workspace
```

### Sign-out

```
1. UI: await auth.signOut()
2. setState({ status: 'signed-out' })
3. (protected)/+layout.svelte's $effect fires:
   onStateChange callback -> goto('/sign-in', { replaceState: true })
4. Render re-runs: status signed-out hits no branch (or empty {:else})
   <ZhongwenProvider> unmounts
   onDestroy fires -> zhongwen[Symbol.dispose]() -> ydoc.destroy()
5. SvelteKit unmounts (protected) layout, mounts sign-in/+page.svelte
```

### Same-user key refresh (background revalidation)

```
1. better-auth atom emits new session with rotated encryptionKeys
2. setState({ status: 'signed-in', identity: { ...prev.user, encryptionKeys: new } })
3. statesEqual check: status same, but identity.encryptionKeys different
   -> not equal, fires
4. Both layout's $effect AND ZhongwenProvider's $effect fire
5. Layout: state.status === 'signed-in', no goto needed
6. Provider: state.identity.user.id === identity.user.id
   -> zhongwen.encryption.applyKeys(state.identity.encryptionKeys)
7. Workspace continues without remount
```

### Cross-tab user switch

```
1. Tab B signs in as different user; cookie updates
2. better-auth atom in Tab A re-fetches via BroadcastChannel signal
3. setState({ status: 'signed-in', identity: <new user> })
4. ZhongwenProvider $effect: state.identity.user.id !== identity.user.id
   -> window.location.reload()
5. Fresh page load
```

### Forget device

```
1. UI: await zhongwen.wipe()
   (disposes doc, awaits idb close, deletes IndexedDB database)
2. UI: await auth.signOut()
3. setState({ status: 'signed-out' }) cascades as in sign-out flow
```

## Implementation plan

### Wave 1: vanilla core

- [ ] **1.1** Add `AuthState` discriminated union to `packages/auth/src/auth-types.ts`.
- [ ] **1.2** In `create-auth.ts`, replace `let identity` + `whenReady` with `let state: AuthState = { status: 'pending' }`.
- [ ] **1.3** Add `setState()` helper; remove `setIdentity`, `identitiesEqual` callsite-level (keep helper as input to `statesEqual`), and `resolveReady` plumbing.
- [ ] **1.4** Replace `onChange` listeners set with `stateListeners`; rename method to `onStateChange`.
- [ ] **1.5** Update `AuthClient` public type: drop `identity` and `whenReady`; add `state` getter and `onStateChange`.
- [ ] **1.6** Update bearer factory's `applyBearerSession`: when parsed null, call `setState({ status: 'signed-out' })`; otherwise `setState({ status: 'signed-in', identity: { user, encryptionKeys } })`.
- [ ] **1.7** Update cookie factory's `handleBetterAuthSession` similarly.
- [ ] **1.8** Update `clearCredential` to call `setState({ status: 'signed-out' })`.
- [ ] **1.9** Update `packages/auth/src/contract.test.ts` and any other tests.

### Wave 2: Svelte wrapper

- [ ] **2.1** Replace `let identity = $state(...)` with `let state = $state(base.state)`.
- [ ] **2.2** Replace `base.onChange(...)` with `base.onStateChange(...)`.
- [ ] **2.3** Spread base methods; override `state` with reactive getter; do NOT add `identity` projection.

### Wave 3: await helpers

- [ ] **3.1** Add `waitForAuthState(auth, predicate)` in `packages/auth`.
- [ ] **3.2** Add `waitForAuthSettled(auth)` as a small helper over `waitForAuthState`.
- [ ] **3.3** Export both helpers from `packages/auth/src/index.ts`.
- [ ] **3.4** Use these helpers only where an `await` composition is genuinely useful, such as `load.ts`, tests, and bootstrap modules. Do not use them inside normal Svelte render branches.

### Wave 4: Zhongwen migration

- [ ] **4.1** Delete `apps/zhongwen/src/routes/(protected)/+layout.ts`.
- [ ] **4.2** Delete `apps/zhongwen/src/routes/sign-in/+page.ts`.
- [ ] **4.3** Rewrite `(protected)/+layout.svelte` to render-branch + $effect goto.
- [ ] **4.4** Create `(protected)/ZhongwenProvider.svelte` with workspace construction and an `identity: AuthIdentity` prop.
- [ ] **4.5** Update `sign-in/+page.svelte` to render-branch + $effect goto-on-signed-in.
- [ ] **4.6** Update `(protected)/+page.svelte` to read `getZhongwen()` (already does). If it still needs user display data, pass that from the layout or expose it through the zhongwen workspace handle rather than adding shared auth identity context.
- [ ] **4.7** Confirm `chat-state.svelte.ts` does not need identity directly (today it uses `auth.fetch` only).

### Wave 5: Dashboard migration

- [ ] **5.1** Update `apps/dashboard/src/routes/+layout.svelte`: replace `{#if identity}` with three-way render-branch on `auth.state.status`.
- [ ] **5.2** Use `auth.state.identity.user` in the signed-in branch and pass `user` to `UserMenu`.
- [ ] **5.3** Do not introduce shared identity context in dashboard unless a real prop-drilling problem appears during migration.

### Wave 6: Tab Manager migration

- [ ] **6.1** Remove `await auth.whenReady; if (!identity) throw` from `client.ts`.
- [ ] **6.2** Migrate workspace construction into `<TabManagerProvider identity={auth.state.identity}>` using a loader/provider split if `openTabManager` remains async.
- [ ] **6.3** Update `App.svelte` to render-branch on `auth.state.status`.
- [ ] **6.4** Replace `bindAuthWorkspaceScope` with inline `auth.onStateChange` listener in TabManagerProvider.

### Wave 7: Delete `@epicenter/auth-workspace`

- [ ] **7.1** Confirm zero callers of `bindAuthWorkspaceScope` (after Wave 6).
- [ ] **7.2** Delete `packages/auth-workspace/`.
- [ ] **7.3** Remove from monorepo workspace declarations.

### Wave 8: Verify

- [ ] **8.1** Targeted typechecks: `@epicenter/auth`, `@epicenter/auth-svelte`, each app.
- [ ] **8.2** Manual smoke: cold boot, sign-in, sign-out, key refresh, user switch, forget device. Per app: zhongwen, dashboard, tab-manager.
- [ ] **8.3** `rg` for `whenReady`, `auth.identity`, `onChange(` in `apps/`. Remaining matches must be unrelated (workspace `whenLoaded`, `sync.onStatusChange`, etc.).

## Edge cases

### Context compatibility

DeepWiki: `setContext` must run during synchronous component init. This spec
does not use context as the phase-1 auth transport, so auth transitions never
try to call `setContext` from `$effect` or an async callback.

If a later app introduces identity context, the context value should be set
once during component initialization. It should either receive a stable handle
with reactive getters or live inside an app-specific provider that owns its
state. Do not set context in response to `onStateChange`.

### HMR

- Editing `$lib/auth.ts`: `import.meta.hot.dispose` runs `auth[Symbol.dispose]()`. Components re-import the new module; new state machine starts at pending; better-auth atom re-fetches.
- Editing `<ZhongwenProvider>`: re-mounts. `onDestroy` disposes the workspace; new instance constructs a fresh workspace. Brief flash of work but bounded.

### Direct nav to /protected while signed-out (cold boot)

```
1. User pastes /protected/some/page in URL bar
2. SvelteKit boots; auth.state = pending
3. (protected)/+layout.svelte mounts; renders <Spinner />
4. better-auth atom returns null (no cookie); setState({ status: 'signed-out' })
5. $effect fires: goto('/sign-in', { replaceState: true })
6. URL changes; sign-in page mounts
```

Brief frame at /protected URL showing Spinner. Acceptable. (To eliminate, see Open Q3.)

### Direct nav to /protected while signed-out (warm)

```
1. User is on /sign-in (signed-out); types /protected in URL bar
2. SvelteKit navigates; (protected)/+layout.svelte mounts
3. auth.state already signed-out; render hits no branch
4. $effect fires: goto('/sign-in')
5. URL changes back
```

Brief frame at /protected URL showing nothing. Acceptable for SPA. Open Q3 covers the C2 fix (one-line synchronous +layout.ts).

### Direct nav to /sign-in while signed-in

```
1. Signed-in user types /sign-in in URL bar
2. sign-in/+page.svelte mounts
3. auth.state already signed-in; render hits no branch (no signed-in branch in sign-in page)
4. $effect fires: goto('/', { replaceState: true })
5. URL changes
```

Same flicker pattern. Same C2 fix applies (synchronous status check in `(public)/+layout.ts` if it exists).

## Open questions

### Q1: Drop `identity` projection on Svelte wrapper too?

- (a) Drop entirely.
- (b) Keep as `$derived(state.status === 'signed-in' ? state.identity : null)` projection.

**Recommendation**: (a). State is canonical; the projection re-creates the ambiguity. If a caller wants identity-only access, they write a one-liner: `const identity = $derived(auth.state.status === 'signed-in' ? auth.state.identity : null)`.

### Q2: Shared identity context now or later?

- (a) No shared identity context in phase 1. Narrow `auth.state` and pass identity or user into the component that needs it.
- (b) Add app-local identity context only after a migration shows repeated prop drilling.
- (c) Add shared `@epicenter/auth-svelte` identity context now.

**Recommendation**: (a), with (b) as the follow-up escape hatch. The core primitive should prove itself first. Shared identity context is not necessary for options 1 through 4.

### Q3: Keep `+layout.ts` synchronous status check (C2) or drop entirely (C1)?

- (a) C1: no `+layout.ts` for the auth gate; render-branch is the only gate.
- (b) C2: keep a one-line synchronous status check that only redirects when status is already settled (no await):
  ```ts
  // (protected)/+layout.ts
  export function load() {
    if (auth.state.status === 'signed-out') redirect(307, '/sign-in');
    return {};
  }
  ```

**Recommendation**: defer until manual smoke. C1 is simpler. C2 reduces URL flicker on warm direct-nav. Pick after testing the flicker in dev. If users notice it, ship C2; if not, stay on C1.

### Q4: Tab Manager workspace construction, sync or async?

- (a) Refactor `openTabManager` to construct synchronously, expose `whenLoaded` for the async parts (peer descriptor, IDB hydration). Component renders `{#await tabManager.whenLoaded}<Spinner />{:then}<App />{/await}`.
- (b) Keep `openTabManager` async and await it from a loader component with `{#await}`. The resolved value is passed into a provider component that sets any context synchronously.
- (c) Refactor `attachAwareness` to support a deferred peer descriptor. This weakens the current "no online peer without device identity" invariant.

**Recommendation**: (b). Keep the existing async construction because
`apps/tab-manager/src/lib/tab-manager/extension.ts` documents a real
awareness invariant: the peer descriptor must exist before the workspace
publishes presence. Svelte cannot `await` in script setup, so use a
loader/provider split:

```svelte
{#await openTabManager({ auth, identity, peer })}
  <Loading />
{:then tabManager}
  <TabManagerProvider {tabManager}>
    {@render children()}
  </TabManagerProvider>
{/await}
```

### Q5: `<RequireSignedIn>` snippet-based component, or inline branches?

- (a) Inline three-way render branches in each app.
- (b) Also ship `<RequireSignedIn>` with `pending`, `signedOut`, `signedIn` snippets:
  ```svelte
  <RequireSignedIn auth={auth}>
    {#snippet pending()}<Loading />{/snippet}
    {#snippet signedOut()}<AuthForm />{/snippet}
    {#snippet signedIn(identity)}<App />{/snippet}
  </RequireSignedIn>
  ```

**Recommendation**: defer. Ship minimum first. If three apps end up writing the same three-branch dance with the same Loading/AuthForm UIs, extract `<RequireSignedIn>` as a follow-up.

### Q6: Should `bindAuthWorkspaceScope` be simplified instead of deleted?

- (a) Delete; each app writes its own onStateChange handler in its provider component.
- (b) Keep as a simplified utility taking onStateChange and the same callbacks as today.

**Recommendation**: (a). The drain state machine in `auth-workspace` exists to detect cold-boot vs sign-out from the imperative `onChange(identity)` callback. With explicit `state.status` transitions, the drain becomes a six-line if/else in the consumer. Two consumers (zhongwen, tab-manager) writing twelve lines beats one shared package with thirty.

### Q7: Does the spread `{...base, get state() { ... }}` trip on getter copying?

JavaScript spread evaluates getters at spread time and copies values as own properties. So `{...base}` reads `base.state` (the vanilla snapshot at spread time) and copies it as a regular property. The subsequent `get state() { ... }` overrides it. Net effect: consumer always reads the reactive getter. Verified by JavaScript semantics; will smoke-test during Wave 2.

A safer alternative using explicit field copy would be:

```ts
return {
  // explicit non-state fields
  onStateChange: base.onStateChange,
  signIn: base.signIn,
  signUp: base.signUp,
  signOut: base.signOut,
  signInWithIdToken: base.signInWithIdToken,
  signInWithSocialRedirect: base.signInWithSocialRedirect,
  fetch: base.fetch,
  openWebSocket: base.openWebSocket,
  // reactive overrides
  get state() { return state; },
  [Symbol.dispose]() { unsubscribe(); base[Symbol.dispose](); },
};
```

If the spread proves fragile in practice, switch to explicit copy. Default to spread for now.

## Success criteria

- [ ] `whenReady` and `onChange(identity)` removed from `@epicenter/auth` and `@epicenter/auth-svelte` public surfaces.
- [ ] `auth.state` and `auth.onStateChange` are the only state-related public fields.
- [ ] `waitForAuthState` and `waitForAuthSettled` exported as derived helpers.
- [ ] No `await auth.whenReady` in any consumer file.
- [ ] No `auth.identity` reads in app code. Consumers narrow `auth.state.status === 'signed-in'` and use `state.identity`.
- [ ] Zhongwen, Dashboard, Tab Manager all use render-branch pattern.
- [ ] `@epicenter/auth-workspace` deleted.
- [ ] Manual smokes pass for cold-boot, sign-in, sign-out, key-refresh, user-switch, forget-device on each app.
- [ ] Targeted typechecks pass for all touched packages.

## References

- `packages/auth/src/create-auth.ts` (vanilla core; today's identity + whenReady shape)
- `packages/auth-svelte/src/create-auth.svelte.ts` (today's 10-line wrapper)
- `packages/auth-workspace/src/index.ts` (bindAuthWorkspaceScope drain machine; deleted by Wave 7)
- `packages/workspace/src/document/attach-sync.ts:87` (SyncStatus precedent)
- `apps/zhongwen/src/lib/zhongwen/browser.ts` (existing createContext for workspace handle; pattern this spec extends to identity)
- `apps/dashboard/src/routes/+layout.svelte` (existing render-branch consumer)
- `apps/tab-manager/src/lib/tab-manager/client.ts` (existing TLA throw-on-null pattern; collapses)
- `docs/articles/sync-client-initialization.md` (sync-construction-with-deferred-ready pattern; basis for Q4)
- DeepWiki: Svelte 5 createContext constraints (https://deepwiki.com/search/in-svelte-540-can-createcontex_e585c85f-b5f1-4eb6-841f-ba43d161b201)
- DeepWiki: SvelteKit static SPA route gating (https://deepwiki.com/search/for-a-static-spa-adapterstatic_0a175f28-1b2f-4bec-8e8b-482483dfeadc)
- DeepWiki: Better Auth useSession atom (https://deepwiki.com/search/for-betterauths-client-usesess_493bd741-6a8e-4231-8853-df924baec90d)
- specs/20260505T060000-zhongwen-context-and-listener-collapse.md (predecessor; introduced workspace context pattern)
- specs/20260505T040000-route-loader-singleton-auth-collapse.md (predecessor; collapsed the route-loader cache)
