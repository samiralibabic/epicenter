# Hoist Async Init Out of createAuth

**Date**: 2026-05-03
**Status**: Implemented
**Author**: AI-assisted

## One-Sentence Test

`createAuth` turns an initial session and a transport into a live, subscribable auth client. Storage hydration is the caller's job, and the snapshot is `signedIn | signedOut` from the moment the factory returns.

If a flag, deferred, or nullable handle exists in `createAuth` to track "have we finished loading from storage yet", it is in the wrong layer. Loading belongs to whoever owns the storage. If `AuthSnapshot` carries a `loading` variant, it is advertising a state the factory cannot produce.

## Overview

Replace the async-init IIFE inside `createAuth` with a synchronous body. Callers load the initial session before constructing the client and pass it in. The `SessionStorage` interface shrinks from `{ load, save }` to just a bare `saveSession` callback. The lifecycle bookkeeping (`disposed`, nullable `unsubscribeBetterAuth`, `disposeSignal` + `resolveDisposeSignal`, `whenLoaded` race) collapses because the async window it was guarding no longer exists. `AuthSnapshot` collapses from three variants to two (`signedOut | signedIn`); the `loading` variant becomes unreachable when init is synchronous, so the type drops it.

## Motivation

### Current State

`createAuth` runs an async IIFE that loads from storage, then subscribes to Better Auth. The factory returns synchronously, but its returned client is in a `loading` state until the IIFE completes:

```ts
export function createAuth({ baseURL, sessionStorage }: CreateAuthConfig): AuthClient {
    let snapshot: AuthSnapshot = { status: 'loading' };
    let disposed = false;
    let unsubscribeBetterAuth: (() => void) | null = null;
    let resolveDisposeSignal: () => void = () => {};
    const disposeSignal = new Promise<void>((resolve) => {
        resolveDisposeSignal = resolve;
    });

    // ...

    const whenLoaded: Promise<void> = Promise.race([
        (async () => {
            let loaded: AuthSession | null;
            try {
                loaded = await sessionStorage.load();
            } catch (error) {
                console.error('[auth] failed to load session:', error);
                loaded = null;
            }
            if (disposed) return;
            setSnapshot(snapshotFromSession(loaded));

            unsubscribeBetterAuth = client.useSession.subscribe((state) => {
                if (disposed || state.isPending) return;
                // ...
            });
        })(),
        disposeSignal,
    ]);

    return {
        get snapshot() { return snapshot; },
        whenLoaded,
        // ...
        [Symbol.dispose]() {
            if (disposed) return;
            disposed = true;
            resolveDisposeSignal();
            unsubscribeBetterAuth?.();
            snapshotChangeListeners.clear();
        },
    };
}
```

This shape carries four intertwined bookkeeping concerns:

1. **`disposed` flag** checked at four call sites (setSnapshot, saveSnapshot, the IIFE post-await, the BA subscription handler) to stop late callbacks from writing state after teardown.
2. **`unsubscribeBetterAuth: (() => void) | null`** is null until the IIFE awaits past `sessionStorage.load()` and calls `subscribe(...)`. The optional chain in dispose (`unsubscribeBetterAuth?.()`) exists because dispose can land before subscribe runs.
3. **`disposeSignal` + `resolveDisposeSignal`** is a manual deferred. Its only job is to settle `whenLoaded` for awaiters when dispose fires mid-load, otherwise `whenLoaded` would hang on a `sessionStorage.load()` we cannot cancel.
4. **`whenLoaded` itself** is a public promise that exists so consumers can wait for the `loading` to `signedIn | signedOut` transition.

These four concerns have one root cause: the factory is callable synchronously, but its initialization is asynchronous, and the async window has to remain interruptible.

### Why the async surface does not earn its keep

A call-site survey shows the async surface is rarely used:

| Call site                                                 | Storage backend            | Async load? |
| --------------------------------------------------------- | -------------------------- | ----------- |
| `apps/fuji/src/lib/fuji/client.ts`                        | `createPersistedState`     | No (localStorage) |
| `apps/opensidian/src/lib/opensidian/client.ts`            | `createPersistedState`     | No (localStorage) |
| `apps/honeycrisp/src/lib/honeycrisp/client.ts`            | `createPersistedState`     | No (localStorage) |
| `apps/zhongwen/src/lib/zhongwen/client.ts`                | `createPersistedState`     | No (localStorage) |
| `apps/dashboard/src/lib/auth.ts`                          | `createPersistedState`     | No (localStorage) |
| `apps/tab-manager/src/lib/tab-manager/client.ts`          | `wxt-dev/storage`          | Yes (extension storage) |
| `packages/auth/src/node/machine-auth.ts`                  | OS keychain (`Bun.secrets`)| Yes |

Five of seven real call sites are synchronous in practice. They wrap a `SessionStateAdapter` whose `get()` is synchronous and whose `whenReady` is undefined. The async surface is purely there to support the two minority cases.

`auth.whenLoaded` consumers in the rest of the codebase:

| Consumer                                                | What it does after the await |
| ------------------------------------------------------- | ---------------------------- |
| `auth.fetch()` in `create-auth.ts`                      | reads `snapshot` for the bearer header |
| `readToken()` in `packages/workspace/src/document/attach-sync.ts:446` | reads `snapshot` for the websocket subprotocol token |

UI render-gating (`<WorkspaceGate whenReady={fuji.whenLoaded}>`) goes through `workspace.whenLoaded`, which already aggregates indexedDB hydration and is the real boot barrier. Nothing in the app shells awaits `auth.whenLoaded` directly.

### Desired State

```ts
export function createAuth({
    baseURL,
    initialSession,
    saveSession,
}: CreateAuthConfig): AuthClient {
    let snapshot: AuthSnapshot = snapshotFromSession(initialSession);
    const snapshotChangeListeners = new Set<AuthSnapshotChangeListener>();

    // ...createAuthClient setup...

    const unsubscribeBetterAuth = client.useSession.subscribe((state) => {
        if (state.isPending) return;
        // ...same body as today, minus the `if (disposed) return` guard...
    });

    return {
        get snapshot() { return snapshot; },
        onSnapshotChange(fn) { /* unchanged */ },
        signIn / signUp / signOut / fetch (no whenLoaded await),
        [Symbol.dispose]() {
            unsubscribeBetterAuth();
            snapshotChangeListeners.clear();
        },
    };
}
```

What disappears: `whenLoaded`, `disposed`, `disposeSignal`, `resolveDisposeSignal`, the IIFE, every `if (disposed) return`, and the optional chain on `unsubscribeBetterAuth`. `unsubscribeBetterAuth` becomes `const`. `[Symbol.dispose]` becomes two lines.

What changes for callers:

```ts
// Before (apps/fuji/src/lib/fuji/client.ts)
const session = createPersistedState({ key: 'fuji.auth.session', schema, defaultValue: null });
export const auth = createAuth({
    baseURL: APP_URLS.API,
    sessionStorage: createSessionStorageAdapter(session),
});

// After
const session = createPersistedState({ key: 'fuji.auth.session', schema, defaultValue: null });
export const auth = createAuth({
    baseURL: APP_URLS.API,
    initialSession: session.get(),
    saveSession: (next) => session.set(next),
});
```

The browser-app boot stays synchronous. Machine auth grows one `await sessionStorage.load()` before constructing the client; that file is already async-first.

## Research Findings

### Storage adapter shape today

```ts
// packages/auth/src/session-store.ts
export type SessionStorage = {
    load(): MaybePromise<AuthSession | null>;
    save(value: AuthSession | null): MaybePromise<void>;
};

// packages/auth/src/create-auth.ts:80-96
export type SessionStateAdapter = {
    get(): AuthSession | null;
    set(value: AuthSession | null): MaybePromise<void>;
    whenReady?: Promise<unknown>;
};

export function createSessionStorageAdapter(state: SessionStateAdapter): SessionStorage {
    return {
        async load() { await state.whenReady; return state.get(); },
        save: (value) => state.set(value),
    };
}
```

`createSessionStorageAdapter` exists only to bridge "sync `get`/`set` adapter" to "potentially-async `load`/`save` storage." Once load moves to the caller, the bridge has nothing left to do: callers can read `state.get()` themselves and pass `state.set` as `saveSession`.

### Tests that exist only because of async init

From `packages/auth/src/create-auth.test.ts`:

| Test                                                                | What it proves under current code | Still relevant after the change? |
| ------------------------------------------------------------------- | --------------------------------- | -------------------------------- |
| `whenLoaded resolves after asynchronous signed-out storage load settles` | snapshot transitions loading -> signedOut after await | No (no transition exists) |
| `whenLoaded resolves after storage load failure`                    | load error becomes signedOut     | Replaced: caller handles load errors |
| `dispose resolves whenLoaded and ignores late storage load`         | mid-load dispose does not deadlock | No (no async window) |
| `Better Auth emission during async load`                            | BA emit before load completes is buffered until cache settles | No (load is at caller) |
| `BA emission before boot cache resolves does not write snapshot until cache settles` | same                              | No |
| `dispose is idempotent and unsubscribes from Better Auth once`      | double dispose is safe            | Yes (still relevant for HMR) |

Five of six lifecycle tests stop being meaningful. The dispose-idempotency test stays because HMR can still re-trigger dispose. The new test surface is much smaller.

### Precedent in this codebase

The previous spec (`20260503T180000-auth-snapshot-three-state-clean-break.md`) eliminated the `bufferedBetterAuthCandidate` mailbox by sequencing init: load cache, then subscribe to Better Auth. This spec continues that direction one step further: move the load step out of the factory entirely, so subscribe runs synchronously and the lifecycle bookkeeping vanishes.

The repo already prefers "wait, then subscribe" (per `attachSync(...)` with `waitFor: idb.whenLoaded`). This change moves the wait from inside the factory to outside the factory. Same idea, one layer higher.

## Design Decisions

| Decision                                          | Choice                                                                        | Rationale                                                                                                                             |
| ------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Where the load happens                            | Caller, before `createAuth`                                                   | Five of seven call sites are synchronous already; the two async ones are async-friendly contexts.                                     |
| Storage parameter shape                           | Replace `sessionStorage: SessionStorage` with `initialSession` + `saveSession` callback | Bundling load+save was what made the adapter feel needed. Splitting them lets each go where it belongs.                               |
| Keep `SessionStorage` type?                       | Delete                                                                        | With load gone, the type is just `{ save }`. A bare callback is more honest.                                                          |
| Keep `createSessionStorageAdapter`?               | Delete                                                                        | It only existed to bridge sync `get`/`set` to async `load`/`save`. With load gone, callers use `state.get()` and `state.set` directly.|
| `whenLoaded` on the public API                    | Delete                                                                        | Snapshot is definite at construction. Two consumers (`auth.fetch`, `attach-sync` `readToken`) drop the await.                          |
| `disposed` flag                                   | Delete                                                                        | No async window to guard. `unsubscribeBetterAuth` is unconditional, dispose is idempotent via guarding the unsubscribe call.          |
| `unsubscribeBetterAuth: \| null`                  | Becomes `const`                                                               | Subscribe runs in the constructor body, so the binding always exists by the time dispose can be called.                               |
| `disposeSignal` + `resolveDisposeSignal`          | Delete                                                                        | Existed only to settle `whenLoaded` early. No `whenLoaded`, no race.                                                                  |
| `loading` state in `AuthSnapshot`                 | Drop. Collapse to `signedOut \| signedIn`.                                    | Audit found three source files and two test files reference the variant; no UI conditions on it. Bundling avoids leaving a dead variant in the type. |
| Idempotent dispose                                | Keep                                                                          | HMR can still call dispose twice; cheap to support with a sentinel after teardown.                                                    |
| Machine auth wrapper (`createMachineAuth`)        | Keep its async shape, await `load` inside                                     | Keychain access is genuinely async; the wrapper is already async-first.                                                               |

## Architecture

Current shape:

```txt
createAuth(config)
  |
  +-- snapshot = { status: 'loading' }
  +-- disposed = false                              <-- lifecycle bookkeeping
  +-- unsubscribeBetterAuth: (() => void) | null    <-- lifecycle bookkeeping
  +-- disposeSignal + resolveDisposeSignal          <-- lifecycle bookkeeping
  +-- createAuthClient(...)
  +-- whenLoaded = Promise.race([
  |       async IIFE {
  |         await sessionStorage.load()
  |         setSnapshot(...)
  |         unsubscribeBetterAuth = client.useSession.subscribe(...)
  |       },
  |       disposeSignal,
  |     ])
  +-- return { snapshot, whenLoaded, ..., [Symbol.dispose] }
```

Target shape:

```txt
caller
  |
  +-- const initialSession = state.get()       (sync, browser apps)
  |   OR const initialSession = await load()   (async, machine auth + extension)
  |
  +-- const auth = createAuth({
  |       baseURL,
  |       initialSession,
  |       saveSession: (s) => state.set(s),
  |   })
  |
  V
createAuth(config)
  |
  +-- snapshot = snapshotFromSession(initialSession)
  +-- createAuthClient(...)
  +-- const unsubscribeBetterAuth = client.useSession.subscribe(...)
  +-- return { snapshot, ..., [Symbol.dispose] }
```

## Implementation Plan

### Phase 1: Refactor the factory body

- [x] **1.1** Update `CreateAuthConfig` in `packages/auth/src/create-auth.ts`: add `initialSession: AuthSession | null` and `saveSession: (value: AuthSession | null) => MaybePromise<void>`. Remove `sessionStorage`.
- [x] **1.2** Inside `createAuth`, initialize `snapshot` from `initialSession` directly. Replace the IIFE with a synchronous `client.useSession.subscribe(...)` call assigned to `const unsubscribeBetterAuth`.
- [x] **1.3** Delete `disposed`, `disposeSignal`, `resolveDisposeSignal`. Remove every `if (disposed) return` from `setSnapshot`, `saveSnapshot`, and the BA subscribe handler.
- [x] **1.4** Delete `whenLoaded` from the returned object and the `AuthClient` type. Remove `await whenLoaded` from `auth.fetch`.
- [x] **1.5** Update `[Symbol.dispose]` to a two-liner: `unsubscribeBetterAuth(); snapshotChangeListeners.clear();`. Add a sentinel to keep dispose idempotent (a single boolean is fine; this is the one bookkeeping var that earns its keep for HMR).
- [x] **1.6** Delete `createSessionStorageAdapter` and the `SessionStateAdapter` type from `create-auth.ts`. Delete `SessionStorage` and `MaybePromise` from `session-store.ts` if no other consumer remains. Otherwise reduce `SessionStorage` to `{ save: ... }`.

### Phase 2: Update browser app call sites

For each of the six browser app client modules, replace the storage adapter with direct `get`/`set` access:

- [x] **2.1** `apps/fuji/src/lib/fuji/client.ts`
- [x] **2.2** `apps/opensidian/src/lib/opensidian/client.ts`
- [x] **2.3** `apps/honeycrisp/src/lib/honeycrisp/client.ts`
- [x] **2.4** `apps/zhongwen/src/lib/zhongwen/client.ts`
- [x] **2.5** `apps/dashboard/src/lib/auth.ts`
- [x] **2.6** `apps/tab-manager/src/lib/tab-manager/client.ts` (wxt-dev/storage; this one needs an async boot wrapper if `storage.getItem` returns a promise; see Edge Cases)

Pattern:

```ts
const session = createPersistedState({ key, schema, defaultValue: null });

export const auth = createAuth({
    baseURL: APP_URLS.API,
    initialSession: session.get(),
    saveSession: (s) => session.set(s),
});
```

### Phase 3: Update machine auth

- [x] **3.1** In `packages/auth/src/node/machine-auth.ts`, change `createMachineAuthWithDependencies` to await `sessionStorage.load()` before calling `createAuth`. Pass the result as `initialSession`. Pass `sessionStorage.save` as `saveSession`.
- [x] **3.2** Decide whether `createMachineAuth` becomes async. If yes, callers need to await it; check downstream consumers (`packages/cli`).

### Phase 4: Update non-call-site consumers

- [x] **4.1** `packages/workspace/src/document/attach-sync.ts:446`: `readToken()` drops `await auth.whenLoaded` and reads `auth.snapshot` directly.
- [x] **4.2** `packages/auth-svelte/src/create-auth.svelte.ts`: re-export the new config type, drop the `whenLoaded` passthrough.
- [x] **4.3** `packages/auth-workspace/src/index.ts`: nothing to change (already snapshot-driven via `onSnapshotChange`).

### Phase 5: Drop the `loading` variant from `AuthSnapshot`

- [x] **5.1** In `packages/auth/src/auth-types.ts`, remove `| { status: 'loading' }` from the `AuthSnapshot` union. The type becomes `{ status: 'signedOut' } | { status: 'signedIn'; session: AuthSession }`.
- [x] **5.2** In `packages/auth-workspace/src/index.ts:42`, remove the `if (snapshot.status === 'loading') return;` early-return from `processSnapshot`. With the variant gone, this branch becomes a TypeScript error before it becomes dead code.
- [x] **5.3** In `packages/auth/src/create-auth.ts`, remove the leftover comment on the dispose method that references `{ status: 'loading' }` (line ~331 in current source).
- [x] **5.4** `bun run typecheck` across `packages/auth`, `packages/auth-svelte`, `packages/auth-workspace`, `packages/workspace`, and the six apps. The compiler will flag any remaining `'loading'` checks; fix them in place (most likely zero, per the audit).

### Phase 6: Tests

- [x] **6.1** Delete tests that exist only to exercise async init / dispose-mid-load (see Research Findings table).
- [x] **6.2** Update remaining tests to construct `createAuth` with a synchronous `initialSession`.
- [x] **6.3** Replace the two `expect(auth.snapshot).toEqual({ status: 'loading' })` assertions in `packages/auth/src/create-auth.test.ts` with assertions matching the new initial state (`signedOut` or `signedIn` depending on what the test seeded).
- [x] **6.4** Update the `setup({ initial = { status: 'loading' } ... })` default in `packages/auth-workspace/src/index.test.ts:104` to a valid two-state value.
- [x] **6.5** Add one test: dispose is idempotent (this is the only lifecycle behavior worth retaining).
- [x] **6.6** `bun test` and `bun run typecheck` across the auth package, auth-svelte, auth-workspace, and each app.

### Phase 7: Update the auth skill

- [x] **7.1** `.agents/skills/auth/SKILL.md` references `whenLoaded`, the late-subscribe flow, and the three-state machine. Rewrite to describe the new caller-loads pattern and the two-state snapshot.

## Edge Cases

### wxt-dev/storage in tab-manager

If `storage.getItem` is async, the tab-manager client cannot synchronously read the initial session. Two options:

1. Wrap the boot in an async function and export a promise: `export const authPromise = (async () => createAuth(...))();`. UI gates on `authPromise`.
2. Construct `auth` with `initialSession: null` and rely on the BA subscription to fill it in. Accept a brief signed-out flash on first load.

Option 1 keeps the post-condition (snapshot is definite at construction). Option 2 is simpler but reintroduces the loading window the original code was avoiding. Recommendation: option 1. Confirm during Phase 2.6.

### HMR re-dispose

`if (import.meta.hot) { import.meta.hot.dispose(() => auth[Symbol.dispose]()); }` already exists in browser apps. With the simpler dispose, double-dispose can still happen if HMR retries. Keep the idempotent sentinel.

### Initial session corruption

`createPersistedState` already validates against the schema and falls back to `defaultValue` (`null`). The factory receives a typed `AuthSession | null`. No new edge case.

### saveSession failure

Today `saveSnapshot` catches and console.errors. Keep the same behavior in the new code. Save failures must not throw out of `setSnapshot`.

## Open Questions

All three of the original open questions have been resolved during planning:

- **Loading variant**: dropped (Phase 5). Audit confirmed three source files and two test files reference it; zero UI consumers depend on it.
- **Storage parameter shape**: bare `saveSession` callback (Phase 1.1). `SessionStorage` and `createSessionStorageAdapter` are deleted.
- **`createMachineAuth` becomes async** (Phase 3). Keychain load needs an await; the entry point already runs in an async context.

If new questions surface during implementation, file them here rather than choosing silently.

## Success Criteria

- [ ] `createAuth` body has no `let` declarations for lifecycle (no `disposed`, no nullable handles, no deferred).
- [x] `unsubscribeBetterAuth` is `const`.
- [x] `whenLoaded` is removed from the public `AuthClient` type and from every consumer.
- [x] `AuthSnapshot` is a two-variant union: `signedOut | signedIn`. No `loading` variant in the type, no `'loading'` string literals checked anywhere in the codebase.
- [x] `bun test` passes for `packages/auth`, `packages/auth-svelte`, `packages/auth-workspace`.
- [ ] `bun run typecheck` passes for the six browser apps and the CLI.
- [ ] Each browser app boots and signs in / out without regressions (manual smoke).

## References

- `packages/auth/src/create-auth.ts` (the factory)
- `packages/auth/src/auth-types.ts` (`AuthSnapshot` union; Phase 5)
- `packages/auth/src/session-store.ts` (`SessionStorage`; deleted in Phase 1.6)
- `packages/auth/src/create-auth.test.ts` (tests to prune)
- `packages/auth/src/node/machine-auth.ts:175` (machine auth wrapper)
- `packages/workspace/src/document/attach-sync.ts:444` (`readToken` whenLoaded consumer)
- `packages/auth-workspace/src/index.ts:42` (loading early-return; Phase 5.2)
- `packages/auth-workspace/src/index.test.ts:104` (loading default in test setup; Phase 6.4)
- `apps/{fuji,opensidian,honeycrisp,zhongwen,dashboard,tab-manager}/...` (browser call sites)
- `specs/20260503T180000-auth-snapshot-three-state-clean-break.md` (precedent: same direction, one layer in)
- `.agents/skills/auth/SKILL.md` (needs rewrite in Phase 7)
- `docs/articles/20260503T220500-pass-the-loaded-value-not-the-loader.md` (companion article on the general pattern)

## Review

**Completed**: 2026-05-03
**Branch**: `codex/explicit-daemon-host-config`

### Summary

`createAuth` now constructs synchronously from `initialSession` and persists through `saveSession`. The public auth snapshot is a two-state union, `whenLoaded` is gone from auth consumers, and the auth skill now describes the caller-loads pattern.

### Files Read

```txt
apps/
|-- dashboard/src/lib/auth.ts
|-- fuji/src/lib/fuji/
|   |-- client.ts
|   |-- daemon.ts
|   |-- integration.test.ts
|   `-- script.ts
|-- honeycrisp/src/lib/honeycrisp/
|   |-- client.ts
|   |-- daemon.ts
|   |-- integration.test.ts
|   `-- script.ts
|-- opensidian/src/lib/
|   |-- components/AppShell.svelte
|   `-- opensidian/
|       |-- client.ts
|       |-- daemon.ts
|       |-- integration.test.ts
|       `-- script.ts
|-- tab-manager/src/lib/tab-manager/client.ts
`-- zhongwen/src/
    |-- lib/zhongwen/
    |   |-- client.ts
    |   |-- daemon.ts
    |   |-- integration.test.ts
    |   `-- script.ts
    `-- routes/+page.svelte
packages/
|-- auth/src/
|   |-- auth-types.ts
|   |-- create-auth.test.ts
|   |-- create-auth.ts
|   |-- index.ts
|   `-- node/
|       |-- machine-auth.test.ts
|       `-- machine-auth.ts
|-- auth-svelte/src/
|   |-- create-auth.svelte.ts
|   `-- index.ts
|-- auth-workspace/src/
|   |-- index.test.ts
|   `-- index.ts
`-- workspace/src/document/
    |-- attach-sync.test.ts
    `-- attach-sync.ts
.agents/skills/auth/SKILL.md
```

### Deviations from Spec

- `createMachineAuthWithDependencies` does not construct a core `AuthClient` on this branch, so the keychain load moved into `createMachineAuthClient()`. `createMachineAuth()` still became async so CLI and script call sites have one consistent machine-auth entry shape.
- `packages/cli` has no `typecheck` script, so verification used `bun x tsc --noEmit` in `packages/cli`.
- `packages/auth-svelte` has no test script. Its `bun run typecheck` passes with the existing no-input-files warning from `svelte-check`.

### Verification

- Passed: `bun test` in `packages/auth`.
- Passed: `bun test` in `packages/auth-workspace`.
- Passed: `bun run typecheck` in `packages/auth`, `packages/auth-workspace`, `packages/workspace`, and `packages/auth-svelte`.
- Passed: `bun x tsc --noEmit` in `packages/cli`.
- Passed: `rg -n "'loading'|\"loading\"|status === 'loading'|status: 'loading'" packages apps` found no auth-related matches. Remaining matches are notification and image-loading contexts in `apps/whispering` and `packages/ui`.
- Blocked by existing unrelated errors: app typechecks for fuji, opensidian, honeycrisp, zhongwen, dashboard, and tab-manager still fail in shared UI, svelte-utils, app-specific chat/dashboard code, and API environment typing.
- Not run: manual browser sign-in and sign-out smoke.
