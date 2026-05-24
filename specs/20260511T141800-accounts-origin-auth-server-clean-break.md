# Accounts Origin Auth Server Clean Break

**Date**: 2026-05-11
**Status**: Superseded. Do not execute directly.
**Author**: AI-assisted
**Builds on**: `specs/20260511T105846-auth-oauth-everywhere-clean-break.md`
**Superseded by**: `specs/20260511T150000-final-oauth-auth-architecture.md`

## Supersession Note

This spec is retained as the account-origin design trail. Its core idea is now
part of `specs/20260511T150000-final-oauth-auth-architecture.md`, which is the
active source of truth for the final OAuth boundary.

## One-Sentence Thesis

`accounts.epicenter.so` signs users in and issues OAuth tokens; `api.epicenter.so` serves Epicenter resources that accept those tokens.

## Overview

This spec moves the Better Auth authorization server off the API origin and onto a dedicated accounts origin. The API becomes a protected resource server only. Apps, including the dashboard when it is hosted at `api.epicenter.so/dashboard`, use the same OAuth app credential model as every other Epicenter app.

The point is not another hostname for its own sake. The point is to delete the hybrid meaning of `https://api.epicenter.so/auth`, where the API origin currently acts as both the OAuth issuer and the OAuth resource.

## Motivation

### Current State

Better Auth is mounted under `/auth` on the API worker:

```ts
export const BASE_AUTH_CONFIG = {
	basePath: '/auth',
	emailAndPassword: { enabled: true },
	// ...
};
```

The production API host is also the resource server:

```ts
export const APPS = {
	API: { port: 8787, urls: ['https://api.epicenter.so'] },
	DASHBOARD: { port: 5178, urls: ['https://api.epicenter.so'] },
};
```

That gives the system two different meanings for the same origin:

```txt
Authorization server issuer:
  https://api.epicenter.so/auth

Protected resource audience:
  https://api.epicenter.so

Authorization endpoints:
  https://api.epicenter.so/auth/oauth2/authorize
  https://api.epicenter.so/auth/oauth2/token
  https://api.epicenter.so/auth/jwks

Resource endpoints:
  https://api.epicenter.so/workspaces/*
  https://api.epicenter.so/documents/*
  https://api.epicenter.so/ai/*
```

The metadata layout is standards-correct, but it is hard to explain:

```txt
/auth/.well-known/openid-configuration
/.well-known/oauth-authorization-server/auth
/.well-known/oauth-protected-resource
```

This creates problems:

1. The API hostname lies about its job. It is both the auth server and the resource server.
2. Better Auth cookies are scoped to the API host even though API resources should use OAuth access tokens.
3. Client helpers learn the old shortcut `issuer = apiBaseURL + "/auth"`.
4. The dashboard is tempting to special-case because it lives on the API host.
5. Route cleanup keeps becoming string-helper cleanup because the boundary is wrong.

### Desired State

The public contract separates accounts from resources:

```txt
Authorization server:
  https://accounts.epicenter.so

Protected resource:
  https://api.epicenter.so
```

App clients configure those two URLs directly:

```ts
const auth = createOAuthAppAuth({
	issuer: 'https://accounts.epicenter.so',
	resource: 'https://api.epicenter.so',
	clientId,
	redirectUri,
	storage,
});
```

The dashboard may still be deployed at `https://api.epicenter.so/dashboard`. That changes only where the SPA assets are served. It does not change the credential model:

```txt
dashboard SPA:
  hosted at https://api.epicenter.so/dashboard
  signs in through https://accounts.epicenter.so
  stores OAuth tokens as an app client
  calls https://api.epicenter.so with Authorization: Bearer
```

## Research Findings

### Better Auth OAuth Provider

Better Auth supports both shapes:

```txt
Single origin:
  baseURL: https://api.epicenter.so
  basePath: /auth
  issuer: https://api.epicenter.so/auth

Dedicated auth origin:
  baseURL: https://accounts.epicenter.so
  basePath: /
  issuer: https://accounts.epicenter.so
```

DeepWiki for `better-auth/better-auth` and the installed source agree on the important details:

1. `oauthProvider()` owns the authorization server.
2. `oauthProviderResourceClient().getActions().verifyAccessToken()` is the resource-server verifier.
3. The OAuth AS metadata path is root well-known, with an issuer suffix when the issuer has a path.
4. The OpenID configuration path lives under the issuer path.
5. Protected resource metadata belongs to the resource server.

The dedicated origin removes the issuer path from the equation:

```txt
accounts.epicenter.so/.well-known/openid-configuration
accounts.epicenter.so/.well-known/oauth-authorization-server
api.epicenter.so/.well-known/oauth-protected-resource
```

**Key finding**: Better Auth does not require the authorization server to live on the API origin. The dedicated origin is cleaner because the issuer and resource become different origins instead of different paths on one origin.

**Implication**: The clean break should move Better Auth to `accounts.epicenter.so` with `basePath: "/"`, not keep polishing `/auth` under the API host.

### Hono And Cloudflare Workers

Hono route order matters. Exact routes must be registered before catch-all routes when both can match. This matters on the accounts app because custom pages like `/sign-in` and well-known routes should run before the Better Auth catch-all.

Cloudflare Workers can route multiple custom domains to one Worker. That lets the code split by `Host` while sharing bindings, database access, Durable Object declarations, KV, and deployment machinery.

**Key finding**: The host split does not require two repos or two databases.

**Implication**: The first implementation should prefer one Worker with host dispatch unless Cloudflare constraints force a later split.

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Authorization server host | 2 coherence | `accounts.epicenter.so` | The host name describes the user-facing boundary: sign-in, consent, device code, and future account settings. |
| API resource host | 1 evidence | `api.epicenter.so` | Existing production route and constants already use this host. |
| Better Auth base path | 2 coherence | `/` on `accounts.epicenter.so` | A dedicated auth origin removes the need for `/auth` as a namespace. |
| Issuer | 2 coherence | `https://accounts.epicenter.so` | The issuer should be the authorization server origin. |
| Audience/resource | 2 coherence | `https://api.epicenter.so` | API resources are the protected resource. |
| OAuth provider `validAudiences` | 1 evidence | `[resourceBaseURL]`, not `[issuerBaseURL]` | Better Auth validates the requested `resource`. Moving `baseURL` to accounts means `validAudiences: [baseURL]` would reject API tokens. |
| Dashboard credential model | 2 coherence | OAuth app client, no cookie shortcut | Same-origin asset hosting must not reintroduce cookie-app versus OAuth-app branching. |
| Dashboard host | 3 taste | Keep `api.epicenter.so/dashboard` for now | It avoids changing product URLs while still using the new accounts issuer. |
| Better Auth cookies | 2 coherence | Host-only accounts cookies | API endpoints should not receive Better Auth login cookies. |
| Old issuer migration | 2 coherence | Force reauth instead of long-lived dual issuer support | Old OAuth sessions can be discarded. Preserving both issuers permanently keeps the hybrid model alive. |
| `/auth/me` resource endpoint | 2 coherence | Add `/me`, keep `/auth/me` only as a temporary alias | The rename is correct, but issuer migration and endpoint rename should not fail together. |
| Deployment shape | 3 taste | One Worker with host dispatch first | It gives a clean public contract without splitting the runtime package yet. |
| `oauth4webapi` usage | 1 evidence | Keep as OAuth client implementation detail | Better Auth does not prescribe a client library; standard OAuth code plus PKCE remains the right client boundary. |
| `skipStateCookieCheck` | 1 evidence | Revisit and preferably remove | It exists because cross-origin API sign-in fetches lost the state cookie. Accounts-hosted sign-in should make the cookie same-origin again. |

## Target Architecture

```txt
                         OAuth authorize, login, token, revoke
+----------------------------------------------------------------+
| accounts.epicenter.so                                          |
|                                                                |
| Better Auth basePath: /                                        |
|                                                                |
| /.well-known/openid-configuration                              |
| /.well-known/oauth-authorization-server                        |
| /oauth2/authorize                                              |
| /oauth2/token                                                  |
| /oauth2/revoke                                                 |
| /jwks                                                          |
| /sign-in                                                       |
| /consent                                                       |
| /device                                                        |
+----------------------------------------------------------------+
              |
              | issues access token with aud https://api.epicenter.so
              v
+----------------------------------------------------------------+
| api.epicenter.so                                               |
|                                                                |
| Resource server only                                           |
|                                                                |
| /.well-known/oauth-protected-resource                          |
| /me                                                            |
| /workspaces/*                                                  |
| /documents/*                                                   |
| /ai/*                                                          |
| /api/assets/*                                                  |
| /api/billing/*                                                 |
| /dashboard/*                                                   |
+----------------------------------------------------------------+
```

### Worker Shape

The first implementation can keep one Cloudflare Worker package:

```ts
const accountsApp = createAccountsApp();
const apiApp = createApiApp();

export default {
	async fetch(request, env, executionCtx) {
		const host = new URL(request.url).host;

		if (host === 'accounts.epicenter.so') {
			return accountsApp.fetch(request, env, executionCtx);
		}

		return apiApp.fetch(request, env, executionCtx);
	},
};
```

This split is a runtime boundary, not necessarily a package boundary. A later spec can move accounts into `apps/accounts` if the file tree keeps growing.

### Accounts App

The accounts app owns Better Auth and account pages:

```txt
apps/api/src/accounts-app.ts
  Hono app for accounts.epicenter.so
  request DB lifecycle
  createAuth({ baseURL: accountsOrigin, basePath: "/" })
  hosted pages
  Better Auth handler
  OAuth discovery
```

Route order matters:

```ts
accounts.get('/sign-in', renderSignIn);
accounts.get('/consent', renderConsent);
accounts.get('/device', renderDevice);
accounts.get('/.well-known/openid-configuration', openIdMetadata);
accounts.get('/.well-known/oauth-authorization-server', authServerMetadata);
accounts.on(['GET', 'POST'], '/*', betterAuthHandler);
```

### API App

The API app owns protected resources:

```txt
apps/api/src/api-app.ts
  Hono app for api.epicenter.so
  request DB lifecycle
  CORS
  single credential guard
  OAuth resource middleware
  dashboard static assets
  Durable Object routes
```

Resource verification becomes explicit:

```ts
verifyAccessToken(accessToken, {
	jwksUrl: 'https://accounts.epicenter.so/jwks',
	verifyOptions: {
		issuer: 'https://accounts.epicenter.so',
		audience: 'https://api.epicenter.so',
	},
});
```

The accounts auth factory must receive both URLs:

```ts
createAuth({
	db,
	env,
	issuerBaseURL: 'https://accounts.epicenter.so',
	resourceBaseURL: 'https://api.epicenter.so',
});
```

The Better Auth instance uses `issuerBaseURL` as `baseURL`, but `oauthProvider.validAudiences` uses `resourceBaseURL`:

```ts
betterAuth({
	baseURL: issuerBaseURL,
	basePath: '/',
	plugins: [
		oauthProvider({
			validAudiences: [resourceBaseURL],
		}),
	],
});
```

### Client Shape

The client package should stop deriving issuer from the API URL:

```ts
createBrowserOAuthLauncher({
	issuer: APP_URLS.ACCOUNTS,
	resource: APP_URLS.API,
	clientId,
	redirectUri,
	storage,
});
```

The convenience constructor should either disappear or be renamed so it cannot encode the old mental model:

```txt
Delete:
  createBrowserOAuthLauncherFromApi({ apiBaseURL })

Keep:
  createBrowserOAuthLauncher({ issuer, resource, ... })
  createExtensionOAuthLauncher({ issuer, resource, ... })
```

The auth core should also split issuer and resource. The resource URL owns identity and API transport. The issuer URL owns OAuth token endpoints:

```txt
Identity:
  GET ${resource}/me

Refresh:
  POST ${issuer}/oauth2/token
  resource=${resource}

Revoke:
  POST ${issuer}/oauth2/revoke
```

## Endpoint Contract

### Accounts Origin

| Endpoint | Owner | Purpose |
| --- | --- | --- |
| `/.well-known/openid-configuration` | Better Auth OAuth provider | OIDC discovery for issuer `https://accounts.epicenter.so`. |
| `/.well-known/oauth-authorization-server` | Better Auth OAuth provider | OAuth AS metadata for issuer `https://accounts.epicenter.so`. |
| `/oauth2/authorize` | Better Auth OAuth provider | Authorization code flow. |
| `/oauth2/token` | Better Auth OAuth provider | Code exchange and refresh. |
| `/oauth2/revoke` | Better Auth OAuth provider | Best-effort token revocation. |
| `/jwks` | Better Auth JWT plugin | JWT verification keys. |
| `/sign-in` | Epicenter hosted page | Email and social sign-in shell. |
| `/consent` | Epicenter hosted page | Consent page for non-trusted clients. |
| `/device` | Epicenter hosted page | CLI device code entry. |

### API Origin

| Endpoint | Owner | Purpose |
| --- | --- | --- |
| `/.well-known/oauth-protected-resource` | API resource server | Advertises resource metadata and authorization server. |
| `/me` | API resource server | Returns `{ user, encryptionKeys }` for a valid OAuth access token. |
| `/workspaces/*` | API resource server | Workspace sync and data APIs. |
| `/documents/*` | API resource server | Document sync and snapshots. |
| `/ai/*` | API resource server | AI routes. |
| `/api/assets/*` | API resource server | Authenticated asset upload and delete. |
| `/api/billing/*` | API resource server | Billing dashboard API. |
| `/dashboard/*` | Static assets | Dashboard SPA fallback. |

## Implementation Plan

Use Build, Prove, Remove ordering. The migration should never leave the deployed product with no sign-in path.

### Phase 1: Constants And Public URLs

- [ ] **1.1** Add `ACCOUNTS` to `APPS` with production URL `https://accounts.epicenter.so`.
- [ ] **1.2** Add `accounts.epicenter.so` to `apps/api/wrangler.jsonc` routes.
- [ ] **1.3** Add concrete local dev origins. Prefer `http://accounts.localhost:8787` and `http://api.localhost:8787` if Wrangler and browsers handle them cleanly. If not, document the required hosts-file entries and cookie behavior.
- [ ] **1.4** Add `APP_URLS.ACCOUNTS` consumers where auth issuer is currently derived as `${APP_URLS.API}/auth`.
- [ ] **1.5** Keep `APP_URLS.API` as the resource URL.
- [ ] **1.6** Add accounts origin to trusted origins where browser app requests need it.

### Phase 2: Split The Worker Into Accounts And API Apps

- [ ] **2.1** Extract shared per-request database and after-response middleware so both apps can reuse it without duplicating lifecycle code.
- [ ] **2.2** Create an accounts Hono app for `accounts.epicenter.so`.
- [ ] **2.3** Create an API Hono app for `api.epicenter.so`.
- [ ] **2.4** Add a top-level host dispatcher in `apps/api/src/app.ts`.
- [ ] **2.5** Keep Durable Object exports unchanged for Wrangler type generation.
- [ ] **2.6** Add tests for host dispatch so `accounts.epicenter.so` does not accidentally hit API routes.
- [ ] **2.7** Prove Cloudflare static assets do not bypass host dispatch for the accounts host. Add tests or Wrangler config for `accounts.epicenter.so/dashboard`, account-host static asset paths, and unknown account-host paths.

### Phase 3: Move Better Auth To The Accounts Origin

- [ ] **3.1** Change the accounts Better Auth config to `basePath: "/"`.
- [ ] **3.2** Set accounts `baseURL` from the request origin and production constant.
- [ ] **3.3** Move `/sign-in`, `/consent`, and `/device` to the accounts app.
- [ ] **3.4** Mount Better Auth OAuth endpoints at root on the accounts app.
- [ ] **3.5** Expose accounts discovery at `/.well-known/openid-configuration` and `/.well-known/oauth-authorization-server`.
- [ ] **3.6** Change `oauthProvider.validAudiences` to `[resourceBaseURL]`. Add a test proving `resource=https://api.epicenter.so` succeeds and `resource=https://accounts.epicenter.so` fails.
- [ ] **3.7** Change Better Auth cookies to host-only accounts cookies unless a test proves Better Auth needs cross-subdomain cookies.
- [ ] **3.8** Remove or re-justify `skipStateCookieCheck`. Default to removing it after accounts-hosted sign-in makes the state cookie same-origin.
- [ ] **3.9** Root-rewrite hosted page scripts. Replace `/auth/sign-in/*`, `/auth/oauth2/consent`, and `/auth/device/*` with root accounts paths.
- [ ] **3.10** Include Better Auth device endpoints in tests: `/device/code`, `/device/token`, `/device/approve`, and `/device/deny`.
- [ ] **3.11** Register the Google OAuth callback `https://accounts.epicenter.so/callback/google` before cutover. Keep the old API callback registered until the old API auth server is removed.
- [ ] **3.12** Update trusted origins and CORS so app origins can start OAuth and API requests without using Better Auth cookies on API routes.
- [ ] **3.13** Add tests for authorize, token exchange, refresh, revoke, Google callback behavior, device flow, and metadata on the accounts origin.

### Phase 4: Make The API A Resource Server Only

- [ ] **4.1** Change OAuth access-token verification to use issuer `https://accounts.epicenter.so`.
- [ ] **4.2** Change JWKS URL to `https://accounts.epicenter.so/jwks`.
- [ ] **4.3** Keep audience/resource as `https://api.epicenter.so`.
- [ ] **4.4** Add `/me` beside `/auth/me`. Keep `/auth/me` as a temporary alias until all clients move.
- [ ] **4.5** Expose `/.well-known/oauth-protected-resource` on the API origin with `authorization_servers: ["https://accounts.epicenter.so"]`.
- [ ] **4.6** Verify WebSocket auth failure still returns close code `4401`.
- [ ] **4.7** Remove Better Auth `getSession()` from API resource routes. It should remain only on accounts-hosted pages and Better Auth internals.
- [ ] **4.8** Add self-hosted URL tests so `accounts.example.com` and `api.example.com` do not accidentally inherit `.epicenter.so` cookie behavior.

### Phase 5: Update OAuth Clients

- [ ] **5.1** Delete or replace `createBrowserOAuthLauncherFromApi({ apiBaseURL })`.
- [ ] **5.2** Require app callers and auth core to pass both `issuer` and `resource`.
- [ ] **5.3** Update browser apps to use `issuer: APP_URLS.ACCOUNTS` and `resource: APP_URLS.API`.
- [ ] **5.4** Update tab-manager to use `issuer: APP_URLS.ACCOUNTS` and `resource: APP_URLS.API`.
- [ ] **5.5** Update `createOAuthAppAuth` to load identity from `${resource}/me`, refresh through `${issuer}/oauth2/token`, revoke through `${issuer}/oauth2/revoke`, and pass `resource` on token requests.
- [ ] **5.6** Update CLI machine auth and device flow to use accounts as issuer and API as resource.
- [ ] **5.7** Update tests to make issuer/resource separation visible in every OAuth fixture.

### Phase 6: Dashboard

- [ ] **6.1** Keep dashboard assets at `https://api.epicenter.so/dashboard` unless a separate product-domain decision changes this.
- [ ] **6.2** Keep dashboard as an OAuth app client. Do not add a same-origin cookie fast path.
- [ ] **6.3** Register dashboard redirect URI as `https://api.epicenter.so/dashboard/auth/callback`.
- [ ] **6.4** Ensure dashboard fetches API resources with `auth.fetch`, even though the API origin is same-origin for the dashboard path.
- [ ] **6.5** Replace dashboard `$platform/auth/cookie.ts` with the OAuth app auth path.
- [ ] **6.6** Remove dashboard dev proxy assumptions for `/auth`.
- [ ] **6.7** Prove dashboard billing calls use bearer auth with `credentials: "omit"`.
- [ ] **6.8** Smoke dashboard sign-in, refresh, sign-out, and billing API calls.

### Phase 7: Remove The Old API-Hosted Authorization Server

- [ ] **7.1** Stop issuing new tokens from `https://api.epicenter.so/auth`.
- [ ] **7.2** Delete the API-hosted Better Auth catch-all route.
- [ ] **7.3** Delete `/.well-known/oauth-authorization-server/auth` from the API origin.
- [ ] **7.4** Delete `/auth/.well-known/openid-configuration` from the API origin.
- [ ] **7.5** Delete `/auth/oauth-session`.
- [ ] **7.6** Delete `/auth/me` after all clients use `/me`.
- [ ] **7.7** Remove issuer helpers that exist only to support path-based issuer construction.
- [ ] **7.8** Run straggler searches:

```txt
rg -n "apiBaseURL|/auth/oauth2|/auth/jwks|/auth/me|oauth-session|oauth-authorization-server/auth|openid-configuration/auth"
rg -n "issuer:.*API|APP_URLS.API.*/auth|\\$\\{.*\\}/auth"
```

## Edge Cases

### Existing OAuth Sessions

Existing sessions issued by `https://api.epicenter.so/auth` will not refresh against `https://accounts.epicenter.so`. The clean break should force reauth instead of carrying a dual-issuer compatibility layer.

Expected behavior:

```txt
1. App boots with old OAuth session.
2. Refresh or protected request fails issuer validation.
3. Auth state enters reauth-required.
4. User signs in through accounts.epicenter.so.
5. App stores a new OAuth session.
```

### Dashboard On The API Host

The dashboard may live at `api.epicenter.so/dashboard` without becoming a cookie app. The dashboard is just another OAuth client. Same-origin asset hosting does not imply same-origin auth cookies.

Expected behavior:

```txt
1. Dashboard calls startSignIn().
2. Browser navigates to accounts.epicenter.so/oauth2/authorize.
3. User signs in on accounts.epicenter.so.
4. Accounts redirects to api.epicenter.so/dashboard/auth/callback.
5. Dashboard stores OAuth tokens and calls api.epicenter.so with Authorization: Bearer.
```

### CLI Device Flow

The CLI should display the accounts host for device verification:

```txt
https://accounts.epicenter.so/device
```

The device token endpoint also moves to the accounts host. The resource remains `https://api.epicenter.so`.

### Local Development

Local development needs two logical origins. Prefer host dispatch on one Worker port:

```txt
http://accounts.localhost:8787 -> accounts app
http://api.localhost:8787      -> API app
```

If Wrangler or the browser makes `*.localhost` unreliable, use hosts-file entries with explicit documentation. Do not rely on `http://accounts.epicenter.so` resolving locally unless the setup script creates that mapping.

The cookie helper must treat the chosen local accounts origin as local development, not as production. A non-localhost HTTP hostname plus `secure: true` would silently break sign-in.

### Self-Hosted Deployments

Self-hosted deployments need the same two-role model, but may choose different hostnames:

```txt
EPICENTER_ACCOUNTS_URL=https://accounts.example.com
EPICENTER_API_URL=https://api.example.com
```

Do not collapse the roles into one URL in the public client contract. A self-hosted deployment can point both records at one Worker or reverse proxy if it wants one runtime.

### Google OAuth Callback Cutover

The Google provider callback changes with the Better Auth base URL:

```txt
Old:
  https://api.epicenter.so/auth/callback/google

New:
  https://accounts.epicenter.so/callback/google
```

The new callback must be registered in Google before accounts sign-in is deployed. Keep the old callback registered until the old API-hosted auth server is removed.

## Open Questions

1. **Should the host be `accounts.epicenter.so` or `auth.epicenter.so`?**
   Recommendation: `accounts.epicenter.so`. It names the user boundary and leaves room for account settings, MFA, passkeys, and recovery pages.

2. **Should dashboard eventually move to `app.epicenter.so` or `dashboard.epicenter.so`?**
   Recommendation: defer. The auth design works whether dashboard is at `api.epicenter.so/dashboard` or another app host.

3. **Should accounts and API become separate Worker packages?**
   Recommendation: start as one Worker with host dispatch. Split only if deployment, ownership, or cold-start behavior makes the single Worker awkward.

4. **Should old issuer tokens be accepted temporarily by API resources?**
   Recommendation: no for app runtime. Force reauth. If a deployment needs a short cutover window, make it a dated temporary branch, not a permanent verifier shape.

5. **Should `/me` be named `/api/me` instead?**
   Recommendation: `/me`. The API already has top-level resource routes like `/workspaces/*` and `/documents/*`.

## Verification

Run targeted tests after each phase:

```txt
bun test apps/api/src/auth
bun test packages/oauth-client/src
bun test packages/auth/src
bun run --filter @epicenter/api typecheck
bun run --filter @epicenter/oauth-client typecheck
bun run --filter @epicenter/auth typecheck
```

Before deleting old paths, smoke these flows:

```txt
Browser app sign-in through accounts.epicenter.so
Dashboard sign-in at api.epicenter.so/dashboard
Tab-manager launchWebAuthFlow sign-in
CLI device flow
OAuth refresh after access-token expiry
OAuth revoke on sign-out
WebSocket auth rejection and reconnect
```

## Sources

- Better Auth OAuth Provider docs: `https://better-auth.com/docs/plugins/oauth-provider`
- Better Auth DeepWiki for `better-auth/better-auth`: OAuth provider can run on a dedicated auth origin, while resource APIs verify tokens with `oauthProviderResourceClient`.
- Hono DeepWiki for `honojs/hono`: route registration order matters, so exact routes should be registered before catch-all handlers.
- Local grounding:
  - `apps/api/src/auth/base-config.ts`
  - `apps/api/src/auth/create-auth.ts`
  - `apps/api/src/app.ts`
  - `packages/oauth-client/src/index.ts`
  - `packages/auth/src/create-oauth-app-auth.ts`
  - `packages/constants/src/apps.ts`
