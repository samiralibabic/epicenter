# Honeycrisp Platform Auth Modes

**Date**: 2026-05-07
**Status**: Superseded (2026-05-11)
**Author**: AI-assisted
**Superseded by**: `specs/20260511T105846-auth-oauth-everywhere-clean-break.md`

## Reconciliation (2026-05-11)

Do not use this spec as the current implementation source. The credential-family spec briefly replaced the Honeycrisp-specific local-bearer split with a repository-wide cookie versus bearer family rule. That rule is now superseded too.

The useful lesson from this spec remains the same: auth ownership belongs at the platform auth boundary, not in shared app code. The current boundary is stricter: every app starts hosted sign-in, completes OAuth authorization code with PKCE, stores OAuth credentials, and uses auth-owned `fetch` and `openWebSocket` capabilities. Better Auth cookies are internal to the hosted API auth server only.

---

(Original spec content follows.)

## Overview

Honeycrisp needs platform-selected auth. The hosted web app can use cookies on `*.epicenter.so`, while desktop and localhost development should be able to use bearer auth without mixing browser cookies into the same runtime.

One sentence: Honeycrisp should choose cookie or bearer auth at the platform boundary, then enforce that choice for the whole app instance.

## Motivation

### Current State

Honeycrisp currently constructs auth from a shared app module:

```ts
// apps/honeycrisp/src/lib/auth.ts
export const auth = createBearerAuth({
	baseURL: APP_URLS.API,
	sessionStorage: createPersistedState({
		key: 'honeycrisp.auth.session',
		schema: BearerSession.or('null'),
		defaultValue: null,
	}),
});
```

That is correct for a standalone bearer runtime. It is not enough for a product that may run as:

```txt
production web   https://honeycrisp.epicenter.so
local web        http://localhost:5175
desktop          Tauri shell
```

This creates problems:

1. **Production web and development want different defaults**: Production subdomain web can rely on `.epicenter.so` cookies. Localhost development cannot rely on those cookies unless the dev server runs on an `.epicenter.so` host.
2. **Desktop should not inherit browser assumptions**: Desktop needs bearer auth backed by native storage or a preloaded synchronous adapter.
3. **One shared module hides platform facts**: The app imports `$lib/auth` and cannot tell whether the current runtime is cookie-backed or bearer-backed.
4. **Mixed auth is tempting during OAuth**: OAuth redirect flows often create an API cookie first. Bearer runtimes need an explicit handoff or cleanup path so they do not carry both cookie and bearer credentials.

### Desired State

Shared Honeycrisp UI imports one stable auth entrypoint:

```ts
import { auth } from '$platform/auth';
```

Each platform module chooses exactly one credential owner:

```txt
hosted web on *.epicenter.so
  createCookieAuth(...)
  browser cookie jar owns the credential

localhost web
  createBearerAuth(...)
  localStorage owns the bearer session

desktop
  createBearerAuth(...)
  native storage owns the bearer session
```

The API keeps rejecting mixed credentials. Platform auth prevents normal app code from producing them.

## Research Findings

### Better Auth Transport

Better Auth's browser client defaults to `credentials: "include"`. That is the right default for cookie auth and the wrong default for bearer auth. The companion spec `20260507T151049-bearer-client-omit-internal-cookies.md` fixes the core bearer guardrail by setting `credentials: 'omit'` inside `createBearerAuth()`.

### Cookie Auth on Epicenter Subdomains

The API config already scopes cookies to `.epicenter.so`:

```ts
advanced: {
	crossSubDomainCookies: {
		enabled: true,
		domain: '.epicenter.so',
	},
	defaultCookieAttributes: {
		sameSite: 'none',
		secure: true,
	},
}
```

That means `https://honeycrisp.epicenter.so` can use cookie auth against `https://api.epicenter.so`. Separate origin does not force bearer auth when both hosts are first-party subdomains.

### Bearer Auth for Localhost and Desktop

Localhost is not under `.epicenter.so`. Cookie auth can still work in some local setups if the API allows localhost origins and the browser accepts the cookie flow, but it creates more browser-policy surface area than bearer auth. Desktop has the same conclusion for a stronger reason: the app should own a token in native storage instead of leaning on a browser cookie jar.

### SvelteKit Platform Aliasing

The OpenSidian platform alias spec already describes the right boundary:

```txt
$platform/auth -> src/lib/platform/auth/cookie.ts
$platform/auth -> src/lib/platform/auth/bearer.ts
$platform/auth -> src/lib/platform/auth/keychain.ts
```

Alias resolution happens before the target module graph is traversed, so desktop-only imports do not enter the web build and web-only storage does not enter the desktop build.

SvelteKit's `kit.alias` is the source of truth for `$platform/auth` in Honeycrisp. SvelteKit feeds that alias into Vite resolution and generated TypeScript config, so `vite.config.ts` does not need a duplicate `$platform/auth` entry.

The production build script sets `NODE_ENV=production`, so `svelte.config.js` resolves `$platform/auth` to `cookie.ts`. Local development leaves `NODE_ENV` unset or development, so the same alias resolves to `bearer.ts`.

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Mixed credentials | 2 coherence | Keep rejecting them at the API | Mixed auth hides precedence and can bind the app to the wrong session. |
| Hosted web auth | 2 coherence | Use cookie auth for `honeycrisp.epicenter.so` | The API cookie is scoped to `.epicenter.so`, so the browser cookie jar is the clean credential owner. |
| Localhost auth | 3 taste | Prefer bearer auth by default | It avoids requiring a local `.epicenter.so` host and mirrors desktop more closely. |
| Desktop auth | 2 coherence | Use bearer auth | Desktop should own a durable token in native storage. |
| Platform selection | 2 coherence | Use `$platform/auth` alias | Shared UI should consume `AuthClient`, not transport facts. |
| Hosted domain shape | 3 taste | Use `*.epicenter.so` for hosted web by default | Epicenter is a collection of apps. Keeping hosted apps under one site gives one cookie domain, one API origin, and less deployment branching. Custom domains stay an exception for apps with a real standalone product reason. |
| Contributor setup | 3 taste | Do not require real product DNS for default local dev | Requiring `.epicenter.so` or `honeycrisp.com` host access makes basic contribution depend on shared DNS, OAuth callbacks, and secrets. Local bearer mode stays the low-friction default. |
| Cookie cleanup for bearer OAuth | Deferred | Design with the handoff flow | Clearing cookies is part of the OAuth handoff, not a side effect inside generic auth construction. |

## Hosted Deployment Shape

The default hosted shape should be Epicenter subdomains:

```txt
Honeycrisp hosted web
  https://honeycrisp.epicenter.so

OpenSidian hosted web, preferred for now
  https://opensidian.epicenter.so

Shared hosted API
  https://api.epicenter.so
    |
    v
  apps/api Cloudflare Worker
```

That is already same-site for browser cookie purposes because every hosted app and the API live under `epicenter.so`. It gives the fastest coherent path:

```txt
*.epicenter.so app
  |
  v
api.epicenter.so
  |
  v
.epicenter.so cookie
```

For now, do not spend implementation energy on custom product domains unless an app has a real standalone distribution need. OpenSidian currently lists `https://opensidian.com`, but the platform-auth rollout can move faster if hosted web standardizes on `https://opensidian.epicenter.so` first.

If a product later needs its own domain, use a matching product API subdomain backed by the same Worker:

```txt
OpenSidian production web
  https://opensidian.com

OpenSidian production API
  https://api.opensidian.com
    |
    v
  apps/api Cloudflare Worker
```

That keeps custom-domain production web on cookie auth without making the browser treat `api.epicenter.so` as a third-party site. The Worker can still serve many hostnames:

```txt
apps/api Worker
  |
  |-- api.epicenter.so
  |-- api.opensidian.com
  |-- api.honeycrisp.com      (only if Honeycrisp later moves to honeycrisp.com)
  `-- api.<product-domain>
```

For each product API hostname, the auth server should choose the cookie domain from the request host:

```txt
api.epicenter.so      -> .epicenter.so
api.opensidian.com    -> .opensidian.com
api.honeycrisp.com    -> .honeycrisp.com
localhost             -> no cross-subdomain cookie domain
```

For this spec, custom-domain support is a deferred escape hatch, not the default target. Cross-site cookies can work with `SameSite=None`, `Secure`, credentialed CORS, and trusted origin checks, but the browser privacy model keeps getting stricter around third-party cookies. Product API subdomains avoid leaning on that edge when a custom domain becomes worth the extra deployment shape.

An app-local path proxy is still useful for local or special deployments:

```txt
https://honeycrisp.com/api/*
  -> apps/api Worker
```

But it should not be the default production architecture unless a product strongly wants a single visible origin. Path proxying means either rewriting `/api/auth/*` to `/auth/*` or teaching the API to run under a base path. That touches auth callbacks, OAuth redirects, WebSocket URLs, asset routes, and generated route helpers.

The contributor story should stay two-mode:

```txt
Default local dev
  app: http://localhost:5175
  api: http://localhost:8787 when apps/api is running locally
  api: deployed API when using a remote API script
  bearer auth
  no DNS setup
  no shared domain access

Production-like auth testing
  deployed app plus deployed matching API subdomain, or explicit local proxy mode
  cookie auth
```

Do not force every contributor through real DNS just to run the app. It is valuable for release validation, OAuth work, and cookie debugging, but it is too much ceremony for UI, workspace, sync, or state work.

The environment matrix should stay explicit:

| Environment | App URL | API URL | Auth Mode | Why |
| --- | --- | --- | --- | --- |
| Honeycrisp hosted web | `https://honeycrisp.epicenter.so` | `https://api.epicenter.so` | Cookie | Both hosts are under `epicenter.so`, so `.epicenter.so` cookies work. |
| OpenSidian hosted web, preferred for now | `https://opensidian.epicenter.so` | `https://api.epicenter.so` | Cookie | Same hosted-app rule as Honeycrisp; fastest consistent path. |
| Custom-domain app, deferred | `https://opensidian.com` | `https://api.opensidian.com` | Cookie | Use only when standalone branding/distribution justifies the extra API hostname. |
| Default local dev | `http://localhost:5175` | `http://localhost:8787` | Bearer | Reproducible without DNS, Cloudflare access, or OAuth callback setup. |
| Remote API local dev | `http://localhost:5175` | Deployed API | Bearer | Useful when the API is not running locally, while avoiding cross-site cookie setup. |
| Cookie-mode local testing | `http://localhost:5175` | Proxied through `http://localhost:5175` | Cookie | Tests cookie auth mechanics locally, but not exact production subdomain cookie behavior. |

## Architecture

```txt
Honeycrisp shared UI
  |
  v
$platform/auth
  |
  |-- hosted web
  |     createCookieAuth({ baseURL: APP_URLS.API })
  |
  |-- localhost web
  |     createBearerAuth({ sessionStorage: localStorage adapter })
  |
  `-- desktop
        createBearerAuth({ sessionStorage: native adapter })
```

The workspace session stays unchanged:

```ts
const honeycrisp = openHoneycrisp({
	userId,
	peer,
	bearerToken: () => auth.bearerToken,
	encryptionKeys: () => requireSignedIn(auth).encryptionKeys,
});
```

For cookie auth, `auth.bearerToken` returns `null`, so WebSocket sync sends no bearer subprotocol. For bearer auth, sync sends `bearer.<token>`.

## OAuth Handoff Shape

Bearer OAuth needs an explicit bridge from API cookie to bearer session:

```txt
1. User starts Google sign-in from a bearer runtime.
2. API completes OAuth and sets the temporary Better Auth cookie.
3. Runtime calls a handoff endpoint with cookie credentials only.
4. API returns the custom session plus set-auth-token.
5. API clears the cookie without revoking the bearer session.
6. Runtime stores BearerSession and continues with credentials omit.
```

This is not needed for hosted cookie web. In that runtime, the cookie is the credential and should stay.

## Implementation Plan

### Phase 1: Platform Entry Point

- [x] **1.1** Add Honeycrisp `$platform/auth` alias entries for hosted web, local web, and desktop.
  > **Note**: Added hosted web and local web modules. Desktop stays deferred until there is a real desktop storage preload path, so the build cannot accidentally bless browser storage as the desktop credential owner.
- [x] **1.2** Move the current bearer auth module into the local web platform module.
  > **Note**: The local module uses `honeycrisp.auth.session` as its bearer session storage key.
- [x] **1.3** Add hosted web auth with `createCookieAuth({ baseURL: APP_URLS.API })`.
- [x] **1.4** Update shared Honeycrisp imports from `$lib/auth` to `$platform/auth`.
- [x] **1.5** Keep the public `AuthClient` surface unchanged for sessions and components.

### Phase 2: Development Selection

- [x] **2.1** Decide how scripts select hosted web versus local bearer mode.
  > **Note**: Honeycrisp selects hosted cookie auth when the build script sets `NODE_ENV=production`. Local dev, including `vite dev --mode production`, remains bearer auth.
- [x] **2.2** Document the default developer flow.
  > **Note**: `bun run dev:local` uses bearer auth against localhost API URLs. `bun run dev:remote` still runs on localhost, so it also uses bearer auth while `APP_URLS.API` points at production.
- [x] **2.3** If cookie-mode local dev is supported, document the required `.epicenter.so` host setup.
  > **Note**: Cookie-mode local dev is not supported by this pass. Use a production build on `https://honeycrisp.epicenter.so` for hosted cookie auth.

### Phase 3: Desktop Storage

- [ ] **3.1** Define a desktop bearer session storage adapter.
- [ ] **3.2** Preload async native storage before constructing `createBearerAuth()`.
- [ ] **3.3** Keep the adapter synchronous at the auth factory boundary.
  > **Deferred**: Desktop auth needs a real native storage preload before adding `keychain.ts`. A temporary `localStorage` adapter would make the platform boundary look finished while storing credentials in the wrong owner.

### Phase 4: Bearer OAuth Handoff

- [ ] **4.1** Design the handoff endpoint shape.
- [ ] **4.2** Return a validated custom session and expose `set-auth-token`.
- [ ] **4.3** Clear the API cookie after handoff without revoking the session.
- [ ] **4.4** Add a dev diagnostic for `multiple_credentials` that explains which credential to clear.

## Verification

Platform builds should prove the import graph:

```sh
bun run --filter @epicenter/honeycrisp typecheck
bun run --filter @epicenter/honeycrisp build
```

Auth behavior should be checked with browser DevTools:

```txt
hosted web request:
  Cookie present
  Authorization absent

local bearer request:
  Cookie absent
  Authorization present

mixed request:
  API returns multiple_credentials
```

## Open Questions

1. Should local bearer OAuth use the same handoff endpoint as desktop?
2. Should hosted web ever support bearer mode, or should bearer be reserved for localhost and desktop?
3. Should the sign-in UI show a recovery action when `multiple_credentials` happens, or should the console diagnostic be enough for development?
4. Should `apps/api` support host-derived cookie domains directly, or should product API domains get separate deployment config entries?

## Review Checklist

Before implementing this spec, run a skeptical pass over the auth split:

1. Read `packages/auth/src/create-auth.ts`, `packages/auth/src/create-auth.test.ts`, `packages/auth/src/contract.test.ts`, `apps/api/src/auth/single-credential.ts`, the Honeycrisp `$platform/auth` consumers, and the companion bearer credential spec.
2. List every file read as an ASCII tree before analysis.
3. Mentally inline helpers, wrappers, files, extracted functions, and platform modules back into their call sites.
4. Challenge whether the bearer credential tests are redundant or misplaced.
5. Challenge whether `createBearerAuth()` should own `credentials: 'omit'` directly, or whether `createAuthCore()` needs a stronger transport-specific config shape.
6. Challenge whether Honeycrisp hosted web should ever use cookie auth if the product may also become a desktop app.
7. Challenge the bearer OAuth handoff. Clearing the Better Auth cookie must clear only the browser credential, not revoke the session that backs the bearer token.
8. Report findings before editing. Do not silently fix structural concerns.

Useful verification for the review:

```sh
bun test packages/auth
bun run --filter @epicenter/auth typecheck
bun -e "const fs = require('fs'); for (const f of process.argv.slice(2)) fs.readFileSync(f, 'utf8').split(/\\n/).forEach((line, i) => { if (/[\\u2013\\u2014]/u.test(line)) console.log(f + ':' + (i + 1) + ':' + line); });" packages/auth/src/create-auth.ts packages/auth/src/create-auth.test.ts packages/auth/src/contract.test.ts specs/20260507T151049-bearer-client-omit-internal-cookies.md specs/20260507T151100-honeycrisp-platform-auth-modes.md
```

## Execution Brief

When this spec is ready to execute, use this closed task shape:

1. Read this spec, the companion bearer credential spec, the OpenSidian platform aliasing draft, Honeycrisp auth/session files, Honeycrisp Vite and SvelteKit config, `packages/auth/src/create-auth.ts`, `packages/svelte-utils/src/session.svelte.ts`, and `apps/api/src/auth/single-credential.ts`.
2. Add a `$platform/auth` entrypoint for Honeycrisp. A folder layout is preferred once more than one platform module exists:

```txt
apps/honeycrisp/src/lib/platform/auth/
|-- bearer.ts
|-- cookie.ts
`-- keychain.ts
```

3. Hosted web exports `auth = createCookieAuth({ baseURL: APP_URLS.API })` with the normal hot-dispose pattern.
4. Local web moves the current `createBearerAuth()` setup into the platform module, using `honeycrisp.auth.session` as the storage key.
5. Desktop uses bearer auth, but do not fake final desktop storage. Add the module only when the build config can select it without pulling desktop-only imports into the web graph. If storage is not ready, document the synchronous adapter requirement instead.
6. Add the alias so shared Honeycrisp code imports `auth` from `$platform/auth`.
7. Default localhost development to bearer mode. Use hosted cookie mode for production only if the existing scripts cleanly identify hosted web. If scripts do not distinguish these modes, update the spec before coding the alias.
8. Keep workspace construction unchanged except for the auth import. `bearerToken: () => auth.bearerToken` works for both modes because cookie auth returns `null`.
9. Do not implement OAuth handoff in the platform-alias pass unless the spec is updated first.

Run:

```sh
bun run --filter @epicenter/honeycrisp typecheck
bun run --filter @epicenter/honeycrisp build
```

If auth core changes during execution, also run:

```sh
bun test packages/auth
```

## Implementation Notes

The platform auth pass added:

```txt
apps/honeycrisp/src/lib/platform/auth/
|-- bearer.ts
`-- cookie.ts
```

`$platform/auth` resolves to local bearer auth for Vite dev and SvelteKit tooling. Production build scripts set `NODE_ENV=production`, so `kit.alias` resolves it to hosted cookie auth. This keeps the localhost runtime from inheriting browser cookie assumptions while letting the deployed `honeycrisp.epicenter.so` app use the `.epicenter.so` cookie jar.

Because `kit.alias` feeds both Vite and generated TypeScript config, Honeycrisp does not repeat `$platform/auth` in `vite.config.ts`.

The old `apps/honeycrisp/src/lib/auth.ts` module was deleted. Shared app code now imports directly from `$platform/auth`.

The local bearer storage key is `honeycrisp.auth.session`.

## Review

**Completed**: 2026-05-07

### Summary

Honeycrisp now chooses auth at the platform boundary. Hosted production builds use `createCookieAuth`, localhost builds use `createBearerAuth` with the `honeycrisp.auth.session` storage key, and shared session code consumes the stable `$platform/auth` entrypoint.

### Deviations from Spec

- Desktop auth was not added. The spec requires native storage or a preloaded synchronous adapter, and that path does not exist yet.
- OAuth handoff was not implemented. The execution brief explicitly leaves it out of the platform-alias pass.

### Follow-up Work

- Add `keychain.ts` once the desktop boot path can preload native storage before constructing auth.
- Design the bearer OAuth handoff endpoint before enabling social OAuth in bearer runtimes.
