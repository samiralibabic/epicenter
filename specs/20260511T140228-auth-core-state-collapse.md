# Auth Core State Collapse

**Date**: 2026-05-11
**Status**: Implemented
**Author**: Codex
**Branch**: codex/auth-bearer-omit-cookies

## Overview

This spec tightens Wave 3 auth core before app and sync migration continue. The goal is to make `reauth-required` mean one thing: network auth refresh failed for an existing `OAuthSession`.

One sentence:

```txt
Auth owns OAuth session freshness for network transports while preserving cached identity for local unlock.
```

## Motivation

### Current State

Wave 3 introduced `OAuthSession`:

```ts
export const OAuthSession = type({
	'...': AuthIdentity,
	accessToken: 'string',
	refreshToken: 'string',
	accessTokenExpiresAt: 'number',
});
```

The current core uses `accessTokenExpiresAt` in two places:

```txt
accessTokenExpiresAt
  -> auth.state at construction time
  -> proactive refresh before fetch and WebSocket open
```

That makes an expired access token look like a local auth failure even though the refresh token may still be valid.

This creates problems:

1. **Expired access token overstates failure**: An expired access token only says the next network request needs refresh. It does not prove the app must reauth.
2. **State and transport share the same clock rule**: `auth.state` and `fetch/openWebSocket` both interpret `accessTokenExpiresAt`, so expiry semantics are split across local unlock and network transport.
3. **Async writes need one ownership rule**: Refresh, sign-in, and sign-out can all write the same session slot after awaits. Without a guard, a stale refresh can restore a session after sign-out.
4. **Persistence errors can be hidden by adapters**: Core awaits `sessionStorage.set`, but an adapter can log and resolve, weakening the persist-before-network invariant.

### Desired State

`accessTokenExpiresAt` is only a transport freshness hint. It never decides local identity state.

```txt
OAuthSession
  ├── user + encryptionKeys -> auth.state local identity
  ├── accessToken -> fetch/socket credential
  ├── refreshToken -> network credential renewal
  └── accessTokenExpiresAt -> transport refresh decision only
```

The collapsed state rule:

```ts
function stateFromSession(session: OAuthSession | null) {
	if (session === null) return { status: 'signed-out' };
	if (networkAuthPaused) {
		return { status: 'reauth-required', identity: identityFromSession(session) };
	}
	return { status: 'signed-in', identity: identityFromSession(session) };
}
```

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Meaning of `reauth-required` | 2 coherence | Only refresh failure or auth rejection sets it. | Local-first unlock depends on cached identity. Expired access tokens are network freshness, not identity failure. |
| Expired cached access token at boot | 2 coherence | Boot `signed-in` from cached `OAuthSession`. | The app can unlock local data and attempt refresh on first network use. |
| `accessTokenExpiresAt` owner | 2 coherence | Transport refresh path only. | It answers "should this request/socket refresh first?" and nothing else. |
| Stale async writes | 1 evidence | Guard session writes with a session epoch. | Without a guard, a slow refresh can restore a session after sign-out. |
| Refresh dedupe | 1 evidence | Keep one in-flight refresh promise. | Rotating refresh tokens make concurrent refresh calls unsafe. |
| Machine persistence failure | 1 evidence | Propagate `sessionStorage.set` failures. | Core awaits storage before network use; adapters must not hide failed persistence. |
| `AuthError.RefreshFailed` | 2 coherence | Delete unless a public method returns it. | Refresh failure is represented as auth state, not a returned command error. |

## What Collapses

Before:

```txt
session + now + accessTokenExpiresAt + networkAuthPaused
  -> signed-in | reauth-required | signed-out

fetch/openWebSocket
  -> also read accessTokenExpiresAt
```

After:

```txt
session + networkAuthPaused
  -> signed-in | reauth-required | signed-out

fetch/openWebSocket
  -> read accessTokenExpiresAt
```

The collapse removes a second meaning from token expiry. Token expiry stops being "auth state changed" and becomes "refresh before network use."

## Mutable State Budget

Every mutable `let` in auth core must own an invariant.

| Mutable value | Keep? | Earns itself by owning |
| --- | --- | --- |
| `session` | Yes | Current durable OAuth session snapshot. |
| `networkAuthPaused` | Yes | Memory that refresh failed and network auth must wait for reauth. |
| `refreshPromise` | Yes | Dedupe rotating refresh-token use. |
| `sessionEpoch` | Yes | Reject stale async writes after sign-out or replacement. |
| `hasDisposed` | Yes | Idempotent listener cleanup. |
| `now` config | Maybe | Testable refresh-skew decisions only. It should not affect state derivation. |

The epoch is the smallest race guard that still says the important thing:

```ts
let sessionEpoch = 0;

async function replaceSession(next: OAuthSession | null) {
	sessionEpoch += 1;
	networkAuthPaused = false;
	await sessionStorage.set(next);
	session = next;
	publishState();
}

async function refreshSession({ force }: { force: boolean }) {
	const startedAt = sessionEpoch;
	const current = session;
	if (current === null || networkAuthPaused) return false;
	if (!force && !shouldRefresh(current, now())) return true;

	const tokens = await refreshOAuthToken(current);
	const next = { ...current, ...tokens };

	if (startedAt !== sessionEpoch || session !== current) return false;
	await sessionStorage.set(next);
	session = next;
	publishState();
	return true;
}
```

This is not cancellation infrastructure. It is one integer that prevents old async work from writing into a newer auth world.

## Could It Collapse Further?

### Option A: Remove `networkAuthPaused`

Rejected. Without this flag, `reauth-required` must be derived from something else. Deriving it from expiry is the current problem. Deriving it from `session === null` would lose cached identity and encryption keys. The flag earns itself because refresh failure is a real event, not a property of the session shape.

### Option B: Remove `sessionEpoch`

Rejected. That would leave the sign-out race alive. A stale refresh can await token refresh, then await storage, then restore the old session after explicit sign-out. The epoch is cheaper than abort controllers, locks, or making every call site pass cancellation state.

### Option C: Remove proactive refresh

Tempting, but deferred. Reactive 401 retry is the correctness path, and proactive refresh is only latency smoothing. Removing proactive refresh would collapse `shouldRefresh` and reduce clock sensitivity, but WebSocket open still needs a fresh enough token because it cannot retry the handshake as cleanly as fetch. Keep proactive refresh for now, but keep it transport-only.

### Option D: Store only refresh token plus identity

Rejected for this wave. That would force every network use to refresh before sending, which turns the access token into dead storage. It simplifies state but makes transport slower and increases refresh-token rotation pressure.

## Implementation Plan

### Phase 1: State Semantics

- [x] **1.1** Change `stateFromSession` so `accessTokenExpiresAt` does not produce `reauth-required`.
- [x] **1.2** Update tests so an expired cached `OAuthSession` boots as `signed-in` without network.
- [x] **1.3** Keep refresh failure tests asserting `reauth-required` with preserved identity and no storage clear.

### Phase 2: Async Session Ownership

- [x] **2.1** Introduce `sessionEpoch` in `createOAuthAppAuth`.
- [x] **2.2** Route sign-in, sign-out, and refresh writes through the smallest shared session replacement path that keeps persistence awaited.
- [x] **2.3** Add a test where `signOut()` happens while refresh is in flight; the stale refresh must not restore the session.
- [x] **2.4** Add a same-user reauth test if the state transition is not already covered by `startSignIn`.

### Phase 3: Persistence and Transport Edges

- [x] **3.1** Make the machine auth `sessionStorage.set` adapter propagate `saveMachineSession` failures.
- [x] **3.2** Add a machine auth test proving refresh does not proceed silently when keychain save fails.
- [x] **3.3** Fix `auth.fetch` 401 retry for `Request` inputs with bodies, or explicitly document and test the narrower supported shape.
- [x] **3.4** Move default refresh expiry calculation to the injected `now`, if that config remains.
- [x] **3.5** Delete `AuthError.RefreshFailed` unless a public API returns it.

### Phase 4: Verification

- [x] **4.1** Run `bun run --filter @epicenter/auth typecheck`.
- [x] **4.2** Run `bun test packages/auth/src/auth-factories.test.ts packages/auth/src/contract.test.ts packages/auth/src/contracts/auth-session.test.ts packages/auth/src/node/machine-auth.test.ts`.
  > Note: `packages/auth/src/contracts/auth-session.test.ts` is absent in this dirty worktree, so the targeted run used the remaining present files.
- [x] **4.3** Run `bun run --filter @epicenter/auth-svelte typecheck`.
- [x] **4.4** Update the parent OAuth clean-break spec to mark this Wave 3.5 complete only after implementation passes.

## Edge Cases

### App Boots Offline With Expired Access Token

The app reads cached `OAuthSession` and enters `signed-in`. Local workspace data can unlock from `user` and `encryptionKeys`. The first network use attempts refresh. If refresh fails, state becomes `reauth-required`.

### Refresh Fails

The session remains in storage. `user` and `encryptionKeys` stay available. `networkAuthPaused` becomes true, so `fetch` and `openWebSocket` stop attaching stale bearer tokens until reauth replaces the session.

### User Signs Out During Refresh

`signOut()` increments the session epoch before awaiting storage. When the in-flight refresh completes, it sees the epoch mismatch and refuses to write. Final state remains `signed-out`.

### User Reauths During Refresh

`startSignIn()` replaces the session and increments the epoch. Any older refresh result is ignored. The new session owns future network credentials.

### Different User Reauth

Auth core can expose the new identity, but workspace lifecycle owns data safety. If the user id changes, the app/session layer must tear down or reload before sync resumes.

## Open Questions

1. Should proactive refresh be removed for `fetch` and kept only for WebSocket open?
2. Should `openWebSocket` fail fast in `reauth-required`, or open without bearer protocols? The safer default is fail fast, but current behavior opens without auth.
3. Should auth expose a narrow `reauth` event or is `auth.state.status === 'reauth-required'` enough?
4. Should `signOut()` eventually revoke refresh tokens in the same core factory, or should revocation remain a launcher/platform concern until Phase 4.8 is implemented?

## Review

**Completed**: 2026-05-11
**Branch**: `codex/auth-bearer-omit-cookies`

### Summary

Implemented the Wave 3.5 auth core state collapse. Cached `OAuthSession`
identity now boots as `signed-in` regardless of access token expiry, while
fetch and WebSocket transport still refresh near-expiry tokens before network
use.

Refresh failures and refreshed 401 rejections now preserve the cached session,
publish `reauth-required`, and stop attaching stale bearer tokens. Sign-in and
sign-out use the shared session replacement path, and refresh writes are
guarded by `sessionEpoch` so stale async refresh work cannot restore a
signed-out session.

### Deviations From Spec

- `auth.fetch` now supports retrying `Request` inputs with bodies by cloning the
  request for each fetch attempt.
- `createMachineAuthClient` accepts test injection for storage, fetch, refresh,
  revoke, logger, and clock dependencies so keychain persistence failures can
  be tested without touching the real keychain.
- `packages/auth/src/contracts/auth-session.test.ts` is absent in the current
  dirty worktree, so verification used the present targeted auth tests.

### Follow-Up Work

- Wave 4 app and sync migration remains deferred. This wave did not migrate app
  sign-in routes or sync boundaries.
