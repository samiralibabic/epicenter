# Portal rename and first-party auth collapse

Date: 2026-05-17
Status: planned
Owner: Braden

## 1. Context

`apps/api` is a Cloudflare Worker that runs three jobs:

1. Better Auth protocol surface: `/auth/*`, OIDC discovery, OAuth provider routes.
2. Authenticated data plane: `/api/me`, `/api/billing/*`, `/api/assets/*`, `/rooms/*`, `/ai/chat`.
3. Human UI: hand-rolled Hono JSX at `/sign-in`, `/consent`, `/auth/cli-callback`, plus a static-asset fallback for the dashboard SPA mounted at `/dashboard/*`.

Job 3 duplicates the SvelteKit + `@epicenter/ui` design system that already lives in `apps/dashboard`. Concretely:

- `apps/api/src/auth-pages/` contains ~780 LOC of JSX, inline CSS in `styles.ts`, and `<script>` strings.
- `apps/dashboard` already ships a full design system, query layer, and an auth client.

Underneath the UI duplication is a deeper redundancy: the dashboard SPA is an **OAuth client** to the very server that serves it. `apps/dashboard/src/lib/platform/auth/auth.ts` runs PKCE, stores a `redirectUri`, and exchanges codes for bearer tokens, all to talk to `api.epicenter.so` from a page hosted at `api.epicenter.so/dashboard`. That OAuth-against-itself model exists because `requireOAuthUser` in `apps/api/src/app.ts:349` accepts only bearer tokens.

This spec replaces the renovation pattern (port the JSX, keep the rest) with the canonical pattern (refuse OAuth-against-itself; portal is first-party).

## 2. Target state

```
                          api.epicenter.so                portal.epicenter.so
                          ════════════════                ═══════════════════

Hono Worker                                          Static SvelteKit SPA
emits JSON, binary, redirects only.                  emits ALL human UI.

/auth/*           Better Auth                        /
/auth/oauth2/*    OAuth provider                     /sign-in
/.well-known/*    OIDC + OAuth metadata              /consent
/api/me           cookie OR bearer                   /billing
/api/billing/*    cookie OR bearer                   /account
/api/assets/*     cookie OR bearer                   /auth/cli-callback  (if _headers works)
/ai/chat          bearer only (external clients)
/rooms/:room      bearer only (external clients)
/auth/cli-callback HTML (only if _headers doesn't
                  carry no-store + no-transform)
```

Two origins, one Better Auth instance, one user identity, one cookie scoped to `.epicenter.so` so `portal.epicenter.so` and `api.epicenter.so` share session state.

Auth model:

```
Surface                          Credential                Scope
───────────────────────────      ───────────────────       ─────────────────────
Portal (same parent domain)      Cookie session            Implicit full access
CLI                              OAuth bearer              workspaces:open
Whispering / Tauri               OAuth bearer              workspaces:open
Tab-manager extension            OAuth bearer              workspaces:open
Future external clients          OAuth bearer              explicit per-scope
```

One middleware accepts either credential:

```
requireUser:
  1. try Better Auth getSession from cookie       → c.set('user', session.user)
  2. else, resolveRequestOAuthUser (bearer)        → c.set('user', user)
  3. else, 401 with OAuth WWW-Authenticate
```

## 3. Explicit decisions

### 3.1 Name: `apps/portal`

Reasons:
- Codebase already uses this term in user-facing copy: `apps/api/src/auth-pages/cli-callback-page.tsx:8-9` says *"after the user signs in on the hosted portal"*.
- Reserves `apps/epicenter` for the future desktop product and `apps/dashboard` for the future analytics surface.
- Names a role, not a product.

Rejected:
- `apps/dashboard` (kept name): collides with future analytics dashboard.
- `apps/epicenter`: collides with future desktop product.
- `apps/web`: too generic, doesn't say what this surface is.
- `apps/account`: too narrow once billing + sign-in + consent + future settings all live here.

### 3.2 Hosting: `portal.epicenter.so`

Separate subdomain from `api.epicenter.so`. Same parent domain so Better Auth's `crossSubDomainCookies` can scope the session cookie to `.epicenter.so` and both subdomains see it.

Rejected:
- Bare `epicenter.so`: collides with `apps/landing` (marketing site).
- Path-based on `api.epicenter.so/portal`: re-introduces the prefix encoding we're explicitly removing with `paths.base = ''`.
- Same origin as API: prevents future independent deploys of the portal and keeps the SPA tied to the Worker's deployment cycle.

### 3.3 Auth model: first-party cookies for portal, OAuth for external clients

Rejected: portal-as-OAuth-client (the renovation plan).

The portal lives on a subdomain of the same parent domain as the API. Better Auth's session cookie scoped to `.epicenter.so` is the canonical mechanism. Bearer-against-itself OAuth is ceremony for a relationship that is, by construction, trusted.

External clients (CLI, Tauri, extension, future native, future third-party) stay on OAuth because they need explicit scopes, the OOB flow, and origin separation.

### 3.4 `paths.base = ''`

The portal owns its origin's root. No URL prefix encoding. SvelteKit asset paths, `$app/paths` base, generated links, and the dev/preview servers all use root.

### 3.5 CLI callback: move to portal if Workers Static Assets `_headers` carries `Cache-Control: no-store, no-transform`; else keep Hono

The page is small (~100 LOC). It is moved if and only if a static asset can carry the same headers the current Hono route enforces (`apps/api/src/app.ts:248-266`). The decision is determined empirically in PR 4, not assumed.

If kept Hono, the file inlines its own layout/styles so the shared `layout.tsx`, `styles.ts`, and `index.tsx` shell can still be deleted in PR 4.

### 3.6 Refuse the `signed-in-page` dead-end UX

Today `/sign-in` with an existing session and no callback renders a "signed in as ..." confirmation page. The SPA replacement redirects to `/` instead. One fewer page, one fewer template.

## 4. Migration: four PRs

Each PR leaves the system fully working. Order matters: PR 1 prepares the cookie path before any portal-side rewiring so the system never sits in a "two auth identities" intermediate state.

### PR 1: cookie auth on `/api/*`

Hono-side only. Zero user-visible change. Zero portal change.

- Add `requireUser` middleware: cookie-first via `auth.api.getSession`, OAuth-bearer fallback via existing `resolveRequestOAuthUser`. Set `c.var.user` from whichever succeeds.
- Apply `requireUser` to `/api/billing/*`, `/api/me`, `/api/assets/*`. Keep `requireOAuthUser` on `/ai/*` and `/rooms/*` (external-clients-only).
- Origin/Referer check for cookie-auth state-changing requests (POST/PUT/DELETE on `/api/*`). Reject when `Origin` is not in `TRUSTED_ORIGINS`. Bearer-auth requests skip the check (they cannot be CSRF-attacked).
- `/api/me` keeps the OAuth-scope check when bearer is used; cookie auth implicitly satisfies it.
- Add `crossSubDomainCookies: { enabled: true, domain: '.epicenter.so' }` to Better Auth config in `apps/api/src/auth/create-auth.ts`.

Verification:
- `bun test` in `apps/api` (existing suites stay green).
- Manual: dashboard still loads billing UI (still using OAuth bearer through the existing flow).
- `curl -b cookie.txt https://api.epicenter.so/api/me` works when `cookie.txt` carries a valid session.
- `curl -X POST https://api.epicenter.so/api/billing/...` from a non-trusted origin is rejected.

Files touched (estimated):
```
apps/api/src/app.ts                         requireUser middleware, apply to 3 routes
apps/api/src/auth/create-auth.ts            crossSubDomainCookies
apps/api/src/auth/resource-boundary.ts      add cookie path (or new sibling)
apps/api/src/trusted-origins.test.ts        assertions still hold
```

### PR 2: rename + flatten + switch portal to cookies

- `mv apps/dashboard apps/portal`.
- `packages/constants/src/apps.ts`: `DASHBOARD` → `PORTAL`, URL → `https://portal.epicenter.so`, port stays `5178`.
- `apps/portal/svelte.config.js`: `paths.base = ''`, output `apps/portal/build`, drop the `/dashboard` directory from `pages`/`assets`.
- `apps/portal/src/lib/platform/auth/auth.ts`:
  - Replace `createOAuthAppAuth` with the first-party Better Auth client (verify `@epicenter/auth-svelte` exports one; if not, expose it as part of this PR).
  - `auth.fetch` collapses to plain `fetch` with `credentials: 'include'`.
  - Delete `createBrowserOAuthLauncher` usage, delete `EPICENTER_DASHBOARD_OAUTH_CLIENT_ID` import.
  - All callers update.
- Delete `apps/portal/src/routes/auth/callback/` (no longer an OAuth client).
- `apps/portal/src/lib/api.ts`: drop the `auth.fetch` wrapper; use `fetch` with `credentials: 'include'` and the absolute API base URL from `APPS.API.urls[0]`.
- `apps/api/wrangler.jsonc`:
  - Add a `route` for `portal.epicenter.so` (custom_domain: true) OR deploy the portal as a separate Worker / Pages project. Decide in this PR; default is "same Worker, second route" because it's the smallest deploy change.
  - Update `assets.directory` to `../portal/build`.
- `apps/api/src/app.ts`:
  - Replace the two `/dashboard/*` and `/dashboard` SPA-fallback handlers with a single catch-all (`app.get('*', ...)`) ordered after every registered route. The catch-all only triggers for requests reaching the Worker at `portal.epicenter.so` (the `api.epicenter.so` host has no SPA to serve, so unmatched routes 404).
  - Delete the `/billing → /dashboard` redirect at line 378 (the `/billing` route now lives in the portal SPA and is reached directly).
- `apps/api/src/auth/trusted-oauth-clients.ts`: the dashboard OAuth client row is no longer needed by the portal. Either delete it, or leave it dormant for one release before deleting (safer).
- Hono `/sign-in` and `/consent` routes still exist (port happens in PR 3); they are still reachable at `api.epicenter.so/sign-in` and continue to serve the JSX pages. Better Auth's redirect targets need to be repointed to `portal.epicenter.so/sign-in` and `portal.epicenter.so/consent` in this PR so the next PR is purely deletion.

Verification:
- `bun run build` in `apps/portal`.
- `wrangler dev` serves API on local API port and ASSETS on portal port (or use two `wrangler dev` invocations if multi-domain dev is awkward).
- Sign in via the Hono `/sign-in` page (still rendered by the Worker). After sign-in the cookie is set at `.epicenter.so`.
- Portal at `portal.epicenter.so` loads, reads the cross-subdomain cookie, calls `/api/me` and `/api/billing/balance` with `credentials: 'include'`, sees the user.
- OAuth flow from CLI still works end-to-end (signs in via Hono `/sign-in`, redirected to consent, redirected to `/auth/cli-callback`, code displayed).

### PR 3: port `/sign-in` and `/consent` to the portal

- `apps/portal/src/routes/sign-in/+page.svelte`:
  - On mount, call `auth.getSession`. Four branches mirroring `apps/api/src/app.ts:199-223`:
    - signed-in + `?sig=...` → `window.location.assign(\`${API_BASE}/auth/oauth2/authorize?${url.searchParams}\`)`.
    - signed-in + `?callbackURL=...` (must start with `/`) → `goto(callbackURL)`.
    - signed-in + neither → `goto('/')`.
    - signed-out → render form.
  - Form posts: `auth.signIn.email`, `auth.signUp.email`, `auth.signIn.social({ provider: 'google' })`.
- `apps/portal/src/routes/consent/+page.svelte`:
  - Reads `client_id`, `scope` from URL.
  - Posts to `${API_BASE}/auth/oauth2/consent` with the chosen action (approve/deny).
- `apps/api/src/app.ts`:
  - Delete the Hono `/sign-in` route. Better Auth redirects pointed at `portal.epicenter.so/sign-in` (from PR 2) take over.
  - Delete the Hono `/consent` route.
- Delete files:
  ```
  apps/api/src/auth-pages/sign-in-page.tsx
  apps/api/src/auth-pages/signed-in-page.tsx
  apps/api/src/auth-pages/consent-page.tsx
  apps/api/src/auth-pages/scripts/sign-in.ts
  apps/api/src/auth-pages/scripts/consent.ts
  apps/api/src/auth-pages/scripts/sign-in.test.ts  (if it exists)
  ```

Verification:
- Full CLI sign-in: `epicenter auth login` → browser opens portal `/sign-in` → submit form → browser redirected to `/auth/oauth2/authorize` re-entry → consent page renders in portal → approve → `/auth/cli-callback` displays code → paste into terminal → CLI exchanges + acquires bearer.
- Sign-up + email verification path (if enabled).
- `?callbackURL` redirect after sign-in for portal-side flows (e.g., `/billing` triggers sign-in with `callbackURL=/billing`).

### PR 4: collapse remaining Hono UI

Try the static `_headers` route for CLI callback. Probe with a deployed test page that carries the headers and verify with `curl -I` that Cloudflare's edge returns them unmodified.

If `_headers` works on Workers Static Assets:
- `apps/portal/src/routes/auth/cli-callback/+page.svelte`.
- `apps/portal/static/_headers`:
  ```
  /auth/cli-callback
    Cache-Control: no-store, no-transform
    Content-Security-Policy: default-src 'self'
    X-Frame-Options: DENY
    X-Content-Type-Options: nosniff
    Referrer-Policy: no-referrer
  ```
- Better Auth CLI redirect URI in `packages/auth/src/node/oob-launcher.ts:79` and `packages/auth/src/node/machine-auth.ts:110` changes from `${baseURL}/auth/cli-callback` to `https://portal.epicenter.so/auth/cli-callback` (or derived from `APPS.PORTAL.urls[0]`).
- Update the registered OAuth client `redirect_uri` rows in `trusted-oauth-clients.ts` for the CLI client.
- Delete the Hono route at `app.ts:248-266`, `cli-callback-page.tsx`, `scripts/cli-callback.ts`, and `cli-callback-page.test.ts`.

Else (keep Hono):
- Inline the layout into `cli-callback-page.tsx` directly.
- Delete `layout.tsx`, `styles.ts`, `index.tsx` (the shared shell, no longer shared with anything).

Either way:
- Remove `@jsxImportSource hono/jsx` from `apps/api/tsconfig.json`.
- Remove the `hono/jsx` dep if no other Hono JSX usage exists.

Verification:
- CLI flow still produces a code page; `curl -I` shows the `no-store` and `no-transform` headers on the deployed callback URL.
- Repo tree shows `apps/api/src/auth-pages/` is either deleted (move case) or contains only `cli-callback-page.tsx` + tests (keep case).

## 5. Source-of-truth map (after PR 4 lands)

```
Concern                       Single source of truth
────────────────────────────  ──────────────────────────────────────────────────
App URLs and ports            packages/constants/src/apps.ts (APPS)
CORS + Better Auth CSRF       apps/api/src/trusted-origins.ts (TRUSTED_ORIGINS,
                              derived from APPS)
Session cookie scope          apps/api/src/auth/create-auth.ts
                              (crossSubDomainCookies domain = .epicenter.so)
Who is the user (per req)?    requireUser middleware in apps/api/src/app.ts
What URL serves what?         apps/api/src/app.ts route registrations,
                              top-to-bottom = match order; ASSETS fallback last.
Portal design system          apps/portal + @epicenter/ui only.
                              Zero alternative CSS in apps/api.
OAuth client registrations    apps/api/src/auth/trusted-oauth-clients.ts
                              (CLI, Tauri, extension; no portal entry)
CLI callback redirect URI     packages/auth/src/node/{oob-launcher,machine-auth}.ts
                              derived from APPS.PORTAL.urls[0]
Portal mount point            apps/portal/svelte.config.js (paths.base = '')
                              + apps/api/wrangler.jsonc (route +
                              assets.directory). Both reference root.
```

## 6. Risks and mitigations

### Cross-subdomain cookie

Risk: Better Auth's default cookie scope is the API origin. Without `crossSubDomainCookies`, the portal cannot read the session.

Mitigation: PR 1 adds the config and a test against `/auth/get-session` from the portal origin. Pinned in `trusted-origins.test.ts` or a new `cross-subdomain-cookie.test.ts`.

### CSRF on cookie-auth POSTs

Risk: bearer tokens are CSRF-immune; cookies are not.

Mitigation: PR 1 adds an `Origin`/`Referer` check that bearer requests skip and cookie requests must pass. Test invariant: a POST to `/api/billing/...` from `https://evil.example` with a forwarded cookie is rejected.

### OAuth callback registration drift

Risk: three places must agree on the CLI callback redirect URI: `oob-launcher.ts`, `machine-auth.ts`, and the registered `redirect_uri` in the OAuth client row.

Mitigation: derive all three from `APPS.PORTAL.urls[0] + '/auth/cli-callback'`. The constant becomes the only place to change. Documented in section 5.

### Flicker on `?sig=` OAuth re-entry

Risk: Hono route did session check + 302 server-side, invisible. SPA route mounts, fetches session, then redirects, ~100-300ms of "loading...".

Mitigation: acceptable for OAuth re-entry (rare, once per interrupted authorize flow). If complaints surface, add a thin Hono shim on `portal.epicenter.so/sign-in` that does the `?sig=` server-side 302 only and falls through to ASSETS otherwise. Not in scope by default.

### Workers Static Assets `_headers` support

Risk: `_headers` is documented for Cloudflare Pages but Workers Static Assets is a newer product with different conventions.

Mitigation: PR 4 starts with a deploy probe. If the headers are dropped or mutated, keep `/auth/cli-callback` in Hono and inline its layout. The decision is data-driven, not assumed.

### Dev loop with two origins

Concern: after the split, two dev servers run (`wrangler dev` for API at `localhost:8787`, `bun run dev` for portal at `localhost:5178`). Need to confirm cookie auth works across them without prod-divergent workarounds.

Analysis: `localhost:5178` and `localhost:8787` are cross-origin but **same-site** (both reduce to the registrable domain `localhost`). `SameSite=Lax` cookies, which is Better Auth's default, attach to same-site cross-origin requests including `fetch` with `credentials: 'include'`. So the session cookie set on `localhost:8787` is sent on fetches from `localhost:5178` to `localhost:8787`. CORS is already configured (`credentials: true`, allow-list including localhost ports via `TRUSTED_ORIGINS`). Production has the same shape: `portal.epicenter.so` and `api.epicenter.so` are cross-origin same-site, same mechanic applies.

PR 1 gates this assumption with an explicit test before the rest of the spec relies on it:

- Sign in via `POST localhost:8787/auth/sign-in/email`.
- From a fetch initiator at `localhost:5178`, call `localhost:8787/api/me` with `credentials: 'include'`.
- Assert 200 + user payload, with no extra cookie-domain config.

If green: the dev loop is unchanged from today. HMR keeps working on the portal, `wrangler dev` keeps working on the API. No special handling, no `apps/portal/README.md` caveat needed.

Fallback (if the test fails, e.g., a Better Auth plugin overrides SameSite to Strict, or a browser handles localhost same-site differently than spec): serve the built portal directly from `wrangler dev` via the existing ASSETS binding on `localhost:8787`. Run `bun run vite build --watch` in `apps/portal` so saves rebuild incrementally (~2-5s) and the Worker serves the new files. Single origin in dev mirrors single-cookie-scope behavior. Cost: HMR is lost, replaced by a 2-5s rebuild cycle. Gain: dev cookie path is identical to prod, with no SameSite gymnastics. The portal's surface (sign-in, consent, billing) is not pixel-iteration UI, so the slower loop is workable. If this path is taken, document the choice and the build-watch command in `apps/portal/README.md`.

### Email verification + password reset links

Risk: Better Auth sends emails with links like `${baseURL}/reset-password?token=...`. The `baseURL` today is the API origin.

Mitigation: change Better Auth's `baseURL` semantics. Verification + reset routes live under `/auth/*` which stays on the API. The portal's `/sign-in` page handles the `?token=` parameter and posts back to the API's `/auth/reset-password`. Verified in PR 3 with a test that sends a reset email in dev and walks the link.

## 7. Out of scope

These are deliberately not in this spec to keep the four PRs small and reversible. Each is a candidate for a follow-up spec.

- New portal pages beyond what the Hono auth-pages cover today (settings, profile, organization management).
- Renaming `EPICENTER_DASHBOARD_OAUTH_CLIENT_ID` constant or migrating its DB row to a new identifier. The constant stops being referenced from the portal but isn't deleted in this work.
- Splitting the portal off into its own Cloudflare Worker (this spec keeps it as ASSETS bound to the API Worker, with `portal.epicenter.so` as a second route on the same Worker).
- Absorbing `apps/landing` into the portal.
- Folding `/ai/chat` or `/rooms/*` to also accept cookies. They remain bearer-only since their consumers are external clients.
- Adding 2FA / passkeys to the new sign-in form.

## 8. Verification at each PR boundary

Per-PR verification lives in each PR's section above. At spec completion (all four PRs landed):

- `apps/api/src/auth-pages/` is gone (or contains only `cli-callback-page.tsx` + tests in the `_headers`-not-supported branch).
- `apps/portal/src/routes/auth/callback/` is gone (no longer an OAuth client).
- `grep -r createOAuthAppAuth apps/portal` returns nothing.
- `grep -r '/dashboard' apps/` returns nothing in URL contexts.
- `paths.base` in `apps/portal/svelte.config.js` is `''`.
- A fresh deploy answers requests at both `api.epicenter.so` (JSON/binary/redirects + auth protocol) and `portal.epicenter.so` (SPA).
- CLI sign-in works end-to-end against the deployed pair.
- Portal sign-in + billing UI loads using only cookie auth, no OAuth dance.
- External clients (Whispering, tab-manager) sign in unchanged: they're OAuth clients to `api.epicenter.so`, untouched by this work.
