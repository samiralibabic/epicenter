# Collapse OAuth Resource Scope

**Date**: 2026-05-20
**Status**: Implemented
**Author**: Codex

## Overview

Collapse `workspaces:open` from the greenfield core API. Keep OAuth as the transport for external clients, but make the bearer boundary honest: issuer, audience, signature, subject, and user existence decide whether a bearer token represents an Epicenter user. Workspace membership, asset ownership, billing, and key release policy stay in server-side domain checks.

This is a breaking clean break. No deployed clients or persisted production OAuth grants need compatibility.

## One Sentence

The API auth boundary turns either a Better Auth cookie session or an API-audience bearer token into an Epicenter user; domain code decides what that user may do.

## Motivation

### Current State

The API currently configures one shared scope list:

```ts
export const AUTH_OAUTH_SCOPES = [
	'openid',
	'profile',
	'email',
	'offline_access',
	'workspaces:open',
] as const;
```

That list is used in two places:

```txt
apps/api/src/auth/plugins.ts
  oauthProvider({ scopes: [...AUTH_OAUTH_SCOPES] })

apps/api/src/auth/trusted-oauth-clients.ts
  oauthClient.scopes = [...AUTH_OAUTH_SCOPES]
```

The resource boundary then rejects bearer tokens unless the token carries `workspaces:open`:

```txt
parse bearer
  -> verify JWT against issuer, audience, and JWKS
  -> read sub
  -> require workspaces:open
  -> find Better Auth user
  -> return AuthUser
```

This creates problems:

1. **The scope duplicates audience**: `workspaces:open` currently means "this token can call the Epicenter API." The token audience already carries that meaning.
2. **The scope does not encode workspace access**: workspace membership is still checked separately through Better Auth organization/member rows.
3. **Every trusted client gets the same scope**: the scope is not distinguishing CLI, extension, browser apps, or native apps.
4. **The route layer starts thinking in OAuth vocabulary**: attempts to split the scope lead to route-to-scope tables or `requireOAuthScope(...)`, which makes OAuth strings the organizing language of `app.ts`.
5. **`InsufficientScope` is ceremonial today**: if no real resource uses a narrower custom scope, the 403 branch exists only because the duplicated scope exists.

### Desired State

The bearer boundary should be simple:

```txt
Bearer request
  -> Authorization header contains Bearer token
  -> token verifies against API issuer and audience
  -> token has a subject
  -> subject resolves to an existing Better Auth user
  -> c.var.user is set
```

Then domain checks decide exact access:

```txt
/api/session
  returns localIdentity for the authenticated user

/workspaces/*
  checks workspace membership before opening a workspace doc

/api/assets/*
  checks asset ownership or unguessable public URL policy

/ai/*
  checks billing plan and usage policy
```

### Greenfield Assumption

This spec assumes no deployed client depends on `workspaces:open`, no production OAuth client row needs to keep accepting it, and no persisted user grant must keep refreshing with it. If that assumption changes, use a staged migration instead.

## Research Findings

### Local Code

Three independent audits reached the same conclusion: `workspaces:open` is redundant with the API audience under the current first-party trusted-client model.

```txt
resource-boundary.ts
  verifies audience and issuer
  checks scope
  loads user

trusted-oauth-clients.ts
  gives every trusted client the same scopes

plugins.ts
  disables dynamic registration
  requires PKCE
  allows only known audiences
```

The strongest counterargument is `/api/session`: it releases `localIdentity.keyring`, which lets clients open and decrypt local workspace data. The current docs say bearer callers need `workspaces:open` before key release. If the scope is removed, the honest rule becomes: any valid access token for the API audience and user may retrieve that user's local identity.

That rule is acceptable only if the trusted-client boundary remains tight.

### Better Auth

DeepWiki and local installed source agree on the relevant Better Auth shape:

```txt
oauthProvider
  supports requirePKCE
  supports cachedTrustedClients
  supports validAudiences
  supports provider/client scopes

oauthProviderResourceClient().verifyAccessToken
  verifies token signature
  verifies issuer and audience
  can verify scopes if asked
```

Implication: Better Auth supports the collapsed model. We do not need a custom resource scope for token verification if issuer, audience, and user lookup are the intended boundary.

### OAuth Standards

OAuth scopes are optional request/response values in RFC 6749. They describe the scope of an access request, but the concrete values are defined by the authorization server.

RFC 6750 defines `insufficient_scope` for cases where a valid token lacks privileges required by a protected resource. It also says the `scope` attribute in `WWW-Authenticate` is optional and intended for programmatic use.

RFC 9700 emphasizes audience-restricted access tokens. It says access tokens should be restricted to a specific resource server, and every resource server should verify that the token was meant for it.

Implication: removing a fake custom scope does not violate OAuth. It makes audience carry the current boundary and leaves scopes available for future real client/resource distinctions.

Sources:

- RFC 6749, Access Token Scope: https://www.rfc-editor.org/rfc/rfc6749#section-3.3
- RFC 6750, Bearer errors and `insufficient_scope`: https://www.rfc-editor.org/rfc/rfc6750#section-3.1
- RFC 9700, audience-restricted access tokens: https://www.rfc-editor.org/rfc/rfc9700#section-4.10.2
- Better Auth OAuth provider docs: https://better-auth.com/docs/plugins/oauth-provider

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Bearer boundary | 2 coherence | Verify issuer, audience, signature, subject, and user existence | This matches the one-sentence model and avoids a fake permission bit. |
| Custom core API scope | 2 coherence | Remove `workspaces:open` as a required resource-boundary check | Every trusted client gets it, so it does not distinguish any real capability. |
| Client scope requests | 2 coherence | Remove `workspaces:open` from clients and server in the same change | Greenfield status removes the compatibility reason to stage the cleanup. |
| `InsufficientScope` | 2 coherence | Remove it from the core API once no custom resource scope is enforced | RFC 6750 supports it, but the current API will not have a real insufficient-scope case. |
| Future scopes | Deferred | Reintroduce only for differentiated client or app capabilities | Scopes become useful when two valid clients need different API powers. |
| `/api/session` key release | 2 coherence | Treat API-audience bearer identity as sufficient to fetch `localIdentity` | This is already the practical model if every trusted client gets the same custom scope. Document it clearly. |

## Architecture

Current:

```txt
Trusted client registry
  -> seeded OAuth clients
  -> all receive workspaces:open
  -> clients request workspaces:open
  -> bearer boundary requires workspaces:open
  -> domain policy checks real access
```

Collapsed:

```txt
Trusted client registry
  -> seeded OAuth clients
  -> clients request OIDC/offline scopes
  -> bearer boundary verifies API audience
  -> domain policy checks real access
```

Ownership:

```txt
Better Auth client rows own:
  which public clients may start OAuth
  redirect URIs
  PKCE requirement
  skipped consent for checked-in first-party clients

OAuth token verification owns:
  issuer
  audience
  signature
  expiration
  subject

Epicenter domain code owns:
  user exists
  workspace membership
  asset ownership
  billing gates
  localIdentity release shape
```

## Implementation Plan

### Phase 1: Collapse The Boundary

- [x] **1.1** Remove the `hasWorkspaceOpenScope(...)` check from `apps/api/src/auth/resource-boundary.ts`.
- [x] **1.2** Remove `WORKSPACES_OPEN_SCOPE`, `hasWorkspaceOpenScope`, and `OAuthError.InsufficientScope` from `apps/api/src/auth/oauth-error.ts` if no other caller remains.
- [x] **1.3** Collapse `apps/api/src/auth/oauth-resource.ts` to the invalid-token response path if `OAuthError` has only `InvalidToken`.
- [x] **1.4** Update tests that currently expect missing `workspaces:open` to return 403. The new expected behavior is that a valid API-audience token without the custom scope succeeds.
- [x] **1.5** Keep wrong-audience, wrong-issuer, malformed bearer, and deleted-user tests. Those are the real bearer-boundary tests.

### Phase 2: Remove The Scope Everywhere

- [x] **2.1** Remove `workspaces:open` from `apps/api/src/auth/oauth-config.ts`.
- [x] **2.2** Let `apps/api/src/auth/trusted-oauth-clients.ts` seed trusted client rows with only the remaining supported scopes.
- [x] **2.3** Remove `workspaces:open` from `packages/auth/src/oauth-launchers/index.ts`.
- [x] **2.4** Remove `workspaces:open` from `packages/auth/src/node/oob-launcher.ts`.
- [x] **2.5** Update trusted-client, launcher, and test-helper expectations to use `openid`, `profile`, `email`, and `offline_access`.
- [x] **2.6** Update `docs/encryption.md` so `/api/session` key release is described as cookie-or-API-bearer identity, not a `workspaces:open` gate.
- [x] **2.7** Search for stale `workspaces:open` references. Delete stale code and rewrite docs/tests that preserve the old vocabulary.

### Phase 3: Name The Future Scope Gate

- [x] **3.1** Add a short comment near the bearer resolver explaining when custom scopes should return: only when two valid clients need different API powers.
- [x] **3.2** Do not add `requireOAuthScope(...)` or an `OAUTH_ROUTE_POLICY` table in this change.
- [x] **3.3** If future scopes become necessary, expose product-boundary middleware names such as `requireAiUser` or `requireWorkspaceSyncUser`; keep raw OAuth scope names inside auth code.

## Test Plan

Run focused tests first:

```txt
bun test apps/api/src/auth/resource-boundary.test.ts
bun test apps/api/src/auth/oauth-resource.test.ts
bun test apps/api/src/api-session.test.ts
bun test apps/api/src/auth/trusted-oauth-clients.test.ts
bun test packages/auth/src/oauth-launchers/index.test.ts
```

Then run the impacted package checks:

```txt
bun run --filter @epicenter/api test
bun run --filter @epicenter/auth test
```

Use the repo's actual package scripts after checking `package.json`; the commands above describe the intended coverage, not a guaranteed script matrix.

## Edge Cases

### Existing Clients Still Request `workspaces:open`

This is out of scope under the greenfield assumption. If a deployed client exists, pause and convert this back to a staged migration.

### Manually Inserted OAuth Clients

If an attacker or operator manually inserts an OAuth client row with a valid redirect URI and API audience, the custom scope no longer adds a second gate. This is not a new product permission if the client could already receive `workspaces:open`, but the trusted-client seeding and dynamic-registration refusal must stay intact.

### `/api/session` Releases Local Identity

This is the most sensitive route in the collapse. The final documentation must say plainly:

```txt
A valid cookie session or a valid API-audience bearer token for the user can fetch localIdentity.
```

If that statement is unacceptable, do not collapse the scope. Instead, design a real key-release capability and make at least one valid client unable to receive it.

### Future Third-Party Clients

Do not use this collapse as a third-party OAuth design. Third-party clients need explicit consent, per-client grants, and real scopes. That is a separate product.

## Concepts Collapsed

This spec intentionally collapses:

```txt
workspaces:open
  into API audience, for the current first-party bearer boundary

InsufficientScope
  into InvalidToken, while the core API has no custom resource scopes

OAuth route policy
  into named product/domain middleware

AUTH_OAUTH_SCOPES as policy
  into provider-supported sign-in/refresh scopes
```

This spec does not collapse:

```txt
audience
  still required to prevent token replay across resource servers

issuer
  still required to prove who minted the token

PKCE
  still required for public clients

trusted client registry
  still required to pin client ids and redirect URIs

domain policy
  still required for workspace, asset, billing, and key-release behavior
```

## Open Questions

1. Are there any current first-party clients that should be denied an API route another first-party client can call?
2. Is `offline_access` needed by every trusted client, or only local-first clients with offline boot requirements?
3. Should `api.epicenter.so` remain the durable resource audience, or should the resource identifier become logical before more clients ship?
4. Should browser apps on Epicenter-owned origins prefer cookies, with OAuth reserved for CLI, extension, native, and cross-origin apps?
5. Should `/api/session` be split if key release and profile session projection need different rules later?
6. What is the review policy for adding a new trusted OAuth client?

## Grill Prompt

Use this prompt before implementation:

```txt
You are reviewing specs/20260520T221026-collapse-oauth-resource-scope.md.

Grill the plan relentlessly. Do not accept "simpler" as a sufficient reason.

Questions to force:

1. What concrete attack does workspaces:open stop today after issuer, audience, signature, expiration, subject, and user lookup pass?
2. Does any current trusted client need less API access than another trusted client?
3. Does /api/session key release need a separate capability, or is API-audience bearer identity enough?
4. Can any in-repo client fail if the server stops allowing workspaces:open before clients stop requesting it?
5. Are issuer and audience derived from stable enough values for localhost, wrangler dev, and production?
6. Does removing InsufficientScope hide a real client recovery path, or was it only supporting the fake scope?
7. Are dynamic registration, redirect URI pinning, PKCE, and trusted-client seeding tight enough to carry this collapse?
8. Are we preserving OAuth best practices: authorization code flow, PKCE, audience restriction, short-lived access tokens, and server-side domain policy?
9. Does every changed test prove a real invariant, or is any test only preserving the old vocabulary?
10. If future third-party clients arrive, where would real scopes re-enter without turning app.ts into a route-to-scope policy table?

Recommended decision to challenge:

Collapse workspaces:open in one breaking pass:
  1. Remove the bearer-boundary requirement.
  2. Remove the client requests, provider advertisement, and seeded client scopes.
  3. Delete stale tests, docs, and error variants.

Reject the plan if the answer to question 3 is "no" or if a current client needs real differentiated API access.
```

## Review

**Completed**: 2026-05-21
**Branch**: `codex/daemon-route-startup-cleanup`

### Summary

Implemented as one breaking wave. The API bearer boundary now verifies issuer, audience, signature, expiration, subject, and user existence, while workspace membership, asset ownership, billing, and key release remain server-side domain checks.

`workspaces:open` is gone from supported OAuth scopes, seeded trusted-client rows, browser and OOB launcher defaults, test helpers, and docs. `InsufficientScope` and the `insufficient_scope` HTTP/WebSocket response branch were deleted because the core API no longer enforces a custom resource scope.

### Deviations From Spec

- Added `packages/auth/src/node/oob-launcher.test.ts` to the focused launcher coverage because the OOB launcher also owns a default scope request.
- Repaired `apps/api/src/app.rooms.test.ts` so its `trusted-oauth-clients` mock preserves the real projection export. The full API test suite otherwise leaked that partial mock into `trusted-oauth-clients.test.ts`.
- The stale `workspaces:open` references remain inside this spec only, where they describe the removed behavior and the clean-break rationale.

### Verification

```txt
bun test apps/api/src/auth/resource-boundary.test.ts apps/api/src/auth/oauth-resource.test.ts apps/api/src/api-session.test.ts apps/api/src/auth/trusted-oauth-clients.test.ts packages/auth/src/oauth-launchers/index.test.ts packages/auth/src/node/oob-launcher.test.ts
  36 pass, 0 fail

bun run --filter @epicenter/api test
  94 pass, 0 fail

bun run --filter @epicenter/auth test
  53 pass, 0 fail

bun run --filter @epicenter/api typecheck
  pass

bun run --filter @epicenter/auth typecheck
  pass
```
