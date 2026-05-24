# Drop AuthClient Social Methods: All Sign-In Through OAuth 2.1 Client

**Date**: 2026-05-04
**Status**: Superseded (2026-05-11)
**Superseded by**: `specs/20260511T105846-auth-oauth-everywhere-clean-break.md`
**Author**: AI-assisted (Claude)
**Branch**: TBD (single feature branch; ships as one cohesive change set)
**Depends on**: `specs/20260503T230000-auth-unified-client-two-factories.md` (Waves 1-6, implemented), `havana/specs/20260504T210000-better-auth-1.6.9-upgrade.md` (need 1.6.0+ for RFC 8252 loopback redirect URI matching)

## Reconciliation (2026-05-10)

The thesis of this spec only partially stands. Dropping `signInWithIdToken` and `signInWithSocialRedirect` was right, but the replacement should not be `auth.signInWithSocial({ provider })`. Provider choice, account creation, recovery, MFA, and future passkeys belong to hosted `/sign-in`. The active app API is:

```ts
await auth.beginSignIn({ returnTo });
```

Two load-bearing assumptions in the implementation plan below did not survive verification against `better-auth/better-auth`:

1. **P.1 hopes `bearer()` accepts oauthProvider JWT access tokens via `getSession`.** It does not. Better Auth's `bearer()` plugin extracts an opaque session token and looks it up in the session store; it rejects anything else. `oauthProvider` access tokens are short-lived JWTs intended for resource-server verification (`verifyAccessToken`, `oauthProviderResourceClient`), not durable session credentials. Configuring `jwt()` to use HMAC does not bridge this; the two token classes are semantically distinct, and conflating them creates a footgun where any access token that passes signature is treated as a session credential.
2. **Three packages (`oauth-client-spa`, `-extension`, `-tauri`) is one too many.** The transport differences are small; one `packages/oauth-client/` core with named per-platform launchers tree-shakes correctly and avoids three publish surfaces.

The later credential-family spec tried to solve this by adding `/auth/oauth-session`, an exchange endpoint that minted a durable Better Auth session token from an OAuth access token. That bridge has since been rejected. The active spec is stricter: every app is an OAuth client, `/auth/oauth-session` becomes `GET /auth/me`, and protected resources verify OAuth access tokens directly with Better Auth's resource-server helper.

The per-app surface map, the wave structure, and the edge-case discussion below are historical reference only. Do not execute the implementation plan in this file.

---

(Original spec content follows.)

## One-Sentence Test

`AuthClient` has no provider-specific social methods; all social sign-in routes through the API-hosted page via OAuth 2.1 PKCE client (powered by the existing `@better-auth/oauth-provider` plugin); both `signInWithSocialRedirect` and `signInWithIdToken` disappear.

If any app still calls `signInWithSocialRedirect` or `signInWithIdToken`, or `AuthClient` still exposes either, the migration is not done.
If `AuthClient` knows the name of any specific provider (Google, Apple, GitHub, etc.), the migration is not done.

## Overview

This spec went through several iterations. Earlier drafts:

1. **First draft**: Drop `signInWithSocialRedirect`; keep `signInWithIdToken` as the OIDC fast path. Each app mints a Google ID token via GIS popup (~1s in-page sign-in) and calls `signInWithIdToken`.
2. **Refined draft**: Same shape, with type derivation from Better Auth, sub-export from `@epicenter/svelte`, atomic-commit pre-work wave, typed error for GIS-blocked browsers.
3. **This version (bold simplification)**: Drop BOTH legacy social methods. Adopt a single universal path via OAuth 2.1 PKCE client through the existing `@better-auth/oauth-provider` plugin (already deployed for the CLI). All apps, all providers, all environments converge on one method: `auth.signInWithSocial({ provider })`.

The work ships as ONE cohesive change set: build the OAuth 2.1 client adapters, register apps as oauthProvider clients, migrate per-app, delete the old methods. See the "Why drop the OIDC fast path" section for the full rationale behind the bold simplification.

## Why drop the OIDC fast path

This is the load-bearing decision. Here's the honest reasoning.

### The fast path's appeal

`signInWithIdToken` via GIS gives browser SPAs a ~1-second Google sign-in flow:

```
Click "Continue with Google" → small in-page modal → click account → signed in (~1s)
```

It also enables GIS One Tap for return users:

```
Open app → "Continue as Braden" prompt appears → click (or auto-select) → signed in (~0.5s)
```

These are real UX wins, especially One Tap.

### The fast path's costs

| Cost | Detail |
|---|---|
| **Per-app GIS helper** | Each browser SPA needs a `getGoogleIdToken()` helper. Earlier draft proposed sub-export from `@epicenter/svelte`. Adds package surface, build complexity. |
| **Browser quirks** | Brave's default privacy settings block the GIS iframe. Filter lists may block `accounts.google.com/gsi/client`. Need a typed error (`SocialSignInUnavailable`), failure-mode UI, fallback path. |
| **OIDC vs non-OIDC type split** | `OIDCProvider` union narrowed from Better Auth's full `SocialProvider`. Two separate methods (`signInWithIdToken` for Google/Apple/Microsoft; `signInWithSocial` for GitHub/Discord). Two flows for users to understand. |
| **Apple/Microsoft scaling cost** | Each new OIDC provider you add comes with its own SDK (Sign in with Apple JS, MSAL.js for Microsoft). Each ~30 LOC of helper code, plus its own browser-quirk surface. |
| **Doesn't help non-browser environments** | Tauri webviews can't run GIS (Google won't accept `tauri://` origins). Chrome extension service workers have no DOM. For these, the "fast path" is `chrome.identity.launchWebAuthFlow` with `response_type=id_token`, which is ~2-3s, not ~1s. So the fast path's ~1s win is concentrated in browser SPAs only. |

### Cost-benefit analysis for Epicenter

For Epicenter's positioning (local-first; users sign in once and stay signed in for months; technical audience):

- **First-time sign-in**: ~3s slower (4s vs 1s). Felt once per device.
- **Re-authentication after session expiry** (every ~30 days for OAuth refresh tokens): ~3s slower. Felt monthly per user.
- **One Tap**: not available. Return users see the API page instead of the in-app prompt.
- **Cumulative time loss**: ~3 seconds × ~12 sign-ins per year per user = ~36 seconds per year per user.

In exchange:

- **One social method on `AuthClient`** (`signInWithSocial`) instead of two (`signInWithIdToken` + `signInWithSocialRedirect`). Surface shrinks by half.
- **One path across all four environments**: cookie SPA, bearer SPA, Chrome extension, Tauri. No environment-specific helpers.
- **All providers (33+) supported uniformly**. Adding Apple, Microsoft, Discord, Slack, GitLab, etc. is server config + an API page button. Zero client changes.
- **No per-app GIS helpers**. No `@epicenter/svelte/google-sign-in` package. No GIS browser quirks. No `SocialSignInUnavailable` failure mode.
- **No OIDC vs non-OIDC type narrowing**. Provider type is just Better Auth's `SocialProvider`.
- **Centralized sign-in branding** on `api.epicenter.so`. Same Epicenter sign-in page across every app.
- **Reuses existing infrastructure**. The `@better-auth/oauth-provider` plugin is already deployed and powers the CLI's PKCE login.
- **Spec ~40% shorter**. Implementation simpler.

### Industry context

Most apps you've signed into use full redirect, not in-page popup. Examples: GitHub, Vercel, Linear, Cursor, Stripe, Slack, Cloudflare. Users have ~15 years of OAuth-redirect muscle memory and don't notice or mind it. The popup form (GIS button) is a small UX improvement; the One Tap auto-prompt is the only genuinely premium case, and it's a niche category most dev tools skip.

For native apps (Tauri, mobile, desktop), the OAuth-redirect-via-system-browser pattern is the **industry standard** (RFC 8252). Every CLI you've used does this: `gh auth login`, `gcloud auth login`, `aws configure sso`. Users know the pattern.

### Verdict

The fast path is nice-to-have, not load-bearing. The complexity it adds compounds with each new OIDC provider; the simplification from dropping it compounds with every new provider, environment, or auth flow. Drop it.

## Why this is its own spec

The unified-client spec's thesis is *"`AuthClient` is the credential's lifecycle handle on this runtime; `createCookieAuth` and `createBearerAuth` produce the same interface, differing only in how they acquire, persist, and present the credential."* That thesis stays true under this spec: AuthClient still owns identity, transport, and lifecycle.

This spec's thesis is different: *"AuthClient holds zero provider-specific knowledge; all social sign-in is delegated to the API-hosted page via OAuth 2.1 PKCE client, reusing the existing oauthProvider infrastructure."* Different verbs, different scope (auth-package + per-app + new client adapter packages), different layer.

Per the cohesive-clean-breaks skill: when work has its own one-sentence thesis, it deserves its own spec.

## Motivation

### Current state

```ts
type AuthClient = {
  // ...
  signInWithIdToken(input: {
    provider: string; idToken: string; nonce: string;
  }): Promise<Result<undefined, AuthError>>;
  signInWithSocialRedirect(input: {
    provider: string; callbackURL: string;
  }): Promise<Result<undefined, AuthError>>;
  // ...
};
```

Two methods, both proxying to Better Auth's `signIn.social()` with different args.

- `signInWithSocialRedirect` is structurally broken for cross-origin bearer apps (the cookie set on the API origin can't reach the SPA's session storage).
- `signInWithIdToken` works for OIDC providers via GIS but only for browser SPAs; extensions need custom workarounds; Tauri can't use it at all.
- Neither supports non-OIDC providers (GitHub, Discord, Slack) for bearer apps. That's the gap.

Browser apps currently call `signInWithSocialRedirect`:

```
apps/dashboard
apps/fuji
apps/honeycrisp
apps/opensidian
apps/zhongwen
```

`apps/tab-manager` already uses `signInWithIdToken` (extension context cannot use redirect).

### Desired state

```ts
type AuthClient = {
  signIn(input: { email: string; password: string }): Promise<Result<undefined, AuthError>>;
  signUp(input: { email: string; password: string; name: string }): Promise<Result<undefined, AuthError>>;
  signInWithSocial(input: { provider: SocialProvider }): Promise<Result<undefined, AuthError>>;
  signOut(): Promise<Result<undefined, AuthError>>;
  // signInWithSocialRedirect: gone
  // signInWithIdToken: gone
  // (Future) signInWithMagicLink: separate spec via Better Auth's magicLink() plugin
};
```

`SocialProvider` derives from Better Auth's full union: `NonNullable<Parameters<typeof betterAuthClient.signIn.social>[0]['provider']>`. No narrowing. All ~33 providers Better Auth supports become available; whichever ones the API has configured server-side will actually work at runtime.

Each app:
1. Imports the appropriate OAuth 2.1 client adapter (`@epicenter/oauth-client-spa` for cross-origin browser SPAs; `@epicenter/oauth-client-extension` for Chrome extensions; `@epicenter/oauth-client-tauri` for Tauri). Cookie SPAs don't need an import; their `signInWithSocial` implementation just navigates to the API page.
2. Replaces existing sign-in handlers with `await auth.signInWithSocial({ provider: 'google' })` (or any other provider).
3. Drops `callbackURL` flows, GIS helpers, `getGoogleIdToken` imports, redirect-flow listeners.

`SocialSignInFailed` stays. Its only producer is now `signInWithSocial`. Other social-related error variants (e.g., `SocialSignInUnavailable` from earlier drafts) are not introduced.

## Per-app surface map

| App | Environment | Current sign-in | After this spec | OAuth 2.1 client transport |
|---|---|---|---|---|
| dashboard | Browser SPA (cookie) | `signInWithSocialRedirect` | `signInWithSocial` | Full-page redirect to `api.epicenter.so/auth/oauth2/authorize`; cookie set on `.epicenter.so`; redirect back to dashboard |
| fuji | Browser SPA (cookie) | `signInWithSocialRedirect` | `signInWithSocial` | Same as dashboard |
| honeycrisp | Browser SPA (cookie) | `signInWithSocialRedirect` | `signInWithSocial` | Same as dashboard |
| opensidian | Browser SPA (bearer, cross-origin) | `signInWithSocialRedirect` | `signInWithSocial` | Full-page redirect to API authorize URL; PKCE; redirect to opensidian.com/callback; client exchanges code for access token |
| zhongwen | Browser SPA (cookie) | `signInWithSocialRedirect` | `signInWithSocial` | Same as dashboard |
| tab-manager | Chrome extension MV3 (bearer) | `signInWithIdToken` (id_token via launchWebAuthFlow) | `signInWithSocial` | `chrome.identity.launchWebAuthFlow` to API authorize URL; redirect to `<EXTID>.chromiumapp.org/`; PKCE; client exchanges code |
| whispering | Tauri | none | (deferred until whispering needs auth) | System browser via `tauri-plugin-opener` to API authorize URL; localhost loopback HTTP server captures redirect; PKCE; exchange |

The single `auth.signInWithSocial({ provider })` call has the same shape across every app. The internal transport varies by environment; that's the adapter's responsibility, hidden below `AuthClient`'s surface.

## Design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Surface shape | One method per sign-in flow shape; ZERO provider-specific methods on AuthClient | Mirrors Better Auth's idiom (`authClient.signIn.social`, `signIn.email`, future `signIn.magicLink`). Provider is config + a string; never a method name. Adding a provider is a config change. |
| Social sign-in transport | OAuth 2.1 PKCE client via the existing `@better-auth/oauth-provider` plugin (already deployed; powers the CLI today) | Reuses Better Auth primitives end-to-end. Zero new server endpoints. The CLI proves the server side works. Industry-standard pattern (RFC 6749 + PKCE). |
| `provider` type | `NonNullable<Parameters<typeof betterAuthClient.signIn.social>[0]['provider']>`. No narrowing. | Single source of truth: derives from Better Auth. Type widens automatically when Better Auth adds providers. Whichever providers are configured server-side will actually work. |
| Browser SPA cookie transport | Full-page redirect to `api.epicenter.so/auth/oauth2/authorize`; API completes OAuth and sets a cookie on `.epicenter.so`; redirects back to the SPA; SPA renders signed-in state from the cookie. | Cookie SPAs already trust cookies on `.epicenter.so` via crossSubDomainCookies. The API's `oauthProvider` flow can either set a cookie (for cookie SPAs) or issue an OAuth code (for bearer SPAs); cookie SPAs use the cookie path. Internally `signInWithSocial` for cookie SPAs is `window.location.href = '...'`. |
| Bearer SPA transport | Full-page redirect (NOT popup) to API authorize URL with `redirect_uri=<spa-origin>/callback`; PKCE; SPA's callback page exchanges code for access token; stores in localStorage. | Standard OAuth 2.1 PKCE for SPAs. Popup adds complexity (postMessage origin checks, popup blockers, opener relationship) for marginal UX. |
| Chrome extension transport | `chrome.identity.launchWebAuthFlow` to API authorize URL with `redirect_uri=https://<EXTID>.chromiumapp.org/`; PKCE; extension extracts code from the response URL and exchanges for token. | Canonical pattern for MV3 extensions. Must call from the background service worker (popup can be killed mid-flow). Persist `code_verifier` to `chrome.storage.session` before launch (SW eviction risk). |
| Tauri transport | Localhost loopback HTTP server (NOT custom-scheme deep link) via `tauri-plugin-oauth` (FabianLars); PKCE; exchange via `oauth2` Rust crate. | Loopback sidesteps every macOS/Linux deep-link footgun (Info.plist, .desktop files, registry, single-instance plugin, first-launch chicken-and-egg). What `gh auth login`, Google Cloud SDK, and most desktop OAuth clients ship. |
| OAuth 2.1 client library (browser/extension) | [`oauth4webapi`](https://github.com/panva/oauth4webapi) | Zero deps, web-crypto based, works in service workers, handles PKCE + state correctly. Don't hand-roll. |
| OAuth 2.1 client library (Tauri) | [`oauth2`](https://docs.rs/oauth2/) Rust crate | Battle-tested, PKCE built in. Used by `gh`, Google Cloud SDK, and many others. |
| Adapter package layout | `@epicenter/oauth-client` (shared core) + `@epicenter/oauth-client-spa`, `-extension`, `-tauri` (per-environment transports) | Each app imports only its environment's adapter. Tree-shakeable. Tauri adapter doesn't drag Chrome extension code into the Tauri build. |
| Wave order | Pre-work (build adapters + register apps + verify bearer/JWT compat) → per-app migration → final deletion of old methods | Apps depend on the adapters; adapters depend on the bearer/JWT compat verification; old methods can only be deleted after every app migrates. |

### Why per-flow framing (not per-provider)

Three competing surface shapes were considered. The rationale for the chosen shape:

```
Per-provider methods (rejected)          Per-flow methods (chosen)              Per-flow with OIDC fast path (rejected; earlier draft)
auth.signInWithGoogle({...})             auth.signInWithSocial({                 auth.signInWithIdToken({         (OIDC fast path)
auth.signInWithGitHub({...})               provider: 'google' \| 'github' \| ...   provider: 'google' \| 'apple',
auth.signInWithApple({...})              })                                         idToken: { ... }
auth.signInWithMicrosoft({...})                                                  })
                                                                                  auth.signInWithSocial({...})    (universal fallback)
N methods, grows with providers          1 method covers all providers
                                                                                  2 methods, fast/slow duality
```

- **Per-provider** doesn't match Better Auth's idiom; surface grows linearly with providers; conflates provider with flow.
- **Per-flow** (chosen) mirrors Better Auth (`signIn.social`, `signIn.email`, future `signIn.magicLink`); each method covers all providers in its flow shape.
- **Per-flow with OIDC fast path** (the earlier draft) preserved a ~1-second Google sign-in advantage for browser SPAs at the cost of a second method, per-app GIS helpers, browser-quirk handling, type-narrowing complexity. Rejected for Epicenter because the UX win is small (~36 seconds/year/user) and bounded to browser SPAs only; the complexity is permanent.

### Type derivation pattern

```ts
// Single source of truth: Better Auth's signIn.social parameter type
import { createAuthClient } from 'better-auth/client';
const betterAuthClient = createAuthClient({ /* ... */ });

type SocialSignInArgs = NonNullable<Parameters<typeof betterAuthClient.signIn.social>[0]>;

// Provider is the full Better Auth union; no narrowing
export type SocialProvider = NonNullable<SocialSignInArgs['provider']>;

// AuthClient surface
signInWithSocial(input: { provider: SocialProvider }): Promise<Result<undefined, AuthError>>;
```

If Better Auth ever adds a provider, the union widens automatically. If Better Auth removes one (rare), TypeScript catches the call sites. Single source of truth.

## Implementation plan

This spec ships as ONE feature branch with three sequential waves. The pre-work wave is a single atomic commit; per-app waves can ship independently after; final deletion is one PR after all apps migrate.

### Pre-work wave: OAuth 2.1 client infrastructure (one PR; one atomic commit)

- [ ] **P.1** Verify `bearer()` plugin validates oauthProvider-issued JWT access tokens via `getSession()`. Write a single integration test: issue a token via `oauthProvider`, send it as `Authorization: Bearer ...`, confirm `auth.api.getSession({ headers })` returns the user. **If this fails**, configure `jwt()` to use HMAC (matching `bearer()`'s expectation) OR add a small resource-server middleware that validates oauthProvider tokens and constructs a session for `getSession()` to read. Per the research, fix is "<1 day if needed."
- [ ] **P.2** Create `packages/oauth-client/` with the shared core. Exports `OAuthClientConfig`, `createOAuthClient(config)`, error types. Uses [`oauth4webapi`](https://github.com/panva/oauth4webapi) for PKCE and metadata discovery.
- [ ] **P.3** Create `packages/oauth-client-spa/` for cross-origin browser SPAs. Exports `signInWithSocial({ provider, redirectUri })` that does full-page redirect to authorize URL with PKCE; `handleCallback({ code, state })` for the post-redirect page that exchanges code for token. `code_verifier` and `state` in `sessionStorage`.
- [ ] **P.4** Create `packages/oauth-client-extension/` for Chrome extension MV3. Exports `signInWithSocial({ provider })` that calls `chrome.identity.launchWebAuthFlow` and exchanges the returned code. `code_verifier` in `chrome.storage.session` (survives SW eviction).
- [ ] **P.5** Register apps as `oauthProvider` clients server-side. Add `EPICENTER_DASHBOARD_OAUTH_CLIENT_ID`, `EPICENTER_OPENSIDIAN_OAUTH_CLIENT_ID`, `EPICENTER_TAB_MANAGER_OAUTH_CLIENT_ID` to `packages/constants/src/oauth.ts`. Each app's `redirect_uri` is registered as an allowed callback. (Cookie SPAs on `.epicenter.so` subdomains may not need separate client registrations if the API's existing direct sign-in already serves them; verify.)
- [ ] **P.6** Add `signInWithSocial` to `AuthClient` in `packages/auth/src/create-auth.ts`. Implementation differs per factory:
  - `createCookieAuth`: `signInWithSocial({ provider }) → window.location.href = baseURL + '/sign-in?provider=' + provider + '&callbackURL=' + currentURL`. Returns void; navigation happens.
  - `createBearerAuth`: takes an injected OAuth client adapter (so the auth package doesn't depend on the per-environment packages); calls `adapter.signInWithSocial({ provider })`; on success, applies the resulting bearer token via `saveSession`.
- [ ] **P.7** Update `packages/auth/src/create-auth.test.ts` and any mocks.
- [ ] **P.8** Verification: `bun run --filter @epicenter/auth typecheck`, `bun run --filter @epicenter/oauth-client typecheck`, `bun run --filter @epicenter/oauth-client-spa typecheck`, `bun run --filter @epicenter/oauth-client-extension typecheck`, `bun test packages/auth/src/create-auth.test.ts`.

### Per-app waves (any order after P; each ships independently)

For each of `apps/{dashboard, fuji, honeycrisp, opensidian, zhongwen, tab-manager}`:

- [ ] **A.1** For bearer apps: wire the OAuth client adapter into `createBearerAuth`. For cookie SPAs: nothing extra; AuthClient handles the navigation.
- [ ] **A.2** Replace each sign-in button handler with `await auth.signInWithSocial({ provider: 'google' })` (or whichever provider).
- [ ] **A.3** Drop `getGoogleIdToken` imports (if any from earlier drafts), `callbackURL` flows, redirect-flow listeners, GIS-related code, `chrome.identity.launchWebAuthFlow` with `response_type=id_token` (tab-manager).
- [ ] **A.4** For bearer SPAs (opensidian): add a `/auth/callback` route that calls the OAuth client adapter's `handleCallback`.
- [ ] **A.5** Add a sign-in smoke test (manual or e2e).
- [ ] **A.6** Per-app verification: `bun run --filter <app> typecheck` and a manual sign-in pass.

### Final wave (after all per-app PRs land)

- [ ] **F.1** Drop `signInWithSocialRedirect` from `AuthClient` in `packages/auth/src/create-auth.ts`.
- [ ] **F.2** Drop `signInWithIdToken` from `AuthClient`.
- [ ] **F.3** Drop any remaining GIS helpers (e.g., `@epicenter/svelte/google-sign-in` if it was created in a prior iteration).
- [ ] **F.4** Confirm `SocialSignInFailed` stays. Its only producer is now `signInWithSocial`. Drop `SocialSignInUnavailable` (no GIS = no GIS-blocked failure mode).
- [ ] **F.5** Update `.claude/skills/auth/SKILL.md` to describe `signInWithSocial` as the only social path; update the "Common Pitfalls" section.
- [ ] **F.6** Grep `signInWithSocialRedirect`, `signInWithIdToken`, `getGoogleIdToken` across `apps/` and `packages/`. Should match only this spec and the historical unified-client spec.

## Edge cases

### bearer + JWT signature compat (the integration test risk)

Better Auth's `bearer()` plugin's `before` hook intercepts `Authorization: Bearer <token>` and converts it into a session that `auth.api.getSession({ headers })` resolves transparently. Per research: `bearer()`'s signature path uses HMAC with the app secret. The `oauthProvider` plugin issues JWT-format access tokens signed by the `jwt()` plugin (defaults to EdDSA/RS256 unless configured).

**If they're incompatible out of the box** (asymmetric vs HMAC), `getSession()` will reject oauthProvider tokens. Mitigation: either configure `jwt()` to use HMAC (matching `bearer()`'s expectation), or add a small resource-server middleware that validates oauthProvider tokens and synthesizes a session for `getSession()` downstream.

**P.1 in the pre-work wave verifies this with one integration test.** If it fails, the fix is <1 day per the research grilling. Block the rest of the spec on this verification.

### OAuth 2.1 redirect_uri registration

Each app's `redirect_uri` must be registered as an allowed callback for the app's `oauthProvider` client. Mismatch → 400 from the OAuth authorize endpoint.

- Cookie SPAs: redirect_uri is the SPA's URL (e.g., `https://dashboard.epicenter.so/auth/callback`).
- Bearer SPAs: redirect_uri is the SPA's URL on its origin (e.g., `https://opensidian.com/auth/callback`).
- Chrome extension: redirect_uri is `https://<EXTID>.chromiumapp.org/`. **The extension ID must be pinned** (via manifest `key`) so dev/prod use the same ID. See `docs/articles/pin-your-chrome-extension-id-or-oauth-breaks.md`.
- Tauri: redirect_uri is `http://127.0.0.1:<RANDOMPORT>/callback`. Better Auth 1.6.0+ matches loopback URIs port-agnostically (RFC 8252). Register `http://127.0.0.1/callback` (port-flexible) once.

### Refresh tokens

`oauthProvider` issues refresh tokens (default 30-day expiry). Each client app calls `/auth/oauth2/token` with `grant_type=refresh_token` to get a new access token before expiry. The bearer plugin's `set-auth-token` rotation header path does NOT apply (different lifecycle).

Each OAuth client adapter handles refresh internally. Apps don't see refresh token logic.

### State parameter / CSRF protection

Standard OAuth 2.1: client generates random `state`, includes it in authorize URL, server returns it in callback, client verifies match. `oauth4webapi` and `oauth2` Rust crate handle this automatically.

For SPAs: store `state` in `sessionStorage` (survives reload but not new tabs).
For extensions: store `state` in `chrome.storage.session` (survives SW restart but not browser close).
For Tauri: `state` lives in the Rust command's local variable for the duration of the flow.

### Service worker eviction in extensions

Chrome may evict the background SW between the `launchWebAuthFlow` call and the callback. Persist `code_verifier` and `state` to `chrome.storage.session` BEFORE calling `launchWebAuthFlow`. The extension adapter handles this internally.

### opensidian bearer token storage in localStorage

Same XSS persistence trade-off as today. SPAs without a backend have no choice. `oauth4webapi` handles refresh; CSP and dependency hygiene are the mitigations. If we ever care, the fix is a thin BFF on opensidian.com that holds the refresh token server-side.

### OAuth callback page flash

Bearer SPAs see a brief callback page render between the API redirect and the home redirect. Mitigation: callback page is minimal (or transparent) and immediately calls `handleCallback`, then `window.location.replace(homePage)`.

## Provider scope

After this spec ships, all 33+ providers Better Auth supports become available via `signInWithSocial({ provider })`. Adding a provider is purely server-side:

```ts
// apps/api/src/auth/create-auth.ts
socialProviders: {
  google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET },        // active
  github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET },        // launch set
  apple: { clientId: env.APPLE_CLIENT_ID, clientSecret: env.APPLE_CLIENT_SECRET, ... },      // launch set
  // discord: { ... },   // when asked
  // slack: { ... },     // when asked
  // ... etc.
},
```

Plus an entry on the API-hosted sign-in page for each provider button.

**Launch set** (per the cross-app research across 20 productivity tools):
- Google (active)
- GitHub
- Apple
- Magic link (separate spec; uses Better Auth's `magicLink()` plugin)

**Skip at launch** (add when asked):
- Microsoft (rare as first-party social; usually via SAML at enterprise tier)
- Discord, Slack, GitLab, Bitbucket, Facebook, X, LinkedIn (niche outside specific verticals)
- Passkey (early adoption; `passkey()` plugin ready when needed)
- SAML / SSO (out of scope; add when an enterprise deal needs it)

## Future direction

Three additions are pre-named so future specs slot in without churn:

1. **Magic link** (`signInWithMagicLink({ email, callbackURL? })`). Better Auth's `magicLink()` plugin. Modern passwordless trend (Linear, Claude, Reflect went password-free). Separate spec. Adds ONE method to AuthClient (per-flow framing); works uniformly across all apps because the magic link click hits the API directly and either sets a cookie (cookie SPAs) or routes through the OAuth 2.1 callback (bearer SPAs).
2. **Apple OIDC**. Just a `socialProviders.apple` server config block + an Apple button on the API-hosted sign-in page. ZERO client changes. (Without the OIDC fast path, no Sign in with Apple JS SDK is needed.)
3. **Passkey** (`signInWithPasskey()`). Better Auth's `passkey()` plugin. Defer to 2026 when adoption catches up. Adds ONE method to AuthClient.

Notably absent: any "OIDC fast path" or "GIS One Tap" item. Those were considered and rejected in the bold simplification (see "Why drop the OIDC fast path"). If product needs ever surface a strong case for One Tap, signInWithIdToken can be RE-ADDED to AuthClient as a parallel method without breaking the OAuth 2.1 client pattern; until then, keep the surface minimal.

## Alternatives considered

The path here was not the only option. Briefly, what was rejected and why:

- **Per-provider methods** (`signInWithGoogle`, `signInWithGitHub`, etc.). Doesn't match Better Auth's idiom. AuthClient surface grows linearly with providers. Conflates provider with flow.
- **Drop AuthClient sign-in methods entirely**, expose Better Auth client directly. Bearer token would leak; the wrapper exists specifically to keep transport details below the public surface. Result-type abstraction would also leak, requiring per-app re-implementation.
- **Keep the OIDC fast path (`signInWithIdToken` via GIS)** alongside `signInWithSocial`. The shape that the previous draft of this spec proposed. Rejected for the bold simplification because the cumulative complexity (GIS helper, browser quirks, OIDC type narrowing, per-OIDC-provider scaling cost, two flows for users to understand) outweighs the bounded UX win (~36s/year/user; only on browser SPAs; only when re-authenticating). For Epicenter's positioning (local-first; users sign in once and stay signed in for months), the trade-off is unfavorable. **If product needs ever surface a strong case for One Tap, this can be re-added later as a parallel method.**
- **Build a custom unified handoff plugin from scratch**. An earlier draft considered an `@epicenter/auth-handoff` server plugin + per-environment client adapters. The grilling pass surfaced the better answer: the existing `@better-auth/oauth-provider` already implements OAuth 2.1 PKCE on the server. Wrapping it from each app via standard OAuth 2.1 client libraries is 2-3x less work, uses Better Auth primitives end-to-end, and avoids becoming the maintainer of bespoke auth code.
- **Daveyplate's lighter Tauri pattern** (`@daveyplate/better-auth-tauri`) as the universal answer. Doesn't generalize: it depends on cookie sharing between the system browser and the Tauri webview (which doesn't exist for Chrome extensions or cross-origin bearer SPAs). Even for Tauri specifically, OAuth 2.1 PKCE + localhost loopback is more reliable than daveyplate's deep-link approach.
- **Tauri custom-scheme deep link** (`whispering://callback`) for the future Tauri OAuth client. Rejected in favor of localhost loopback: deep links are full on Windows/Linux but partial on macOS/iOS (must register at config-time, no runtime dynamic registration), and the loudest footgun in the stack per the research. Loopback (`tauri-plugin-oauth`) sidesteps every platform quirk.
- **Microsoft as a launch-set provider.** Research said no; first-party Sign-In-With-Microsoft is rare (3/20 apps). Reach Microsoft users via SAML when enterprise demand surfaces.
- **A new dedicated `@epicenter/social-sign-in-browser` package** (from the earlier draft of this spec, when GIS was still the path). Moot now: the OAuth 2.1 client pattern doesn't need GIS helpers at all.

## Deferred (not open)

- **Tauri auth path.** Same as the main path now. When whispering adds auth, it depends on `@epicenter/oauth-client-tauri` (built in the pre-work wave) and calls `auth.signInWithSocial({ provider })`. The transport (system browser via `tauri-plugin-opener` + localhost loopback HTTP server via `tauri-plugin-oauth` + `oauth2` Rust crate exchange) is documented in the design decisions table. ~1-2 days of integration work when whispering needs auth.

## Success criteria

- [ ] Every browser app calls `auth.signInWithSocial`; tab-manager calls `auth.signInWithSocial`.
- [ ] No source file imports `signInWithSocialRedirect` or `signInWithIdToken`.
- [ ] `AuthClient` does not declare `signInWithSocialRedirect` or `signInWithIdToken`.
- [ ] `SocialSignInFailed` is unchanged; its only producer is `signInWithSocial`.
- [ ] No `SocialSignInUnavailable` variant exists (no GIS = no GIS-blocked failure mode).
- [ ] `@epicenter/oauth-client`, `@epicenter/oauth-client-spa`, `@epicenter/oauth-client-extension` packages exist and typecheck.
- [ ] `@epicenter/oauth-client-tauri` package may be empty/stub until whispering needs it; either way it exists in the `packages/` tree as the documented Tauri path.
- [ ] All affected app typechecks pass.
- [ ] Manual smoke: each migrated app completes sign-in via OAuth 2.1 flow (Google for now; GitHub/Apple after their server config is added).
- [ ] Integration test confirms `bearer()` plugin validates oauthProvider-issued tokens via `getSession()`.

## Verification commands

```sh
bun run --filter @epicenter/auth typecheck
bun run --filter @epicenter/oauth-client typecheck
bun run --filter @epicenter/oauth-client-spa typecheck
bun run --filter @epicenter/oauth-client-extension typecheck
bun run --filter dashboard typecheck
bun run --filter fuji typecheck
bun run --filter honeycrisp typecheck
bun run --filter opensidian typecheck
bun run --filter zhongwen typecheck
bun run --filter tab-manager typecheck
bun test packages/auth/src/create-auth.test.ts
bun test packages/auth/src/oauth-provider-bearer.integration.test.ts  # the P.1 verification
```

## Straggler searches

```sh
rg -n "signInWithSocialRedirect" apps packages -S
rg -n "signInWithIdToken" apps packages -S
rg -n "getGoogleIdToken|google-sign-in" apps packages -S
rg -n "callbackURL" apps packages -S    # Better Auth's redirect param
rg -n "SocialSignInUnavailable" apps packages -S
rg -n "accounts.google.com/gsi" apps packages -S    # GIS script tag
```

After implementation, the first five should match only this spec and historical specs. The sixth should match nothing (no GIS anywhere).
