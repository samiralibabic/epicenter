# Bearer Client Internal Cookie Omission

**Date**: 2026-05-07
**Status**: Implemented
**Author**: AI-assisted

## Overview

Bearer auth must omit browser cookies for every Better Auth client request, not only for `auth.fetch()`. This keeps bearer clients from sending both `Authorization` and Better Auth session cookies to the API.

One sentence: a bearer client owns the credential, so every request from that client must send bearer only.

## Motivation

### Current State

`createBearerAuth()` already omits cookies for the public fetch wrapper:

```ts
fetch(input, init) {
	const headers = headersFromRequest(input, init);
	if (session !== null) {
		headers.set('Authorization', `Bearer ${session.token}`);
	} else {
		headers.delete('Authorization');
	}
	return fetch(input, { ...init, headers, credentials: 'omit' });
}
```

The internal Better Auth client used by `useSession`, `signIn`, `signOut`, and `getSession` was configured with bearer token support but did not override Better Auth's default cookie behavior:

```ts
const betterAuthClient = createAuthClient({
	baseURL,
	basePath: '/auth',
	plugins: [InferPlugin<EpicenterCustomSessionPlugin>()],
	fetchOptions,
});
```

That made this request shape possible:

```txt
Cookie: better-auth.session_token=...
Authorization: Bearer ...
```

This creates problems:

1. **Mixed credentials reach the API**: `apps/api/src/auth/single-credential.ts` rejects cookie plus bearer before Better Auth sees the request.
2. **State can flip during boot**: A bearer app can have a local bearer session and an API cookie. If Better Auth's internal session refresh sends both, the API returns `multiple_credentials`, and the local session can be cleared.
3. **Upstream behavior is intentionally permissive**: Better Auth's bearer plugin accepts mixed inputs and resolves them internally. That is not the contract we want at the Epicenter boundary.

### Desired State

Bearer auth has one credential path:

```txt
createBearerAuth
  Better Auth client fetchOptions.credentials = 'omit'
  Better Auth client fetchOptions.auth        = Bearer token callback
  public auth.fetch credentials              = 'omit'
```

Cookie auth has the opposite contract:

```txt
createCookieAuth
  Better Auth client default credentials      = include
  public auth.fetch credentials              = include
  bearerToken                                = null
```

## Research Findings

### Better Auth Client Defaults

DeepWiki against `better-auth/better-auth` confirmed that Better Auth's client defaults to `credentials: "include"` when the environment supports the `credentials` request option. It also confirmed that `createAuthClient({ fetchOptions: { credentials: "omit" } })` is the supported override, and that this can be combined with `fetchOptions.auth` for bearer transport.

The installed package matches that reading. `node_modules/better-auth/dist/client/config.mjs` creates the client fetcher with:

```ts
...(isCredentialsSupported ? { credentials: 'include' } : {}),
...
...restOfFetchOptions,
```

The spread order means caller-provided `fetchOptions.credentials` overrides the default.

### Better Auth Bearer Plugin

DeepWiki confirmed that the bearer plugin does not treat cookie plus bearer as an error. It converts a valid bearer into a session cookie for internal processing, and an invalid bearer can fall back to a valid cookie.

That is a reasonable upstream behavior for a general-purpose auth library, but Epicenter has a stricter invariant:

```txt
cookie client -> cookie credential only
bearer client -> bearer credential only
API           -> reject mixed credentials
```

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Bearer internal credentials | 1 evidence | Set `fetchOptions.credentials = 'omit'` in `createBearerAuth()` | Better Auth defaults to include and allows this override. Local installed code confirms the override order. |
| Cookie internal credentials | 2 coherence | Leave cookie auth on Better Auth defaults | Cookie auth intentionally uses the browser cookie jar. |
| API mixed credential guard | 2 coherence | Keep rejecting mixed credentials | The guard makes precedence explicit and keeps upstream permissiveness from leaking into app behavior. |
| Self healing | Deferred | Handle in platform auth spec | Clearing one credential is a product choice, not a core transport primitive. |

## Architecture

```txt
Bearer runtime
  |
  v
createBearerAuth()
  |
  |-- Better Auth useSession/signOut/getSession
  |     credentials: omit
  |     Authorization: Bearer <token>
  |
  `-- auth.fetch()
        credentials: omit
        Authorization: Bearer <token>
```

```txt
Cookie runtime
  |
  v
createCookieAuth()
  |
  |-- Better Auth useSession/signOut/getSession
  |     credentials: include
  |
  `-- auth.fetch()
        credentials: include
        no Authorization header
```

## Implementation Plan

### Phase 1: Core Guardrail

- [x] **1.1** Add `credentials: 'omit'` to the `createBearerAuth()` Better Auth client fetch options.
- [x] **1.2** Assert the internal Better Auth client receives `credentials: 'omit'` in `create-auth.test.ts`.
- [x] **1.3** Assert the shared contract keeps cookie auth defaulted and bearer auth omitted in `contract.test.ts`.

### Phase 2: Platform Follow-up

- [ ] **2.1** Decide which Honeycrisp builds use cookie auth and which use bearer auth.
- [ ] **2.2** Move the decision out of shared app code with a platform auth entrypoint.
- [ ] **2.3** Decide whether development should run against bearer auth on localhost or cookie auth on an `.epicenter.so` dev host.

## Verification

Run:

```sh
bun test packages/auth
```

Expected result: auth tests pass, and bearer clients prove both public and internal fetch paths omit cookies.

## Open Questions

1. Should bearer-mode development auto-clear a stale API cookie, or should it show a diagnostic and let the developer choose?
2. Should social OAuth for bearer web apps use a token handoff endpoint that clears the API cookie after issuing the bearer session?
3. Should the API expose a dedicated `clear-cookie` endpoint for development hygiene, or should sign-out own that path?
