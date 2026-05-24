---
name: auth-core-package
status: shipped
---

# Extract framework-agnostic auth core into `packages/auth`

## Current Reconciliation (2026-05-07)

The shipped notes below are historically useful but stale in two important
ways. `packages/auth/src` now has tests for the auth factories, auth contract,
machine auth, machine session storage, and session normalization. The old
"step 5 did not land" follow-up is no longer accurate.

The remaining follow-up from this lineage is not "add auth tests from scratch."
It is narrower:

1. Add targeted tests only when changing the current contract.
2. Keep the boot-cache storage invariant: storage loads an initial bearer
   session or cookie identity, then auth state flows from Better Auth.
3. Prefer changing the current `createCookieAuth` and `createBearerAuth`
   surfaces directly. Do not revive the old `AuthCore`, `onSessionChange`,
   `onLogin`, or `onLogout` API from this spec body.

## Shipped notes (2026-04-25)

This spec was originally marked `queued`. The migration actually landed on the `drop-document-factory` branch across ~24 commits. `packages/auth/` and `packages/auth-svelte/` exist with the full `AuthCore` surface; all six apps consume `@epicenter/auth-svelte` and use `auth.onSessionChange(...)` in place of the old `applySession` Svelte-effect bridge. Steps 1---8 of the migration plan landed. Historical note: the 2026-04-25 shipped note said **step 5 (unit tests) did not** land, but that follow-up has since been superseded by the current auth test files.

### Divergences from the spec as written

1. **`signOut` returns `Result<undefined, AuthError>` instead of `Promise<void>`** (commit `e2f7ed3c9`). Improvement --- gives consumers a consistent error contract across all auth ops.

2. **HMR pattern only calls `auth[Symbol.dispose]()`**, not the spec's `unsubscribeSession() + auth[Symbol.dispose]()` two-step. `Symbol.dispose` clears all subscriber registries via `.clear()`, so the Set is dropped and the old core becomes unreachable on the next module evaluation. Spec was over-cautious; shipped form is functionally equivalent and one line shorter per app.

3. **Per-doc rotation uses `getToken: () => auth.getToken()` (live read at connect time), not `auth.onTokenChange(token => sync.setToken(token))` (subscription per handle)**. Documented in `apps/fuji/src/lib/entry-content-docs.ts:53-56`. The supervisor in `attach-sync.ts:451-454` calls `getToken()` before every connect attempt, so natural reconnects pick up rotations without per-doc subscriptions to leak. Per-doc factories now register **zero** subscribers; they take `Pick<AuthCore, 'getToken'>` only. Strictly simpler than the spec.

4. **Field-level session writer partition** (commits `e3b2a38b8`, `d11ae8e00`, `ff852c3c2`) --- `onSuccess` interceptor owns token writes; `useSession.subscribe` owns user/keys writes. Not in the original spec; added to fix a real race where BA's async `useSession` refetch would clobber a token the `onSuccess` interceptor had just rotated. Inline JSDoc explains the partition. Working *with* better-auth, not fighting it.

### Out-of-scope follow-ups --- status

| Follow-up | Status |
|---|---|
| `attachSync` redesign (replace `setToken`/`requiresToken` with `url:` callback) | **partially done** --- `setToken` removed, `getToken` callback added on `attachSync`, `requiresToken` is now internal (derived from presence of `getToken`). The unified `url: () => string \| null` closure was rejected in favor of separate `url` (string) + `getToken` (callback). |
| Removing `sync.setToken` / `sync.reconnect` | `setToken` gone; `reconnect()` retained at 4 app `client.ts` call sites where session-change forces a workspace-doc reconnect. Marginal value remaining; keep. |
| Collapsing `applySession` into `onLogin`/`onLogout` | **Not done.** All apps still use a single `onSessionChange` with `if (next === null)` / `if (previous?.token !== next.token)` branching. The `onLogin`/`onLogout` API exists on `AuthCore` but has zero call sites --- candidate for either deletion or a sweeping migration. |

### Historical follow-up, now superseded

The original follow-up was: **land the unit tests from step 5.** That is no
longer the right action item. Current `packages/auth/src` contains auth factory,
contract, machine auth, machine session storage, and normalization tests. Add
new tests at the specific seam touched by future auth changes instead of
backfilling the old `AuthCore` test matrix.

---

## Motivation (original spec, retained for context)

`createAuth` in `packages/svelte-utils/src/auth/create-auth.svelte.ts` is a Svelte-flavored adapter around `better-auth/client`. Its public API is **reactive getters only**: `auth.token`, `auth.session`, `auth.user`, `auth.isAuthenticated`, `auth.isBusy`.

That has two direct consequences:

1. **Every consumer that wants "do X when auth changes" has to reach through Svelte**, by touching a reactive value in a `$effect` purely to register tracking:

   ```svelte
   $effect(() => {
     auth.session;         // touched, not used --- wake signal
     workspace.applySession(auth.session);
   });
   ```

2. **Token rotation can't propagate to code that doesn't live inside a Svelte component.** The per-doc syncs in `apps/fuji/src/lib/entry-content-docs.ts` and `apps/honeycrisp/src/lib/note-body-docs.ts` read `auth.token` via a `getToken: () => auth.token` closure, called once at handle-open time. If the token rotates while an editor is open, the per-doc sync keeps the stale token until the component remounts.

Both are symptoms of the same root cause: **the publisher (auth) exposes reactive state but no imperative subscription API.** Subscribers fill the gap with framework plumbing.

The fix is to build a framework-agnostic `createAuth` in its own `packages/auth`, with imperative `on*` callbacks, and make the Svelte layer a thin projection over it.

This spec covers the auth extraction only. A companion spec (to be written after this lands) will rework `attachSync` to replace `setToken` / `requiresToken` with a single `url: (docId) => string | null` closure --- that work is only clean *after* the auth core exists.

## Non-goals

- Changing `attachSync`'s surface. That's the follow-up.
- Changing `better-auth` version or server-side behavior.
- Changing `AuthSession` type, `EncryptionKeys` type, or persisted-state shape.
- Building an observable / Rx / EventEmitter abstraction. Subscriptions are plain `(fn) => unsubscribe`.

## Design

### Package layout

Two packages from day one. Yjs precedent: `yjs` core stays framework-agnostic; every framework/provider binding (`y-prosemirror`, `y-quill`, `y-websocket`, `y-indexeddb`) ships as a separate package. Same rationale here --- zero mandatory dependencies, no optional-peer machinery, package boundary enforces isolation without a lint rule.

```
packages/auth/
-------- package.json               # @epicenter/auth, zero svelte
-------- tsconfig.json              # extends tsconfig.base.json (no DOM)
--------- src/
    -------- index.ts               # barrel: createAuth, AuthCore, AuthSession, StoredUser, EncryptionKeys re-exports
    -------- create-auth.ts         # framework-agnostic core
    --------- auth-types.ts          # moved from svelte-utils

packages/auth-svelte/
-------- package.json               # @epicenter/auth-svelte, depends on @epicenter/auth
-------- tsconfig.json              # extends tsconfig.base.dom.json
--------- src/
    -------- index.ts               # barrel
    --------- create-auth.svelte.ts
```

```json
// @epicenter/auth/package.json
{ "exports": { ".": "./src/index.ts" } }
```

```json
// @epicenter/auth-svelte/package.json
{
  "exports": { ".": "./src/index.ts" },
  "dependencies":     { "@epicenter/auth": "workspace:*" },
  "peerDependencies": { "svelte": "^5.0.0" }
}
```

Non-Svelte consumers (future CLI, workers, server tooling) `import { createAuth } from '@epicenter/auth'` --- svelte never enters the dep tree. Svelte apps `import { createAuth } from '@epicenter/auth-svelte'`.

### Core API --- `packages/auth/src/create-auth.ts`

```ts
export type AuthCore = {
  // Imperative reads
  getToken(): string | null;
  getSession(): AuthSession | null;
  getUser(): StoredUser | null;
  isAuthenticated(): boolean;
  isBusy(): boolean;

  // Imperative subscriptions
  onTokenChange(fn: (token: string | null) => void): () => void;
  onSessionChange(fn: (next: AuthSession | null, previous: AuthSession | null) => void): () => void;
  onLogin(fn: (session: AuthSession) => void): () => void;
  onLogout(fn: () => void): () => void;
  onBusyChange(fn: (busy: boolean) => void): () => void;

  // Actions
  signIn(input: EmailPasswordInput): Promise<Result<undefined, AuthError>>;
  signUp(input: EmailSignUpInput): Promise<Result<undefined, AuthError>>;
  signInWithSocialPopup(): Promise<Result<undefined, AuthError>>;
  signInWithSocialRedirect(input: SocialRedirectInput): Promise<Result<undefined, AuthError>>;
  signOut(): Promise<void>;
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;

  // Cleanup
  [Symbol.dispose](): void;
};

export type CreateAuthConfig = {
  baseURL: string | (() => string);
  session: SessionStore;                    // historical shape, superseded by SessionStorage load/save
  socialTokenProvider?: () => Promise<SocialTokenPayload>;
};

export function createAuth(config: CreateAuthConfig): AuthCore;
```

Internally, `createAuth` wraps `better-auth/client` exactly like the current svelte one does --- the wrapping is framework-agnostic; only the *exposure* was Svelte-shaped. The subscribers work through plain `Set<Fn>` registries that `signIn`/`signUp`/`signOut`/`onSuccess`-interceptor/`useSession.subscribe` all call through.

### Historical `SessionStore` contract

This early plan used a synchronous observable store. Current auth storage is a boot cache with `load()` and `save()` only.

```ts
export type SessionStore = {
  load(): AuthSession | null;
  save(value: AuthSession | null): void;
};
```

Superseded invariants:

- Storage loads the last known session at boot.
- Runtime auth changes flow through Better Auth and auth snapshot listeners.
- `save()` is fire-and-forget for durable persistence.

Adapters land alongside the stores that need them (not in `@epicenter/auth`):

- `createPersistedState` and `createStorageState` can still be wrapped, but auth only consumes their boot read and durable write behavior.

This keeps the core sync-only and pushes async concerns to the adapter layer, matching how `attachIndexedDb` already handles async hydration via `whenLoaded`.

### Subscription firing semantics

`onSessionChange` is the primitive event; `onLogin`, `onLogout`, `onTokenChange`, and `onBusyChange` are derived.

**Firing order on any session transition:**

1. Internal state is updated --- `getSession()`, `getToken()`, `getUser()`, `isAuthenticated()` all reflect the new value before any subscriber runs.
2. `onSessionChange` subscribers fire in registration order with `(next, previous)`.
3. `onLogin` fires if `previous === null && next !== null`, with `next`.
4. `onLogout` fires if `previous !== null && next === null`.
5. `onTokenChange` fires if `previous?.token !== next?.token`, with `next?.token ?? null`.

**Replay on subscribe:** every `on*` callback fires synchronously once during `on*()` itself with the current state. `onSessionChange` replays with `(current, null)`. `onLogin` replays only if a session already exists. `onTokenChange` replays with the current token (even if null). `onLogout` does NOT replay on subscribe --- it only fires on a real logged-in - logged-out transition.

**Reads inside subscribers:** all `getX()` methods return the *new* value when called from any subscriber. `previous` is carried only through the callback argument.

**Subscriber errors:** each subscriber runs in its own `try/catch`. Errors are logged via `@epicenter/workspace`'s logger (or a noop if not wired) and do not prevent other subscribers from firing.

### `isBusy` semantics

Implemented as an in-flight counter, not a boolean:

```ts
let busyCount = 0;
async function runBusy<T>(fn: () => Promise<T>): Promise<T> {
  const wasBusy = busyCount > 0;
  busyCount++;
  if (!wasBusy) notifyBusyChange(true);
  try {
    return await fn();
  } finally {
    busyCount--;
    if (busyCount === 0) notifyBusyChange(false);
  }
}
```

`isBusy()` returns `busyCount > 0`. Fixes the existing concurrency bug where two overlapping ops would flip busy false prematurely.

### Svelte wrapper --- `packages/auth-svelte/src/create-auth.svelte.ts`

Both packages export a function named `createAuth`. The import path distinguishes them --- callers never see both in the same file, so there's no name collision at the type level. Same name keeps migration churn minimal (Svelte apps already type `createAuth`).

```ts
// @epicenter/auth-svelte
import { createAuth as createAuthCore, type CreateAuthConfig } from '@epicenter/auth';

export function createAuth(config: CreateAuthConfig) {
  const core = createAuthCore(config);
  const token = $state({ current: core.getToken() });
  const session = $state({ current: core.getSession() });
  const busy = $state({ current: core.isBusy() });

  core.onTokenChange(t => { token.current = t; });
  core.onSessionChange(s => { session.current = s; });
  core.onBusyChange(b => { busy.current = b; });

  return {
    ...core,  // imperative surface re-exposed for consumers that want it
    get token()           { return token.current; },
    get session()         { return session.current; },
    get isAuthenticated() { return session.current !== null; },
    get user()            { return session.current?.user ?? null; },
    get isBusy()          { return busy.current; },
  };
}
```

~30 lines. No `$effect.root`, no HMR ceremony --- disposal is delegated to the core's `[Symbol.dispose]`.

### Caller migration --- workspace apps

Before (`apps/fuji/src/lib/client.svelte.ts`):

```ts
let previousSession: AuthSession | null = null;
async function applySession(next: AuthSession | null) {
  const wasAuthed = previousSession !== null;
  previousSession = next;
  if (next === null) {
    sync.goOffline();
    sync.setToken(null);
    if (wasAuthed) await idb.clearLocal();
    return;
  }
  encryption.applyKeys(next.encryptionKeys);
  sync.setToken(next.token);
  sync.reconnect();
}

const dispose = $effect.root(() => {
  $effect(() => { void workspace.applySession(auth.session); });
});
```

After:

```ts
auth.onSessionChange((next, previous) => {
  if (next === null && previous !== null) {
    sync.goOffline();
    sync.setToken(null);
    idb.clearLocal();
    return;
  }
  if (next !== null) {
    encryption.applyKeys(next.encryptionKeys);
    sync.setToken(next.token);
    sync.reconnect();
  }
});
```

Edge-detector boilerplate gone. `$effect.root` gone. One subscription, three branches, each saying what it does. Cold-boot-anonymous is a silent no-op (neither branch runs). Cold-boot-authed re-applies keys and reconnects sync. Logout wipes. Token rotation mid-session fires the `next !== null` branch (idempotent key apply, setToken + reconnect).

(Note: `sync.setToken` / `sync.reconnect` stay for now. The follow-up spec replaces them with a `url: () => string | null` closure after this lands.)

### Caller migration --- per-doc factories

`apps/fuji/src/lib/entry-content-docs.ts`, `apps/honeycrisp/src/lib/note-body-docs.ts`:

```ts
// Before --- getToken closure, called once at handle open:
getToken: () => auth.token,
// Inside factory: sync.setToken(getToken()) --- never updates.

// After --- factory accepts the auth core directly:
auth: AuthCore,
// Inside factory:
sync.setToken(auth.getToken());
auth.onTokenChange(token => sync.setToken(token));
// Subscription lives for the handle's lifetime, cleaned up on dispose.
```

Per-doc syncs now observe rotation. Workspace and per-doc wiring use the same API.

## Naming --- resolved

Both packages export `createAuth`. Package name distinguishes them:

```ts
// Non-Svelte consumer (CLI, worker, server):
import { createAuth } from '@epicenter/auth';

// Svelte consumer (fuji, honeycrisp, opensidian, dashboard, tab-manager):
import { createAuth } from '@epicenter/auth-svelte';
```

Callers never see both in one file, so there's no name collision. Migration churn stays minimal --- existing `createAuth` call sites only need their import path updated, not renamed. Grep disambiguates via the import source, not the function name.

## Migration plan

1. **Create `packages/auth` and `packages/auth-svelte` shells** --- package.json, tsconfig, empty `src/index.ts` for each. Bun's `packages/*` workspace glob auto-picks them up. `@epicenter/auth` has zero framework deps; `@epicenter/auth-svelte` has `@epicenter/auth: workspace:*` + `svelte` peer. No lint rule needed --- the package boundary enforces isolation.
2. **Move `AuthSession` + related types** --- `auth-types.ts` from `packages/svelte-utils/src/auth/` into `packages/auth/src/`. Re-export from the old location so nothing else breaks during migration. **Do not move `create-ai-chat-fetch.ts`** --- it has no auth dependency; it stays in `svelte-utils` (or moves to a more appropriate home like `@epicenter/ai` as a separate change, out of scope here).
3. **Define `SessionStore` type and adapters** --- the type lands in `packages/auth`. The two adapters (`fromPersistedState`, `fromStorageState`) land next to the stores they wrap: `packages/svelte-utils/src/persisted-state.svelte.ts` and `apps/tab-manager/src/lib/state/storage-state.svelte.ts`. The chrome-storage adapter exposes `whenReady`.
4. **Build `createAuth` core** --- port logic from the current `.svelte.ts` file. Replace `$state`-backed `isBusy` with a counter (see `isBusy` semantics above). Replace reactive getters with imperative `getX()`. Add the five `on*` registries with firing order per spec. Wrap every subscriber call in try/catch with logger. Audit that `@epicenter/auth` imports zero from `@epicenter/svelte-utils`.
5. **Unit tests** --- `create-auth.test.ts` must cover at minimum:
   - `onSessionChange` replays with `(current, null)` on subscribe when session exists
   - `onSessionChange` replays with `(null, null)` on subscribe when session is null
   - `onLogin` does not replay when session is null; does replay when session exists
   - `onLogout` does not replay on subscribe (only fires on real transition)
   - `onTokenChange` fires only when token value actually changed (not on every session update)
   - Firing order: session state is updated before any subscriber sees it; `getX()` inside subscribers returns new value
   - Subscriber throwing does not prevent other subscribers from firing
   - `isBusy` counter: two overlapping ops only fires `onBusyChange(false)` once, when both settle
   - `[Symbol.dispose]` unsubscribes from better-auth's `useSession`, clears registries, rejects pending ops? (decide during impl --- probably leaves promises dangling, doesn't cancel)
6. **Build `createAuth` Svelte wrapper** --- ~30 lines in `packages/auth-svelte/src/create-auth.svelte.ts`.
7. **Migrate consumers** --- one commit per app. fuji, honeycrisp, opensidian each swap `@epicenter/svelte-utils/auth` - `@epicenter/auth-svelte` and replace `applySession` bridge with the `onSessionChange` pattern above. dashboard, tab-manager, zhongwen just swap the import path (no applySession to migrate).
8. **Delete old `svelte-utils/auth`** --- once every consumer is off it. Keep `auth-form` and other unrelated subpaths.
9. **Typecheck + test across the repo.**

Each step commits independently. Steps 1---6 land without touching any app. Step 7 is per-app.

### HMR pattern for callers

Module-scope subscriber registrations leak across HMR reloads if not managed. The pattern for Svelte apps:

```ts
// In client.svelte.ts
import { createAuth } from '@epicenter/auth-svelte';
export const auth = createAuth({ baseURL: APP_URLS.API, session });

const unsubscribeSession = auth.onSessionChange((next, previous) => { ... });

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    unsubscribeSession();
    auth[Symbol.dispose]();
  });
}
```

Each subscription returns an unsubscribe fn; HMR dispose calls them all. The core's `[Symbol.dispose]` tears down the better-auth client and clears all registries.

## Risks

- **Better-auth interceptor parity.** The current `.svelte.ts` uses `fetchOptions.auth.token` (Bearer callback) and an `onSuccess` response interceptor for token rotation. The core must preserve both exactly. Tests gate this.
- **`session.current =` vs `session.set(...)`.** Current code mutates via property assignment. The new `SessionStore` uses explicit `set()`. The adapter for `createPersistedState` translates one to the other --- no behavior change visible to auth.
- **`auth.fetch` and in-flight rotation.** `fetch` reads `session.get()?.token` at request time. The rotation interceptor calls `session.set(...)` before any subscriber fires, so a `fetch` call triggered from inside a subscriber sees the new token. Documented as an invariant in the firing-order section.
- **Social popup requires a DOM.** Core stays framework-agnostic but not environment-agnostic: `signInWithSocialPopup` without a `socialTokenProvider` errors at runtime. Core-only CLI/worker consumers should omit the popup method or accept that it will reject.
- **IDE import ambiguity on `createAuth`.** VS Code auto-import will offer both `@epicenter/auth` and `@epicenter/auth-svelte`. Reviewers must confirm the right one. Low-severity; the wrong import fails type-check immediately (the Svelte wrapper has reactive getters the core doesn't).
- **`BetterAuthOptions` type drag.** The current file imports `InferPlugin<EpicenterCustomSessionPlugin>` which transitively references `better-auth`'s server package types. Verify during step 4 that this doesn't pull server-only runtime code into the core.

## Out of scope (follow-ups)

- `attachSync` redesign --- new spec, builds on this.
- Removing `sync.setToken` / `sync.reconnect` in favor of `url: () => string | null` --- part of the follow-up.
- Collapsing the workspace `applySession` edge detector into `auth.onLogin` / `auth.onLogout` --- partially done in step 6; the full kill happens after the `attachSync` redesign when `sync.setToken` goes away.
