# Workspace Identity Reset: Deterministic Teardown

**Date**: 2026-05-04
**Status**: Implemented; Round 5 follow-ups applied (see Review > Round 5)
**Author**: AI-assisted (Claude)
**Branch**: codex/sync-create-auth (or successor)
**Sibling spec**: `specs/20260504T010000-drop-authclient-redirect-sign-in.md` (per-app local credential minting; ships independently)
**Supersedes**: `specs/20260504T000000-auth-workspace-drop-sync-control.md` (earlier draft scoped only to the syncControl parameter; the deeper teardown invariant turned out to be the load-bearing change)

## One-Sentence Test

Workspace identity reset is a deterministic teardown sequence (dispose subdoc caches, destroy the parent Y.Doc, wipe local data, destroy the JS context in `finally`); the binding stays runtime-agnostic and the app owns the destruction step.

If the design retains a `pause()` call to make sync offline during reset, threads a `SyncControl` parameter through any caller, leaves any reset path with a conditional `reload()`, awaits `whenDisposed` ceremony in a path that is about to reload, or keeps `composeSyncControls` alive for hypothetical future fan-out, the design is not clean yet.

## Overview

Today's "sign out and reset" flow is partially deterministic. It depends on `window.location.reload()` to be the real teardown but the reload is conditional inside a try-catch; if `clearLocalData()` throws, the app shows a toast and keeps running with half-cleared local state. This conditional teardown forced layers above (`auth-workspace`) to add defensive sync-pause logic that narrows the in-process race window between auth-change and reload.

This spec replaces the partial teardown with a deterministic one:

```
1. Dispose subdoc caches       (synchronous; closes child IDB connections so deleteDB doesn't block)
2. Destroy the parent Y.Doc    (synchronous; aborts attachSync, detaches listeners, starts parent IDB close)
3. Await clearLocalData()      (deleteDB blocks until each connection finishes closing; then wipes)
4. Destroy the JS context      (reload, in finally: unconditional)
```

`await sync.whenDisposed` is intentionally NOT in this sequence: after `ydoc.destroy()` synchronously detaches every doc listener and `masterController.abort()` initiates `ws.close()`, the WS finishes closing in the background and the page unload (step 4) handles whatever's left. Awaiting it would be ceremony in a path that is about to reload.

With this teardown in place, every defensive mechanism the layers above accumulated becomes provably redundant and is removed in cascading order: the `syncControl?.pause()` calls, the `syncControl` parameter on `bindAuthWorkspaceScope`, the `composeSyncControls` helper, the `SyncControl` named base type, and the `BrowserWorkspace.syncControl` field.

The result is fewer concepts, less code, and a single layer that owns "what happens when identity transitions to terminal state."

## Why this is the right scope

This is the worked example for `docs/articles/20260504T030000-when-the-smell-wont-die-go-up-a-level.md`: each round of grilling found another defensive surface compensating for the same missing invariant (deterministic teardown), and the final scope is what made all of those surfaces evaporate at once.

The scope evolved through four rounds of grilling. Round 1 proposed only dropping the cold-null pause. Round 2 uncovered factual errors (`composeSyncControls` is already orphaned; `BrowserWorkspace` carries the field; the doc surface was incomplete). Round 3 found three load-bearing issues:

1. **Listener registration order.** `attachSync` registers `auth.onChange` first (during `openFuji()`), `bindAuthWorkspaceScope` registers second (after the bundle returns and the client wires the binding).
2. **`reload()` is conditional.** Every app's `resetLocalClient` only reloads if `clearLocalData()` succeeds. If it throws, only a toast renders.
3. **The reset-path pause IS doing real work.** It synchronously closes the WS *before* `await clearLocalData()` yields. Without it, there's a microtask-window race where pre-queued WS messages can mutate the doc and trigger IDB writes that race the clear.

Round 4 found the actual blocker hiding under the previous fix and trimmed the ceremony around it:

4. **Subdoc cache deadlock.** Fuji, Honeycrisp, and Opensidian hold child Y.Docs in a `createDisposableCache`. Each child has its own `attachIndexedDb` (and Fuji/Honeycrisp also `attachSync`). `clearLocalData` calls `clearDocument(childGuid)` per child, which is `idb.deleteDB(name)`. IndexedDB's `deleteDatabase` blocks until every open connection to that database closes. The parent's `ydoc.destroy()` does NOT destroy these cache children (they are sibling docs, not Yjs subdocs). Without explicit `entryContentDocs[Symbol.dispose]()` (or the equivalent for the other apps), `deleteDB` fires `onblocked` and never resolves; control never reaches `finally`; reload never runs.
5. **`whenDisposed` ceremony in a reload path.** Once the cache disposal lands, `await sync.whenDisposed` adds nothing: `ydoc.destroy()` synchronously detaches every doc listener, so a late WS message can't reach the doc; and the page unload kills the in-flight close. `whenDisposed` remains valuable for the daemon/CLI/test path. It just doesn't earn its keep in the browser reset path.

These collapse into one root cause: there is no deterministic teardown. The pauses, the conditional reload, the missing cache disposal, and the misplaced trust in `whenDisposed` are all partial mitigations for that absence.

The cohesive-clean-breaks principle says: move the boundary that caused the smell, don't wrap it. The boundary that needs moving is the reset path itself: make it deterministic, then the mitigations vanish.

## Grounding (DeepWiki, queried 2026-05-04)

**Better Auth.** `signOut()` is auth-only. There is no canonical Better Auth pattern for atomic teardown of local state. The `onSuccess` callback is the recommended hook for clearing local state and reloading. WebSocket session-token revocation is NOT propagated by Better Auth; clients are responsible. Source: `better-auth/better-auth`.

**Yjs.** `ydoc.destroy()` is synchronous and detaches all `on()` listeners via `ObservableV2`. Pending IDB writes are NOT awaited by `destroy()` itself; persistence providers expose `whenSynced` for that wait. Updates received after `destroy()` are silently dropped (listeners detached). Canonical teardown sequence: disconnect sync → await persistence-synced → destroy doc → clear persistence. Source: `yjs/yjs`.

**Codebase already has the primitives.** `attach-sync.ts:879-907` registers a one-shot destroy handler on the Y.Doc:

```ts
ydoc.once('destroy', async () => {
  masterController.abort();              // sync: kills supervisor + WS
  // ...
  await waitForWsClose(ws, 1000, log);
  resolveDisposed();                     // resolves whenDisposed
});
```

`sync.whenDisposed` is exposed on `SyncAttachment` (`attach-sync.ts:163`) and remains available for the daemon/CLI/test path. The browser reset path skips it (see Round 4 above): `ydoc.destroy()` synchronously detaches every doc listener, so awaiting the WS close adds no behavior, only latency.

**IndexedDB blocking semantics.** `y-indexeddb`'s `clearDocument(name)` is `idb.deleteDB(name)`. The IndexedDB spec: `deleteDatabase` waits for every open connection to that database to close (firing `onblocked` while waiting). Synchronously closing the connection (via the child Y.Doc's destroy handler) is the only thing that lets `deleteDB` proceed; after that, `deleteDB`'s native blocking is enough. No explicit `await whenDisposed` barrier is required.

## Motivation

### Current state

`bindAuthWorkspaceScope` in `packages/auth-workspace/src/index.ts`:

```ts
export type AuthWorkspaceScopeOptions = {
  auth: AuthClient;
  syncControl: SyncControl | null;       // ← removed
  applyAuthIdentity(identity: AuthIdentity): void;
  resetLocalClient(): Promise<void>;
};
```

Two pause calls live on identity transitions:

```ts
async function processIdentity(identity: AuthIdentity | null) {
  if (identity === null) {
    if (appliedIdentity === null) {
      syncControl?.pause();              // ← cold null
      return;
    }
    await resetCurrentClient();          // calls pause inside
    return;
  }
  // ...
}

async function resetCurrentClient() {
  syncControl?.pause();                  // ← reset path
  // ...
}
```

Every app's `resetLocalClient` (using fuji as the canonical example):

```ts
async resetLocalClient() {
  try {
    await fuji.clearLocalData();
    window.location.reload();            // conditional on success
  } catch (error) {
    toast.error('Could not clear local data', {
      description: extractErrorMessage(error),
    });
    // no reload: app keeps running in inconsistent state
  }
},
```

The auth subscription wiring in each app is:

```
T=0 sync   createBrowserAuth(...)                     → identity readable
T=1 sync   openFuji({ auth, ... })                    → calls attachSync(...)
                                                       → attachSync registers
                                                         auth.onChange  [LISTENER 1]
T=2 sync   bindAuthWorkspaceScope({ auth, ... })       → registers
                                                         auth.onChange  [LISTENER 2]
```

So when `auth.onChange` fans out, attachSync's listener fires first, bindAuthWorkspaceScope's second.

### What today's teardown actually does (with the corrected order)

```
auth.onChange(null) fires
   ├── [1] attachSync's listener:
   │       queueMicrotask(reconnect)
   └── [2] auth-workspace's listener:
            schedule(null) → drain → processIdentity(null)
            → resetCurrentClient(): syncControl.pause()  ← SYNC: aborts cycle, ws.close()
                                    isTerminal = true
                                    await resetLocalClient()  [yields]
                                       ├── tries: await clearLocalData()
                                       │   ├── if succeeds: reload()
                                       │   └── if throws:   toast()
                                       └── (no finally)

(microtask phase)
   reconnect runs: cycleController already aborted, swap, ensureSupervisor
   new loop sees masterController not aborted, sees no credential, parks at offline
```

The pause's value: synchronously closes the WS before `clearLocalData` yields. Without it, the WS would close one microtask later. Either way, that microtask runs before any macrotask, so pre-queued WS messages still don't deliver. Messages that arrive *during* `clearLocalData`'s IDB-yields could land on a still-living ydoc.

The reload's failure: if `clearLocalData` throws, the app stays alive with sync-paused, IDB partially cleared, ydoc still alive in memory. User sees a toast and keeps working in a corrupted state.

### Desired state

Each app's `resetLocalClient` becomes a deterministic teardown. The exact shape varies by which subdoc cache (if any) the bundle owns:

```ts
// fuji (has entryContentDocs cache)
async resetLocalClient() {
  try {
    fuji.entryContentDocs[Symbol.dispose]();  // sync: each child ydoc.destroy() closes its IDB
    fuji.ydoc.destroy();                       // sync: parent ydoc.destroy() closes parent IDB
    await fuji.clearLocalData();               // deleteDB blocks until each connection finishes closing
  } catch (error) {
    toast.error('Could not clear local data', {
      description: extractErrorMessage(error),
    });
  } finally {
    window.location.reload();                  // unconditional
  }
},
```

Honeycrisp uses `noteBodyDocs[Symbol.dispose]()`. Opensidian uses `fileContentDocs[Symbol.dispose]()`. Zhongwen and tab-manager have no subdoc cache and skip the first line.

The per-app divergence is honest composition: the call site reflects what the bundle actually owns. Adding a future subdoc cache to any app is a one-line update at exactly the same call site.

The auth-workspace binding's parameter type collapses to:

```ts
export type AuthWorkspaceScopeOptions = {
  auth: AuthClient;
  applyAuthIdentity(identity: AuthIdentity): void;
  resetLocalClient(): Promise<void>;
};
```

`composeSyncControls`, `SyncControl` (the named base type), the `syncControl` field on every `BrowserWorkspace`, and the orphaned `pause()` method on `SyncAttachment` are all deleted.

## Architecture: the new teardown sequence

```
                 SIGN OUT (or USER SWITCH)
                 ─────────────────────────

  auth.onChange(null) fires (synchronous fan-out from useSession.subscribe)
                 │
                 │ Listeners run in registration order:
                 │
                 ├─[1..N]─ each attachSync's onCredentialChange listener
                 │         (parent + any cached child syncs):
                 │         queueMicrotask(reconnect)
                 │
                 └─[last]─ bindAuthWorkspaceScope's listener:
                          schedule(null) → drain → processIdentity(null)
                          → reset(): isTerminal = true
                                     await resetLocalClient()
                                        │
                                        ▼
                            APP'S resetLocalClient RUNS:
                                        │
                                        ▼
                            try {
                              entryContentDocs[Symbol.dispose]()  ← SYNC
                              │  iterates cache, each child:
                              │    ydoc.destroy() → child IDB starts closing
                              │
                              ydoc.destroy()                      ← SYNC
                              │  emits 'destroy' event
                              │  ObservableV2 detaches all listeners
                              │  attachSync's destroy handler runs:
                              │    masterController.abort() ← SYNC
                              │    onAbort → ws.close() (sync)
                              │  attachIndexedDb's destroy handler runs:
                              │    starts await idb.destroy() (async; db.close)
                              │
                              await clearLocalData()              ← AWAIT
                              │  clearEntryContentLocalData():
                              │    deleteDB(childGuid) per child
                              │    blocks until each child IDB connection
                              │    finishes closing, then deletes
                              │  idb.clearLocal():
                              │    deleteDB(parentGuid)
                              │    blocks until parent IDB closes, then deletes
                              │
                            } catch (error) {
                              toast.error(...)                    ← if clear fails
                            } finally {
                              window.location.reload()            ← JS CONTEXT DIES
                            }


                 What happened to the queued reconnect microtasks?
                 ─────────────────────────────────────────────────

  ydoc.destroy() (parent and each child) runs synchronously *inside* the
  binding's listener stack, before any microtask phase. Each destroy aborts
  its own masterController synchronously. By the time the queued reconnect
  microtasks run, their respective masterController.signal.aborted is true:

    function reconnect() {
      if (masterController.signal.aborted) return;   ← bails here
      // ...
    }

  So every reconnect is a no-op. No race. No order-dependence among listeners.
  ydoc.destroy() makes everything else moot.

                 Why no `await sync.whenDisposed`?
                 ─────────────────────────────────

  After ydoc.destroy(), the WS is in CLOSING state and every doc listener is
  detached. A late inbound message has no listener to dispatch to. The WS
  finishes closing in the background; the page unload (reload in finally)
  finishes whatever is left. Awaiting whenDisposed would add measurable
  latency for no observable behavior change.

                 Why no `await idb.whenDisposed`?
                 ────────────────────────────────

  IndexedDB's deleteDatabase() natively blocks on open connections (fires
  `onblocked`, waits, then proceeds when each connection closes). The sync
  destroys above start the connection-close process; deleteDB's own blocking
  serializes the wait. We don't need an explicit promise barrier; IDB has one.
```

After `ydoc.destroy()`, every later operation is operating on a dead workspace. Reload in `finally` is hygiene that handles any throws, including the privacy-leak case where `clearLocalData` partially succeeded and the user's data would otherwise persist.

## Design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Reset teardown sequence | dispose subdoc cache (sync) → `ydoc.destroy()` (sync) → `await clearLocalData()` → `reload()` in `finally` | Deterministic; uses primitives already present; reload unconditionally destroys the JS context |
| `await sync.whenDisposed` in reset path | Drop | Ceremony in a path that's about to reload. WS close is hygiene; page unload handles it. The primitive stays on `SyncAttachment` for daemon/CLI/test use. |
| `await idb.whenDisposed` in reset path | Drop | `deleteDatabase` natively blocks on open connections; explicit barrier is redundant. |
| Subdoc cache disposal | Caller does `<bundle>.<cache>[Symbol.dispose]()` synchronously before `ydoc.destroy()` | Without this, `clearDocument(childGuid)` deadlocks on `onblocked`. Per-app variation is honest composition: the call site reflects what the bundle owns. |
| Reload ownership | App's `resetLocalClient` calls reload directly | The binding sequences auth reset; the app owns whether reset means `window.location.reload()`, extension reload, Tauri window reload, navigation, or a test noop. |
| `auth-workspace` parameter | Drop `syncControl` | Wave 1 invariant: sync owns its own offline state. After deterministic reset, the pause is provably redundant. |
| Both `pause()` calls | Delete | Cold null was always a no-op; reset-path pause was narrowing a race that no longer exists once `ydoc.destroy()` is the synchronous teardown. |
| `composeSyncControls` | Delete | No source caller. Was a pre-emptive helper that no app adopted. |
| `SyncControl` named base type | Inline `reconnect` into `SyncAttachment` and delete | Earned nothing once `composeSyncControls` is gone. |
| `SyncAttachment.pause()` | Delete | No source caller remained after deterministic reset. A future manual offline mode should be designed as a real feature, not preserved as an orphaned method. |
| `BrowserWorkspace.syncControl` | Strip the field | No source consumer after the parameter goes. |
| Conditional `reload()` | Move to `finally` | Reload is the real teardown; making it conditional broke the load-bearing invariant. |
| `appliedIdentity: { userId } \| null` | Collapse to `appliedUserId: string \| null` | Wrapping object stored only the userId. |
| `resetCurrentClient` | Rename to `reset` | "current client" naming conflated user identity with workspace lifetime. |
| Failure mode if `clearLocalData` throws | Reload anyway. Signed-out next load shows empty state; same-user re-sign-in may show inconsistent rows | Better than today's silent "toast and keep running with half-cleared state." |
| Backwards compatibility | None | Mid-migration; this spec is a clean break. |

## API design

### `auth-workspace`

Before:

```ts
export type AuthWorkspaceScopeOptions = {
  auth: AuthClient;
  syncControl: SyncControl | null;
  applyAuthIdentity(identity: AuthIdentity): void;
  resetLocalClient(): Promise<void>;
};
```

After:

```ts
export type AuthWorkspaceScopeOptions = {
  auth: AuthClient;
  applyAuthIdentity(identity: AuthIdentity): void;
  /**
   * Tear down all local state and destroy the JS context.
   *
   * Recommended sequence (apps with subdoc caches; e.g. fuji's
   * `entryContentDocs`):
   *   try {
   *     workspace.entryContentDocs[Symbol.dispose]();
   *     workspace.ydoc.destroy();
   *     await workspace.clearLocalData();
   *   } catch (error) {
   *     // optional: toast or log
   *   } finally {
   *     window.location.reload();
   *   }
   *
   * Apps without subdoc caches drop the first line. Apps without sync drop
   * nothing further (the sync attachment, if absent, simply doesn't exist on
   * the bundle). The destruction step (reload, navigate, or otherwise
   * destroying the JS context) MUST be in `finally` so it runs even if
   * cleanup throws. After this resolves, the binding is in a terminal state
   * and ignores further identity changes.
   */
  resetLocalClient(): Promise<void>;
};
```

Internal `reset()` (renamed from `resetCurrentClient`):

```ts
async function reset() {
  isTerminal = true;
  pendingIdentity = undefined;
  try {
    await resetLocalClient();
  } catch {
    // resetLocalClient is contracted to destroy the JS context.
    // We swallow because a thrown clear is a contract violation we
    // can't recover from here. isTerminal already prevents reentry.
  }
}
```

### `attach-sync.ts`

Before:

```ts
export type SyncControl = {
  pause(): void;
  reconnect(): void;
};

export type SyncAttachment = SyncControl & {
  whenConnected: Promise<unknown>;
  // ...
  pause(): void;       // shadows base for JSDoc
  reconnect(): void;   // shadows base for JSDoc
  // ...
};
```

After:

```ts
export type SyncAttachment = {
  whenConnected: Promise<unknown>;
  readonly status: SyncStatus;
  onStatusChange: (listener: (status: SyncStatus) => void) => () => void;
  /** Force a fresh connection with new credentials (supervisor restarts iteration). */
  reconnect(): void;
  whenDisposed: Promise<unknown>;
  attachRpc(actions: RpcActionSource): SyncRpcAttachment;
};
```

`SyncControl` removed entirely.

### Workspace bundle (e.g., `apps/fuji/src/lib/fuji/browser.ts`)

Before:

```ts
return {
  ...doc,
  idb,
  entryContentDocs,
  awareness,
  sync,
  syncControl: sync,                  // ← removed
  async clearLocalData() { ... },
  remote,
  rpc,
  whenLoaded: idb.whenLoaded,
  [Symbol.dispose]() { ... },
};
```

After:

```ts
return {
  ...doc,
  idb,
  entryContentDocs,
  awareness,
  sync,
  async clearLocalData() { ... },
  remote,
  rpc,
  whenLoaded: idb.whenLoaded,
  [Symbol.dispose]() { ... },
};
```

`BrowserWorkspace` in `packages/workspace/src/shared/workspace.ts` becomes:

```ts
export type BrowserWorkspace = Workspace & {
  clearLocalData(): Promise<void>;
};
```

## Rejected alternatives

### Option A: binding owns the reload policy

The binding internally wraps `resetLocalClient` in `try/finally` and calls `window.location.reload()` itself.

Rejected because the boundary is wrong: the binding is responsible for *sequencing* auth reset (debounce identity changes, gate on terminal state, drive `resetLocalClient`); the app is responsible for *what reset means* in this runtime (browser reload, extension reload, Tauri window reload, navigation, test noop). Folding reload into the binding hides a runtime decision behind a library contract. Readers of `client.ts` can't see it, and any later runtime that wants different destruction semantics has to pry it back out.

Cohesive-clean-breaks skill cites the inverted version (app owns reload policy) as the IoC example: *"a workspace lifecycle helper may know that signed-out cleanup finished; the app decides whether to reload, show a toast, navigate, or keep running."*

(Tauri webviews can in fact call `window.location.reload()`, so "Tauri compatibility" is not the reason. The reason is ownership.)

### Drop only the cold-null pause; keep the reset-path pause

Rejected. The reset-path pause is doing real work today (narrows the WS-message race). Keeping it preserves the layer-violation that the cold-null pause exemplifies. Either both go or neither does. The way to make both go is the deterministic teardown.

### Move `pause()` into `attachSync` as a "signed-out" hook

Rejected. `attachSync` already handles signed-out via `openWebSocket → null`. The pause was doing synchronous-ordering work, not signed-out work. Once `ydoc.destroy()` provides the synchronous abort, no hook is needed.

### Keep `composeSyncControls` for "future fan-out"

Rejected. *"Compatibility is a feature. If nobody explicitly asked for that feature, do not smuggle it into the implementation."* No app adopted it; it has no caller; deleting is correct.

### Defer renames (`appliedIdentity`, `resetCurrentClient`)

Rejected after grill 3. The test file already changes substantially in this spec; deferring leaves variable names mismatched between implementation and helpers. Folding in saves a confused mid-state.

### Two specs (separate teardown spec + syncControl spec)

Rejected. The teardown change is the precondition for the syncControl removal being correct. Splitting forces an ugly intermediate where teardown is fixed but the now-redundant pauses still ride. One spec, one clean break.

## Implementation plan

Phase ordering: A is the architectural change (no breakage; pauses still run). B is the cleanup that A enables (breaking changes confined to one wave). C is internal hygiene. D is doc sweep.

Each phase is one or more commits. Within a phase, the bullets are ordered so each commit compiles.

### Phase A: Deterministic teardown (no breakage)

For each app whose `client.ts` has a `resetLocalClient` body:

- [x] **A.1** Rewrite `resetLocalClient` per the canonical shape. Apps with a subdoc cache dispose it first (synchronously); apps without skip that line.

  Fuji (`apps/fuji/src/lib/fuji/client.ts`):
  ```ts
  async resetLocalClient() {
    try {
      fuji.entryContentDocs[Symbol.dispose]();
      fuji.ydoc.destroy();
      await fuji.clearLocalData();
    } catch (error) {
      toast.error('Could not clear local data', {
        description: extractErrorMessage(error),
      });
    } finally {
      window.location.reload();
    }
  },
  ```

  Honeycrisp (`apps/honeycrisp/src/lib/honeycrisp/client.ts`): identical shape with `honeycrisp.noteBodyDocs[Symbol.dispose]()` instead of `entryContentDocs`.

  Opensidian (`apps/opensidian/src/lib/opensidian/client.ts`): identical shape with `opensidian.fileContentDocs[Symbol.dispose]()` instead of `entryContentDocs`.

  Zhongwen (`apps/zhongwen/src/lib/zhongwen/client.ts`): no subdoc cache, no `attachSync`; drop the cache-dispose line. The rest is identical.

  Tab-manager (`apps/tab-manager/src/lib/tab-manager/client.ts`): no subdoc cache; drop the cache-dispose line. The rest is identical.

  (Dashboard does NOT bind auth-workspace. Verified: `apps/dashboard/src/lib/auth.ts` only creates `auth`; no `bindAuthWorkspaceScope` import anywhere in the dashboard tree. Out of scope.)

- [x] **A.2** After every app updated, run per-app typechecks and the auth-workspace tests. Both should still pass because Phase A is additive in terms of behavior (more thorough teardown) and existing tests don't exercise the failure path.
  > **Note**: Auth-workspace tests and package typechecks pass. Per-app typechecks were run but currently fail on unrelated shared UI and app diagnostics that predate this reset diff.

After Phase A, every app reset is deterministic. The pauses still exist but are now provably redundant (`ydoc.destroy()` happens before any `clearLocalData()` yield, and the existing pause runs before that, so order is `pause → entryContentDocs.dispose → ydoc.destroy → clearLocalData → reload`).

### Phase B: Drop the syncControl surface

- [x] **B.1 (one commit)** Drop the parameter, every call site, AND the auth-workspace tests that exercise it, simultaneously. The test file is part of `@epicenter/auth-workspace`'s typecheck, so leaving the test asserting `'pause'` and constructing fake `syncControl` would break the typecheck at this commit.
  - `packages/auth-workspace/src/index.ts`: remove `syncControl: SyncControl | null` from `AuthWorkspaceScopeOptions`; remove from destructure; remove both `syncControl?.pause()` calls; remove `import type { SyncControl }`.
  - `packages/auth-workspace/src/index.test.ts`:
    - Remove the `syncControl` branch from the `setup()` helper (lines ~109-121); drop the `syncControl: false` test variant (line ~158) and the `cold signedOut with null sync control does not throw` test entirely.
    - Remove `'pause'` entries from each test's expected `calls` array (the six asserting `'pause'` are at lines 152, 194, 206, 224, 242, 254; verify before editing).
    - Rename `cold signedOut pauses sync` → `cold signedOut is a no-op` and assert `[]`.
    - Test variable `appliedIdentities: AuthIdentity[]` is unrelated; leave as-is.
  - For each app's `client.ts`, remove the `syncControl: ...` line from the `bindAuthWorkspaceScope` call:
    - `apps/fuji/src/lib/fuji/client.ts`
    - `apps/honeycrisp/src/lib/honeycrisp/client.ts`
    - `apps/opensidian/src/lib/opensidian/client.ts`
    - `apps/zhongwen/src/lib/zhongwen/client.ts` (the `syncControl: null` line)
    - `apps/tab-manager/src/lib/tab-manager/client.ts`

- [x] **B.2 (one commit)** Drop `syncControl` from workspace bundles + strip from `BrowserWorkspace` simultaneously:
  - `apps/fuji/src/lib/fuji/browser.ts`: drop `syncControl: sync` field.
  - `apps/honeycrisp/src/lib/honeycrisp/browser.ts`: drop `syncControl: sync` field.
  - `apps/opensidian/src/lib/opensidian/browser.ts`: drop `syncControl: sync` field.
  - `apps/tab-manager/src/lib/tab-manager/extension.ts`: drop `syncControl: sync` field.
  - (zhongwen has no `syncControl` field in its bundle; verified)
  - `packages/workspace/src/shared/workspace.ts`: strip `syncControl: SyncControl` from `BrowserWorkspace`. Drop `import type { SyncControl }` if it becomes unused.

- [x] **B.3 (one commit)** Barrel removal must precede file deletion:
  - `packages/workspace/src/index.ts`: remove the `composeSyncControls` re-export.
  - Same commit: remove the `SyncControl` re-export (no remaining external consumer; decision is forced).
  - Same commit: delete `packages/workspace/src/document/sync-control.ts`.
  - Same commit: delete `packages/workspace/src/document/sync-control.test.ts`.

- [x] **B.4 (one commit)** Inline `reconnect` into `SyncAttachment`; delete `SyncControl`:
  - `packages/workspace/src/document/attach-sync.ts:128-131`: delete `export type SyncControl = { pause; reconnect };`.
  - `:133`: change `export type SyncAttachment = SyncControl & { ... }` to `export type SyncAttachment = { ... }`.
  - `reconnect()` remains on `SyncAttachment`; `pause()` is dropped in Round 5 because no source caller remains.

### Phase C: Internal renames

- [x] **C.1** `packages/auth-workspace/src/index.ts`:
  - Rename `appliedIdentity: { userId } | null` → `appliedUserId: string | null`. Drop the wrapping object; compare directly against `identity.user.id`.
  - Rename `resetCurrentClient` → `reset`.

  Test updates that touch implementation-renamed names land in this commit. (The `syncControl`/`pause` test cleanup already shipped in B.1; this commit is purely the rename rippling.)

### Phase D: Doc sweep

- [x] **D.1** `docs/articles/satisfies-lets-go-to-definition-follow-the-value.md`: contains six `syncControl`/`SyncControl` references (lines 10, 12, 29, 67, 158, 163, 168). The example is structural: `BrowserWorkspace` shape demonstrates `satisfies` behavior. Either pick a different field that survives this spec (e.g., the existing `idb` reference in the same article), or update the demo `BrowserWorkspace` type to match the new shape.

- [x] **D.2** `.agents/skills/auth/SKILL.md`:
  - Line 103 (code example showing `syncControl: workspace.syncControl` inside `bindAuthWorkspaceScope`): drop the line.
  - Line 118 (prose recommending fan-out via `pause()`/`reconnect()` on a small inline object): replace with a one-liner that each `attachSync` is independently auth-aware via `openWebSocket` and `onCredentialChange`; no fan-out is needed.

- [x] **D.3** `docs/guides/consuming-epicenter-api.md` (~line 127): drop the `syncControl: workspace.sync` example or refresh the surrounding sample.

- [x] **D.4** `packages/workspace/README.md`: strip `composeSyncControls` and `SyncControl` mentions if any; refresh sample code.

- [x] **D.5** `apps/fuji/README.md:56`: replace the prose "Auth state flows through `auth.identity` and `bindAuthWorkspaceScope` in `apps/fuji/src/lib/fuji/client.ts`, where the app composes sync pause, key application, reconnect, and local reset policy" with a one-liner reflecting the new shape: the app composes key application and the deterministic reset path (subdoc cache disposal, `ydoc.destroy()`, `clearLocalData`, reload). The app no longer composes sync pause or reconnect; sync owns its own offline state. (`apps/honeycrisp/README.md` and the other app READMEs verified clean: they do not mention `syncControl` and need no edit.)

- [x] **D.6** Run straggler greps below.

## Edge cases

### App-admin "Click to reconnect" button

`packages/svelte-utils/src/account-popover/account-popover.svelte` reads `sync.status` and calls `sync.reconnect()` directly off the `SyncAttachment`. The popover is unchanged because it never called `pause()`.

### CLI and daemon

`packages/cli/src/commands/up.ts:322` uses `sync.onStatusChange`. `packages/workspace/src/daemon/run-handler.ts:146` reads `sync.status`. Neither uses `SyncControl` or `composeSyncControls`. Unchanged.

(Note: `packages/cli/package.json` has no `scripts` field, so there is no `bun run --filter @epicenter/cli typecheck` to invoke. The cli compiles inline through workspace `typecheck` when it ripples; the canary is `bun run --filter @epicenter/workspace typecheck`, which the cli depends on.)

### Whispering

`apps/whispering/` does not bind `auth-workspace` (verified: no `bindAuthWorkspaceScope` import). Out of scope.

### Reset paths that don't reload (future)

If a future caller writes a `resetLocalClient` that doesn't reload, for example a Tauri webview using `navigate` or a unit test mocking the destruction step, the contract holds: the function must destroy the JS context or equivalent. The binding is in a terminal state after `reset()` completes, so subsequent identity changes are ignored regardless. JSDoc on `resetLocalClient` documents this.

### `clearLocalData` throws

With the new `finally`, reload always runs. The user sees a brief toast (the catch path still toasts) and a fresh page load. Two outcomes after reload, depending on what the user does next:

- **Stays signed out**: Encryption is in passthrough mode (no `applyKeys` call), so `decrypt(encryptedBlob, ...)` returns `undefined` for every encrypted entry. `getAllValid()` filters those out. The app shows an empty state. (Verified against `attach-encryption.ts:215` and `y-keyvalue-lww-encrypted.ts:174-193`.)
- **Signs back in as the same user immediately**: Keys decrypt cleanly. The app may show inconsistent rows: metadata for entries whose body content was cleared (because `clearEntryContentLocalData` partially succeeded) appears as ghost rows with empty bodies. This is rare and acceptable; better than today's silent "toast and keep running with half-cleared state."

Privacy guarantee holds in both cases: the `await fuji.clearLocalData()` is what we trust to wipe before reload. Without that await, page unload would cancel in-flight `deleteDatabase` transactions and the next user could read the previous user's encrypted blobs.

### Sign-out flow timing

`auth.signOut()` is HTTP-first. The flow inside `packages/auth/src/create-auth.ts:363-372`:

```ts
async signOut() {
  const { error } = await betterAuthClient.signOut();   // HTTP round trip
  if (error) return AuthError.SignOutFailed({ cause: error });
  clearCredential(setIdentity);                          // sync; fires onChange listeners
  return Ok(undefined);
}
```

So during the round trip (~200ms-2s), the workspace is fully alive and sync is connected. After the fetch resolves, `clearCredential` synchronously invokes every `auth.onChange` listener. The reset begins inside the same call stack as the HTTP-resolution microtask, before the click handler's `await auth.signOut()` returns to the UI. This timing is what makes the listener-order analysis above tractable: there is no async gap between identity flip and reset start.

### Concurrent identity changes during reset

After `reset()` sets `isTerminal = true`, the drain loop ignores subsequent identities and the reload runs. If a third identity arrives between `await resetLocalClient()` returning and the reload firing, it's ignored because the binding is terminal and the JS context is about to die.

### `ydoc.destroy()` triggers handlers in the same Y.Doc

Confirmed via DeepWiki: synchronous; sets `isDestroyed = true`; recursively destroys subdocuments; emits `'destroy'`; detaches all listeners via `ObservableV2`. The codebase's `attach-sync.ts:879` registers a `once('destroy', ...)` handler that runs `masterController.abort()` synchronously and then awaits the WS close. `whenDisposed` resolves after that handler completes.

### BroadcastChannel during reset

`attachBroadcastChannel` registers a listener on the Y.Doc. `ydoc.destroy()` detaches it. No further BroadcastChannel events reach the destroyed doc.

### Subdocument lifecycle (Fuji's entry-content docs, Honeycrisp's note-body docs, Opensidian's file-content docs)

These caches hold sibling Y.Docs (created via `new Y.Doc({ guid })`), NOT Yjs subdocuments. Yjs only auto-destroys true subdocs (those tracked by `parent.subdocs`). Each cached child has its own `attachIndexedDb`, and Fuji/Honeycrisp children also have their own `attachSync`. Each child's IDB connection only closes when that child's `ydoc.destroy()` runs.

`clearLocalData` calls `clearDocument(childGuid)` per child, which is `idb.deleteDB(name)`. IndexedDB's `deleteDatabase` blocks until every open connection to that database closes: it fires `onblocked` and waits indefinitely otherwise. If we destroy only the parent and rely on reload to handle children, `deleteDB` blocks waiting for child connections that won't close until reload. Reload never runs because we're stuck inside `await clearLocalData()`. Deadlock.

The fix is the first line of the canonical reset shape: `<bundle>.<cache>[Symbol.dispose]()` synchronously, before `ydoc.destroy()` on the parent. The cache's dispose iterates entries and calls `ydoc.destroy()` on each child, which initiates each child's IDB close. By the time `await clearLocalData()` runs, all closes are in flight; `deleteDB`'s native blocking serializes the wait per child.

## Success criteria

- [x] No source file imports `composeSyncControls`.
- [x] No source file imports `SyncControl` from `@epicenter/workspace`.
- [x] `bindAuthWorkspaceScope`'s parameter type has no `syncControl` field.
- [x] `BrowserWorkspace` has no `syncControl` field.
- [x] `packages/workspace/src/document/sync-control.ts` and its test are deleted.
- [x] No app's workspace bundle exposes a `syncControl` field.
- [x] `attach-sync.ts` does not export a named `SyncControl` type.
- [x] Every app's `resetLocalClient` disposes its subdoc cache (where applicable), calls `ydoc.destroy()`, awaits `clearLocalData()`, and reloads in `finally`. No `await sync.whenDisposed` in the reset path.
- [x] `bun test packages/auth-workspace` passes.
- [x] `bun run --filter @epicenter/auth-workspace typecheck` passes.
- [x] `bun run --filter @epicenter/workspace typecheck` passes.
- [ ] Per-app typechecks pass (see verification commands).
  > **Blocked**: All five requested app typechecks were run and fail on unrelated existing Svelte/shared UI/app diagnostics, including `packages/svelte-utils/src/from-table.svelte.ts`, `packages/ui/src/sonner/toast-on-error.ts`, `packages/ui` `#/utils.js` import resolution, and unrelated app component errors.
- [ ] Manual sign-out smoke test on Fuji and Honeycrisp at minimum (the apps with subdoc caches): open at least one entry/note (populating the cache), then sign out, verify the page reloads cleanly with no `onblocked` warning in DevTools and no console errors related to teardown.
  > **Blocked**: Fuji was opened in the in-app browser on `http://localhost:5174/`, but no throwaway account/session was available. Completing sign-in or account creation requires explicit credentials and action-time approval.

## Files to inspect

```
packages/auth-workspace/src/index.ts                   edit (Phase B.1, C.1)
packages/auth-workspace/src/index.test.ts              edit (Phase B.1)
packages/workspace/src/document/attach-sync.ts         edit (Phase B.4)
packages/workspace/src/document/sync-control.ts        delete (Phase B.3)
packages/workspace/src/document/sync-control.test.ts   delete (Phase B.3)
packages/workspace/src/shared/workspace.ts             edit (Phase B.2)
packages/workspace/src/index.ts                        edit (Phase B.3)
apps/fuji/src/lib/fuji/client.ts                       edit (Phase A, B.1)
apps/fuji/src/lib/fuji/browser.ts                      edit (Phase B.2)
apps/honeycrisp/src/lib/honeycrisp/client.ts           edit (Phase A, B.1)
apps/honeycrisp/src/lib/honeycrisp/browser.ts          edit (Phase B.2)
apps/opensidian/src/lib/opensidian/client.ts           edit (Phase A, B.1)
apps/opensidian/src/lib/opensidian/browser.ts          edit (Phase B.2)
apps/zhongwen/src/lib/zhongwen/client.ts               edit (Phase A, B.1)
                                                        (no sync, no subdoc cache; teardown is ydoc.destroy + clearLocalData)
apps/tab-manager/src/lib/tab-manager/client.ts         edit (Phase A, B.1)
                                                        (no subdoc cache)
apps/tab-manager/src/lib/tab-manager/extension.ts      edit (Phase B.2)
packages/svelte-utils/src/account-popover/
  account-popover.svelte                               verify unchanged
.agents/skills/auth/SKILL.md                           edit (Phase D.2; line 103 + line 118)
packages/workspace/README.md                           edit (Phase D.4)
apps/fuji/README.md                                    edit (Phase D.5; line 56 prose only)
docs/articles/satisfies-lets-go-to-definition-follow-the-value.md   edit (Phase D.1)
docs/guides/consuming-epicenter-api.md                 edit (Phase D.3)
```

## Verification commands

```sh
# Auth-workspace and workspace package
bun test packages/auth-workspace/src/index.test.ts
bun run --filter @epicenter/auth-workspace typecheck
bun run --filter @epicenter/workspace typecheck

# Per-app typechecks. Note: opensidian uses `check` not `typecheck`.
# packages/cli has no typecheck script; it rides on @epicenter/workspace's typecheck.
bun run --filter @epicenter/fuji typecheck
bun run --filter @epicenter/honeycrisp typecheck
bun run --filter opensidian check
bun run --filter @epicenter/zhongwen typecheck
bun run --filter @epicenter/tab-manager typecheck

# Manual smoke (Fuji and Honeycrisp at minimum, since they have subdoc caches)
# 1. Sign in.
# 2. Open at least one entry/note (populates the subdoc cache).
# 3. Sign out from the account popover.
# 4. Verify:
#    - page reloads cleanly within ~1-2s
#    - DevTools Console: no errors, no `onblocked` warnings from IndexedDB
#    - DevTools Application > IndexedDB: previous user's databases are gone
#    - fresh state shows (signed-out UI)
#    - no "could not clear local data" toast that doesn't reload
```

## Straggler searches

```sh
rg -n "composeSyncControls" apps packages docs -S
rg -n "from '@epicenter/workspace'.*SyncControl" apps packages -S
rg -n "syncControl" apps packages docs -S
rg -n "syncControl\?\.pause\(\)|syncControl\.pause\(\)" apps packages -S
rg -n "BrowserWorkspace" packages apps docs -S
```

After implementation:
- The first should match only historical specs.
- The second should be empty in source.
- The third should match only historical specs (parameter, field, and call sites all gone).
- The fourth should be empty.
- The fifth should match the slimmed `BrowserWorkspace` definition and any remaining callers (verify the type still earns its keep with what's left).

## Review

**Completed**: 2026-05-04
**Branch**: `codex/sync-create-auth`

### Summary

The implementation installed the deterministic reset sequence in every auth-bound browser app. Fuji, Honeycrisp, and Opensidian dispose cached child documents before destroying the parent `ydoc`; Zhongwen and Tab Manager destroy only the parent document before clearing local data. Every reset path reloads in `finally` and does not await `sync.whenDisposed` or `idb.whenDisposed`.

The cleanup phases removed the `syncControl` binding parameter, app call sites, bundle fields, `BrowserWorkspace.syncControl`, the `composeSyncControls` helper, the named `SyncControl` alias, and the unused `SyncAttachment.pause()` method. `reconnect()` remains part of `SyncAttachment` for direct sync UI, daemon, CLI, and test use.

### Commits

- `2b6bc63fa` `fix: make workspace resets deterministic`
- `9188ad25c` `refactor(auth-workspace): remove sync control binding`
- `b3e1114de` `refactor(workspace): drop browser sync control field`
- `eda328c32` `refactor(workspace): remove sync control helper`
- `0e1829343` `refactor(workspace): inline sync attachment controls`
- `c0f1da6b0` `refactor(auth-workspace): simplify applied identity state`
- `d9a95d76f` `docs: refresh workspace auth reset guidance`

### Verification

Passed:

```sh
bun test packages/auth-workspace/src/index.test.ts
bun run --filter @epicenter/auth-workspace typecheck
bun run --filter @epicenter/workspace typecheck
```

Straggler greps were run. Source matches for `composeSyncControls`, `SyncControl`, and `syncControl` are empty; remaining matches are historical article/spec references.

Blocked:

- `bun run --filter @epicenter/fuji typecheck`
- `bun run --filter @epicenter/honeycrisp typecheck`
- `bun run --filter opensidian check`
- `bun run --filter @epicenter/zhongwen typecheck`
- `bun run --filter @epicenter/tab-manager typecheck`

The app checks fail on diagnostics outside this reset diff, including shared `packages/svelte-utils/src/from-table.svelte.ts`, `packages/ui/src/sonner/toast-on-error.ts`, `packages/ui` `#/utils.js` resolution, and unrelated app component errors.

Manual smoke is also blocked. Fuji opened in the in-app browser, but the session was signed out and no throwaway credentials were available. Sign-in or account creation needs explicit credentials and action-time approval.

### Follow-up Work

- Fix the existing app and shared UI typecheck failures so app-level verification can run as a reliable gate.
- Run Fuji and Honeycrisp sign-out smoke tests with a throwaway account or isolated browser profile after credentials are available.

### Round 5: post-implementation findings

The original spec ran four rounds of grilling before implementation. A fifth round, run against the merged code by sub-agent audits, found three loose ends. Two are real cleanups; one is a verification result that closes a previously-open question.

**Lesson named**: cleanup that drops every caller of an API should drop the API in the same pass. The cleaner the deletion looks at the call site, the easier it is to forget the now-orphaned definition. Round 5 is the "smell won't die, go up a level" article's pattern applied to itself.

#### 5.1: `SyncAttachment.pause()` was provably dead

After Phase B dropped the cold-null pause and the reset-path pause, no source caller of `pause()` remained anywhere in the repo. The method declaration, body, and returned property survived the cleanup as orphaned API. Round 5 dropped `pause()` entirely:

- `packages/workspace/src/document/attach-sync.ts`: removed the JSDoc + type declaration, the function body (`cycleController.abort(); manageWindowListeners('remove'); status.set({ phase: 'offline' });`), and the `pause,` line in the returned `SyncAttachment` object.

`reconnect()` stays: `packages/svelte-utils/src/account-popover/account-popover.svelte` calls it from the "Reconnect" button, and `attach-sync.ts` itself queues it via `onCredentialChange`.

#### 5.2: `isTerminal` renamed to `isResetting`

Internal flag in `packages/auth-workspace/src/index.ts`. The state-machine metaphor "terminal" required readers to understand the reset-then-reload lifecycle to parse. `isResetting` directly names what the flag gates: a reset has begun, and nothing else should run until the page reloads. Five-line rename + one test docstring update. Behavior unchanged. References to `isTerminal` elsewhere in this spec body (in code blocks and prose) reflect the as-planned shape; the as-implemented shape uses `isResetting`.

#### 5.3: tab-manager service-worker reload semantics: verified safe

Open question from the original review: `window.location.reload()` from a Chrome extension popup reloads the popup, not the service worker. If the workspace lived (even partially) in the background script, the previous user's state would persist across reset.

Verified: `apps/tab-manager/src/entrypoints/background.ts` is minimal: its only job is `browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`. The header comment confirms the architecture: *"All Y.Doc, browser event listeners, sync, and command consumer logic has been consolidated into the side panel context."*

Tab-manager's workspace lives entirely in the side panel. `window.location.reload()` reloads the side panel, which is exactly where the workspace lives. No service-worker state to flush. The canonical reset shape is correct as-is.

#### Status of stale references in this spec

Lines that read "isTerminal" are historical notes from the as-planned design. The as-implemented shape uses `isResetting`. References that described `pause()` as still declared on `SyncAttachment` were updated in the main body because they described the current surface, not historical motivation.
