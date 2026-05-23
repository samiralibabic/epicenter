# Session Encryption Keys Collapse

**Date**: 2026-05-13
**Status**: Implemented
**Author**: Braden + Claude

## Sentence

```txt
createSession hands the build callback a ready-to-use encryptionKeys
getter, so apps stop reaching back into @epicenter/auth for the one
field that needs to stay fresh across reauth.
```

## Overview

Every browser app's `session.ts` repeats the same opaque line:

```ts
encryptionKeys: () => requireIdentity(auth).encryptionKeys,
```

`createSession` already subscribes to `auth.onStateChange` and is the only thing that knows the workspace's lifetime is bounded by identity presence. It should be the one to expose a "current encryption keys" getter so apps don't import `@epicenter/auth` just to write a defensive throw that can never fire.

## Execution note

Current status: live and implemented in this pass. `createSession` still accepted only an identity snapshot, and the five app session files still repeated `encryptionKeys: () => requireIdentity(auth).encryptionKeys`.

Implemented now: `createSession` passes `{ identity, encryptionKeys }` to the build callback. The getter stays lazy and reads through `requireIdentity(auth)` at call time, preserving same-user workspace lifetime behavior across reauth. Fuji, Honeycrisp, Opensidian, Zhongwen, and Tab Manager now pass that getter through and no longer import `requireIdentity` in their session files.

Out of scope now: daemon-route and script auth wiring still imports `requireIdentity` directly, as planned. Manual browser sign-in and forced reauth checks remain manual validation.

## Motivation

### Current State

Five apps. Four follow the same shape, one (tab-manager) is bespoke.

`apps/fuji/src/lib/session.ts`:

```ts
import { requireIdentity } from '@epicenter/auth';
import { createSession } from '@epicenter/svelte';
import { auth } from '$platform/auth';

export const session = createSession({
  auth,
  build: (identity) => {
    const fuji = openFujiBrowser({
      userId: identity.user.id,
      replicaId: createReplicaId({ storage: localStorage }),
      openWebSocket: auth.openWebSocket,
      encryptionKeys: () => requireIdentity(auth).encryptionKeys,
    });
    // ...
  },
});

export const requireFuji = session.require;
```

`apps/honeycrisp/src/lib/session.ts`, `apps/opensidian/src/lib/session.ts`, `apps/zhongwen/src/lib/session.ts`: same shape, different binding.

`apps/tab-manager/src/lib/session.svelte.ts`: wraps `createSession` in a `whenReady`-gated singleton because its auth client can only be constructed after `authSessionStorage.whenReady` resolves.

`createSession` itself (`packages/svelte-utils/src/session.svelte.ts`):

```ts
export function createSession<T extends Disposable>({
  auth,
  build,
}: {
  auth: AuthClient;
  build: (identity: WorkspaceIdentity) => T;
}) {
  let payload = $state<T | null>(null);

  function reconcile(state: AuthState) {
    if (state.status === 'signed-out') {
      payload?.[Symbol.dispose]();
      payload = null;
    } else {
      payload ??= build(state.identity);  // captured once per signed-in span
    }
  }
  // ...
}
```

`requireIdentity` (`packages/auth/src/require-identity.ts`):

```ts
export function requireIdentity(auth: AuthClient): WorkspaceIdentity {
  if (auth.state.status === 'signed-out') {
    throw new Error('[auth] called requireIdentity while signed-out.');
  }
  return auth.state.identity;
}
```

This creates problems:

1. **Leaky abstraction**: `createSession` already owns the auth subscription; apps shouldn't reach back into `auth` to read the same identity the session is tracking.
2. **Dead defensive code**: The throw inside `requireIdentity` cannot fire from a session-built workspace's lazy callback. The workspace is disposed before signed-out. The throw exists to satisfy TypeScript narrowing, not to catch a real failure mode.
3. **Per-app duplication**: Five files write the same opaque getter line. New apps copy-paste it without understanding why.
4. **Two imports for one concept**: Every session file imports `createSession` and `requireIdentity` to express one idea ("get fresh identity for this workspace").

### Desired State

Apps stop importing `requireIdentity` in session files. The build callback receives a session-bound `encryptionKeys` getter:

```ts
import { createSession } from '@epicenter/svelte';
import { auth } from '$platform/auth';

export const session = createSession({
  auth,
  build: ({ identity, encryptionKeys }) => {
    const fuji = openFujiBrowser({
      userId: identity.user.id,
      replicaId: createReplicaId({ storage: localStorage }),
      openWebSocket: auth.openWebSocket,
      encryptionKeys,
    });
    // ...
  },
});

export const requireFuji = session.require;
```

`requireIdentity` stays exported from `@epicenter/auth` and `@epicenter/auth/node` because daemons (`apps/fuji/blocks/daemon-route.ts`) still use it directly. This spec only collapses the **session-bound** path.

## Why a getter, not the value

`encryptionKeys` is the only field on `WorkspaceIdentity` that can change during a workspace's lifetime. Today:

- `payload ??= build(state.identity)` captures `identity` once per signed-in span.
- A `signed-in` to `reauth-required` to `signed-in` cycle preserves the workspace (no dispose/rebuild) but can land a fresh identity object on `auth.state`.
- The lazy `() => requireIdentity(auth).encryptionKeys` re-reads each time. The captured `identity` parameter would be stale.

So the lazy form is load-bearing, not paranoia. Surfacing it as a session-bound getter keeps the correctness without leaking the auth import.

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Build signature | 2 coherence | `build({ identity, encryptionKeys }) => T` | Single object arg; named fields read clearly at the call site. Adding a future `currentIdentity` is non-breaking. |
| Surface name | 3 taste | `encryptionKeys` | Matches the workspace API parameter name verbatim. Apps pass through, no rename. |
| Surface shape | 2 coherence | `() => EncryptionKeys` getter | Identical to what `openFujiBrowser` and friends already accept. Pass-through, not adapt. |
| Keep `requireIdentity` export | 1 evidence | Yes | Used by `apps/fuji/blocks/daemon-route.ts:46` and by `@epicenter/auth/node`'s daemon-side machine auth. Verified via grep. |
| Keep `requireFoo` aliases | 3 taste | Keep | Reads cleaner at component call sites (`requireFuji()` over `session.require()`); already idiomatic across all five apps. **Revisit when:** a new app pattern emerges where the alias adds friction. |
| `createAppSession` wrapper | Deferred | Defer | Four apps are already a single `createSession` call; the only repeated lines after Phase 1 are the HMR dispose block and the alias. Not enough surface to justify another factory. Revisit if a sixth app appears. |
| Tab-manager async-auth path | Deferred | Out of scope | Its `whenReady` wrapper is a real complication (auth client itself is async). Folding `Promise<AuthClient>` support into `createSession` would complicate the common case for one outlier. Defer until a second async-auth app appears. |

## Architecture

What changes:

```
                        BEFORE
┌─────────────────────────────────────────────┐
│ app/session.ts                              │
│   imports: createSession, requireIdentity   │
│   build: (identity) => openX({              │
│     ...                                     │
│     encryptionKeys: () =>                   │
│       requireIdentity(auth).encryptionKeys  │  <-- reaches back into auth
│   })                                        │
└─────────────────────────────────────────────┘
              │
              ▼ uses
┌─────────────────────────────────────────────┐
│ createSession (svelte-utils)                │
│   subscribes to auth.onStateChange          │
│   passes only identity snapshot to build    │
└─────────────────────────────────────────────┘

                        AFTER
┌─────────────────────────────────────────────┐
│ app/session.ts                              │
│   imports: createSession                    │  <-- one import
│   build: ({ identity, encryptionKeys }) =>  │
│     openX({ ..., encryptionKeys })          │  <-- pass through
└─────────────────────────────────────────────┘
              │
              ▼ uses
┌─────────────────────────────────────────────┐
│ createSession (svelte-utils)                │
│   subscribes to auth.onStateChange          │
│   exposes encryptionKeys getter that reads  │
│   auth.state on every call                  │
└─────────────────────────────────────────────┘
```

Inside `createSession`, the getter is one line:

```ts
const encryptionKeys = () => requireIdentity(auth).encryptionKeys;
// ...
payload ??= build({ identity: state.identity, encryptionKeys });
```

`createSession` is allowed to import `requireIdentity` because it's the one place the throw is still meaningful: a misuse would mean the session's own subscription is broken.

## Implementation Plan

### Phase 1: Build the new path

- [x] **1.1** Update `createSession` signature in `packages/svelte-utils/src/session.svelte.ts` to pass `{ identity, encryptionKeys }` to `build`. The getter is `() => requireIdentity(auth).encryptionKeys`.
- [x] **1.2** Update the JSDoc example in the same file to match the new shape.
- [x] **1.3** Typecheck `packages/svelte-utils` in isolation.

### Phase 2: Migrate consumers

- [x] **2.1** `apps/fuji/src/lib/session.ts`: drop `requireIdentity` import, switch to `({ identity, encryptionKeys })`, pass `encryptionKeys` through.
- [x] **2.2** `apps/honeycrisp/src/lib/session.ts`: same.
- [x] **2.3** `apps/opensidian/src/lib/session.ts`: same.
- [x] **2.4** `apps/zhongwen/src/lib/session.ts`: same.
- [x] **2.5** `apps/tab-manager/src/lib/session.svelte.ts`: same migration inside the inner `buildSession`. The outer `whenReady` wrapper is unchanged.

### Phase 3: Prove

- [x] **3.1** Run focused typechecks for `packages/svelte-utils`, Fuji, Honeycrisp, Opensidian, Zhongwen, and Tab Manager.
- [ ] **3.2** Boot each app's dev server, confirm sign-in to signed-in workspace works, no console errors on first encrypt/decrypt.
- [ ] **3.3** Spot-check one app on a `reauth-required` cycle (force token expiry or stub) to confirm the workspace stays mounted and encryption still works.

### Phase 4: Remove

- [x] **4.1** Verify `requireIdentity` is still imported by `apps/fuji/blocks/daemon-route.ts` and node-side consumers.
- [x] **4.2** Confirm no remaining `requireIdentity(auth)` call inside any `apps/*/src/lib/session*` file: `rg "requireIdentity\\(auth\\)" apps/*/src/lib/session*`.

## Edge Cases

### Reauth refreshes encryption keys

1. App is `signed-in` with keys K1.
2. Workspace is built once; `encryptionKeys` getter is held by the workspace runtime.
3. Auth flips to `reauth-required` (still has identity), then back to `signed-in` with keys K2.
4. `payload ??= build(...)` does not rebuild (payload is non-null).
5. Next encrypt/decrypt call invokes the getter, which reads `auth.state.identity.encryptionKeys` = K2.
6. Correct keys used. No stale capture.

### Signed-out during workspace operation

1. Workspace is mid-operation; getter has been called and returned K1.
2. Auth transitions to `signed-out`.
3. `reconcile` disposes the payload synchronously.
4. Any in-flight async op holding the value K1 completes against K1 (correct for what it was started with).
5. New ops cannot start because the workspace is disposed.

### Daemon side

1. `apps/fuji/blocks/daemon-route.ts` continues to use `requireIdentity` directly because there's no `createSession` wrapper on the node side.
2. Out of scope for this spec; a separate `createDaemonSession` could mirror the pattern later.

## Open Questions

1. **Object arg vs positional arg for `build`?**
   - Options: (a) `build({ identity, encryptionKeys })`, (b) `build(identity, { encryptionKeys })`.
   - **Recommendation**: (a). The signed-in payload is a single record of "everything you need to construct the workspace"; one object arg is more cohesive and forward-compatible if more fields surface (e.g., `currentIdentity` or `onIdentityChange`).

2. **Should `createSession` also pass through `auth.openWebSocket` to remove another `auth.` reference from build callbacks?**
   - Apps still need `auth` for `actionsToAiTools` chat wiring (`apps/tab-manager`, `apps/opensidian`). Passing `openWebSocket` separately would only remove one reference per file and leave the import.
   - **Recommendation**: No. `auth` import stays. Only collapse the encryption getter.

3. **Should `requireFoo = session.require` get formalized into `createSession`'s return shape (e.g., a `name` arg that produces a named require)?**
   - Would let `createSession({ name: 'fuji', ... })` return `{ require: requireFuji, ... }`.
   - **Recommendation**: Defer. The alias is one line per app; the perceived savings don't justify a new arg with a name-tracking concern. Leave as Class 3 keep.

## Decisions Log

- Keep `requireFoo` aliases per app: ergonomic and idiomatic; readable at component call sites. Revisit when: a sixth app shows the alias is friction rather than help.
- Keep `requireIdentity` exported from `@epicenter/auth` and `@epicenter/auth/node`: still used by daemon code paths that have no session wrapper. Revisit when: a `createDaemonSession` (or equivalent) absorbs the daemon-side identity wiring.
- Keep tab-manager's async-auth singleton bespoke: its `whenReady` requirement is structural, not accidental. Revisit when: a second app needs async auth construction.

## Success Criteria

- [x] `createSession` passes `{ identity, encryptionKeys }` to `build`.
- [x] All five apps' session files compile against the new shape.
- [x] No app's `session.ts` imports `requireIdentity` from `@epicenter/auth`.
- [x] `requireIdentity` is still exported and still imported by daemon code paths.
- [x] Focused typechecks pass for the touched package and apps.
- [ ] Each app boots, signs in, and performs at least one encrypted read/write through the session-bound workspace.

## References

- `packages/svelte-utils/src/session.svelte.ts` - The factory being modified.
- `packages/auth/src/require-identity.ts` - Helper that stays for daemon use.
- `packages/auth/src/auth-contract.ts` - `AuthState` discriminator and `AuthClient` shape.
- `packages/auth/src/auth-types.ts` - `WorkspaceIdentity` shape.
- `apps/fuji/src/lib/session.ts` - Migration target (simple shape).
- `apps/honeycrisp/src/lib/session.ts` - Migration target (simple shape).
- `apps/opensidian/src/lib/session.ts` - Migration target (simple shape).
- `apps/zhongwen/src/lib/session.ts` - Migration target (simple shape).
- `apps/tab-manager/src/lib/session.svelte.ts` - Migration target (inside the inner builder; outer wrapper unchanged).
- `apps/fuji/blocks/daemon-route.ts` - Out-of-scope `requireIdentity` consumer kept as-is.
