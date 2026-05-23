# Auth Snapshot Three-State Clean Break

**Date**: 2026-05-03
**Status**: Implemented
**Author**: AI-assisted

## One-Sentence Test

`AuthSnapshot` is a real three-state machine: `loading` until the boot cache resolves, then `signedIn` or `signedOut`, with no hidden fourth state.

Everything in this spec serves that sentence. If a flag, buffer, or guard exists to track a state that is not in the public `AuthSnapshot` union, it is in the wrong shape.

## Overview

Eliminate the `bufferedBetterAuthCandidate` mailbox and its `bootCacheLoaded` flag in `packages/auth/src/create-auth.ts` by sequencing initialization correctly: load the boot cache first, set the initial snapshot, then subscribe to Better Auth. The public surface (`AuthClient`, `CreateAuthConfig`, `SessionStorage`) does not change. The internal flow becomes linear and matches the three-state machine the type advertises.

## Motivation

### Current State

`createAuth()` opens the Better Auth subscription before the boot cache has loaded, then patches the resulting race with hidden state.

```ts
let snapshot: AuthSnapshot = { status: 'loading' };
let bootCacheLoaded = false;
let bufferedBetterAuthCandidate: AuthSession | null | undefined;

const client = createAuthClient({ ... });

disposers.push(
    client.useSession.subscribe((state) => {
        if (disposed) return;
        if (state.isPending) return;
        let next: AuthSession | null;
        try {
            next = authSessionFromBetterAuthSessionResponse(state.data);
        } catch (error) {
            console.error('[auth] invalid Better Auth session response:', error);
            return;
        }

        if (!bootCacheLoaded) {
            bufferedBetterAuthCandidate = next;
            return;
        }

        if (next) {
            reconcileBetterAuthCandidate(next);
        } else if (snapshot.status === 'signedIn') {
            writeLocalSnapshot({ status: 'signedOut' });
        }
    }),
);
loadPersistedSession();
```

This shape has four de facto states tracked across two booleans and one tri-state variable:

```txt
                       bootCacheLoaded   bufferedBetterAuthCandidate   visible status
phase 1: pre-load          false         undefined                     'loading'
phase 2: BA ahead of cache false         null | AuthSession            'loading'    <- HIDDEN
phase 3: post-load         true          undefined                     'signedOut' | 'signedIn'
```

This creates problems:

1. **Hidden fourth state**: `AuthSnapshot` advertises three cases. The runtime has four. Reviewers who trust the type are wrong.
2. **Subscription order is backward**: opening the Better Auth subscription before the cache is read is what creates the race. The buffer is the patch, not the cure.
3. **Tri-state variable**: `AuthSession | null | undefined` packs three meanings ("no emission", "emitted signed-out", "emitted signed-in") into a single slot. Each consumer must remember which check is which.
4. **Branching guards everywhere**: `reconcileBetterAuthCandidate(undefined)` early-returns; the null branch guards on `snapshot.status !== 'loading'`. These guards exist only because the function is reachable from two timelines.
5. **`settleLoadedSession()` does too many jobs**: it sets the loaded snapshot, flushes the buffer, and resolves `whenLoaded`. Each step belongs to a different concern.

### Desired State

Initialization is linear:

```txt
1. load boot cache (sync or async)
2. setSnapshot(loading -> signedIn | signedOut)
3. subscribe to Better Auth (atom replays current state synchronously)
4. resolveWhenLoaded
```

`AuthSnapshot` is a true three-state machine. `bufferedBetterAuthCandidate`, `bootCacheLoaded`, `settleLoadedSession()`, and `reconcileBetterAuthCandidate()` (as a separate function) disappear. The Better Auth subscription handler reads as one obvious function: project the response, write a snapshot.

## Research Findings

### Nanostore subscribe semantics

Better Auth's session atom is built on `nanostores`:

```ts
// node_modules/.../better-auth/dist/client/session-atom.mjs
import { atom, onMount } from "nanostores";
function getSessionAtom($fetch, options) {
    const $signal = atom(false);
    const session = useAuthQuery($signal, "/get-session", $fetch, { method: "GET" });
    ...
}
```

`nanostores` documents that `subscribe(listener)` invokes the listener once synchronously with the current value before returning. This means a late subscriber does not miss the current state; it receives it as the first event on subscription.

**Implication**: there is no correctness reason to subscribe to `client.useSession` before the boot cache loads. Subscribing later is safe and gives us the current atom value as the first emission.

### What the buffer was protecting

The buffer was protecting against this race:

```txt
T0: createAuth() called
T1: subscribe(BA) opens
T2: loadPersistedSession() starts
T3: BA emits real session  (state X)
T4: cache load resolves    (state Y)
```

Without the buffer, T3 writes the snapshot, then T4 overwrites it with the stale cached value. The buffer holds T3's emission until T4 settles, then merges. Reordering eliminates the race entirely:

```txt
T0: createAuth() called
T1: loadPersistedSession() starts
T2: cache load resolves     (state Y)
T3: setSnapshot(Y)
T4: subscribe(BA) opens     (atom replays current state X synchronously)
T5: subscribe handler reconciles X over Y
```

### Test mock behavior

The unit test mock at `packages/auth/src/create-auth.test.ts:37-44` registers listeners but does not retain current state:

```ts
useSession: {
    subscribe(listener: (state: BetterAuthSessionState) => void) {
        betterAuthSessionListeners.add(listener);
        return () => { betterAuthSessionListeners.delete(listener); };
    },
},
```

This diverges from real nanostore behavior. The test "Better Auth emission during async load is applied after boot cache settles" relies on the current ordering (subscribe early, buffer the emission). Under the new ordering, the mock must retain the most recent emission and replay it on a late subscriber, matching nanostore.

**Implication**: updating the mock to replay on subscribe is part of this spec. With that change, the existing assertions remain valid; the buffer is no longer the mechanism that makes them pass.

### Comparable patterns in the codebase

| Pattern | Example | Init shape |
| --- | --- | --- |
| `attachSync(...)` with `waitFor: idb.whenLoaded` | `apps/honeycrisp/src/lib/honeycrisp/browser.ts` | gates network subscription on local hydration |
| `attachIndexedDb(...)` exposing `whenLoaded` | workspace `attach*` primitives | "ready" promise gates downstream work |
| `connectWorkspace(...)` chains attachments by reading earlier `whenReady` | docs `architecture.md` | sequential, not buffered |

The repo already prefers "wait, then subscribe" over "subscribe, then buffer." `createAuth` is the outlier.

## Design Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Init ordering | Load boot cache first, then subscribe to Better Auth | Eliminates the race the buffer was patching. Matches the existing repo pattern. |
| `bufferedBetterAuthCandidate` | Delete | The buffer is the symptom of subscribing too early. Removing the cause removes the buffer. |
| `bootCacheLoaded` | Delete | With sequenced init, "cache loaded" is implied by progress past the await. No flag needed. |
| `settleLoadedSession()` | Delete | Each step (set initial, subscribe, resolve) becomes a line in the init function. |
| `reconcileBetterAuthCandidate()` | Inline into the subscription handler | Only one caller after the buffer is gone. No reason to keep a separate function. |
| Snapshot type | Unchanged | Three states remain accurate; the smell was the implementation, not the type. |
| Public API | Unchanged | `AuthClient`, `CreateAuthConfig`, `SessionStorage`, `createSessionStorageAdapter` keep their shape. |
| `safeRun` | Inline | Five-line helper used in one place. |
| `disposers: Array<() => void>` | Replace with one named local | One subscription does not need a list. Rename to `unsubscribeBetterAuth` until a second exists. |
| Pure helpers (`snapshotsEqual`, etc.) | Defer move | Moving to a sibling file is tangential to the thesis. Note as optional follow-up. |
| Test mock for `useSession.subscribe` | Update to retain current state and replay on subscribe | Matches real nanostore semantics; required by the new init ordering. |

## Architecture

Current shape:

```txt
createAuth()
  |
  +-- snapshot = { status: 'loading' }
  +-- bootCacheLoaded = false              <-- internal flag
  +-- bufferedBetterAuthCandidate          <-- mailbox
  +-- createAuthClient(...)
  +-- subscribe(BA)
  |       on emit:
  |         if !bootCacheLoaded -> stash in buffer
  |         else                -> reconcile
  +-- loadPersistedSession()
          on resolve:
            bootCacheLoaded = true
            setSnapshot(loaded)
            if buffered != undefined -> reconcile(buffered)
            resolveWhenLoaded()
```

Target shape:

```txt
createAuth()
  |
  +-- snapshot = { status: 'loading' }
  +-- createAuthClient(...)
  +-- whenLoaded = (async () => {
        const loaded = await sessionStorage.load() (with try/catch)
        if (disposed) return
        setSnapshot(snapshotFromSession(loaded))

        unsubscribeBetterAuth = client.useSession.subscribe((state) => {
            if (disposed || state.isPending) return
            const next = authSessionFromBetterAuthSessionResponse(state.data)  // try/catch
            if (next === null) {
                if (snapshot.status === 'signedIn') writeLocalSnapshot({ status: 'signedOut' })
                return
            }
            const current = sessionFromSnapshot(snapshot)
            writeLocalSnapshot({
                status: 'signedIn',
                session: {
                    token: current?.token ?? next.token,
                    user: next.user,
                    encryptionKeys: next.encryptionKeys,
                },
            })
        })
    })()
```

State diagram (target):

```txt
                       +----------+
                       | loading  |
                       +----+-----+
                            |
              boot cache load resolves
                            |
                  +---------+----------+
                  |                    |
                  v                    v
            +-----------+        +-----------+
            | signedOut |<------>| signedIn  |
            +-----------+        +-----------+
                  ^                    ^
                  |                    |
        BA emits null         BA emits session,
                              token rotation,
                              local signOut() success
```

There is no fourth state. There is no buffered emission. The arrows out of `loading` happen exactly once.

## Implementation Plan

### Phase 1: Reorder initialization

- [x] **1.1** In `packages/auth/src/create-auth.ts`, replace the manual `whenLoaded` deferred + `loadPersistedSession()` with an inline async IIFE assigned to `whenLoaded`. Inside, `await sessionStorage.load()` (a non-Promise return is awaited transparently), set the initial snapshot, then open the Better Auth subscription.
  > **Note**: `whenLoaded` is `Promise.race([initIIFE(), disposeSignal])` so dispose during the `await sessionStorage.load()` step still settles `whenLoaded` (preserving existing behavior asserted by the "dispose resolves whenLoaded and ignores late storage load" test). The IIFE itself stays linear: load, snapshot, subscribe.
- [x] **1.2** Delete `bufferedBetterAuthCandidate`, `bootCacheLoaded`, `settleLoadedSession`, and `reconcileBetterAuthCandidate`. Inline the reconciliation logic into the Better Auth subscription handler.
- [x] **1.3** Replace `disposers: Array<() => void>` with a single `unsubscribeBetterAuth: (() => void) | null = null` (assigned inside the async init). `[Symbol.dispose]()` calls it if set.
- [x] **1.4** Inline `safeRun` into `setSnapshot`'s listener loop. The fan-out becomes a try/catch in place.
- [x] **1.5** Make `[Symbol.dispose]()` continue to resolve `whenLoaded` (existing behavior). Keep the `if (disposed) return` guards inside the async init so a late `load()` resolution does not write a snapshot after dispose. Add a one-line comment on the dispose path explaining that awaiters proceed after teardown but observe `{ status: 'loading' }`.
  > **Note**: Implemented via `resolveDisposeSignal()` racing against the init IIFE; dispose calls it before unsubscribing.

### Phase 2: Update tests

- [x] **2.1** In `packages/auth/src/create-auth.test.ts`, update the `useSession.subscribe` mock to track the latest emitted state and replay it synchronously to new subscribers. Match nanostore semantics. Suggested shape:
    ```ts
    let currentBetterAuthState: BetterAuthSessionState = { isPending: false, data: null };
    function emitBetterAuthSession(data: unknown) {
        currentBetterAuthState = { isPending: false, data };
        for (const l of betterAuthSessionListeners) l(currentBetterAuthState);
    }
    // in mock createAuthClient:
    useSession: {
        subscribe(listener) {
            listener(currentBetterAuthState);
            betterAuthSessionListeners.add(listener);
            return () => betterAuthSessionListeners.delete(listener);
        },
    },
    ```
    Reset `currentBetterAuthState` in `beforeEach`.
- [x] **2.2** Verify the existing test "Better Auth emission during async load is applied after boot cache settles" still passes. Under the new ordering, the assertion logic is the same, but the mechanism is "atom replays on late subscribe" instead of "buffer flush after load."
- [x] **2.3** Verify the "persisted storage load drives initial signed-in snapshot" test still passes (initial snapshot is set from cache before any BA emission).
  > **Note**: With replay-on-subscribe semantics, this test now seeds `currentBetterAuthState` with the matching BA session before `createAuth`. Without seeding, the default null replay would flip the cache-hydrated `signedIn` snapshot to `signedOut`. Seeding models the realistic scenario where the BA atom already holds the user's session at construction time.
- [x] **2.4** Verify "Better Auth signed-out emission drives snapshot and storage save" still passes (BA emits null after subscribe, snapshot transitions signedIn -> signedOut).
  > **Note**: Same seeding pattern as 2.3, plus a `setup.saved.length = 0` reset after `await auth.whenLoaded` to drop the redundant save fired by the subscribe replay (see Open Question 1 about gating `saveSnapshot` on `snapshotsEqual`). Same applies to "response-header token rotation persists through session storage save".
- [x] **2.5** Verify "dispose resolves whenLoaded and ignores late storage load" still passes.
  > **Note**: Required `Promise.race(initIIFE, disposeSignal)` in Phase 1.1 to keep this passing.
- [x] **2.6** Add one new test: "BA emission before boot cache resolves does not write snapshot until cache settles." This was implicit in the previous tests; make it explicit so the invariant survives future refactors.

### Phase 3: Verify consumers and documentation

- [x] **3.1** Run the package's tests (`bun run test:unit` per `monorepo` skill).
  > **Note**: 13 of 13 tests pass in `packages/auth/src/create-auth.test.ts` after the Phase 2 mock update.
- [x] **3.2** Type-check all dependents of `@epicenter/auth` (`bun run check`).
  > **Note**: `@epicenter/auth`, `@epicenter/auth-svelte`, and `@epicenter/auth-workspace` typecheck cleanly. `@epicenter/zhongwen` fails on a missing `apps/zhongwen/.svelte-kit/tsconfig.json` (svelte-kit bootstrap artifact, not generated in this workspace) and `@epicenter/tab-manager` fails on pre-existing `#/utils.js` resolution issues in shadcn-svelte components and an unrelated `savedTabState.save(tab)` arity error. Both failures reproduce on the pre-spec tree and are unrelated to the auth refactor.
- [x] **3.3** Skim `packages/auth-svelte/src/create-auth.svelte.ts` to confirm the wrapper still works (it relies only on the public surface, which is unchanged).
- [x] **3.4** Skim `packages/auth/src/node/machine-auth.ts` to confirm `createMachineAuthClient()` still works (sync/async storage, no buffer dependency).
- [x] **3.5** Search for `bufferedBetterAuthCandidate`, `bootCacheLoaded`, `settleLoadedSession`, `reconcileBetterAuthCandidate` across the repo to confirm no docs, specs, or comments still reference them.
  > **Note**: Only this spec mentions the deleted names (motivation and decision-table sections). No source, doc, or older spec references them.
- [x] **3.6** Update `.agents/skills/auth/SKILL.md` if it describes the buffered behavior.
  > **Note**: One sentence in the Write Ownership section described the buffered flow; rewrote to describe the late-subscribe + nanostore replay flow that replaces it.

### Phase 4: Optional cleanups (defer if scope grows)

- [ ] **4.1** Pull `snapshotFromSession`, `sessionFromSnapshot`, `sessionsEqual`, `snapshotsEqual`, and `usersEqual` into `packages/auth/src/snapshot.ts` (or extend `auth-types.ts`). They have zero closure dependencies and are unit-testable on their own.
- [ ] **4.2** Extract the `set-auth-token` rotation hook into a named local function `applyResponseHeaderToken(response: Response): void` so the reader does not have to scroll into `createAuthClient` config to find token rotation.

## Edge Cases

### Sync `sessionStorage.load()`

Browser apps using `createPersistedState` may return a non-Promise from `load()` once `whenReady` has resolved. `await` on a non-Promise resolves on the next microtask, so the init flow stays the same shape. Snapshot transitions out of `loading` on the next tick rather than synchronously, but `whenLoaded` already documents this: callers gate UI on it.

### `sessionStorage.load()` rejects

The init wraps the await in try/catch; a thrown error logs and treats the load as `null`. Behavior matches the current `(error) => { ... settleLoadedSession(null); }` path. Snapshot becomes `signedOut`. Better Auth subscription still opens.

### Dispose during async load

The init function checks `if (disposed) return` immediately after `await sessionStorage.load()`. If disposed before the cache resolves, the subscription is never opened and `whenLoaded` is resolved by the dispose path. Snapshot remains `{ status: 'loading' }`. Existing behavior preserved.

### Better Auth emits before init's await resolves

In production with real BA: the atom retains the value internally; subscribing later replays it. In tests with the updated mock: same behavior. The new flow does not depend on emission timing relative to cache load.

### Better Auth emits `isPending`

The handler skips pending states (existing guard preserved). The atom continues to retain the most recent non-pending value for replay on subscribe.

### Sign-out flow

`auth.signOut()` calls `client.signOut()`, then `writeLocalSnapshot({ status: 'signedOut' })`. Better Auth's atom emits `null` shortly after; the subscription handler observes `snapshot.status === 'signedOut'` already and skips writing again (existing guard).

### Local signed-in snapshot, BA atom replays a session

When the cache hydrated a signed-in snapshot and Better Auth's atom holds the same user, the subscription handler computes:

```txt
current.token   <- from cache
next.user       <- from BA
next.encryptionKeys <- from BA
```

`writeLocalSnapshot` runs `snapshotsEqual` and skips the listener fan-out if nothing changed. Storage `save()` still fires (current behavior); if that becomes an issue, gate `save()` on `snapshotsEqual` too.

## Open Questions

1. **Should `saveSnapshot` also be gated on `snapshotsEqual`?**
    - Today, `writeLocalSnapshot` calls both `setSnapshot` (which is gated) and `saveSnapshot` (which is not). Equal snapshots still trigger a no-op `save()`.
    - **Recommendation**: defer. The cost of an idempotent `save()` is small for browser localStorage and machine keychain; eager save also covers cases where storage drifted out of sync with snapshot for unrelated reasons. Reconsider if save side effects become observable.

2. **Should the inline async IIFE that produces `whenLoaded` be extracted to a named function for readability?**
    - Options: (a) keep it inline so the reader sees the whole init in one place; (b) extract to `async function init()` and assign `whenLoaded = init()`.
    - **Recommendation**: keep it inline. The thesis of this clean break is "init is linear and short." Lifting it back into a named function risks re-fragmenting the flow.

3. **Should the test mock be promoted to a tiny shared helper?**
    - The nanostore-replay-on-subscribe pattern may be useful elsewhere if other tests mock `client.useSession`.
    - **Recommendation**: defer. One caller does not earn an extraction. If a second test mocks the same surface, then extract.

## Success Criteria

- [x] `packages/auth/src/create-auth.ts` no longer contains `bufferedBetterAuthCandidate`, `bootCacheLoaded`, `settleLoadedSession`, or `reconcileBetterAuthCandidate`.
- [x] `AuthSnapshot` remains a three-case discriminated union with no internal flags simulating a fourth case.
- [x] `whenLoaded` resolves after `sessionStorage.load()` settles and the Better Auth subscription is open.
- [x] All existing tests in `packages/auth/src/create-auth.test.ts` pass after the mock update.
- [x] One new test asserts that a Better Auth emission arriving before cache resolution does not produce a snapshot until the cache settles.
- [x] `bun run check` and `bun run test:unit` succeed for `@epicenter/auth`.
- [x] No references to the deleted internal names remain in code, specs, or docs.
- [x] The public `AuthClient`, `CreateAuthConfig`, `SessionStorage`, and `createSessionStorageAdapter` shapes are unchanged.

## References

Files touched:

- `packages/auth/src/create-auth.ts` (primary)
- `packages/auth/src/create-auth.test.ts` (mock + new test)

Files read for verification (no expected changes):

- `packages/auth/src/auth-types.ts`
- `packages/auth/src/session-store.ts`
- `packages/auth/src/contracts/auth-session.ts`
- `packages/auth/src/index.ts`
- `packages/auth/src/node/machine-auth.ts`
- `packages/auth-svelte/src/create-auth.svelte.ts`
- `apps/honeycrisp/src/lib/honeycrisp/client.ts` (representative consumer)
- `apps/fuji/src/lib/fuji/client.ts` (representative consumer)
- `apps/zhongwen/src/lib/zhongwen/client.ts` (representative consumer)
- `apps/tab-manager/src/lib/tab-manager/client.ts` (representative consumer)
- `apps/dashboard/src/lib/auth.ts` (representative consumer)
- `apps/opensidian/src/lib/opensidian/client.ts` (representative consumer)

Prior specs that produced the current shape:

- `specs/20260503T124735-auth-session-storage-boot-cache.md`
- `specs/20260503T012932-local-auth-session-clean-break.md`
- `specs/20260501T013208-auth-snapshot-api.md`

External references:

- `node_modules/.bun/better-auth@1.5.6+.../node_modules/better-auth/dist/client/session-atom.mjs`
- nanostores docs (`subscribe()` invokes the listener immediately with the current value)
- [Better Auth Client Concepts](https://better-auth.com/docs/concepts/client)

## Review

**Completed**: 2026-05-03
**Branch**: `codex/explicit-daemon-host-config`

### Summary

Three waves landed cleanly: Wave 1 linearized `createAuth` init in `packages/auth/src/create-auth.ts`, Wave 2 updated the test mock to nanostore replay-on-subscribe semantics and added the new pre-load invariant test, and Wave 3 verified consumers and updated the auth SKILL doc. All 13 unit tests pass, `bun run typecheck` passes for `@epicenter/auth`, `@epicenter/auth-svelte`, and `@epicenter/auth-workspace`. The public surface of the auth package is unchanged. The hidden fourth state in the snapshot machine is gone.

### Deviations from Spec

- Phase 1.1 used `Promise.race(initIIFE, disposeSignal)` instead of a bare IIFE assignment to `whenLoaded`. The spec asked for an inline async IIFE assigned to `whenLoaded`, but Phase 1.5 also required `[Symbol.dispose]()` to continue settling `whenLoaded` (existing behavior, asserted by an existing test). A pure IIFE would deadlock when dispose runs while the IIFE is suspended on `sessionStorage.load()`. `Promise.race` keeps the linear init shape inside the IIFE while delegating the early-settle path to a dispose signal.
- Phase 2.3 / 2.4 / response-header-rotation tests required seeding `currentBetterAuthState` to a matching session before constructing `createAuth`. Without seeding, the late subscribe replays the default null and flips a cache-hydrated `signedIn` snapshot to `signedOut`. Two tests also reset `setup.saved.length = 0` after `await auth.whenLoaded` to drop the redundant save fired by the subscribe-replay no-op transition (related to spec Open Question 1 about gating `saveSnapshot` on `snapshotsEqual`, which is deferred).

### Follow-up Work

- **Optional cleanup, deferred (Phase 4 in this spec)**: extracting `snapshotFromSession`, `sessionFromSnapshot`, `sessionsEqual`, `snapshotsEqual`, and `usersEqual` into `packages/auth/src/snapshot.ts`, and renaming the `set-auth-token` rotation hook to a named local function. Both are pure ergonomics with no thesis impact.
- **Open Question 1 (deferred)**: gating `saveSnapshot` on `snapshotsEqual` would let two seeded tests drop the `setup.saved.length = 0` reset and would avoid redundant idempotent saves on the BA replay no-op. Consider when save side effects become observable.
- **Open Question 3 (deferred)**: if a second test starts mocking `client.useSession`, promote the module-scope `currentBetterAuthState` + replay-on-subscribe pattern into a small shared helper.

### Verification

- `bun run typecheck` (in `packages/auth`): pass.
- `bun test src/create-auth.test.ts`: 13 of 13 pass, 29 assertions.
- `bun run typecheck --filter=@epicenter/auth --filter=@epicenter/auth-svelte --filter=@epicenter/auth-workspace`: 3 of 3 pass.
- Other workspace typecheck failures (`@epicenter/zhongwen` missing `.svelte-kit/tsconfig.json`, `@epicenter/tab-manager` `#/utils.js` resolution and unrelated `savedTabState.save(tab)` arity error) reproduce on the pre-spec tree and are unrelated.
- Grep for `bufferedBetterAuthCandidate`, `bootCacheLoaded`, `settleLoadedSession`, `reconcileBetterAuthCandidate`: only this spec mentions them.
