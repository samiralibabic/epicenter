# Hosted Epicenter Sign-In Clean Break

**Date**: 2026-05-11
**Status**: Superseded draft, retained as audit trail
**Author**: AI-assisted
**Supersedes**: `specs/20260511T090000-auth-credential-families-minimal-production.md` for the public app sign-in surface and bearer runtime model. That older spec still contains useful implementation notes for OAuth client registration, extension callbacks, and manual verification, but it preserves the stale `signInWithSocial({ provider })` app API and the stale OAuth-access-token-to-Better-Auth-session bridge.
**Superseded By**: `specs/20260511T105846-auth-oauth-everywhere-clean-break.md`

## Supersession Note

This spec is no longer the implementation target. It is kept because the audit
found useful evidence: hosted sign-in is still the credential boundary, and
`/auth/oauth-session` is still the wrong bridge. The rejected part is the split
where cookie apps remain in Better Auth's session-token world while bearer apps
move to OAuth resource-server credentials.

The replacement direction is stricter: every app is an OAuth client. Better Auth
cookies remain inside the hosted API auth server so `/sign-in`, `/consent`, and
`/oauth2/authorize` can complete login. Apps do not use those cookies as their
runtime credential.

## Active Direction

This historical section is preserved for context. It is not the source of truth
for the next auth cleanup.

The headline:

```txt
Cookie apps:
  Native Better Auth session world

Bearer apps:
  Native OAuth resource-server world
```

Use this shape:

```ts
await auth.beginSignIn({ returnTo });
```

Do not continue this older shape:

```ts
await auth.signIn({ email, password });
await auth.signUp({ email, password, name });
await auth.signInWithSocial({ provider: 'google' });
```

The clean break is narrower and stronger than "put every client on bearer." Apps all start sign-in the same way, but the factory still owns the transport that fits the runtime.

```txt
Public shape:
  every app calls beginSignIn()

Credential boundary:
  hosted Epicenter /sign-in owns all human credential and account-factor UI

Private completion:
  cookie factory completes through HttpOnly session cookies
  bearer factory completes through OAuth code + PKCE + GET /auth/me
```

## One-Sentence Thesis

Every Epicenter app starts sign-in by sending the user to the hosted Epicenter sign-in page; the hosted page owns credentials and account factors, while each app receives either a cookie session or a complete bearer session before workspace data unlocks.

## Blunt Recommendation

Make a thorough change, but make it the right thorough change.

Centralize all human credential entry. Apps should not render email/password fields, sign-up fields, recovery UI, social-provider buttons, or future MFA prompts. An app should render one product action: "Sign in to Epicenter." The hosted API page decides whether the user signs in with email/password, creates an account, uses Google, recovers access, or completes a future factor.

Do not collapse cookie and bearer transport into one transport. That would be over-cleaning. Cookie apps and bearer apps solve different credential ownership problems:

```txt
Cookie app:
  Browser cookie jar owns the credential.
  Server sets and clears the credential with Set-Cookie.
  Only for Epicenter-owned apps inside the same approved cookie boundary.

Bearer app:
  App-owned storage owns the credential.
  OAuth token endpoint returns access and refresh tokens.
  The client sends Authorization: Bearer <accessToken>.
  For first-party apps outside the cookie boundary, third-party apps,
  extensions, CLIs, daemons, Tauri, and cross-origin SPAs.
```

The clean break is not "everything is OAuth bearer." The clean break is "only hosted Epicenter collects credentials, and each runtime uses the credential system it was built for."

The family rule has two axes: ownership and origin shape.

```txt
First-party + same Epicenter cookie boundary:
  createCookieAuth
  direct hosted /sign-in
  no OAuth ceremony for normal sign-in

Trusted static client + outside the cookie boundary:
  createBearerAuth
  OAuth authorization code + PKCE
  consent can be skipped because the client id is in the monorepo-owned list

Third-party:
  OAuth bearer
  consent required
```

Cookie auth is therefore not a generic "browser app" mode. It is an Epicenter web-property mode. A third-party app should not depend on Epicenter's first-party cookie jar, even if a trusted origin entry could make it work technically. Bearer clients are third-party by default unless their `clientId` appears in Epicenter's static trusted-client list in this monorepo.

Do not collapse the transport split further in this cleanup:

```txt
Do not make cookie apps bearer just for uniformity.
  Same-site browser apps should not store bearer tokens when HttpOnly cookies
  already give the browser the honest credential owner.

Do not make bearer apps cookie just for simplicity.
  Extensions, CLIs, daemons, Tauri, and cross-origin apps need portable
  app-owned credentials.
```

The stronger collapse is at the app boundary:

```txt
Before:
  apps choose email/password, sign-up, Google, or recovery UI

After:
  apps request sign-in
  hosted Epicenter chooses the credential path
  auth factories complete the session
```

## How Much Simplifies

This simplifies a lot, but not by deleting every auth distinction. It deletes two wrong distinctions at once: app-embedded credential entry, and a hand-rolled bridge between Better Auth's OAuth-provider world and its session-token world.

The first smell is in `packages/auth/src/create-bearer-auth.ts`:

```ts
let pendingBearerToken: string | null = null;
```

That variable exists because bearer email/password sign-in can receive a Better Auth bearer token before Epicenter has a complete `BearerSession`:

```ts
type BearerSession = {
	token: string;            // durable Better Auth session token
	user: AuthUser;
	encryptionKeys: EncryptionKeys;
};
```

The token is enough to call `/auth/get-session`, but it is not enough for Epicenter to become signed in honestly. The workspace cannot unlock until `encryptionKeys` are present. So the auth client temporarily holds a credential that cannot be exposed as `auth.bearerToken`, cannot become `AuthIdentity`, and cannot be persisted as the real local session yet.

The second smell is at the API edge: `POST /auth/oauth-session` swaps an OAuth access token for that durable Better Auth session token. That swap has no upstream recipe. Better Auth ships `verifyAccessToken` for resource-server validation and ships the bearer plugin for durable session tokens, but never the bridge between them. Bearer apps end up speaking *both* token vocabularies: OAuth code + PKCE for sign-in, then a Better Auth session token for everything else, with a custom endpoint amplifying token lifetime in between.

Centralized hosted sign-in plus an honest resource-server pattern delete both smells at once:

```txt
Before:
  app form
    -> auth.signIn({ email, password })
    -> Better Auth returns bearer session token
    -> pendingBearerToken
    -> /auth/get-session
    -> derive user + encryptionKeys
    -> persist BearerSession { token, user, encryptionKeys }

After:
  app beginSignIn()
    -> hosted sign-in page
    -> OAuth code + PKCE for bearer apps
    -> launcher returns { accessToken, refreshToken, expiresIn }
    -> auth core stores BearerSession
    -> GET /auth/me with Authorization: Bearer <accessToken>
    -> { user, encryptionKeys }
    -> persist complete BearerSession {
         accessToken, refreshToken, accessTokenExpiresAt,
         user, encryptionKeys
       }
```

`/auth/oauth-session` does not survive in its current shape. It becomes `/auth/me`, a normal OAuth 2.1 protected-resource endpoint that calls `oauthProviderResourceClient.verifyAccessToken` and returns identity. It stops minting durable session tokens.

The simplification is asymmetric:

```txt
Refuse:
  Embedded credential forms in every app.
  A Better Auth session-token model for bearer apps.

Code family deleted:
  AuthClient.signIn
  AuthClient.signUp
  AuthClient.signInWithSocial
  AuthForm email/password/sign-up state
  bearer email/password hydration path
  pendingBearerToken
  hydrateSignedOutSession
  readTokenFromAuthCommandData
  BearerSession.token as a durable Better Auth session token
  set-auth-token rotation on the bearer fetch path
  customSession as the boot mechanism for bearer apps
  /auth/oauth-session as a session-token swap endpoint
  app-level recovery/account-factor drift
  provider-specific public app buttons

User loss:
  Some flows redirect to a hosted auth page instead of staying in an app popover.
  Access tokens expire periodically; WebSocket sync reconnects more often.

Decision:
  Refuse embedded credentials. Refuse the hidden bridge between OAuth and
  Better Auth session-token worlds. The product still has email/password, sign-up,
  social login, recovery, and future factors. It has them in one place.
  Bearer apps dogfood the OAuth provider Epicenter already ships.
```

## Current State

The auth surface currently asks every `AuthClient` to implement credential methods:

```ts
export type AuthClient = {
	readonly state: AuthState;
	readonly bearerToken: string | null;
	onStateChange(fn: (state: AuthState) => void): () => void;
	signIn(input: {
		email: string;
		password: string;
	}): Promise<Result<undefined, AuthError>>;
	signUp(input: {
		email: string;
		password: string;
		name: string;
	}): Promise<Result<undefined, AuthError>>;
	signInWithSocial(input: {
		provider: SocialProvider;
	}): Promise<Result<undefined, AuthError>>;
	signOut(): Promise<Result<undefined, AuthError>>;
	fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
	[Symbol.dispose](): void;
};
```

`packages/svelte-utils/src/auth-form/auth-form.svelte` uses that whole surface directly:

```txt
AuthForm
  has mode = sign-in | sign-up
  owns email, password, name
  calls auth.signIn(...)
  calls auth.signUp(...)
  calls onSocialSignIn()
```

That means every app using `AuthForm` is a credential collector. It also means every new account factor becomes either a shared UI expansion or a product inconsistency.

The API already has the centralized pieces:

```txt
apps/api/src/app.ts
  GET /sign-in
  GET /consent
  GET /device
  POST /auth/oauth-session        (currently a session-token swap;
                                   becomes GET /auth/me in this break)
  GET/POST /auth/* -> Better Auth handler

apps/api/src/auth/create-auth.ts
  oauthProvider({
    loginPage: '/sign-in',
    consentPage: '/consent',
    requirePKCE: true,
    validAudiences: [baseURL],
    allowDynamicClientRegistration: false,
  })

apps/api/src/auth-pages/scripts/sign-in.ts
  POST /auth/sign-in/email
  POST /auth/sign-up/email
  POST /auth/sign-in/social
  preserves oauth_query when present
```

The local hosted page is not a theory. It exists. The missing move is making it the credential boundary for apps, and reshaping the post-OAuth endpoint into a normal resource-server identity read.

## Desired State

The shared auth client stops exposing credential-specific verbs. Apps do not know whether the hosted page chooses email/password, sign-up, Google, recovery, or a future factor.

```ts
export type AuthClient = {
	readonly state: AuthState;
	readonly bearerToken: string | null;
	onStateChange(fn: (state: AuthState) => void): () => void;
	beginSignIn(input?: {
		returnTo?: string;
	}): Promise<Result<undefined, AuthError>>;
	signOut(): Promise<Result<undefined, AuthError>>;
	fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
	[Symbol.dispose](): void;
};
```

The ideal signed-out app UI becomes tiny:

```txt
Signed-out state
  "Sign in to Epicenter"
    -> auth.beginSignIn()
```

No app imports a credential form. No app decides providers. No app handles sign-up mode. No app adds account recovery.

The bearer session shape changes underneath. After this break, `BearerSession` mirrors the OAuth 2.1 token endpoint response plus the cached identity that backs offline boot:

```ts
export type BearerSession = {
	accessToken: string;
	refreshToken: string;
	accessTokenExpiresAt: number;   // epoch ms, computed at receipt
	user: AuthUser;
	encryptionKeys: EncryptionKeys;
};
```

Cookie apps and bearer apps then complete the same `beginSignIn()` call through different transports:

```txt
Cookie family completion:
  hosted /sign-in
    -> Set-Cookie session
    -> reload
    -> useSession picks up { user, encryptionKeys } via customSession
    -> AuthIdentity { user, encryptionKeys }

Bearer family completion:
  hosted /sign-in
    -> OAuth code + PKCE
    -> launcher returns { accessToken, refreshToken, expiresIn }
    -> GET /auth/me (Authorization: Bearer <accessToken>)
    -> { user, encryptionKeys }
    -> BearerSession persisted

Bearer runtime:
  every fetch carries Authorization: Bearer <accessToken>
  401 -> POST /auth/oauth2/token grant_type=refresh_token
       -> rotate stored refresh token atomically
       -> retry once
  signOut -> POST /auth/oauth2/revoke + clear local session
```

## Relationship To Credential Families Spec

`specs/20260511T090000-auth-credential-families-minimal-production.md` was correct about the family split, but its bearer runtime should not be carried forward unchanged:

```txt
Still true:
  browser cookie jar owns the session credential
  app storage owns the bearer credential

Stale:
  app storage owns a durable Better Auth session token
  exchanges oauthProvider access tokens for Epicenter's complete bearer session
```

It is no longer correct about the public app sign-in method or the bearer runtime credential. The app should not call `signInWithSocial({ provider })`, because provider choice belongs to hosted `/sign-in`. The bearer app should not swap an OAuth access token for a Better Auth session token, because OAuth access tokens are the bearer runtime credential.

Carry these pieces forward from the older spec:

```txt
static OAuth client registry
registered redirect URIs for bearer clients
Chrome extension launchWebAuthFlow constraints
Tauri callback decision notes
CLI device flow remains separate and already bearer-shaped
manual verification matrix
```

Replace this older model:

```txt
Every app belongs to a credential family.
Each family signs in differently.
```

With this model:

```txt
Every app starts hosted sign-in the same way.
Each factory completes the session differently.
```

## Two Bearer Worlds, One Choice

Better Auth ships two credential systems that look similar at the surface but are designed for different jobs:

```txt
OAuth provider world:                Better Auth session world:
  /oauth2/authorize (code + PKCE)      session.token (durable, opaque, DB row)
  /oauth2/token (issues access_token)  Set-Cookie or set-auth-token transport
  access_token (JWT, signed by JWKS)   useSession.subscribe live state
  short-lived (minutes)                long-lived (until signOut or expiry)
  /oauth2/userinfo (OIDC claims)       customSession enrichment
  verifyAccessToken at the edge        Better Auth getSession middleware
  refresh_token grant rotates          opaque token survives across requests
```

Cookie apps live entirely in the Better Auth session world, with the browser cookie jar carrying the credential. Bearer apps today *also* live there, after a one-shot OAuth dance whose only purpose is to satisfy the "credentials belong to hosted /sign-in" thesis. The custom `POST /auth/oauth-session` endpoint exists to ferry an OAuth access token into a durable session token so the Better Auth session world can take over.

That bridge is the second smell. The recommended Better Auth pattern for app-storage clients is the resource-server pattern:

```txt
@better-auth/oauth-provider exports oauthProviderResourceClient
  .verifyAccessToken(token, { audience, jwksUrl, issuer })
  -> JWTPayload { sub, sid, aud, iss, scope, ... }

Resource-server flow:
  client stores { access_token, refresh_token, expires_in }
  client calls protected endpoints with Authorization: Bearer <access_token>
  endpoint calls verifyAccessToken at the edge
  payload.sub identifies the user
  payload.sid (when present) links to the live Better Auth session
```

Better Auth ships the verifier. Better Auth does not ship the bridge endpoint Epicenter currently writes.

The clean break is to live in whichever world a given app actually belongs to:

```txt
Cookie apps:
  Better Auth session world (cookies are session tokens with a jar)
  customSession works natively
  Better Auth's getSession middleware runs at the edge

Bearer apps:
  OAuth provider world (access tokens are the credential)
  refresh via /auth/oauth2/token grant_type=refresh_token
  identity via GET /auth/me (verifyAccessToken + derive encryption keys)
  no durable Better Auth session token on the client
  no set-auth-token rotation on the client fetch path
```

The endpoint Epicenter writes is `GET /auth/me`. Internally it calls Better Auth's `verifyAccessToken`, reads `payload.sub`, derives the user's encryption keys, and returns `{ user, encryptionKeys }`. That is a textbook OAuth 2.1 protected-resource read. No session-token swap. No `set-auth-token` header. No upstream pattern needed because the endpoint *is* the upstream pattern.

The bridge stops being load-bearing. Bearer apps now dogfood Epicenter's own OAuth provider.

```txt
Refuse:
  Two bearer-credential systems on one client.

Win:
  Cookie apps:  Better Auth's recommended cookie shape, unchanged.
  Bearer apps:  Better Auth's recommended resource-server shape.
  Both:         beginSignIn() at the front door, hosted page owns credentials.
```

## Research Findings

### Better Auth

Better Auth's `oauthProvider` plugin supports a custom `loginPage`. Its docs say that if a user is not logged in during the provider flow, the user is redirected to that page, and after a new session is created the plugin continues the authorization flow. Source: [Better Auth OAuth 2.1 Provider](https://better-auth.com/docs/plugins/oauth-provider).

Better Auth's bearer plugin returns a session token through the `set-auth-token` response header after sign-in. The docs show that bearer clients store that token and send it through `Authorization: Bearer`. Source: [Better Auth Bearer Token Authentication](https://better-auth.com/docs/plugins/bearer).

Better Auth custom session fields are attached to `getSession` and `useSession` through `customSession`. Source: [Better Auth Session Management](https://better-auth.com/docs/concepts/session-management).

Better Auth treats consent bypass as a trusted-client property. Its OAuth provider docs describe `skip_consent` as a restricted field that should only be editable by admin or server code, useful for trusted clients. The same docs also describe hard-coded trusted clients and consent bypass for first-party applications. That maps cleanly to Epicenter using a static monorepo-owned client registry as the source of truth. Prefer feeding that registry directly into Better Auth config if the installed `oauthProvider` supports full static client metadata; otherwise project the registry into Better Auth's `oauth_client` table with server-only admin APIs.

`@better-auth/oauth-provider` exports `oauthProviderResourceClient`. Its `verifyAccessToken(token, { audience, jwksUrl, issuer })` is the documented helper for resource servers built on the same auth host. Source path (vendored copy of upstream): `node_modules/@better-auth/oauth-provider/dist/client-resource.d.mts`. The JSDoc reads "Performs verification of an access token for your APIs." That is the helper `/auth/me` uses.

Better Auth's `/auth/oauth2/token` endpoint accepts `grant_type=refresh_token` for public clients (no `client_secret` needed when the client is registered with `token_endpoint_auth_method: 'none'`). The response shape mirrors RFC 6749: `{ access_token, refresh_token, expires_in, token_type: "Bearer", ... }`. Refresh tokens are rotated on every successful refresh, and Better Auth implements replay detection: using a revoked refresh token deletes every refresh token for that user and client pair. Source path: `node_modules/@better-auth/oauth-provider/dist/index.mjs:655-725`. The client must persist the new refresh token atomically with the access token swap, or it locks itself out on the next refresh attempt.

Implication:

```txt
Bearer apps consume Epicenter's OAuth provider as a resource server.
verifyAccessToken at the edge handles identity for every protected endpoint.
/auth/me returns { user, encryptionKeys } keyed off payload.sub.
Refresh is grant_type=refresh_token against /auth/oauth2/token.
OAuth clients are third-party unless they appear in Epicenter's static trusted registry.
```

### Hono and Worker Routing

Hono executes handlers and middleware in registration order. A fallback or catch-all route must be registered after specific routes. Source: [Hono routing priority](https://hono.dev/docs/api/routing).

The current API order is correct, with one route renamed in this break:

```txt
/sign-in
/consent
/device
/auth/me              (formerly /auth/oauth-session)
/auth/*
```

`/auth/me` must stay before `/auth/*`, because the generic Better Auth handler should not swallow Epicenter's resource-server identity route. The route is a `GET` since it reads identity, not a swap.

### Cloudflare Cookies

Cross-site cookies require `SameSite=None; Secure`. Cloudflare documentation also describes CHIPS partitioning, where partitioned cookies are keyed by the top-level site. Source: [Cloudflare SameSite cookie interaction](https://developers.cloudflare.com/waf/troubleshooting/samesite-cookie-interaction/).

Local code already documents the practical consequence in `apps/api/src/auth/create-auth.ts`: a cross-origin fetch from an app to the API is a poor place to rely on a state cookie being stored. Hosted top-level navigation is a better credential boundary than app-embedded cross-origin credential fetch.

### Chrome Extensions and WXT

WXT provides types and build structure, but the OAuth callback constraints come from the browser extension platform. Chrome's identity API generates callback URLs matching `https://<app-id>.chromiumapp.org/*`, and `launchWebAuthFlow` closes the window when the provider redirects to that pattern. Source: [Chrome identity API](https://developer.chrome.com/docs/extensions/reference/api/identity).

Implication:

```txt
Tab Manager should remain bearer.
Its platform auth module should own launchWebAuthFlow.
Auth core should not know Chrome callback mechanics.
```

### SvelteKit SPA Callback Routes

SvelteKit static or SPA deployments need fallback routing for non-prerendered routes, and `paths.base` must be included in root-relative links and callback URLs when the app is served from a subpath. Sources: [SvelteKit adapter-static fallback](https://svelte.dev/docs/kit/adapter-static) and [SvelteKit paths.base](https://svelte.dev/docs/kit/configuration#paths).

Implication:

```txt
Opensidian callback URLs must include base path when deployed under a base.
The hosted sign-in launcher should not hard-code root paths.
```

### Tauri

Tauri supports deep links through `@tauri-apps/plugin-deep-link`. Desktop deep links have platform constraints: macOS requires static config and installed app testing, while Linux and Windows can register at runtime in some cases. Source: [Tauri deep linking](https://v2.tauri.app/plugin/deep-linking/).

Implication:

```txt
Whispering or future Tauri apps should be bearer.
The Tauri launcher is a platform adapter, not auth-core behavior.
Loopback can still be considered, but it is a separate product decision.
```

## Architecture

### Current Mixed Boundary

```txt
App UI
  |
  | email/password/social provider choice
  v
AuthClient
  |
  +-- cookie auth
  |     -> Better Auth cookie session
  |
  +-- bearer auth
        -> Better Auth bearer token
        -> pendingBearerToken
        -> /auth/get-session
        -> BearerSession
```

Problem: the app and auth core both participate in credential entry. Bearer auth also has a token-only intermediate state that does not match Epicenter's signed-in contract.

### Proposed Boundary

```txt
App UI
  |
  | beginSignIn()
  v
Hosted Epicenter Sign-In
  |
  +-- email/password
  +-- sign-up
  +-- Google
  +-- recovery
  +-- future MFA/passkey
  |
  v
Session family
  |
  +-- cookie app
  |     -> Set-Cookie
  |     -> getSession/useSession (Better Auth session world)
  |     -> AuthIdentity { user, encryptionKeys }
  |
  +-- bearer app  (OAuth resource-server world)
        -> OAuth code + PKCE
        -> launcher returns { accessToken, refreshToken, expiresIn }
        -> GET /auth/me with Authorization: Bearer <accessToken>
        -> verifyAccessToken at the edge
        -> derive { user, encryptionKeys } from payload.sub
        -> BearerSession {
             accessToken, refreshToken, accessTokenExpiresAt,
             user, encryptionKeys
           }
        -> runtime fetches: Authorization: Bearer <accessToken>
        -> 401 -> POST /auth/oauth2/token grant_type=refresh_token -> retry
        -> signOut: revoke + clear local session
```

The hosted page owns credential semantics. The auth factory owns transport semantics. Cookie apps stay in Better Auth's session-token world. Bearer apps live in OAuth's access-token world. The two worlds do not cross on the client.

## Proposed Public API

### Shared Auth Client

```ts
export type AuthClient = {
	readonly state: AuthState;
	readonly bearerToken: string | null;
	onStateChange(fn: (state: AuthState) => void): () => void;
	beginSignIn(input?: {
		returnTo?: string;
	}): Promise<Result<undefined, AuthError>>;
	signOut(): Promise<Result<undefined, AuthError>>;
	fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
	[Symbol.dispose](): void;
};
```

#### Contract for `beginSignIn`

This function has two honest behaviors depending on the transport. Callers must not treat the returned Promise as a "sign-in finished" signal.

```txt
Navigating flows (cookie family, bearer SPA redirect):
  The function calls window.location.href and returns a Promise that
  never settles in this page lifetime. The caller is unloaded with the
  page. Observe completion through auth.state on the next page load,
  not by awaiting this Promise.

Launcher flows (bearer extension via launchWebAuthFlow, bearer Tauri
via deep-link or loopback):
  The function awaits the launcher and then loads identity from /auth/me.
  The Promise settles when the launcher returns and identity load finishes.
    Ok(undefined)              -> OAuth completed, /auth/me succeeded,
                                  auth.state will transition to signed-in
    Ok(undefined) with no
    state transition           -> user cancelled the launcher
    AuthError.SignInFailed     -> launcher rejected (popup blocked,
                                  /auth/me failed, network error)
```

The Promise is for in-page error surfacing only. Components that need to render signed-in UI must subscribe to `auth.state`. Components that need to render "Signing in..." must track local pending state around the `beginSignIn` call, not infer it from the Promise.

### Cookie Auth

```ts
export type CreateCookieAuthConfig = {
	baseURL?: string;
	getSignInURL?: (input: { returnTo?: string }) => string;
	initialIdentity?: AuthIdentity | null;
	saveIdentity?: (value: AuthIdentity | null) => void | Promise<void>;
};
```

Suggested behavior:

```txt
beginSignIn({ returnTo })
  -> window.location.href = getSignInURL({ returnTo })
  -> hosted /sign-in sets cookie
  -> app reloads or returns
  -> Better Auth useSession updates identity
```

`@epicenter/auth` should not import browser globals by default. The Svelte/browser wrapper or platform auth file can inject the navigation launcher.

### Bearer Auth

```ts
export type CreateBearerAuthConfig = {
	baseURL?: string;
	sessionStorage: BearerSessionStorage;
	signInLauncher: HostedSignInLauncher;
};

export type HostedSignInLauncher = {
	begin(input: {
		returnTo?: string;
	}): Promise<Result<HostedSignInTokens | null, unknown>>;
};

export type HostedSignInTokens = {
	accessToken: string;
	refreshToken: string;
	accessTokenExpiresIn: number;   // seconds from now, as RFC 6749 expires_in
};

export type BearerSession = {
	accessToken: string;
	refreshToken: string;
	accessTokenExpiresAt: number;   // epoch ms, computed at receipt
	user: AuthUser;
	encryptionKeys: EncryptionKeys;
};
```

Suggested behavior:

```txt
beginSignIn()
  -> signInLauncher.begin()
  -> if null, flow redirected away and will resume later
  -> if HostedSignInTokens, GET /auth/me with the access token
  -> normalize { user, encryptionKeys } from /auth/me body
  -> assemble BearerSession with accessTokenExpiresAt = now + expiresIn*1000
  -> update in-memory auth state
  -> persist BearerSession

auth.fetch
  -> attach Authorization: Bearer <accessToken>
  -> if response.status === 401:
       POST /auth/oauth2/token grant_type=refresh_token
       -> on success, atomically replace stored BearerSession credentials
       -> retry the original request once
       -> on second 401 or refresh failure, transition to signed-out

auth.signOut
  -> POST /auth/oauth2/revoke token=<refreshToken>
  -> clear sessionStorage and in-memory state
  -> transition to signed-out

bearerToken getter
  -> returns the current accessToken string (or null if signed out)
  -> sync callers read this lazily on each WebSocket reconnect
```

Refresh policy is **reactive on 401 with proactive light**: the fetch path handles 401 and retries; an optional foreground check before sending a request can refresh when `accessTokenExpiresAt - Date.now()` is below a small threshold (suggest 60 seconds). The proactive light is opt-in; the reactive path is the correctness guarantee. Either way, the persist-before-retry contract is the hard rule.

Rename `oauthAdapter` to `signInLauncher` or `hostedSignIn` if this clean break lands. `oauthAdapter.signInWithSocial({ provider })` is now a stale name because the app no longer chooses a social provider.

The launcher does **not** own refresh. The launcher is one-shot: "do the OAuth dance, return tokens." Refresh is a long-running credential-lifecycle concern that belongs to `createBearerAuth`. The launcher should not know that bearer sessions exist.

### Hosted Sign-In Launcher Package

`packages/oauth-client` can keep the PKCE implementation, but its public naming should stop saying "social":

```txt
createBrowserHostedSignInLauncher
createExtensionHostedSignInLauncher
createTauriHostedSignInLauncher
createOAuthClient
```

This package should still not depend on `@epicenter/auth` or `BearerSession`. It returns `HostedSignInTokens` only. Auth core owns identity loading via `/auth/me` and the refresh lifecycle.

### Server: /auth/me

```ts
// apps/api/src/auth/me.ts (rename of oauth-session.ts after this break)

import { oauthProviderResourceClient } from '@better-auth/oauth-provider/client-resource';

export async function handleGetMe(c: Context) {
	const resource = oauthProviderResourceClient(c.var.auth);
	const payload = await resource.getActions().verifyAccessToken(
		extractBearer(c.req.header('authorization')),
		{ verifyOptions: { audience: c.var.authBaseURL } },
	).catch(() => null);

	if (!payload?.sub) return c.json({ code: 'invalid_oauth_token' }, 401);

	const user = await c.var.db
		.select()
		.from(schema.user)
		.where(eq(schema.user.id, payload.sub as string))
		.then(([row]) => row ?? null);
	if (!user) return c.json({ code: 'invalid_oauth_token' }, 401);

	const encryptionKeys = await deriveUserEncryptionKeys(user.id);
	return c.json({ user, encryptionKeys });
}
```

Notes:

```txt
- Uses oauthProviderResourceClient.verifyAccessToken (documented Better Auth helper).
- Does NOT return set-auth-token. The access token IS the credential.
- Does NOT issue any durable session token.
- Returns the same { user, encryptionKeys } shape that customSession returns
  for cookie apps. AuthIdentity is identical between transports.
- 401 mapping: any verifier failure (invalid signature, wrong audience,
  expired token, missing sub, user row gone) returns the same opaque
  invalid_oauth_token response. Detail leakage is deliberate-low.
```

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Credential entry owner | 2 coherence | Hosted Epicenter sign-in only | The thesis says credentials belong to the auth server boundary. Embedded app forms are the source of the bearer partial-session smell. |
| Remove `AuthClient.signIn` | 2 coherence | Remove | Email/password is a hosted-page implementation detail, not an app auth method. |
| Remove `AuthClient.signUp` | 2 coherence | Remove | Sign-up is an account lifecycle flow. Apps should not own it. |
| Replace `signInWithSocial({ provider })` | 2 coherence | Use `beginSignIn()` | Provider choice belongs to the hosted page. Keeping provider in the app preserves a stale mental model. |
| Cookie family eligibility | 2 coherence | Epicenter-owned and same cookie boundary only | Cookie auth relies on Epicenter's first-party browser cookie jar. That is an ownership and origin-boundary privilege, not a generic browser-app mode. |
| Cookie app sign-in path | 2 coherence | Direct hosted `/sign-in` | Cookie apps want a Better Auth cookie, not an OAuth grant. OAuth authorize is ceremony unless the app needs bearer semantics. |
| Trusted bearer client policy | 1 evidence and 2 coherence | Static monorepo list plus Better Auth `skip_consent` | Better Auth models consent bypass as a restricted trusted-client field. Epicenter should default OAuth clients to third-party and allow bypass only for client ids in code-owned static config. |
| Third-party app transport | 2 coherence | OAuth bearer with consent | Third-party apps should not depend on Epicenter's first-party cookie jar. OAuth exists for delegated access. |
| Keep `createCookieAuth` | 1 evidence and 2 coherence | Keep | Better Auth is cookie-native, local code already supports cookie apps, and unifying on bearer adds callback registration and token storage for no clear product win. |
| Keep `createBearerAuth` | 1 evidence | Keep | Extensions, CLIs, Tauri, daemons, third-party apps, and cross-origin SPAs cannot rely on the same cookie assumptions. Better Auth documents bearer as the alternative for APIs that need bearer tokens. |
| Bearer runtime credential | 1 evidence and 2 coherence | OAuth access token | Better Auth ships `oauthProviderResourceClient.verifyAccessToken` for resource servers. Bearer apps should consume Epicenter's OAuth provider directly instead of swapping access tokens for durable Better Auth session tokens. |
| Bearer identity endpoint | 1 evidence and 2 coherence | `GET /auth/me` | `/oauth2/userinfo` stays OIDC-shaped. `/auth/me` is Epicenter's protected-resource identity read: verify access token, load user, derive encryption keys, return `{ user, encryptionKeys }`. |
| Bearer refresh | 1 evidence | `/auth/oauth2/token` with `grant_type=refresh_token` | Better Auth's OAuth provider implements refresh for public PKCE clients and rotates refresh tokens. Auth core must atomically persist the rotated refresh token before retrying requests. |
| Refresh policy | 2 coherence | Reactive on 401 plus proactive light at near-expiry | Reactive alone is correct but produces avoidable WebSocket reconnect churn at the expiry boundary. Proactive light keeps sync warm without a background timer becoming a separate concern. |
| Launcher owns refresh | 2 coherence | Refuse | Launcher is one-shot ("do the OAuth dance"). Refresh is a credential-lifecycle concern owned by `createBearerAuth`. Bundling them collapses two responsibilities into one package and re-creates the swap smell at a different layer. |
| Keep `AuthClient.bearerToken` temporarily | 3 taste under current constraints | Keep, meaning current access token for bearer apps | Sync reads this value lazily today. Keeping the field avoids coupling this break to the future `auth.openWebSocket` cleanup. Cookie apps continue returning `null`. |
| Keep `encryptionKeys` in `AuthIdentity` | 3 taste under current constraints | Keep for now | Local-first apps need cached complete identity to unlock on boot. A separate unlock step is not justified until there is a real lock product or user-held keys. |
| Do not add `transport: 'cookie' | 'bearer'` | 2 coherence | Refuse | The two factories already put the family decision at construction. A flag makes runtime branching leak into callers. |
| Do not add provider buttons in apps | 2 coherence | Refuse | The hosted page owns provider availability and ordering. |

## What Gets Deleted or Simplified

### Auth Core

Delete:

```txt
AuthClient.signIn
AuthClient.signUp
AuthClient.signInWithSocial
SocialProvider from the shared app-facing surface
pendingBearerToken
hydrateSignedOutSession
readTokenFromAuthCommandData
bearer email/password command handling
cookie email/password command handling
BearerSession.token as a durable Better Auth session token
set-auth-token rotation on the bearer fetch path
customSession as the boot mechanism for bearer apps
/auth/oauth-session as a session-token swap endpoint
```

Keep:

```txt
AuthState
AuthIdentity
BearerSession
createCookieAuth
createBearerAuth
auth.fetch
auth.bearerToken, temporarily meaning current access token for bearer apps
auth.signOut
customSession parsing for cookie apps
/auth/me identity read for bearer apps
```

### Shared Svelte UI

Delete `AuthForm`. Do not replace it with a shared `HostedSignInPrompt` component.

The replacement is three lines per app and earns nothing from being centralized. A shared component would re-create the AuthForm centralization smell at a smaller scale: every app would import it and every app would feel coupled to a single signed-out vocabulary. The honest pattern is inline:

```svelte
<script lang="ts">
  import { auth } from '$lib/platform/auth/cookie';
  import { Button } from '@epicenter/ui/button';
  let busy = $state(false);
</script>

{#if auth.state.status === 'signed-out'}
  <Button
    disabled={busy}
    onclick={async () => {
      busy = true;
      try {
        await auth.beginSignIn({ returnTo: window.location.href });
      } finally {
        busy = false;
      }
    }}
  >
    {busy ? 'Signing in...' : 'Sign in to Epicenter'}
  </Button>
{/if}
```

The one shared surface that earns its keep is `AccountPopover`. It is the place every app shows account state, and it owns the "you got signed out mid-session" branch. After this break:

```txt
Before:
  AccountPopover received an `onSocialSignIn` prop that each app
  threaded down from its own auth wiring.

After:
  AccountPopover receives `auth` and calls `auth.beginSignIn()` directly.
  The `onSocialSignIn` prop is deleted.
```

No other shared component is justified.

### Apps

App family selection follows this rule:

```txt
createCookieAuth:
  Epicenter-owned app
  same approved Epicenter cookie boundary
  normal sign-in goes directly to hosted /sign-in

createBearerAuth:
  trusted static client outside the cookie boundary
  third-party app
  extension
  desktop app
  CLI or daemon
```

Cookie apps keep their cookie platform file:

```txt
apps/dashboard/src/lib/platform/auth/cookie.ts
apps/fuji/src/lib/platform/auth/cookie.ts
apps/honeycrisp/src/lib/platform/auth/cookie.ts
apps/zhongwen/src/lib/platform/auth/cookie.ts
```

Bearer apps keep their bearer platform file:

```txt
apps/opensidian/src/lib/platform/auth/bearer.ts
apps/tab-manager/src/lib/platform/auth/bearer.ts
future apps/whispering auth
```

App routes no longer import `AuthForm` or call `auth.signInWithSocial({ provider: 'google' })`.

## Real Downsides

### Redirects and Lost Popover Context

The user leaves the app surface for sign-in. That is acceptable. Authentication is a high-trust boundary, and the hosted page can provide a consistent account experience.

Mitigation:

```txt
beginSignIn({ returnTo: current URL })
hosted page returns to app
first-party clients can skip consent
```

### Local Dev Callback Registration

This is the biggest practical cost. Bearer apps need registered callback URLs. The repo currently declares public clients in `packages/constants/src/oauth.ts`, but the API does not obviously expose that list as a Better Auth static client registry while `allowDynamicClientRegistration` is disabled.

This must be fixed before deleting old sign-in paths.

### Extension Callback Handling

Chrome extension OAuth must use the extension identity callback URL shape. The app id is part of the redirect URI, so production and development extension ids need deliberate registration.

This is acceptable because Tab Manager is already in the bearer family. The platform file owns that callback.

### Tauri Callback Handling

Tauri needs a callback strategy. Deep links work but have platform constraints. Loopback is also viable, but that would require a separate launcher implementation.

This is deferred until Whispering or another Tauri app actually adds auth.

### Offline Sign-In

No hosted sign-in works offline. Cached sessions can still unlock local-first data if the app already has a complete `BearerSession` or cached cookie identity. New sign-in cannot happen offline.

That is acceptable. Offline account creation or recovery is not a real product promise.

### Password Manager UX

This likely improves. One hosted Epicenter origin owns username and password fields, so password managers learn one site instead of several app origins. The downside is that app-specific context is less visible during credential entry.

### Cookie Boundary

Cookie apps still depend on browser cookie behavior. That is acceptable only for Epicenter-owned apps inside the approved Epicenter cookie boundary. It is not acceptable for cross-origin apps like Opensidian, which should stay bearer even if the product is first-party.

The distinction matters:

```txt
Ownership:
  who controls and publishes the app

Cookie boundary:
  whether the browser can honestly use Epicenter's first-party cookie jar
```

Both must be true for `createCookieAuth`.

### Account Recovery and MFA

Centralizing makes these easier, but it also makes the hosted page more load-bearing. The hosted page must become production UI, not a minimal helper page.

### Access Token Expiry During WebSocket Sync

Bearer apps establish a WebSocket sync connection with the current access token as a subprotocol. Today's durable session tokens never expire mid-connection. Access tokens expire on the configured OAuth lifetime (default in Better Auth is typically minutes). When that expiry hits, the server may close the connection or reject the next message.

Mitigations:

```txt
- attachSync reads `bearerToken: () => auth.bearerToken` lazily. On reconnect
  it reads the current value, which the refresh path has already rotated.
- Proactive light refresh before expiry keeps the live connection healthy
  most of the time; the reactive 401 path is the safety net.
- Sync infrastructure already reconnects on transport failure; the worst
  case is one extra reconnect per access-token lifetime.
- Configure access token lifetime to match typical session windows so the
  reconnect rate stays low. This is a server config decision, not an
  auth-core decision.
```

This is a real cost relative to the durable session token model. It is the price of using the recommended OAuth resource-server pattern.

### Refresh Token Storage Atomicity

Better Auth implements refresh token replay detection: using a revoked refresh token wipes every refresh token for that user and client. The client must persist the rotated refresh token *before* firing any request that depends on the new credential. This rules out fire-and-forget persistence and forces an awaited write inside the refresh path.

Concretely:

```ts
async function refresh() {
	const response = await fetch(tokenEndpoint, { /* refresh_token grant */ });
	const tokens = await response.json();
	await sessionStorage.set(applyTokens(session, tokens));  // MUST await
	return tokens;
}
```

If `sessionStorage.set` is async and we do not await it, a fast follow-up request can use the new access token while the old refresh token is still on disk. A crash between those moments leaves the client locked out.

### Access Token Expiry While Offline

Today's durable session tokens survive arbitrary offline periods. Access tokens do not; they expire on the OAuth lifetime regardless of network state. If the refresh token is still valid when the app comes back online, the next request silently refreshes. If the refresh token has also expired (longer-lived but bounded), the user must `beginSignIn()` again.

This is the standard OAuth contract. It is fine for Epicenter's product shape: an offline-only app session that lasts past the refresh window is not a real flow we promise.

## Encryption Keys and Workspace Unlock

Do not split `encryptionKeys` out of `AuthIdentity` as part of this break.

What changes is the *delivery mechanism* for bearer apps, not the shape:

```txt
Cookie apps (unchanged):
  Better Auth getSession -> customSession enriches the response
  -> AuthIdentity { user, encryptionKeys }

Bearer apps (changed):
  GET /auth/me with Authorization: Bearer <accessToken>
  -> server calls verifyAccessToken, reads payload.sub
  -> server derives encryption keys for that user id
  -> response: { user, encryptionKeys }
  -> client assembles BearerSession with those fields
  -> AuthIdentity { user, encryptionKeys } (same shape as cookie apps)
```

The auth server still derives per-user keys from `ENCRYPTION_SECRETS` and attaches them to the identity response. The workspace builder reads keys synchronously through:

```ts
encryptionKeys: () => requireSignedIn(auth).encryptionKeys
```

For local-first apps, that matters:

```txt
Opensidian boot:
  load cached BearerSession
  auth.state is signed-in immediately
  open workspace
  attach IndexedDB
  attach encrypted stores with cached keys

Tab Manager boot:
  await chrome.storage auth session
  create bearer auth
  open encrypted workspace
```

A separate key-loading step would add:

```txt
auth signed-in but locked
workspace locked
key fetch pending
key fetch failed
offline signed-in but locked
same-user key refresh
lock/unlock UI
```

That may become valuable later if Epicenter wants a Bitwarden-style lock model, user-held keys, PIN unlock, passphrase unlock, or explicit memory wipe. It is not required to fix the current auth smell.

The real caveat is different: current docs note no explicit encrypted-store deactivation hook after logout. Workspace disposal is the current key-drop boundary. If the threat model changes, handle that as an encryption lifecycle spec, not as a reason to keep credential forms in apps.

## Migration Plan

This is a clean break with no production users. The plan trades the careful Build, Prove, Remove cadence for atomic correctness: server foundation first, then everything else in one PR. The codebase may be temporarily broken between commits inside PR 2; that is acceptable because rollback is `git revert` and no user state is at risk.

### Why no coexistence wave

The earlier draft of this spec proposed a wave that added `beginSignIn()` beside the existing `signIn`, `signUp`, and `signInWithSocial` so apps could migrate one at a time. That cadence makes sense when production traffic must keep flowing. It does not make sense here. A coexistence wave produces a hybrid API where every consumer asks "which path is canonical." That is exactly the smell the `cohesive-clean-breaks` skill warns against, for no benefit. The thesis is "credentials belong to the hosted page." A spec that keeps app-side credential methods alive for a wave is a spec that says "credentials mostly belong to the hosted page."

### PR 1: Server foundation

Low-risk. Server-only. Changes no app and no shared client surface. Useful even if PR 2 is delayed by days or weeks; the trusted-client refactor and audience validation are correct security tightenings on their own merits.

Trusted-client refactor:

- [ ] **1.1** Replace `EPICENTER_OAUTH_PUBLIC_CLIENTS` with one canonical `EPICENTER_TRUSTED_OAUTH_CLIENTS` registry. Every entry in this list is Epicenter-owned, public, PKCE-required, authorization-code-only, and allowed to skip consent.
- [ ] **1.2** Inline the client id string into each registry entry unless another package needs the id constant independently. Avoid a separate `EPICENTER_OPENSIDIAN_LOCAL_OAUTH_CLIENT_ID` export when the registry is the only source of truth.
- [ ] **1.3** Keep only per-client facts in each entry: `clientId`, `name`, `runtime`, and `redirectUris`. Do not repeat invariant OAuth defaults such as `token_endpoint_auth_method: 'none'`, `grant_types: ['authorization_code']`, `response_types: ['code']`, or `require_pkce: true` in every entry.
- [ ] **1.4** Prefer passing `EPICENTER_TRUSTED_OAUTH_CLIENTS` directly to Better Auth's static/trusted client config if the installed `oauthProvider` supports full client metadata there.
- [ ] **1.5** If the installed provider only supports database-backed client metadata, project `EPICENTER_TRUSTED_OAUTH_CLIENTS` into Better Auth's `oauth_client` table with server-only admin APIs. Treat the database rows as generated state, not the source of truth.
- [ ] **1.6** If the installed Better Auth version exposes `cachedTrustedClients`, wire it from `EPICENTER_TRUSTED_OAUTH_CLIENTS.map((client) => client.clientId)`. This avoids a DB read per authorize call for first-party flows.
- [ ] **1.7** Test: a trusted client skips consent on `/auth/oauth2/authorize`. A non-trusted client renders `/consent`.

`/auth/me` foundation:

- [ ] **1.8** Replace `POST /auth/oauth-session` with `GET /auth/me`. The handler verifies the access token with Better Auth's `oauthProviderResourceClient.verifyAccessToken`, including audience validation.
- [ ] **1.9** Return `{ user, encryptionKeys }` keyed off `payload.sub`. Do not return `set-auth-token`. Do not mint or expose a durable Better Auth session token.
- [ ] **1.10** Test: a token with the wrong audience returns 401 `invalid_oauth_token`. A token with the right audience and an existing user returns 200 with `user` and `encryptionKeys`.

Hosted page continuity:

- [ ] **1.11** Test: `/auth/sign-in/email` with an `oauth_query` body continues the OAuth flow. (Verifies the existing contract in `apps/api/src/auth-pages/scripts/sign-in.ts` does not regress.)
- [ ] **1.12** Test: already-signed-in `/sign-in?sig=...` redirects to `/auth/oauth2/authorize` with the params intact.

Verification:

- [ ] **1.13** `bun run --filter api typecheck`, `bun test apps/api/src/auth`.

PR 1 ships independently. It does not block PR 2 design work, and PR 2's design does not depend on PR 1 having shipped (only on PR 1 having shipped *before PR 2 lands*).

### PR 2: The atomic break

One PR. Commits are organized for review legibility, not for runtime safety. The codebase may not typecheck between commits inside this PR; it must typecheck at the end. Reviewers should review the PR as a whole.

Suggested commit order (review-friendly, not safety-required):

**Commit 1: Add `packages/oauth-client/`**

- [ ] **2.1.1** Scaffold the package with `oauth4webapi` as a dep. Export `createOAuthClient(config)` plus browser, extension, and Tauri hosted sign-in launchers. The package depends on `@epicenter/constants` only; not on `@epicenter/auth` or `BearerSession`.
- [ ] **2.1.2** Rename the launcher interface away from `signInWithSocial`. Suggested: `HostedSignInLauncher.begin(input)`. The package's public type names must not mention "social" or "provider" anywhere.
- [ ] **2.1.3** Tests: PKCE invariants, state mismatch rejection, token response parsing, cancelled launcher flow, and callback error mapping.

**Commit 2: Auth core surface change**

- [ ] **2.2.1** In `packages/auth/src/create-auth.ts`: delete `signIn`, `signUp`, `signInWithSocial`, `signInWithIdToken`, `signInWithSocialRedirect` (any that survive). Delete `SocialProvider`, `signInWithSocial` error variants that no longer have a producer.
- [ ] **2.2.2** Delete the bearer email/password hydration path: `pendingBearerToken`, `hydrateSignedOutSession`, `readTokenFromAuthCommandData`, and any helper that exists only to support in-app credential entry. Grep for `pendingBearerToken` and `Bearer.*email` to find stragglers.
- [ ] **2.2.3** Add `beginSignIn(input?: { returnTo?: string }): Promise<Result<undefined, AuthError>>` to `AuthClient`.
- [ ] **2.2.4** Implement in `createCookieAuth`: takes an injected `getSignInURL` (default builds `${baseURL}/sign-in?returnTo=...`). Calls `window.location.href = getSignInURL(...)` and returns a non-settling Promise. The package itself does not import browser globals; the navigator is injected by the Svelte wrapper or the platform file.
- [ ] **2.2.5** Implement in `createBearerAuth`: takes an injected `signInLauncher: HostedSignInLauncher`. Calls launcher, receives `{ accessToken, refreshToken, accessTokenExpiresIn }`, calls `GET /auth/me`, assembles `BearerSession`, persists it with `sessionStorage.set`, and returns `Result` with launcher or identity-load errors mapped to `AuthError.SignInFailed`.
- [ ] **2.2.6** Implement refresh in `auth.fetch`: attach the current access token, refresh through `/auth/oauth2/token` on 401, atomically persist the rotated refresh token and new access token before retrying once, then sign out on refresh failure.
- [ ] **2.2.7** Update `packages/auth-svelte/src/create-auth.svelte.ts` to mirror the new surface.
- [ ] **2.2.8** Update `packages/auth/src/index.ts` and `packages/auth-svelte/src/index.ts` exports.

**Commit 3: API skill and contracts**

- [ ] **2.3.1** Delete cases for the removed methods from `packages/auth/src/contract.test.ts` and `packages/auth/src/create-auth.test.ts`.
- [ ] **2.3.2** Add tests for `beginSignIn`: cookie path issues the right navigation URL; bearer path runs the launcher, loads `/auth/me`, and persists a complete `BearerSession`; bearer cancel does not change auth state; `/auth/me` 401 surfaces `AuthError.SignInFailed`.
- [ ] **2.3.3** Add tests for bearer refresh: first 401 calls `/auth/oauth2/token`, rotated refresh token is persisted before retry, second 401 signs out, refresh failure signs out.
- [ ] **2.3.4** Update `.agents/skills/auth/SKILL.md` to describe the hosted-sign-in model. Remove every reference to `signIn`, `signUp`, `signInWithSocial`, `AuthForm`, and `onSocialSignIn`.

**Commit 4: Cookie family apps**

For each of `dashboard`, `fuji`, `honeycrisp`, `zhongwen`:

- [ ] **2.4.1** Wire `getSignInURL` into the app's `platform/auth/cookie.ts` (the file may need to be created if the app still uses `src/lib/auth.ts`).
- [ ] **2.4.2** Replace every `<AuthForm>` usage with the inline button pattern from the Shared Svelte UI section, calling `auth.beginSignIn({ returnTo: window.location.href })`.
- [ ] **2.4.3** Remove the app's `onSocialSignIn` plumbing.
- [ ] **2.4.4** Confirm `bun run --filter <app> typecheck` passes.

**Commit 5: Bearer family apps**

For `opensidian`:

- [ ] **2.5.1** Create `apps/opensidian/src/lib/platform/auth/bearer.ts` if it does not exist yet. Wire `createOAuthClient` + `createBrowserHostedSignInLauncher` into `createBearerAuth`.
- [ ] **2.5.2** Add the `/auth/callback` SvelteKit route. The page reads `code` and `state` from query params and calls into the launcher's callback handler. Set `export const prerender = false` and remember `paths.base` if Opensidian is served under a base path.
- [ ] **2.5.3** Replace every `<AuthForm>` usage with the inline button pattern.

For `tab-manager`:

- [ ] **2.5.4** Wire `createOAuthClient` + `createExtensionHostedSignInLauncher` into `createBearerAuth`. The launcher uses `browser.identity.launchWebAuthFlow` with `https://<EXTID>.chromiumapp.org/`. Persist PKCE verifier + state to `chrome.storage.session` before calling `launchWebAuthFlow` (SW eviction safety).
- [ ] **2.5.5** Delete `getGoogleCredentials` and `GOOGLE_CLIENT_ID` from the extension. The launchWebAuthFlow path replaces it.
- [ ] **2.5.6** Replace `<AuthForm>` usage with the inline button pattern.

**Commit 6: Shared UI**

- [ ] **2.6.1** Update `packages/svelte-utils/src/account-popover/account-popover.svelte`: signed-out branch calls `auth.beginSignIn()` directly. Delete the `onSocialSignIn` prop.
- [ ] **2.6.2** Delete `packages/svelte-utils/src/auth-form/`. No "keep on disk" option; the directory leaves the repo.
- [ ] **2.6.3** Update any re-exports in `packages/svelte-utils/src/index.ts`.

**Commit 7: Straggler sweep**

- [ ] **2.7.1** Run the Straggler Searches. Each pattern returns matches only inside `apps/api/src/auth-pages/` (which still implements email/password and social internally) or inside historical specs.
- [ ] **2.7.2** Manual smoke: cookie sign-in in dashboard, bearer sign-in in opensidian, bearer sign-in in tab-manager. Each must reach signed-in state and establish a WebSocket sync connection.

If a smoke test fails, fix in this PR before merging. Do not split fixes into follow-ups.

### Rollback

PR 1: `git revert`. The trusted-client refactor and audience validation are useful on their own; reverting only matters if a real bug surfaces. Audience validation can be disabled in PR 2 if it conflicts with the launcher work; that is unlikely.

PR 2: `git revert`. There is no half-applied state to preserve because the old surface is gone in one PR. Reverting restores the old surface in full.

### What does not gate the break

The hosted page does not need new product features to ship this break:

```txt
Does NOT block:
  forgot-password UI
  email verification UI polish
  MFA scaffolding
  brand polish
  separate built-frontend for the hosted page

Does block:
  trusted-client skip_consent behavior
  /auth/me audience validation
  the inline button pattern in every consumer
  AuthForm deletion
```

Polish items become their own follow-up PRs. The break defines the new boundary; polish makes the boundary feel good.

## Straggler Searches

Before deletion is done, these should be empty outside historical specs:

```txt
rg "auth\.signIn\("
rg "auth\.signUp\("
rg "signInWithSocial"
rg "onSocialSignIn"
rg "AuthForm"
rg "pendingBearerToken"
rg "readTokenFromAuthCommandData"
rg "Continue with Google" apps packages
```

Allowed matches:

```txt
apps/api/src/auth-pages
historical specs
tests that intentionally cover hosted sign-in
```

## Edge Cases

### User Cancels Hosted Sign-In

Bearer launcher returns `Ok(null)` when the flow redirected away or was cancelled without a token. Auth state remains unchanged. UI clears pending state.

### OAuth Access Token Valid But User Missing

`/auth/me` returns `401 invalid_oauth_token`. The app remains signed out. This can happen if the user row is deleted after authorization, if the token is expired, or if the token is valid for the wrong audience.

### Cookie App Already Signed In

`/sign-in` sees a valid session. If signed OAuth params are present, it redirects to `/auth/oauth2/authorize`. If `callbackURL` is present and local, it redirects there. Otherwise it can render a signed-in confirmation.

### Bearer App Has Cached Session And Is Offline

The app can boot from the cached `BearerSession`. It can open local encrypted data because `user` and `encryptionKeys` are present. Network sync fails normally.

### OAuth Refresh Token Rotates

Bearer auth does not listen for `set-auth-token`. It refreshes through `/auth/oauth2/token` with `grant_type=refresh_token`. Better Auth rotates refresh tokens on success, so the client must persist the new refresh token before retrying the original request.

### Same User Gets New Encryption Keys

Current workspace behavior does not remount on same-user identity update. Existing encrypted stores keep the keyring they derived at attachment time. This spec does not change that. A future key-rotation spec should own reattachment or explicit activation policy.

## Decisions Log

- Keep cookie and bearer factories.
  Revisit when: all production apps can use the same credential owner without losing HttpOnly cookie benefits or adding public OAuth client burden.

- Use one static `EPICENTER_TRUSTED_OAUTH_CLIENTS` registry as the source of truth.
  Revisit when: Epicenter has a developer portal or organization-owned internal apps that need delegated trust management outside this monorepo.

- Trusted clients skip consent; all other clients require it.
  Revisit when: a third-party client argues for a one-tap experience and a product decision is made to grant the corresponding trust.

- Signed-out copy across apps is "Sign in to Epicenter."
  Revisit when: product evidence shows a different phrase converts better, or a separate surface (marketing CTA, onboarding) needs a different verb.

- `AuthClient.bearerToken` stays on the shared surface for now.
  Revisit when: sync moves behind `auth.openWebSocket` (see Next Clean Break). At that point the token never leaves the auth boundary and the public field becomes redundant.

- Replace `AuthForm` with an inline button per app, not a shared `HostedSignInPrompt` component.
  Revisit when: more than one shared signed-out surface emerges that genuinely needs the same prompt component. The current count is one (`AccountPopover`), which is not a count that justifies a package.

- No coexistence wave during migration.
  Revisit when: this codebase has production users whose sessions cannot be lost across a deploy. The current count is zero.

- `beginSignIn`'s Promise is for in-page error surfacing only.
  Revisit when: a transport emerges that completes in-page for all families (unlikely; redirect-based flows are the industry default).

- Keep `encryptionKeys` in auth identity.
  Revisit when: Epicenter introduces explicit lock/unlock, user-held keys, PIN unlock, or a memory-wipe threat model stronger than current workspace disposal.

- Keep `/auth/me` identity loading and OAuth refresh in auth core, not oauth-client.
  Revisit when: another package besides auth needs to manage Epicenter bearer sessions. The launcher should stay one-shot: start hosted sign-in, return tokens, stop.

- Keep hosted sign-in as Hono JSX for now.
  Revisit when: account recovery, MFA, and passkeys make the page large enough to justify a separate built frontend.

## Next Clean Break (Follow-up, NOT This Spec)

After this break lands, the next obvious follow-up is `auth.bearerToken` on the shared surface. Today sync reads it through:

```ts
attachSync(ydoc, {
  url,
  bearerToken: () => auth.bearerToken,
  awareness,
});
```

The honest move is to invert that: `auth` owns the transport, sync receives an `openWebSocket(url, baseProtocols?)` capability that already includes the bearer subprotocol for bearer auth or nothing for cookie auth. After that follow-up:

```ts
type AuthClient = {
  readonly state: AuthState;
  onStateChange(fn): () => void;
  beginSignIn(input?): Promise<Result<...>>;
  signOut(): Promise<Result<...>>;
  fetch(input, init?): Promise<Response>;
  openWebSocket(url, protocols?): WebSocket;
  [Symbol.dispose](): void;
};
```

The cookie-vs-bearer distinction shrinks to a transport-internal detail: `fetch` carries `Authorization` for bearer and doesn't for cookie; `openWebSocket` adds a subprotocol for bearer and doesn't for cookie. Nothing else differs at the shared surface.

This follow-up is one to two days of work. Do not conflate it with this spec. Ship this spec first; that break's clarity makes the next one easy.

The pattern across the auth specs has been: each clean break deletes one stale invariant that the prior break preserved. The `bearerToken` survival is the obvious next deletion. Naming it here stops it from re-appearing as an Open Question every spec.

## Open Questions

1. Does the installed Better Auth `oauthProvider` support full static trusted client metadata?
   - Recommendation: verify against the installed package before implementation. If yes, use the static registry directly. If no, project the registry into Better Auth's DB through server-only admin APIs and keep the registry as the source of truth.

2. Should hosted sign-in support passkeys in this same break?
   - Recommendation: no. This break moves credential entry to one place. Passkeys can be the first major feature that proves the new boundary works.

3. Should Tauri use loopback or deep link?
   - Recommendation: defer until Whispering needs auth. Deep links are supported by Tauri but carry per-OS setup and testing constraints. Loopback may be simpler for desktop OAuth, but needs its own launcher design. A third option worth considering when this question comes up: device flow (CLI-style), which uses `/auth/device/token` and returns a real Better Auth session token with no callback registration. The Tauri launcher choice is a product decision, not an auth-core decision.

4. Are there any other surfaces in apps that currently render account-related UI (sign-up landing page, marketing site, onboarding) that need the same hosted-sign-in treatment?
   - This spec covers the in-app auth surface. If there is a separate marketing or onboarding surface that today shows credential fields, name it here and bring it under the same boundary.

5. What is the right access-token lifetime, given that bearer apps now reconnect WebSocket sync on every expiry?
   - Recommendation: pick a value that balances credential-leak blast radius against reconnect frequency. Better Auth's `oauthProvider` defaults are a reasonable starting point. Document the chosen lifetime in `apps/api/src/auth/create-auth.ts` so it does not become an invisible knob. Revisit if sync metrics show reconnect storms.

6. Should `/auth/me` accept either an OAuth access token or a cookie session, or is it bearer-only?
   - Recommendation: bearer-only. Cookie apps already get `{ user, encryptionKeys }` through Better Auth's `useSession` + `customSession`. Making `/auth/me` accept cookies blurs the line the break is drawing. Cookie apps must not depend on `/auth/me`.

## Final Shape Test

A new app should answer exactly two auth questions:

```txt
1. Is this a cookie app or a bearer app?
2. What launcher or navigation function starts hosted Epicenter sign-in?
```

If the app has to answer "which providers do we show," "how does sign-up work," "where do password reset links go," or "how do we collect the second factor," the clean break failed.
