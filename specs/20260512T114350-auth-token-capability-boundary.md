# Auth Token Capability Boundary

**Date**: 2026-05-12
**Status**: Draft
**Author**: AI assisted
**Branch**: `codex/auth-bearer-omit-cookies`
**Depends on**:

- `specs/20260511T150000-final-oauth-auth-architecture.md`
- `specs/20260512T100428-app-side-oauth-migration.md`
- `specs/20260512T111335-post-oauth-audit-remediation.md`

**Stack Map**: `specs/20260512T134603-auth-spec-stack-clean-break-map.md`
**Stack Position**: Long-term token ownership and persistence cleanup after runtime invariants are sealed.

## One Sentence

Epicenter auth stores token credentials privately and exposes only identity and transport capabilities to app code.

## Overview

This spec tightens the OAuth-only `AuthClient` path. It does not reintroduce cookie app auth, a backend frontend pattern, or app-specific credential families. The goal is one token-native path where refresh tokens keep long-running sync alive, while app code cannot casually read, log, pass, or persist raw credentials outside the auth boundary.

Out of scope:

```txt
cookie-first app auth
backend frontend token mediation
Better Auth session tokens as app runtime credentials
per-app auth modes
client-managed end-to-end encryption
new WebSocket ticket issuance in the first implementation wave
```

## Motivation

### Current State

The last 10 commits show a deliberate migration to one OAuth `AuthClient` path:

```txt
dashboard     -> OAuth AuthClient
fuji          -> OAuth AuthClient
honeycrisp    -> OAuth AuthClient
zhongwen      -> OAuth AuthClient
opensidian    -> OAuth AuthClient
tab-manager   -> OAuth AuthClient
```

The public client surface is already capability-shaped:

```ts
export type AuthClient = {
	state: AuthState;
	onStateChange(fn: (state: AuthState) => void): () => void;
	startSignIn(input?: {
		returnTo?: string;
	}): Promise<Result<undefined, AuthError>>;
	signOut(): Promise<Result<undefined, AuthError>>;
	fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
	openWebSocket(url: string | URL, protocols?: string[]): Promise<WebSocket>;
	[Symbol.dispose](): void;
};
```

The internal persisted session is flat:

```ts
export const OAuthSession = type({
	'...': WorkspaceIdentity,
	'+': 'delete',
	accessToken: 'string',
	refreshToken: 'string',
	accessTokenExpiresAt: 'number',
});
```

Expanded:

```ts
type OAuthSession = {
	user: AuthUser;
	encryptionKeys: EncryptionKeys;
	accessToken: string;
	refreshToken: string;
	accessTokenExpiresAt: number;
};
```

`createOAuthAppAuth()` receives a `sessionStorage` adapter:

```ts
export type OAuthSessionStorage = {
	get(): OAuthSessionType | null;
	set(value: OAuthSessionType | null): void | Promise<void>;
};
```

Browser app configs currently pass `createPersistedState(...)` directly:

```ts
export const auth = createOAuthAppAuth({
	baseURL: APP_URLS.API,
	clientId: EPICENTER_OPENSIDIAN_OAUTH_CLIENT_ID,
	sessionStorage: createPersistedState({
		key: 'opensidian.auth.session',
		schema: OAuthSession.or('null'),
		defaultValue: null,
	}),
	launcher: createBrowserOAuthLauncher({ ... }),
});
```

That creates problems:

1. **The conceptual split is hidden**: identity and network credentials are different things, but the flat `OAuthSession` shape makes them look like one bag.
2. **The storage name is misleading**: `sessionStorage` sounds like browser `window.sessionStorage`, but the current helper defaults to `window.localStorage` unless a storage backend is passed.
3. **Apps import the credential schema**: app platform auth files import `OAuthSession` just to configure persistence. That keeps token field names visible outside the auth package.
4. **The internal invariant is stronger than the type names**: `auth.state` exposes only `WorkspaceIdentity`, while `auth.fetch` and `auth.openWebSocket` use tokens internally. The code mostly behaves correctly, but the names do not teach the boundary.
5. **WebSocket auth is correct but underspecified**: `openWebSocket()` hides the access token and encodes it as `bearer.<token>` in the subprotocol list. That is a good browser-compatible mechanism, but the app contract should say sync never owns refresh or access tokens.
6. **Storage policy is too implicit**: if a runtime stores refresh tokens in local storage, that should be an explicit runtime decision, not an accidental default.

### Desired State

The auth package names the two planes separately:

```ts
type WorkspaceIdentity = {
	user: AuthUser;
	encryptionKeys: EncryptionKeys;
};

type NetworkCredentials = {
	accessToken: string;
	refreshToken: string;
	accessTokenExpiresAt: number;
};

type OAuthSession = {
	identity: WorkspaceIdentity;
	network: NetworkCredentials;
};
```

The public API stays capability-shaped:

```ts
type AuthClient = {
	state: AuthState;
	startSignIn(input?: { returnTo?: string }): Promise<Result<undefined, AuthError>>;
	signOut(): Promise<Result<undefined, AuthError>>;
	fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
	openWebSocket(url: string | URL, protocols?: string[]): Promise<WebSocket>;
};
```

The app wiring should read like this:

```txt
Need local identity:
  read auth.state.identity

Need encrypted workspace data:
  pass () => requireSignedIn(auth).encryptionKeys

Need HTTP:
  call auth.fetch()

Need sync:
  call auth.openWebSocket()

Need raw tokens:
  no public app API
```

## Research Findings

### Local Migration History

The recent branch history already collapsed apps onto `createOAuthAppAuth()`, `auth.fetch()`, and `auth.openWebSocket()`. This spec should not restart that migration. It should remove the remaining places where credential implementation details leak into names, storage config, examples, and app platform files.

Key implication:

```txt
The right clean break is not "choose OAuth."
That decision is made.

The right clean break is "make OAuth credentials private to auth."
```

### Current Token Flow

`startSignIn()` receives an `OAuthTokenGrant`, calls `/workspace-identity`, and persists the combined identity plus token session:

```txt
OAuth launcher
  -> accessToken, refreshToken, accessTokenExpiresAt
  -> /workspace-identity
  -> user, encryptionKeys
  -> OAuthSession
  -> auth.state
```

`fetch()` uses the same stored credentials internally:

```txt
auth.fetch()
  -> refresh if access token is stale
  -> Authorization: Bearer <accessToken>
  -> credentials: 'omit'
  -> retry once after 401
  -> mark reauth-required if refresh or retry fails
```

`openWebSocket()` uses the transport boundary:

```txt
attachSync reconnects
  -> calls auth.openWebSocket(url, ['epicenter'])
  -> auth refreshes if needed
  -> new WebSocket(url, ['epicenter', 'bearer.<accessToken>'])
  -> API normalizes bearer subprotocol into Authorization
```

The current behavior is close to the desired design. The cleanup should preserve the behavior and make the boundary harder to misuse.

### Token Storage Risk

Access tokens, refresh tokens, and expiry timestamps are not equal:

```txt
accessToken
  Short-lived credential. Needed for HTTP and WebSocket.

refreshToken
  Long-lived credential. Needed to keep the network session alive over time.

accessTokenExpiresAt
  Not a credential. It is a refresh hint.
```

The refresh token is the sensitive field. Epicenter is intentionally token-native across browser apps, extensions, Tauri, CLI, and daemon code. That means the refresh token exists in client-side auth storage. The mitigation is not to pretend it is harmless. The mitigation is to put one small auth boundary in charge of it and stop downstream code from needing it.

### WebSocket Ticket Option

A stricter WebSocket design could mint a short-lived one-use ticket:

```txt
auth.fetch('/websocket-ticket')
  -> ticket

auth.openWebSocket(url)
  -> new WebSocket(url, ['epicenter', 'ticket.<ticket>'])
```

That reduces the blast radius if a WebSocket handshake credential leaks, but it adds a new endpoint, replay prevention, ticket expiry, tests, and operational behavior. It also does not change the app API if `auth.openWebSocket()` already owns transport auth.

Implication: keep the current access-token subprotocol in this spec, but make `openWebSocket()` the only public way to open authenticated sync. If a ticket becomes worth it later, auth can swap the internal transport credential without changing app or workspace callers.

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Keep one OAuth path | 2 coherence | Keep | The branch already migrated apps toward one token-native `AuthClient`. Reopening cookies or backend mediation would fight the product direction. |
| Split identity from network credentials | 2 coherence | Introduce `identity` and `network` fields in the persisted session shape | The split matches how the client behaves: identity feeds app state, tokens feed transport. |
| Keep tokens private to auth | 2 coherence | No raw token getters, no app-owned Authorization construction | Sync and HTTP stay alive through `auth.openWebSocket()` and `auth.fetch()`, not through token access. |
| Rename `sessionStorage` | 2 coherence | Use `sessionStore` | Avoid confusing an auth storage adapter with browser `sessionStorage`. |
| Make browser storage explicit | 3 taste | No default `window.localStorage` in auth-facing browser token helpers | Token persistence should be a visible runtime decision. |
| Reduce app imports of `OAuthSession` | 2 coherence | Prefer auth-owned store factories over app files importing the token schema | App platform code should choose key and storage backend, not know the token object shape. |
| Keep access-token WebSocket subprotocol | 3 taste | Keep for first pass, behind `auth.openWebSocket()` | It is browser-compatible, already implemented, and does not leak tokens to app callers. A ticket can replace it later inside auth. |
| Do not add compatibility aliases | 2 coherence | Rename call sites in one sweep | A hybrid `sessionStorage` plus `sessionStore` config makes every caller ask which one is canonical. |

## Architecture

### Ownership

```txt
Better Auth
  owns login, account sessions, OAuth authorize/token/revoke, JWKS

Epicenter API
  owns /workspace-identity
  verifies OAuth access token
  returns WorkspaceIdentity

@epicenter/auth
  owns OAuthSession
  owns NetworkCredentials
  owns refresh
  owns fetch()
  owns openWebSocket()

Apps and workspace packages
  own UI, local workspace lifetime, Yjs state, app behavior
  consume identity and transport capabilities
```

### Proposed Auth Shape

```txt
OAuthSession
|-- identity
|   |-- user
|   `-- encryptionKeys
`-- network
    |-- accessToken
    |-- refreshToken
    `-- accessTokenExpiresAt
```

### Runtime Flow

```txt
SIGN IN

startSignIn()
  |
  v
OAuth launcher returns token grant
  |
  v
/workspace-identity
  |
  v
OAuthSession { identity, network }
  |
  v
auth.state = signed-in(identity)
```

```txt
HTTP

app or chat calls auth.fetch()
  |
  v
auth reads network credentials
  |
  v
refresh if needed
  |
  v
fetch(..., Authorization: Bearer accessToken, credentials: 'omit')
```

```txt
SYNC

attachSync calls auth.openWebSocket()
  |
  v
auth reads network credentials
  |
  v
refresh if needed
  |
  v
new WebSocket(url, ['epicenter', 'bearer.<accessToken>'])
  |
  v
API normalizes to Authorization
```

The refresh token keeps long-running sync working, but sync never reads it.

## Implementation Plan

### Phase 0: Verify The Surface

- [ ] **0.1** Grep for `OAuthSession`, `OAuthSessionStorage`, `sessionStorage:`, `accessToken`, `refreshToken`, `bearerToken`, and manual `Authorization` construction in `apps/*`, `packages/auth`, `packages/auth-svelte`, `packages/oauth-client`, and `packages/workspace`.
- [ ] **0.2** Confirm whether the current flat `OAuthSession` shape has shipped to a production build. If not, use a clean storage break. If yes, add a narrow storage-boundary migration and do not expose both shapes to app code.
- [ ] **0.3** Record every app that imports `OAuthSession` only for persistence schema validation.
- [ ] **0.4** Record every caller that passes `auth.openWebSocket`, `auth.fetch`, or `requireSignedIn(auth).encryptionKeys`.

### Phase 1: Split The Stored Session Shape

- [ ] **1.1** Add a `NetworkCredentials` arktype schema inside `packages/auth/src/auth-types.ts`.
- [ ] **1.2** Change `OAuthSession` to `{ identity: WorkspaceIdentity, network: NetworkCredentials }`.
- [ ] **1.3** Update `loadIdentity()` to construct the nested shape.
- [ ] **1.4** Update refresh code to replace only `session.network`.
- [ ] **1.5** Update `stateFromSession()` so `auth.state` is still derived from `session.identity`.
- [ ] **1.6** Update machine auth and tests to use the nested shape.

Expected internal pattern:

```ts
const next = OAuthSession.assert({
	identity,
	network: {
		accessToken: tokens.accessToken,
		refreshToken: tokens.refreshToken,
		accessTokenExpiresAt: tokens.accessTokenExpiresAt,
	},
});
```

### Phase 2: Rename The Store Boundary

- [ ] **2.1** Rename `OAuthSessionStorage` to `OAuthSessionStore`.
- [ ] **2.2** Rename config property `sessionStorage` to `sessionStore`.
- [ ] **2.3** Update `@epicenter/auth-svelte` and every app call site in one sweep.
- [ ] **2.4** Do not keep a `sessionStorage` alias unless Phase 0 proves this API has already shipped and compatibility is an explicit product requirement.
- [ ] **2.5** Update failure messages and comments to use the new store name.

### Phase 3: Move Session Schema Knowledge Back Into Auth

- [ ] **3.1** Add an auth-owned helper for browser Web Storage backed OAuth session persistence.
- [ ] **3.2** Require callers to pass the storage backend explicitly.
- [ ] **3.3** Use the helper in browser app platform auth files so those files no longer import `OAuthSession` directly.
- [ ] **3.4** Add or adapt an auth-owned helper for preloaded async stores if the extension cannot use the browser helper directly.
- [ ] **3.5** Stop exporting the `OAuthSession` schema from app-facing entrypoints if no app needs it after the helper migration.

Example direction:

```ts
sessionStore: createWebStorageOAuthSessionStore({
	key: 'opensidian.auth.session',
	storage: window.localStorage,
});
```

If an app chooses `window.localStorage`, that is acceptable. The point is that the choice is explicit.

### Phase 4: Seal Transport Capability Use

- [ ] **4.1** Keep `auth.fetch()` as the only app-facing way to add `Authorization` for protected resources.
- [ ] **4.2** Keep `auth.openWebSocket()` as the only app-facing way to add sync credentials.
- [ ] **4.3** Add tests that prove `openWebSocket()` refreshes before opening and never requires app code to read tokens.
- [ ] **4.4** Add tests that prove refresh failure moves state to `reauth-required` while preserving identity.
- [ ] **4.5** Document that WebSocket ticket auth is intentionally deferred because the public capability boundary already allows it later without caller changes.

### Phase 5: Remove Old Vocabulary

- [ ] **5.1** Remove old `sessionStorage` property names.
- [ ] **5.2** Remove stale flat `OAuthSession` examples.
- [ ] **5.3** Remove app imports of token schemas where auth-owned store helpers replaced them.
- [ ] **5.4** Update `auth` skill docs and package READMEs to show the nested mental model.
- [ ] **5.5** Grep for old vocabulary before final review.

Search terms:

```txt
sessionStorage:
OAuthSession.or
accessToken
refreshToken
bearerToken
Authorization: Bearer
```

Old token field names may remain inside auth internals, token endpoint parsing, tests, and server verification. They should not appear as app-consumed public auth state.

## Edge Cases

### Expired Access Token On App Boot

1. The app loads a stored session with a stale `network.accessToken`.
2. `auth.state` becomes `signed-in` from `identity`.
3. The first `auth.fetch()` or `auth.openWebSocket()` refreshes before transport.
4. If refresh fails, state becomes `reauth-required` and keeps identity.

### WebSocket Reconnect After Token Rotation

1. A sync socket is already open.
2. The access token expires or rotates.
3. The open socket continues until it closes.
4. The next reconnect calls `auth.openWebSocket()` and gets a fresh access token.

### Refresh Token Rejection

1. Refresh fails because the refresh token is revoked, expired, or invalid.
2. Auth sets `reauth-required`.
3. Local workspace identity remains available.
4. Network operations fail or stay paused until sign-in repairs the session.

### Persisted Session Shape Change

1. An older flat session is present in storage.
2. If the flat shape has not shipped, schema validation should read it as null and require sign-in.
3. If the flat shape has shipped, add one storage-boundary migration and keep that migration out of app code.

### Extension Async Storage

1. The extension must preload storage before constructing `createOAuthAppAuth()`.
2. The auth client still needs a synchronous initial read.
3. Keep the preload boundary, but move token shape validation into auth-owned helpers if possible.

## Open Questions

1. **Should browser apps use localStorage or sessionStorage by default?**
   Recommendation: no default in auth helpers. Make each app pass the storage backend explicitly. Local-first apps may still choose localStorage, but the choice should be visible in the app platform auth file.

2. **Should `OAuthSession` remain exported?**
   Recommendation: stop exporting it from app-facing entrypoints once store helpers cover browser and extension persistence. Keep the schema internal to `@epicenter/auth` for validation, tests, and machine auth.

3. **Should WebSocket use a one-use ticket now?**
   Recommendation: no. Keep access-token subprotocol auth in this pass. Revisit if `Sec-WebSocket-Protocol` starts appearing in logs, access tokens become long-lived, or WebSocket handshake leakage becomes a concrete threat model.

4. **Should the persisted shape migration support old flat sessions?**
   Recommendation: decide from release evidence. If this branch has not shipped, prefer a clean break and force sign-in. If shipped, keep the migration at the storage boundary only.

## Decisions Log

- Keep access-token WebSocket subprotocol auth for this pass: it avoids app token exposure and preserves one transport capability. Revisit when WebSocket ticketing can remove a real observed risk without changing app call sites.
- Keep token-native auth everywhere: browser cookie or backend mediation patterns are out of scope for Epicenter's cross-runtime product direction. Revisit only if the product direction changes, not as a local cleanup.

## Success Criteria

- [ ] App code cannot read `accessToken` or `refreshToken` through `AuthClient`.
- [ ] `auth.state` exposes identity only.
- [ ] `auth.fetch()` and `auth.openWebSocket()` still refresh as needed.
- [ ] Sync keeps working over reconnects without receiving raw tokens.
- [ ] The persisted auth shape names `identity` and `network` separately.
- [ ] Browser storage choice is explicit at app platform boundaries.
- [ ] `sessionStorage` no longer names the auth persistence adapter.
- [ ] No app-facing docs show flat `OAuthSession` as the mental model.
- [ ] Tests cover sign-in storage, refresh, 401 retry, WebSocket refresh, and `reauth-required` identity preservation.

## References

- `packages/auth/src/auth-types.ts`: current `WorkspaceIdentity`, `OAuthTokenGrant`, and `OAuthSession` schemas.
- `packages/auth/src/create-oauth-app-auth.ts`: token refresh, `auth.fetch()`, `auth.openWebSocket()`, and state projection.
- `packages/auth/src/auth-contract.ts`: public `AuthClient` boundary.
- `packages/auth-svelte/src/create-auth.svelte.ts`: Svelte reactive wrapper that must preserve the same public surface.
- `packages/svelte-utils/src/session.svelte.ts`: app workspace lifecycle around `auth.state`.
- `apps/*/src/lib/platform/auth/auth.ts`: app platform auth configs that currently choose session persistence.
- `apps/tab-manager/src/lib/platform/auth/auth.ts`: extension storage path and async preload boundary.
- `apps/api/src/auth/single-credential.ts`: WebSocket bearer subprotocol normalization.
- `packages/sync/src/auth-subprotocol.ts`: shared WebSocket subprotocol parsing and rationale.
