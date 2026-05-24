# Collapse `SyncAuth` to a single `SyncTransport` function

**Date**: 2026-05-05
**Status**: Implemented with verification caveats
**Author**: AI-assisted (Claude)
**Branch**: feat/encrypted-local-workspace-storage
**Superseded note**: `specs/20260505T031500-move-websocket-construction-into-sync.md` replaces the `SyncTransport` shape with `bearerToken?: () => string | null` and inline WebSocket construction. The `onStateChange` removal in this spec still applies.

## One-Sentence Test

`attachSync` requires a single `transport: (url, protocols?) => WebSocket` callable; no `onStateChange` subscription, no `null` return, no `'no-credential'` supervisor branch, and no consumer passes the whole `AuthClient` to `attachSync`.

If `SyncAuth` still exists in `attach-sync.ts`, the work is not done.
If `attemptConnection` still has a `'no-credential'` return path, the work is not done.
If `unsubscribeAuthChange` or `auth.onStateChange` appears anywhere in `attach-sync.ts`, the work is not done.
If any consumer in `apps/` passes `auth: AuthClient` to `attachSync`, the work is not done.

## Overview

`attachSync` currently asks for a two-method capability (`SyncAuth = { openWebSocket, onStateChange }`) and treats `openWebSocket` returning `null` as a "stay offline until creds appear" signal. That design assumes the workspace stays attached across sign-out/sign-in gaps and re-binds itself when credentials reappear. In practice the layout (`FujiWorkspaceProvider`, etc.) already disposes the entire workspace on sign-out via `window.location.reload()`, so the "stay attached, wait for re-auth" behavior is dead code.

This spec collapses `SyncAuth` into a single `SyncTransport` callable, deletes the `'no-credential'` supervisor branch and the `auth.onStateChange` subscription, and changes `AuthClient.openWebSocket` to return `WebSocket` (non-null) so consumers can pass `auth.openWebSocket` directly with no wrapper. Workspace-disposal-on-sign-out becomes the only path back to a connected state.

## Motivation

### Current state

`packages/workspace/src/document/attach-sync.ts:194-231`:

```ts
export type SyncAuth = {
  openWebSocket(url: string, protocols?: string | string[]): WebSocket | null;
  onStateChange(handler: () => void): () => void;
};

export type SyncAttachmentConfig = {
  url: string;
  waitFor?: WaitForBarrier;
  auth: SyncAuth;
  // ...
};
```

`attach-sync.ts:619-625` (called per reconnect attempt):

```ts
async function attemptConnection(signal: AbortSignal): Promise<'connected' | 'failed' | 'no-credential'> {
  const wsUrl = config.url;
  const subprotocols = [MAIN_SUBPROTOCOL];
  const ws = config.auth.openWebSocket(wsUrl, subprotocols);
  if (ws === null) return 'no-credential';
  // ...
}
```

`attach-sync.ts:572-587` (the supervisor consumes `'no-credential'`):

```ts
const result = await attemptConnection(signal);
if (result === 'no-credential') {
  setStatus({ phase: 'offline' });
  await waitForAbort(signal);
  continue;
}
```

`attach-sync.ts:810-812` (re-wakes the loop on auth state change):

```ts
const unsubscribeAuthChange = config.auth.onStateChange(() => {
  queueMicrotask(reconnect);
});
```

`packages/auth/src/create-auth.ts:90-103` (the `AuthClient` surface):

```ts
openWebSocket(
  url: string | URL,
  protocols?: string | string[],
): WebSocket | null;
```

`packages/auth/src/create-auth.ts:203-209` (bearer impl, returns null on signed-out):

```ts
openWebSocket(url, protocols) {
  if (session === null) return null;
  return new WebSocket(url, websocketProtocolsWithBearer(session.token, protocols));
},
```

`apps/fuji/src/lib/fuji/browser.ts:36-99` (consumer passes the entire `AuthClient`):

```ts
export function openFuji({ auth, identity, peer }: { auth: AuthClient; identity: AuthIdentity; peer: PeerIdentity }) {
  // ...
  const childSync = attachSync(ydoc, { url: ..., waitFor: childIdb.whenLoaded, auth });
  // ...
  const sync = attachSync(doc, { url: ..., waitFor: idb, auth, awareness });
}
```

`apps/fuji/src/lib/components/FujiWorkspaceProvider.svelte:32-38` (the layout already tears down on sign-out):

```ts
const unsubscribe = auth.onStateChange((state) => {
  if (state.status === 'pending') return;
  if (state.status === 'signed-out') return window.location.reload();
  if (state.identity.user.id !== identity.user.id) return window.location.reload();
  fuji.encryption.applyKeys(state.identity.encryptionKeys);
});
```

### Problems

1. **Two paths handle the same event.** When the user signs out, both `FujiWorkspaceProvider` (reload the page) and `attachSync` (`onStateChange` → reconnect → `openWebSocket` returns null → supervisor goes offline) react. The provider's reload always wins; the supervisor's reaction is wasted work. Worse, every child entry doc has its own `onStateChange` subscription, so a single sign-out fires `N+1` reconnect attempts that all immediately resolve to `'no-credential'` before the page tears down.

2. **`openWebSocket: WebSocket | null` is asymmetric with caller knowledge.** The provider has already proven signed-in via its render gate (`identity: AuthIdentity` is non-null by construction). Yet every `openWebSocket` call site has to handle a `null` return that, given the provider gate, can only happen briefly during a sign-out race. The type forces every consumer to model a degenerate state.

3. **`SyncAuth` overstates what sync needs.** The `onStateChange` subscription only buys "skip the disposal-and-reconstruction step on re-auth." Given the provider already does full disposal-and-reconstruction (via reload), the optimization buys nothing.

4. **`openFuji({ auth: AuthClient })` overstates what `openFuji` needs.** Across the entire `openFuji` body, `auth` is only ever forwarded to `attachSync`. None of `signIn`, `signOut`, `fetch`, `state`, or `[Symbol.dispose]` is touched. The signature claims a 7-method dependency for what is structurally a 1-method dependency.

5. **Token rotation does not fire `onStateChange` anyway.** `rotateToken` in `packages/auth/src/create-auth.ts:173-177` mutates `session.token` in place and does not call `setState`. So `onStateChange` only fires for identity-level changes (sign-in, sign-out, identity flip), all of which the provider already handles by tearing down. The "wake sync on credential rotation" use case the subscription appears to serve does not exist.

### Desired state

```ts
// packages/workspace/src/document/attach-sync.ts

/**
 * Open an authenticated WebSocket. Caller has proven signed-in by construction
 * (workspace factories are not called until the layout's signed-in render
 * branch). If credentials disappear during a connection attempt, the throw
 * propagates as a normal connection failure; the layout owns disposal.
 */
export type SyncTransport = (
  url: string,
  protocols?: string | string[],
) => WebSocket;

export type SyncAttachmentConfig = {
  url: string;
  waitFor?: WaitForBarrier;
  transport: SyncTransport;
  log?: Logger;
  awareness?: AwarenessAttachment<AwarenessSchema>;
};
```

`attemptConnection` collapses:

```ts
async function attemptConnection(signal: AbortSignal): Promise<'connected' | 'failed'> {
  const ws = config.transport(config.url, [MAIN_SUBPROTOCOL]);
  ws.binaryType = 'arraybuffer';
  // ... rest unchanged
}
```

`unsubscribeAuthChange` is deleted entirely.

`AuthClient.openWebSocket` narrows to non-null:

```ts
openWebSocket(url: string | URL, protocols?: string | string[]): WebSocket;
// Throws if no credentials. Caller must have proven signed-in.
```

Consumers stop passing `auth` and pass the bound method directly:

```ts
// apps/fuji/src/lib/fuji/browser.ts
export function openFuji({
  identity,
  peer,
  transport,
}: {
  identity: AuthIdentity;
  peer: PeerIdentity;
  transport: SyncTransport;
}) {
  // ...
  const sync = attachSync(doc, { url: ..., waitFor: idb, transport, awareness });
  const childSync = attachSync(ydoc, { url: ..., waitFor: childIdb.whenLoaded, transport });
}

// FujiWorkspaceProvider.svelte
const fuji = openFuji({
  identity,
  peer: { ... },
  transport: auth.openWebSocket,
});
```

## Research Findings

### What `auth.onStateChange` actually fires for

Traced from `packages/auth/src/create-auth.ts`:

| Event | Calls `setState`? | Fires `onStateChange`? |
| --- | --- | --- |
| Initial session resolve (`pending` → `signed-in`/`signed-out`) | Yes (`applyBearerSession` / cookie equivalent) | Yes |
| Sign-in completes | Yes | Yes |
| Sign-out completes | Yes (`clearBearerSession`) | Yes |
| Identity changes (different `user.id` or `encryptionKeys`) | Yes | Yes |
| Server invalidates session (Better Auth `useSession` returns `null`) | Yes | Yes |
| **Bearer token rotation (`set-auth-token` header)** | **No** (`rotateToken` mutates in place) | **No** |

**Implication**: the only events `attachSync`'s subscription wakes for are events the layout already handles by reloading. Token rotation, the case sync actually cares about, doesn't fire.

### Better Auth session lifetime in this codebase

`apps/api/src/auth/create-auth.ts:73-84`:

```ts
session: {
  expiresIn: 60 * 60 * 24 * 7,   // 7 days
  updateAge: 60 * 60 * 24,        // refresh sessions older than 1 day
  storeSessionInDatabase: true,
  cookieCache: { enabled: true, maxAge: 60 * 5, strategy: 'jwe' },
},
plugins: [bearer(), jwt(), ...],
```

| Property | Value | Implication for sync |
| --- | --- | --- |
| Session lifetime | 7 days | A workspace open for a week is the longest credential window. |
| Session roll | 1 day | Tokens can rotate at most once per day, only on HTTP fetches that hit auth middleware. |
| Bearer token rotation transport | `set-auth-token` header on HTTP responses | Never observed by WebSocket clients (101 upgrade headers are not exposed to JS). |
| Cookie auth refresh | Browser-managed via `Set-Cookie` | Transparent to client code. |

For Fuji-style apps where most traffic is WebSocket (Yjs sync), token rotation is rare-to-never within a session.

### Real failure modes without `onStateChange`

| Failure mode | Today | After |
| --- | --- | --- |
| Token rotates mid-session | Provider doesn't fire; sync loop continues with old WebSocket. Old token remains valid until close. Next reconnect reads new token. | Identical. The fresh `transport(url)` call reads the current token. |
| User signs out | Provider reloads page → workspace disposed. Sync also fires `onStateChange` → reconnect → `null` → offline. Wasted. | Provider reloads page → workspace disposed. No second handler. |
| User signs back in (same account) | Provider re-renders; `identity` snapshot is fresh; `openFuji` reconstructs. Sync's `onStateChange` would also reconnect, but workspace is being rebuilt anyway. | Provider re-renders; `openFuji` reconstructs. |
| Identity changes (different account) | Provider reloads. | Provider reloads. |
| Session expires server-side | Server closes WebSocket with code 4401. Sync enters `phase: 'failed'`. | Identical. |
| Network blip | WebSocket close → supervisor reconnects with backoff. | Identical. |
| `transport()` throws (race during sign-out) | N/A (returns null today) | Throw bubbles into the supervisor's existing error handling; `attemptConnection` returns `'failed'`; backoff applies; provider's reload finishes the teardown shortly after. |

There is no failure mode where `onStateChange` is the only thing keeping sync resilient.

### Comparison: where do similar systems put this?

| System | Reconnection model | Auth-state subscription in transport? |
| --- | --- | --- |
| `y-websocket` | Reconnect-on-close with backoff. | No. URL is constructed once; auth is whatever the URL/cookie carries. |
| Liveblocks client | Token-fetch callback per connection. | No subscription; calls callback fresh each connect. |
| Hocuspocus client | `onAuthenticationFailed` hook on close codes. | No proactive auth subscription. |
| Hono + Cloudflare Workers WebSocket guidance | "Don't initiate when no credentials." | Pre-flight check at the call site, not inside the sync layer. |

**Implication**: pre-flight check belongs at the layout (which we have), not inside `attachSync`. The "callback returns null" pattern is acceptable but uncommon; "don't call the factory until signed in" is the dominant pattern.

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Shape of the transport capability | 2 coherence | Single function `(url, protocols?) => WebSocket` | Smallest honest contract. Not an "auth" type; it's a credentialed transport. Future extension can widen to an object if a second capability emerges. |
| Property name on `SyncAttachmentConfig` | 3 taste | `transport` | Reads as what it is. `auth` mis-claims a broader surface. |
| `AuthClient.openWebSocket` return type | 2 coherence | `WebSocket` (non-null), throw on missing credentials | Caller has proven signed-in. Null was modeling a degenerate state callers don't observe. |
| Keep `onStateChange` on `AuthClient`? | 1 evidence | Yes | Used by `auth-svelte`, `auth-workspace`, and provider components for layout-level orchestration. Not in scope. |
| Keep `onStateChange` on `SyncAuth` (rename to `SyncTransport`)? | 2 coherence | Delete | Only consumer was `attachSync`. Provider does the workspace-level reaction via `window.location.reload()`. |
| Behavior of `attachSync` when `transport` throws | 2 coherence | Treat as a normal connection failure | Falls into the existing `attemptConnection` failure path; supervisor backs off. Race during sign-out resolves when provider tears down the workspace. |
| Migrate `openFuji` to take `transport` directly? | 2 coherence | Yes | The honest dependency is `(url, p) => WebSocket`, not the entire `AuthClient`. |
| Keep `SyncAuth` as a type alias to `SyncTransport`? | 3 taste | No | No consumers need it. A rename is a clean break, not a renamed alias. |
| Update the cookie auth `openWebSocket` to throw too? | 2 coherence | Yes | Same contract. Cookie auth's `currentIdentity === null` path also throws. |
| Backwards-compatibility shim | 2 coherence | None | Per repo convention. All consumers in this monorepo. Atomic migration. |

## Architecture

### Before

```
┌─────────────────────────────────────────┐
│ FujiWorkspaceProvider                   │
│   ├── auth.onStateChange ──┐            │
│   │     ├── signed-out → location.reload│
│   │     ├── identity-flip → reload       │
│   │     └── same-id → applyKeys          │
│   └── openFuji({ auth, identity, peer })│
└─────────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────┐
│ openFuji                                │
│   ├── attachSync(root, { auth, ... })   │
│   └── attachSync(child, { auth, ... }) (×N)
└─────────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────┐
│ attachSync                              │
│   ├── auth.openWebSocket(...)           │
│   │     └── returns WebSocket | null    │
│   ├── if null → 'no-credential' branch  │
│   └── auth.onStateChange(reconnect)     │
└─────────────────────────────────────────┘

Result: TWO independent subscribers to auth state changes (provider + sync).
        N+1 sync subscriptions per workspace. Provider reload always wins.
```

### After

```
┌─────────────────────────────────────────────────┐
│ FujiWorkspaceProvider                           │
│   ├── auth.onStateChange ──┐                    │
│   │     ├── signed-out → location.reload        │
│   │     ├── identity-flip → reload               │
│   │     └── same-id → applyKeys                  │
│   └── openFuji({ identity, peer, transport })   │
│         transport = auth.openWebSocket          │
└─────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────┐
│ openFuji                                │
│   ├── attachSync(root, { transport, ... })
│   └── attachSync(child, { transport, ... }) (×N)
└─────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────┐
│ attachSync                              │
│   └── transport(url, protocols)         │
│         returns WebSocket               │
│         (throws on missing creds → connection failure path)
└─────────────────────────────────────────┘

Result: ONE subscriber. Provider owns workspace lifecycle.
        Sync owns transport lifecycle. No overlap.
```

### Sign-out flow comparison

```
BEFORE                                      AFTER
──────                                      ─────
user signs out                              user signs out
    │                                           │
    ├─ provider.onStateChange fires             ├─ provider.onStateChange fires
    │     └─ window.location.reload() ←──┐      │     └─ window.location.reload()
    │                                    │      │           │
    └─ attachSync.onStateChange fires    │      │           ▼
        (×N+1, one per doc)              │      │     workspace disposed
            └─ queueMicrotask(reconnect)─┘      │     fresh page load
                  └─ transport returns null      │
                        └─ 'no-credential' branch│     (no second path)
                              └─ phase: offline  │
                                    ↑            │
                            wasted before reload finishes
```

## Implementation Plan

Build, Prove, Remove. Each wave leaves the workspace typecheckable.

### Wave 1: Build the new transport contract (additive)

- [x] **1.1** In `packages/workspace/src/document/attach-sync.ts`, add the `SyncTransport` type definition above the existing `SyncAuth` type. Export it from the file.
- [x] **1.2** Add `transport?: SyncTransport` to `SyncAttachmentConfig` (optional during the migration; required in wave 4). Keep `auth?: SyncAuth` for now so existing consumers compile.
- [x] **1.3** Re-export `SyncTransport` from `packages/workspace/src/index.ts`.
- [x] **1.4** Verify: `bun run --filter @epicenter/workspace typecheck` passes. No behavior change yet.

### Wave 2: Migrate `attachSync` internals to prefer `transport`

- [x] **2.1** In `attemptConnection` (around line 619), change the WebSocket construction to: prefer `config.transport` if present, fall back to `config.auth.openWebSocket`. The `'no-credential'` branch still applies only to the legacy path.
- [x] **2.2** In the `unsubscribeAuthChange` block (around line 810), make it conditional: only subscribe if `config.auth` is provided (the new `transport`-only path skips it).
- [x] **2.3** Verify: workspace tests still pass. Provider tests still pass.

### Wave 3: Migrate consumers

- [x] **3.1** Migrate `apps/fuji/src/lib/fuji/browser.ts`:
  - Change `openFuji`'s parameter from `{ auth: AuthClient, identity, peer }` to `{ transport: SyncTransport, identity, peer }`.
  - Replace the two `attachSync(..., { auth, ... })` calls with `attachSync(..., { transport, ... })`.
- [x] **3.2** Update `apps/fuji/src/lib/components/FujiWorkspaceProvider.svelte`:
  - Change the `openFuji({...})` call to pass `transport: auth.openWebSocket` instead of `auth`.
  - Leave the `auth.onStateChange` block intact (it owns layout-level orchestration).
- [x] **3.3** Repeat the same migration for the other workspace factories that consume `attachSync`:
  - `apps/honeycrisp/src/lib/honeycrisp/browser.ts` + `HoneycrispWorkspaceProvider.svelte`
  - `apps/opensidian/src/lib/opensidian/browser.ts` + provider
  - `apps/zhongwen/src/lib/zhongwen/browser.ts` + `ZhongwenWorkspaceProvider.svelte`
  - `apps/zhongwen/src/lib/zhongwen/script.ts`, `daemon.ts` (if they `attachSync`)
  - `apps/honeycrisp/src/lib/honeycrisp/script.ts`, `daemon.ts`
  - `apps/opensidian/src/lib/opensidian/script.ts`, `daemon.ts`
  - `apps/fuji/src/lib/fuji/daemon.ts`
  - `apps/tab-manager/src/lib/tab-manager/extension.ts`
- [x] **3.4** Workspace-wide grep: `grep -rn "auth: SyncAuth" --include='*.ts'` and `grep -rn "auth: AuthClient" apps/` should turn up zero hits except the provider components themselves (which legitimately consume `AuthClient` for `onStateChange`).
- [x] **3.5** Verify: every app typechecks. Workspace tests pass.
  > Note: app typechecks were run for Fuji, Honeycrisp, Opensidian, Zhongwen, and Tab Manager. The transport-related errors were eliminated, but the app checks still fail on unrelated existing errors in shared UI aliases, `packages/svelte-utils`, and app state/component files. `@epicenter/workspace` typecheck and tests passed.

### Wave 4: Make `transport` required, remove the legacy path

- [x] **4.1** In `attach-sync.ts`, change `transport?: SyncTransport` to `transport: SyncTransport`. Delete `auth?: SyncAuth` entirely.
- [x] **4.2** In `attemptConnection`, replace the conditional with a single line: `const ws = config.transport(config.url, [MAIN_SUBPROTOCOL]);`. Remove the `'no-credential'` return value from the function's return type. Delete the `if (ws === null) return 'no-credential';` line.
- [x] **4.3** In the supervisor `runLoop` (around line 583), delete the `if (result === 'no-credential')` branch. Update the `setStatus({ phase: 'offline' })` exit path so the supervisor only enters offline on `signal.aborted`.
- [x] **4.4** Delete the `unsubscribeAuthChange = config.auth.onStateChange(...)` block at line 810. Find and delete the matching `unsubscribeAuthChange()` call in the dispose path.
- [x] **4.5** Delete the `SyncAuth` type definition.
- [x] **4.6** Update `packages/workspace/src/index.ts`: remove `SyncAuth` from the re-exports.
- [x] **4.7** Update `attemptConnection`'s return type annotation: `Promise<'connected' | 'failed'>`.
- [x] **4.8** Verify: `bun run --filter @epicenter/workspace typecheck` passes. `attach-sync.test.ts` likely needs migration in wave 5.

### Wave 5: Migrate `attachSync` tests

- [x] **5.1** In `packages/workspace/src/document/attach-sync.test.ts`:
  - Replace `fakeAuth()` (lines 99-108) with a `fakeTransport: SyncTransport` backed by the test `FakeWebSocket`.
  - Update every `attachSync(ydoc, { url, auth: fakeAuth() })` to `attachSync(ydoc, { url, transport: fakeTransport })`.
  - Delete the `createCredentialSource` helper (lines 110-137) and the tests that depend on it (the four around lines 334, 360, 376, 399). These tests exercise the `null → setSignedIn → reconnect` flow that we are removing. The behavior they test no longer exists.
- [x] **5.2** Verify: `bun run --filter @epicenter/workspace test` passes.

### Wave 6: Narrow `AuthClient.openWebSocket` to non-null

- [x] **6.1** In `packages/auth/src/create-auth.ts`:
  - Change the `AuthClient.openWebSocket` signature (lines 100-103) to return `WebSocket` (drop `| null`).
  - Update the bearer impl (line 203): `if (session === null) throw new Error('[auth] openWebSocket called with no session : provider gate failed')` instead of returning null.
  - Update the cookie impl (line 262): same throw on `currentIdentity === null`.
  - Update the `AuthCoreConfig.openWebSocket` type (lines 278-281).
- [x] **6.2** Update the JSDoc on `AuthClient.openWebSocket` to drop the "Returns null when no credentials" wording. State the new contract: "Caller must have proven signed-in; throws otherwise."
- [x] **6.3** Update `packages/auth/src/create-auth.test.ts`:
  - Drop the `'openWebSocket returns null signed out'` assertion (line 358-362). Replace with an assertion that calling without a session throws.
  - Update the `'cookie openWebSocket'` test (line 429) similarly.
- [x] **6.4** Update `packages/auth/src/contract.test.ts` (line 344) where it checks the cookie return value.
- [x] **6.5** Update `packages/auth-workspace/src/index.test.ts` (line 94): the mock `openWebSocket` no longer needs to model null returns.
- [x] **6.6** Verify: `bun run --filter @epicenter/auth typecheck` and `test` pass. `bun run --filter @epicenter/auth-workspace typecheck` and `test` pass.
  > Note: `@epicenter/auth-workspace` has no package `test` script, so verification used `bun test packages/auth-workspace/src`.

### Wave 7: Documentation

- [x] **7.1** Update `packages/workspace/SYNC_ARCHITECTURE.md` (if it documents the `SyncAuth` shape).
- [x] **7.2** Update `packages/workspace/README.md` and `packages/workspace/src/document/README.md` with new `attachSync` examples.
- [x] **7.3** Update `apps/fuji/README.md` with the new `openFuji` signature.
- [x] **7.4** Update `docs/architecture.md` and `docs/guides/consuming-epicenter-api.md`.
- [x] **7.5** Update `.agents/skills/auth/SKILL.md` and `.agents/skills/workspace-app-layout/SKILL.md`.
- [x] **7.6** Mark the prior spec `specs/20260504T185711-attach-sync-auth-namespace.md` as superseded by this one (add a note pointing here).

### Wave 8: Final verification

- [x] **8.1** Workspace-wide grep : all of these returned zero hits in non-spec, non-historical-doc files:
  - `SyncAuth`
  - `'no-credential'`
  - `unsubscribeAuthChange`
  - `openWebSocket.*null` (function signatures)
  - `auth\.onStateChange` inside `attach-sync.ts`
- [ ] **8.2** `bun run typecheck` (workspace-wide) passes.
  > Final run failed on unrelated existing errors in `packages/ui`, `packages/svelte-utils`, and `apps/landing`. Package-level checks for the touched packages passed.
- [x] **8.3** `bun run test` for `@epicenter/workspace`, `@epicenter/auth`, `@epicenter/auth-workspace` all pass.
  > `@epicenter/auth-workspace` has no package `test` script, so final verification used `bun test packages/auth-workspace/src`.
- [ ] **8.4** Smoke test in browser:
  - Open Fuji while signed in. Sync connects.
  - Sign out from another tab. Confirm the page reloads (existing provider behavior) and a fresh sign-in prompt appears.
  - Sign in. Open Fuji again. Sync reconnects.
  - Open and edit an entry to trigger a child sync. Confirm child sync connects.
  > Skipped in this run because no signed-in browser session was available.

## Edge Cases

### Race: sign-out fires while a `transport()` call is in flight

1. User clicks sign out.
2. Provider's `onStateChange` handler queues `window.location.reload()`.
3. Supervisor's reconnect loop calls `transport(url)` before the page actually unloads.
4. `transport` reads `session === null` and throws.
5. Throw propagates into `attemptConnection`'s WebSocket-construction surface; supervisor logs and treats it as a connection failure.
6. Page unloads. Workspace disposed.

**Outcome**: brief `phase: 'failed'` blip in console logs that no UI consumes (the page is unloading). Acceptable.

### Race: token rotates mid-handshake

1. Open WebSocket connects with token T1.
2. Server sends `set-auth-token: T2` on a parallel HTTP fetch.
3. Client `rotateToken` updates `session.token = T2`. (No `setState` fires.)
4. Existing WebSocket continues with T1; server already authenticated this connection.
5. WebSocket eventually closes (network blip, server restart, etc.).
6. Supervisor reconnects. Calls `transport(url)`. Reads `session.token` (now T2). Connects with T2.

**Outcome**: identical to today. Token rotation flows through naturally on the next reconnect.

### Permanent server-side auth rejection

1. Server's session table revokes the user's session.
2. Next reconnect: server accepts the WebSocket upgrade but immediately closes with code 4401 and reason `'invalid_token'`.
3. `attachSync`'s `parsePermanentFailure` (line 676) detects 4401 and sets `permanentFailure = { type: 'auth', code: 'invalid_token' }`.
4. Supervisor exits with `phase: 'failed'`.
5. UI surfaces the failure. User signs in again. Provider re-renders. Workspace reconstructed.

**Outcome**: identical to today.

### Multiple workspace docs (root + N child entry docs)

1. Workspace opens. Root doc + every opened entry doc each gets its own `attachSync`.
2. Each `attachSync` holds a reference to the same `transport` function (passed through `openFuji`).
3. Supervisor lifecycles are independent: each doc reconnects on its own backoff.
4. On dispose, each `attachSync` aborts its own supervisor and closes its own socket.

**Outcome**: identical to today, minus N+1 `onStateChange` subscriptions that fired redundantly on every auth change.

## Open Questions

1. **Should `SyncTransport` accept `URL` in addition to `string`?**
   - Today `attachSync` constructs `config.url` as `string` upstream via `websocketUrl()`. `AuthClient.openWebSocket` accepts `string | URL`.
   - **Recommendation**: keep `SyncTransport` typed with `string`. Function-parameter contravariance lets `auth.openWebSocket` (which accepts `string | URL`) satisfy the narrower `(url: string) => WebSocket` contract. No friction at the call site.

2. **Should the throw on missing credentials be a typed error?**
   - Options: (a) plain `throw new Error(...)` since this is a programmer-error contract violation; (b) a defined error like `AuthError.NoCredentials` so callers can match on it.
   - **Recommendation**: (a). The contract is "caller proves signed-in." A throw here is a bug, not a recoverable state. Plain `Error` keeps the wellcrafted error surface focused on user-actionable errors.

3. **Should `openFuji` accept `transport` as a positional argument or a named field?**
   - **Recommendation**: keep the named-field destructured signature. Consistent with the current shape and with `peer`/`identity`.

4. **Should `attachSync` typecheck the throw at compile time (e.g., document via JSDoc that `transport` may throw)?**
   - **Recommendation**: yes, JSDoc only. TypeScript doesn't enforce throws-clauses, but a JSDoc note lets future maintainers reason about the failure shape.

5. **Should the existing test names that reference "credential" (e.g., `createCredentialSource`) be preserved as a thin shim?**
   - **Recommendation**: no. Delete them. The behavior they exercised does not exist anymore. Per repo convention: no compatibility shims.

## Decisions Log

- Keep `auth.onStateChange` at the layout level (`auth-svelte`, `auth-workspace`, providers): the provider's reaction to auth state changes is the workspace lifecycle policy. Constraint: if we ever stop tearing down on sign-out (e.g., to support multi-account hot-swap), we revisit whether sync needs its own subscription.
  Revisit when: a product requirement appears that says "workspace must stay attached across credential gaps."

- Narrow `auth.openWebSocket` for every `AuthClient` consumer: future non-gated consumers must add their own signed-in gate before calling it instead of depending on `null` as deferred credentials.
  Revisit when: a non-gated consumer of `openWebSocket` appears that genuinely needs a deferred-credential transport.

## Success Criteria

- [x] `SyncAuth` does not exist anywhere in `packages/workspace/`.
- [x] `SyncTransport` is exported from `@epicenter/workspace` and is the only transport-shaped type used by `attachSync`.
- [x] `attemptConnection` returns `'connected' | 'failed'` only.
- [x] `attach-sync.ts` contains zero references to `auth.onStateChange`, `unsubscribeAuthChange`, or `'no-credential'`.
- [x] `AuthClient.openWebSocket` returns `WebSocket` (non-null) and throws when called without credentials.
- [x] Every `openFuji`-style workspace factory takes `transport: SyncTransport` (not `auth: AuthClient`).
- [x] Every `*WorkspaceProvider.svelte` passes `transport: auth.openWebSocket` (and continues to subscribe to `auth.onStateChange` for layout-level orchestration).
- [ ] `bun run typecheck` passes workspace-wide.
- [x] `bun run test` passes for `@epicenter/workspace`, `@epicenter/auth`, `@epicenter/auth-workspace`.
  > `@epicenter/auth-workspace` was verified with `bun test packages/auth-workspace/src` because the package has no `test` script.
- [ ] Smoke test: sign-in → workspace opens → sync connects → sign-out → page reloads → sign-in → workspace re-opens → sync reconnects.

## References

- `packages/workspace/src/document/attach-sync.ts` : primary file under refactor (lines 194-231, 572-625, 808-815)
- `packages/auth/src/create-auth.ts` : `AuthClient` definition + impls (lines 68-106, 173-211, 257-267, 327-403)
- `packages/auth/src/create-auth.test.ts` : auth client tests to migrate (lines 358, 429)
- `packages/auth/src/contract.test.ts` : cross-factory contract tests (line 344)
- `packages/auth-workspace/src/index.ts` + `index.test.ts` : layout-level orchestrator (continues to use `onStateChange`; not in scope to change)
- `apps/fuji/src/lib/fuji/browser.ts` : primary consumer (`openFuji`)
- `apps/fuji/src/lib/components/FujiWorkspaceProvider.svelte` : provider that gates on signed-in identity
- `apps/api/src/auth/create-auth.ts` : Better Auth server config (session lifetime / roll cadence)
- `specs/20260504T185711-attach-sync-auth-namespace.md` : predecessor spec that introduced `SyncAuth`; will be marked superseded
- `specs/20260505T100000-auth-state-machine-cleanup-and-provider-migration.md` : companion spec on provider-level auth gating
- Skills: `cohesive-clean-breaks`, `one-sentence-test`, `factory-function-composition`, `specification-writing`
