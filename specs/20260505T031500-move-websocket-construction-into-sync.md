# Move WebSocket construction into sync; auth exposes only `bearerToken`

**Date**: 2026-05-05
**Status**: Implemented with verification caveats
**Author**: AI-assisted (Claude)
**Branch**: feat/encrypted-local-workspace-storage
**Supersedes parts of**: `specs/20260505T021500-collapse-syncauth-to-transport-function.md` (the `SyncTransport` callable shape)

## One-Sentence Test

`attachSync` constructs every WebSocket itself with its own subprotocol convention, given an optional `bearerToken: () => string | null` callback; `AuthClient` exposes a `bearerToken` getter and no longer has `openWebSocket`; `@epicenter/auth` does not import from `@epicenter/sync`.

If `AuthClient.openWebSocket` still exists, the work is not done.
If `@epicenter/auth` still imports `BEARER_SUBPROTOCOL_PREFIX` or `MAIN_SUBPROTOCOL`, the work is not done.
If `websocketProtocolsWithBearer` still exists in the auth package, the work is not done.
If `SyncTransport` still exists in `attach-sync.ts`, the work is not done.
If `attemptConnection` does not call `new WebSocket(...)` directly, the work is not done.

## Overview

The previous spec (`20260505T021500`) collapsed `SyncAuth` to a `SyncTransport` callable and removed dead `onStateChange` plumbing. It left the `auth.openWebSocket` method in place: `AuthClient` still owns "construct a credentialed WebSocket" and still imports `BEARER_SUBPROTOCOL_PREFIX` + `MAIN_SUBPROTOCOL` from `@epicenter/sync` to do it.

This is a backwards dependency. `auth.openWebSocket` exists exclusively to serve sync, lives in the wrong package, and forces the auth package to depend on sync's wire protocol. Sync should own its own protocol end-to-end.

This spec deletes `auth.openWebSocket`, replaces it with a `readonly bearerToken: string | null` getter on `AuthClient`, moves WebSocket construction inline into `attachSync`'s `attemptConnection`, and reverses the package dependency. After: `@epicenter/sync` is fully self-contained; `@epicenter/auth` is purely about identity, credentials, and HTTP.

## Motivation

### Current state (after `20260505T021500` landed)

`packages/auth/src/create-auth.ts:1`:

```ts
import { BEARER_SUBPROTOCOL_PREFIX, MAIN_SUBPROTOCOL } from '@epicenter/sync';
```

`packages/auth/src/create-auth.ts:98` (the surface):

```ts
openWebSocket(url: string | URL, protocols?: string | string[]): WebSocket;
```

`packages/auth/src/create-auth.ts:198-209` (bearer impl):

```ts
openWebSocket(url, protocols) {
  if (session === null) {
    throw new Error('[auth] openWebSocket called with no session: provider gate failed');
  }
  return new WebSocket(
    url,
    websocketProtocolsWithBearer(session.token, protocols),
  );
},
```

`packages/auth/src/create-auth.ts:474+` (the helper):

```ts
function websocketProtocolsWithBearer(token, protocols) {
  const offered = protocols ? [...protocols] : [MAIN_SUBPROTOCOL];
  if (!offered.includes(MAIN_SUBPROTOCOL)) offered.unshift(MAIN_SUBPROTOCOL);
  offered.push(`${BEARER_SUBPROTOCOL_PREFIX}${token}`);
  return offered;
}
```

`packages/workspace/src/document/attach-sync.ts:198-218`:

```ts
export type SyncTransport = (
  url: string,
  protocols?: string | string[],
) => WebSocket;

export type SyncAttachmentConfig = {
  url: string;
  waitFor?: WaitForBarrier;
  transport: SyncTransport;
  // ...
};
```

`packages/workspace/src/document/attach-sync.ts:606`:

```ts
ws = config.transport(config.url, [MAIN_SUBPROTOCOL]);
```

Consumers (every workspace factory + provider) plumb `transport: auth.openWebSocket` through.

### Problems

1. **Backwards dependency.** `@epicenter/auth` imports `BEARER_SUBPROTOCOL_PREFIX` and `MAIN_SUBPROTOCOL` from `@epicenter/sync` solely to format a subprotocol string for `auth.openWebSocket`. Auth should not know about sync's wire protocol; sync should own it.

2. **`auth.openWebSocket` exists only for sync.** Workspace-wide grep confirms zero non-sync consumers. The method is a sync-shaped abstraction misplaced in the auth package. By the clean-breaks "single-method `Pick` is a boundary leak" rule, the boundary is in the wrong place.

3. **Two names for one wire reality.** `SyncTransport` claims to abstract "transport." In practice every implementation (bearer, cookie, future strategies) reduces to "do I have a bearer token? Append the subprotocol; otherwise don't." That single bit doesn't earn a function-shaped abstraction.

4. **The `transport` plumbing through `openFuji` mirrors a deeper mismatch.** Consumers don't think about "transports"; they think about "auth strategies." The public API should express what apps actually know: "here's a way to get the current bearer token, or null if I'm using cookies."

### Desired state

**Auth package:**

```ts
// packages/auth/src/create-auth.ts
// No more import from @epicenter/sync.

export type AuthClient = {
  readonly state: AuthState;
  readonly bearerToken: string | null;   // getter; reads live token from closure
  onStateChange(fn: AuthStateChangeListener): () => void;
  signIn / signUp / signInWithIdToken / signInWithSocialRedirect / signOut;
  fetch(input, init?): Promise<Response>;
  [Symbol.dispose](): void;
};

// Bearer impl:
get bearerToken() { return session?.token ?? null; }

// Cookie impl:
get bearerToken() { return null; }
```

**Sync package:**

```ts
// packages/workspace/src/document/attach-sync.ts
export type SyncAttachmentConfig = {
  url: string;
  waitFor?: WaitForBarrier;
  /**
   * Returns the current bearer token, or null when this app uses cookie/no auth.
   * Called per reconnect attempt for token rotation freshness.
   * Omit entirely for cookie-only apps.
   */
  bearerToken?: () => string | null;
  log?: Logger;
  awareness?: AwarenessAttachment<AwarenessSchema>;
};

// inside attemptConnection:
const token = config.bearerToken?.();
const protocols = token
  ? [MAIN_SUBPROTOCOL, `${BEARER_SUBPROTOCOL_PREFIX}${token}`]
  : [MAIN_SUBPROTOCOL];
const ws = new WebSocket(config.url, protocols);
```

**Consumers (provider):**

```ts
const fuji = openFuji({
  identity,
  peer: { ... },
  bearerToken: () => auth.bearerToken,
});
```

Identical at every call site, regardless of auth strategy. Bearer apps return tokens; cookie apps return null. Both work uniformly.

## Research Findings

### Why a getter on `AuthClient`, not a literal property

| Shape | Rotation handling | Public mutation? |
| --- | --- | --- |
| `bearerToken: string \| null` (literal) | `rotateToken` would have to do `this.bearerToken = newToken` | Yes |
| `get bearerToken()` (getter) | Closure already mutated; getter reads through | No |
| `getBearerToken(): string \| null` (method) | Same as getter, less ergonomic call site | No |

Getter wins: matches the existing closure pattern, reads as a property (`auth.bearerToken`), no mutable public state.

### Why a function on `SyncAttachmentConfig`, not a literal

`attachSync` is constructed once; the supervisor reconnects many times across rotations. A literal `bearerToken: string | null` captured at construction time would go stale on every rotation. The function `bearerToken?: () => string | null` reads fresh on every call.

### Why `string | null` covers cookie + bearer + no-auth + signed-out

| Scenario | `bearerToken()` returns | Sync wire | Credential supplier |
| --- | --- | --- | --- |
| Cookie auth, signed in | (callback omitted, or returns `null`) | `[MAIN_SUBPROTOCOL]` | Browser cookie jar |
| Cookie auth, signed out | (omitted/`null`) | `[MAIN_SUBPROTOCOL]` | None → server 4401 |
| Bearer auth, signed in | `"abc..."` | `[MAIN_SUBPROTOCOL, "bearer.abc..."]` | Sync subprotocol |
| Bearer auth, signed out | `null` | `[MAIN_SUBPROTOCOL]` | None → server 4401 |
| No auth at all (future) | (omitted) | `[MAIN_SUBPROTOCOL]` | None → server policy decides |

All five cases collapse onto the same wire-construction logic. No strategy enum, no discriminated union, no per-strategy config.

### Test injection model

Today, tests inject `FakeWebSocket` via `fakeAuth().openWebSocket`. After this change, `attemptConnection` calls `new WebSocket(...)` directly. Tests need a different injection point.

Three options considered:

| Option | Mechanism | Verdict |
| --- | --- | --- |
| Re-introduce `webSocketImpl` config field | Pass a constructor | Rejected : explicitly deleted in `20260504T185711` wave 7 with strong rationale |
| Module-level `WebSocketCtor` variable | Test setter swaps it | Adds package-internal mutable state |
| Swap `globalThis.WebSocket` per-test | Standard browser-test pattern | Recommended |

`globalThis.WebSocket` swap is the cleanest. The test file already lives in a `/// <reference lib="dom" />` context; the `FakeWebSocket` class is already shaped to satisfy `WebSocket`.

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Replace `auth.openWebSocket` with `auth.bearerToken` | 2 coherence | Replace | Reverses the backwards dependency; eliminates a method that exists only to serve one consumer. |
| Property shape on `AuthClient` | 2 coherence | Getter property `readonly bearerToken: string \| null` | Matches existing closure pattern; no public mutation; reads as property. |
| Property shape on `SyncAttachmentConfig` | 2 coherence | Function `bearerToken?: () => string \| null` | Must be live-readable per reconnect for rotation freshness. |
| Cookie auth's `bearerToken` value | 1 evidence | Always `null` | Cookie auth has no token to expose; browser handles credential. |
| Discriminator in the type system | 3 taste | None : `null` is sufficient | All non-bearer cases (cookie, signed-out, no-auth) reduce to identical wire construction. No need to enumerate. |
| Where the bearer subprotocol convention lives | 2 coherence | `@epicenter/sync` exclusively | The subprotocol is sync's wire protocol; `@epicenter/sync` already exports both constants. |
| `SyncTransport` type | 2 coherence | Delete | Replaced by inline construction; the abstraction was the smell. |
| `transport` parameter on workspace factories | 2 coherence | Replace with `bearerToken?: () => string \| null` | Matches what consumers actually know. |
| Test injection mechanism | 3 taste | Swap `globalThis.WebSocket` per-test | Cleanest; avoids re-introducing the `webSocketImpl` field that was deleted with strong rationale. |
| Backwards-compat shim | 2 coherence | None | Per repo convention. Atomic monorepo migration. |

## Architecture

### Before (after the prior spec)

```
@epicenter/auth                      @epicenter/sync
├── AuthClient                       ├── BEARER_SUBPROTOCOL_PREFIX
│   ├── state                        ├── MAIN_SUBPROTOCOL
│   ├── openWebSocket ──────────┐    └── attachSync
│   ├── fetch                   │        └── SyncTransport (= auth.openWebSocket)
│   └── ...                     │            └── config.transport(url, [MAIN])
└── websocketProtocolsWithBearer│        └── ws.binaryType = ...
        ↑                       │
        └─ imports ─────────────┘
        BEARER_SUBPROTOCOL_PREFIX
        MAIN_SUBPROTOCOL

Dependency arrow: auth → sync (BACKWARDS)
```

### After

```
@epicenter/auth                      @epicenter/sync
├── AuthClient                       ├── BEARER_SUBPROTOCOL_PREFIX
│   ├── state                        ├── MAIN_SUBPROTOCOL
│   ├── bearerToken (getter)         └── attachSync
│   ├── fetch                            ├── SyncAttachmentConfig
│   └── ...                              │   └── bearerToken?: () => string | null
└── (no @epicenter/sync import)          └── attemptConnection:
                                              const token = config.bearerToken?.();
                                              const protocols = token
                                                ? [MAIN, `bearer.${token}`]
                                                : [MAIN];
                                              new WebSocket(url, protocols);

Dependency arrow: sync → auth-shaped function (only via the consumer's lambda)
                  No direct package import either way for the wire protocol.
```

### Consumer call site (uniform across all auth strategies)

```ts
// Bearer apps (Tauri, extension):
openFuji({
  identity,
  peer,
  bearerToken: () => auth.bearerToken,   // returns "abc..." when signed in
});

// Cookie apps (web Fuji):
openFuji({
  identity,
  peer,
  bearerToken: () => auth.bearerToken,   // always returns null; cookie does the work
});

// Same line. Same shape. Different runtime values.
```

## Surface Map

### `@epicenter/auth` changes

| Location | Change |
| --- | --- |
| `packages/auth/src/create-auth.ts:1` | Delete `import { BEARER_SUBPROTOCOL_PREFIX, MAIN_SUBPROTOCOL } from '@epicenter/sync';` |
| `packages/auth/src/create-auth.ts:98` | Delete `openWebSocket(...)` from the `AuthClient` type. Add `readonly bearerToken: string \| null;` |
| `packages/auth/src/create-auth.ts:198-209` | Bearer impl: delete `openWebSocket`. Add `get bearerToken() { return session?.token ?? null; }`. |
| `packages/auth/src/create-auth.ts:261+` | Cookie impl: delete `openWebSocket`. Add `get bearerToken() { return null; }`. |
| `packages/auth/src/create-auth.ts:281-296` | `AuthCoreConfig`: delete the `openWebSocket` field. Add `bearerToken: () => string \| null` (the impl-supplied getter binding). |
| `packages/auth/src/create-auth.ts:396-398` | `createAuthCore`: delete the `openWebSocket(url, protocols) { return openWebSocket(url, protocols); }` block. Add `get bearerToken() { return bearerToken(); }`. |
| `packages/auth/src/create-auth.ts:474+` | Delete `websocketProtocolsWithBearer` helper entirely. |
| `packages/auth/src/create-auth.test.ts` | Migrate the openWebSocket bearer-subprotocol assertion (around line 358) to assert on `auth.bearerToken` directly. The "openWebSocket throws when no session" test is replaced by "bearerToken returns null when no session." |
| `packages/auth/src/contract.test.ts:344` | Replace the cookie `openWebSocket` assertion with a `bearerToken === null` assertion. |
| `packages/auth-workspace/src/index.test.ts:94` | Mock auth client: replace `openWebSocket: () => { ... }` with `get bearerToken() { return null; }` (or whatever the test needs). |

### `@epicenter/workspace` changes

| Location | Change |
| --- | --- |
| `packages/workspace/src/document/attach-sync.ts:198-216` | Delete `SyncTransport` type. Replace `transport: SyncTransport` field on `SyncAttachmentConfig` with `bearerToken?: () => string \| null`. |
| `packages/workspace/src/document/attach-sync.ts:600-610` (around `attemptConnection`) | Replace `ws = config.transport(config.url, [MAIN_SUBPROTOCOL]);` with the inline 3-line construction reading `config.bearerToken?.()`. Make sure `MAIN_SUBPROTOCOL` and `BEARER_SUBPROTOCOL_PREFIX` are imported (they likely already are). |
| `packages/workspace/src/index.ts` | Remove `SyncTransport` from re-exports. |
| `packages/workspace/src/document/attach-sync.test.ts` | Replace `fakeTransport` (or whatever the test helper is named after the prior spec) with a `globalThis.WebSocket` swap in `beforeEach`/`afterEach`. Tests pass `bearerToken: () => 'test-token'` (or omit it entirely for cookie-style tests). |

### Consumer call sites

Every file that currently passes `transport: SyncTransport` to a workspace factory or directly to `attachSync` migrates to `bearerToken: () => string | null`. From the prior spec's surface map, these are roughly:

| File | Migration |
| --- | --- |
| `apps/fuji/src/lib/fuji/browser.ts` | `transport` → `bearerToken` parameter on `openFuji`; thread to both `attachSync` calls. |
| `apps/fuji/src/lib/components/FujiWorkspaceProvider.svelte` | `transport: auth.openWebSocket` → `bearerToken: () => auth.bearerToken`. |
| `apps/fuji/src/lib/fuji/daemon.ts` | Same pattern. |
| `apps/honeycrisp/src/lib/honeycrisp/browser.ts` + provider | Same. |
| `apps/honeycrisp/src/lib/honeycrisp/daemon.ts`, `script.ts` | Same. |
| `apps/opensidian/src/lib/opensidian/browser.ts` + provider | Same. |
| `apps/opensidian/src/lib/opensidian/daemon.ts`, `script.ts` | Same. |
| `apps/zhongwen/src/lib/zhongwen/browser.ts` + provider | Same. |
| `apps/zhongwen/src/lib/zhongwen/daemon.ts`, `script.ts` | Same. |
| `apps/tab-manager/src/lib/tab-manager/extension.ts` | Same. |
| `examples/notes-cross-peer/notes.ts` | Same if applicable. |

### Documentation

| File | Change |
| --- | --- |
| `packages/workspace/SYNC_ARCHITECTURE.md` | Update wire-construction section; remove `SyncTransport` references. |
| `packages/workspace/README.md`, `packages/workspace/src/document/README.md` | Update `attachSync` examples. |
| `apps/fuji/README.md` | Update `openFuji` signature. |
| `docs/architecture.md`, `docs/guides/consuming-epicenter-api.md` | Update auth + sync sections. |
| `.agents/skills/auth/SKILL.md` | Update to show `bearerToken` getter instead of `openWebSocket`. |
| `.agents/skills/workspace-app-layout/SKILL.md` | Update factory examples. |

## Implementation Plan

Build, Prove, Remove. Each wave leaves the workspace typecheckable.

### Wave 1: Add `bearerToken` to `AuthClient` (additive)

- [x] **1.1** In `packages/auth/src/create-auth.ts`, add `readonly bearerToken: string | null` to the `AuthClient` type. Keep `openWebSocket` for now.
- [x] **1.2** Implement the getter in `createBearerAuth` (`get bearerToken() { return session?.token ?? null; }`).
- [x] **1.3** Implement the getter in `createCookieAuth` (`get bearerToken() { return null; }`).
- [x] **1.4** Wire it through `AuthCoreConfig` and `createAuthCore` so both factories funnel through the same shape.
- [x] **1.5** Verify: `bun run --filter @epicenter/auth typecheck` and `test` pass. No behavior change yet.

### Wave 2: Add `bearerToken` to `SyncAttachmentConfig` (additive, optional)

- [x] **2.1** In `packages/workspace/src/document/attach-sync.ts`, add `bearerToken?: () => string | null` to `SyncAttachmentConfig` (alongside the existing `transport: SyncTransport`).
- [x] **2.2** In `attemptConnection`, prefer `config.bearerToken` if present: construct the WebSocket inline using the 3-line protocol logic. Fall back to `config.transport(...)` otherwise.
- [x] **2.3** Verify: workspace tests still pass.
  > Note: the first sandboxed workspace test run failed on Unix socket `EPERM`. The same command passed with sandbox escalation.

### Wave 3: Migrate consumers from `transport` to `bearerToken`

- [x] **3.1** For each file in the Surface Map "Consumer call sites" table, change the workspace factory parameter from `transport: SyncTransport` to `bearerToken?: () => string | null`. Thread to each `attachSync` call.
- [x] **3.2** For each `*WorkspaceProvider.svelte`, change the call site from `transport: auth.openWebSocket` to `bearerToken: () => auth.bearerToken`.
- [x] **3.3** Workspace-wide grep: `grep -rn "transport: auth\." apps/` and `grep -rn "transport: SyncTransport" apps/` should both return zero hits.
- [x] **3.4** Verify: `bun run typecheck` (workspace-wide) passes. App-level smoke tests still work.
  > Note: package-level checks for `@epicenter/workspace`, `@epicenter/auth`, and `@epicenter/auth-workspace` passed. Workspace-wide and touched app typechecks still fail on existing shared `packages/svelte-utils` / `packages/ui` errors and app-local errors unrelated to this migration.
  > Note: `SyncAttachmentConfig.transport` was made optional in this wave so migrated cookie-style consumers can pass only `bearerToken: () => auth.bearerToken`. The field is still present and is removed in Wave 4.

### Wave 4: Make `transport` removable; migrate sync tests

- [x] **4.1** In `packages/workspace/src/document/attach-sync.ts`, remove the `transport` field from `SyncAttachmentConfig`. Remove the `transport`-fallback branch from `attemptConnection`. Make `bearerToken?` stay optional (cookie apps omit it).
- [x] **4.2** Delete the `SyncTransport` type definition.
- [x] **4.3** Remove `SyncTransport` from `packages/workspace/src/index.ts` re-exports.
- [x] **4.4** Migrate `attach-sync.test.ts`:
  - Add `beforeEach` that swaps `globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket` and `afterEach` that restores it.
  - Replace every `transport: fakeTransport` with `bearerToken: () => 'test-token'` (or omit entirely for cookie-style tests that just need a working WebSocket).
- [x] **4.5** Verify: `bun run --filter @epicenter/workspace typecheck` and `test` pass.

### Wave 5: Remove `openWebSocket` from `AuthClient`

- [x] **5.1** In `packages/auth/src/create-auth.ts`:
  - Delete `openWebSocket(...)` from the `AuthClient` type.
  - Delete the bearer impl's `openWebSocket(...)` block.
  - Delete the cookie impl's `openWebSocket(...)` block.
  - Delete the `openWebSocket` field on `AuthCoreConfig`.
  - Delete the `openWebSocket(url, protocols) { return openWebSocket(url, protocols); }` re-binding in `createAuthCore`.
  - Delete the `websocketProtocolsWithBearer` helper function.
  - Delete the `import { BEARER_SUBPROTOCOL_PREFIX, MAIN_SUBPROTOCOL } from '@epicenter/sync';` line.
- [x] **5.2** Migrate `packages/auth/src/create-auth.test.ts`:
  - Replace the bearer-subprotocol assertion with `expect(auth.bearerToken).toBe(token)`.
  - Replace the "throws when no session" test with `expect(auth.bearerToken).toBeNull()`.
  - Replace the cookie test with `expect(auth.bearerToken).toBeNull()`.
- [x] **5.3** Migrate `packages/auth/src/contract.test.ts:344` similarly.
- [x] **5.4** Migrate `packages/auth-workspace/src/index.test.ts:94`: remove the `openWebSocket` mock; ensure the test mock satisfies `AuthClient` with `bearerToken` instead.
- [x] **5.5** Verify: `bun run --filter @epicenter/auth typecheck` and `test` pass. Same for `@epicenter/auth-workspace`.
  > Note: `@epicenter/auth-workspace` has no package `test` script, so verification used `bun test packages/auth-workspace/src`.

### Wave 6: Documentation

- [x] **6.1** Update `packages/workspace/SYNC_ARCHITECTURE.md` : describe inline WebSocket construction; reference `bearerToken` callback.
- [x] **6.2** Update `packages/workspace/README.md`, `packages/workspace/src/document/README.md` : new `attachSync` examples.
- [x] **6.3** Update `apps/fuji/README.md` : new `openFuji` signature.
- [x] **6.4** Update `docs/architecture.md`, `docs/guides/consuming-epicenter-api.md`.
- [x] **6.5** Update `.agents/skills/auth/SKILL.md` and `.agents/skills/workspace-app-layout/SKILL.md`.
- [x] **6.6** Mark `specs/20260505T021500-collapse-syncauth-to-transport-function.md` as superseded by this spec where the `SyncTransport` shape is concerned. Leave the `onStateChange` removal section intact (still applies).

### Wave 7: Final verification

- [x] **7.1** Workspace-wide grep : all of these must return zero hits in non-spec, non-historical-doc files:
  - `auth\.openWebSocket`
  - `openWebSocket` (in `packages/auth/`)
  - `SyncTransport`
  - `websocketProtocolsWithBearer`
  - `import.*from '@epicenter/sync'` inside `packages/auth/`
  - `transport: auth\.` (in `apps/`)
  - `transport: SyncTransport` (in `apps/`)
- [ ] **7.2** `bun run typecheck` passes workspace-wide.
  > Caveat: workspace-wide typecheck fails in `@epicenter/landing` because `svelte-check` is not available on PATH for that package. The touched packages pass targeted typecheck: `@epicenter/workspace`, `@epicenter/auth`, and `@epicenter/auth-workspace`.
- [x] **7.3** `bun run test` for `@epicenter/workspace`, `@epicenter/auth`, `@epicenter/auth-workspace` all pass.
  > Note: `@epicenter/workspace` tests require Unix socket permissions outside the sandbox. The sandboxed run fails with `EPERM` on socket bind; the escalated run passes. `@epicenter/auth-workspace` has no package `test` script, so verification used `bun test packages/auth-workspace/src`.
- [ ] **7.4** Browser smoke test: open Fuji while signed in, sync connects (cookie path); for a Tauri-style app, confirm bearer subprotocol is sent (DevTools -> Network -> WS -> Frames).
  > Skipped: no signed-in browser or Tauri session was available in this execution environment.

## Edge Cases

### Cookie auth caller forgets to omit `bearerToken`

A web app passes `bearerToken: () => auth.bearerToken` even though it's cookie auth. `auth.bearerToken` returns `null`. Sync builds `[MAIN_SUBPROTOCOL]` with no bearer suffix. Browser attaches cookie. Server accepts. **Works correctly without any special handling.**

### Bearer auth signed out mid-session

`auth.bearerToken` returns `null`. Sync omits the bearer subprotocol. Server has no other credential, returns `4401 invalid_token`. Sync's existing `parsePermanentFailure` (already in place) sets `phase: 'failed'`. Provider's `onStateChange` handler observes `signed-out` and reloads. Workspace torn down. **Same behavior as today, fewer code paths.**

### Token rotation during reconnect attempt

Token rotates from T1 to T2 between the previous reconnect and the next. Supervisor calls `config.bearerToken()` which calls `auth.bearerToken` (the getter) which reads `session?.token` (now T2). New WebSocket built with T2. **Works without any explicit synchronization.**

### Tests need to assert subprotocols are correct

Today: assert by inspecting the FakeWebSocket constructor args via the openWebSocket mock. After: assert by inspecting `globalThis.WebSocket`'s constructor args via the swapped FakeWebSocket. Mechanical; FakeWebSocket already records `protocols` as a constructor arg.

### A future auth strategy needs more than a token

If a third strategy emerges (signed URLs with rotating signatures, mTLS via session keys, etc.), this design pushes back hard. The strategy would need to return *more* than a string. But that's correctly load-bearing pushback: the new strategy is a real new shape, not a parameter. Add a new field at that point. Don't pre-design for it.

## Open Questions

1. **Should `auth.bearerToken` be exposed on `AuthClient` even for cookie auth, or split into `BearerAuthClient` vs `CookieAuthClient`?**
   - Options: (a) uniform `bearerToken: string | null` on every `AuthClient`; (b) variant types where cookie auth doesn't have the field.
   - **Recommendation**: (a). Uniform contract keeps consumers strategy-agnostic; the `null` value is honest ("this client never has a bearer token"); workspace factories don't need TS narrowing. Tiny "always null" property is cheap.

2. **Should the sync field be named `bearerToken` or something more strategy-agnostic like `getCredential`?**
   - **Recommendation**: `bearerToken`. It says exactly what it returns. A more abstract name (`getCredential`) would invite implementations to put non-bearer things in it, which would break the simple-string contract.

3. **Should we keep `MAIN_SUBPROTOCOL` and `BEARER_SUBPROTOCOL_PREFIX` in `@epicenter/sync` or move them to a neutral `@epicenter/protocol` package?**
   - **Recommendation**: keep in `@epicenter/sync`. They are sync's wire protocol. After this spec, no other package imports them. Moving them somewhere "neutral" would invite other packages to grow protocol awareness, which is the smell we're fixing.

4. **Should the throw-on-missing-creds behavior survive somewhere, or fully disappear?**
   - The previous spec's throw was inside `auth.openWebSocket`. After this spec, `bearerToken` returning `null` is not an error condition : it's the ordinary signal for "no bearer here, browser may handle it." There is no "missing creds" exceptional path; the server's `4401` close code remains the only auth failure signal.
   - **Recommendation**: fully disappear. The throw was load-bearing only because of the previous design's contract; this design eliminates the contract.

## Decisions Log

- Keep `MAIN_SUBPROTOCOL` and `BEARER_SUBPROTOCOL_PREFIX` in `@epicenter/sync`: they are the sync wire protocol and have no consumers in other packages after this spec lands.
  Revisit when: a non-sync layer needs to know the protocol shape (which would itself be a smell).

- Keep `bearerToken: string | null` on `AuthClient` uniformly (not split into bearer/cookie variants): consumer ergonomics outweigh the tiny "always null" property on cookie auth.
  Revisit when: a third auth strategy emerges that the uniform shape can't honestly accommodate.

## Success Criteria

- [x] `AuthClient.bearerToken` is a getter returning `string | null`.
- [x] `AuthClient.openWebSocket` does not exist.
- [x] `websocketProtocolsWithBearer` does not exist.
- [x] `@epicenter/auth` does not import from `@epicenter/sync`.
- [x] `SyncAttachmentConfig.bearerToken` is `(() => string | null) | undefined`.
- [x] `SyncTransport` does not exist.
- [x] `attemptConnection` constructs WebSockets via `new WebSocket(url, protocols)` directly.
- [x] Every workspace factory accepts `bearerToken?: () => string | null` (not `transport`).
- [x] Every `*WorkspaceProvider.svelte` passes `bearerToken: () => auth.bearerToken` (uniform across cookie and bearer apps).
- [ ] `bun run typecheck` passes workspace-wide.
  > Caveat: blocked by `@epicenter/landing` missing `svelte-check` on PATH. Targeted typechecks for the touched packages pass.
- [x] `bun run test` passes for `@epicenter/workspace`, `@epicenter/auth`, `@epicenter/auth-workspace`.
- [ ] Browser smoke confirms web Fuji syncs (cookie path) and Tauri Fuji or extension syncs (bearer path).
  > Skipped: no signed-in browser or Tauri session was available.

## Implementation Review

Completed: 2026-05-06

Files read:

```txt
.agents/skills/
|-- auth/SKILL.md
`-- workspace-app-layout/SKILL.md
apps/
|-- fuji/
|   |-- README.md
|   `-- src/lib/
|       |-- components/FujiWorkspaceProvider.svelte
|       `-- fuji/{browser.ts,daemon.ts}
|-- honeycrisp/src/lib/
|   |-- components/HoneycrispWorkspaceProvider.svelte
|   `-- honeycrisp/{browser.ts,daemon.ts,script.ts}
|-- opensidian/src/lib/opensidian/{browser.ts,client.ts,daemon.ts,script.ts}
|-- tab-manager/src/lib/tab-manager/{client.ts,extension.ts}
`-- zhongwen/src/lib/zhongwen/{daemon.ts,script.ts}
docs/
|-- architecture.md
`-- guides/consuming-epicenter-api.md
packages/
|-- auth/
|   |-- package.json
|   `-- src/{contract.test.ts,create-auth.test.ts,create-auth.ts}
|-- auth-workspace/src/index.test.ts
`-- workspace/
    |-- README.md
    |-- SYNC_ARCHITECTURE.md
    `-- src/
        |-- document/{README.md,attach-sync.test.ts,attach-sync.ts}
        `-- index.ts
specs/
|-- 20260505T021500-collapse-syncauth-to-transport-function.md
`-- 20260505T031500-move-websocket-construction-into-sync.md
```

Findings:

1. No implementation issues found in the second read. The final API shape is cohesive: auth owns identity and token access; sync owns WebSocket construction and subprotocol assembly.

Verification:

- `rg` checks for `auth.openWebSocket`, `openWebSocket` in auth, `SyncTransport`, `websocketProtocolsWithBearer`, auth imports from `@epicenter/sync`, and app `transport` call sites: zero hits in non-spec, non-historical files.
- `bun run --filter @epicenter/workspace typecheck`: pass.
- `bun run --filter @epicenter/auth typecheck`: pass.
- `bun run --filter @epicenter/auth-workspace typecheck`: pass.
- `bun run --filter @epicenter/workspace test`: pass with socket-permission escalation.
- `bun run --filter @epicenter/auth test`: pass.
- `bun test packages/auth-workspace/src`: pass.
- `bun run typecheck`: fails in `@epicenter/landing` because `svelte-check` is not available on PATH.
- Browser smoke: skipped because no signed-in browser or Tauri session was available.

## References

- `specs/20260505T021500-collapse-syncauth-to-transport-function.md` : the prior spec; this one supersedes its `SyncTransport` shape.
- `packages/auth/src/create-auth.ts` : primary file under refactor (lines 1, 90-110, 198-211, 261-269, 281-296, 396-398, 474+).
- `packages/workspace/src/document/attach-sync.ts` : primary file under refactor (lines 198-218, 600-610).
- `packages/auth/src/create-auth.test.ts`, `packages/auth/src/contract.test.ts`, `packages/auth-workspace/src/index.test.ts` : tests under migration.
- All workspace factory files listed in the Surface Map.
- `specs/20260504T185711-attach-sync-auth-namespace.md` : historical context on prior `webSocketImpl` deletion (informs the test injection decision).
- Skills: `cohesive-clean-breaks`, `one-sentence-test`, `factory-function-composition`, `specification-writing`.
