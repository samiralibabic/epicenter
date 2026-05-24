# Handoff Prompt: Post-OAuth Invariant Patch

Use this prompt for a coding agent that has repo access but no conversation history.

```txt
You are working in /Users/braden/Code/epicenter.

Task:
Implement the invariant patch described in specs/20260512T111335-post-oauth-audit-remediation.md.

Core thesis:
Keep same-user local workspaces alive during temporary network auth failure, and require every network resource to prove the OAuth scope it uses.

Why this should be done:
The branch already moved apps toward the OAuth AuthClient shape, but the migration is not trustworthy until two invariants are true:
1. Local identity and local Yjs workspace lifetime survive same-user refresh failure.
2. HTTP and WebSocket protected resources reject tokens that are valid but missing the required resource scope.

This is not an auth rewrite. Treat it as a narrow invariant patch.

Required reading:
- specs/20260512T111335-post-oauth-audit-remediation.md
- specs/20260511T150000-final-oauth-auth-architecture.md
- specs/20260512T100428-app-side-oauth-migration.md
- specs/20260504T233223-sign-out-preserves-local-data.md
- specs/20260512T114350-auth-token-capability-boundary.md, if present

Conflict answer:
This work does not conflict with the prior OAuth direction. It reinforces the AuthClient boundary, /workspace-identity, workspaces:open, and auth.openWebSocket.

The only subtle distinction is sign-out versus reauth-required:
- sign-out is account exit. It must destroy the live workspace and clear runtime key access.
- reauth-required is same-user network repair. It must keep the local workspace mounted.

Implementation order:
1. Seal protected API resources.
2. Fix dead /docs child sync routes.
3. Preserve same-user workspace lifetime during reauth-required.
4. Pick and implement one machine auth path.
5. Tighten WebSocket credential normalization.
6. Polish callback and extension durability.

Do not start with billing, deployable split, token storage naming, or API middleware cleanup.

Known relevant files:
- apps/api/src/auth/oauth-principal.ts
- apps/api/src/auth/workspace-identity.ts
- apps/api/src/auth/single-credential.ts
- apps/api/src/auth/workspace-identity.test.ts
- apps/api/src/auth/single-credential.test.ts
- apps/api/src/app.ts
- packages/svelte-utils/src/session.svelte.ts
- packages/svelte-utils/src/account-popover/account-popover.svelte
- apps/fuji/src/routes/(signed-in)/fuji/browser.ts
- apps/honeycrisp/src/routes/(signed-in)/honeycrisp/browser.ts
- apps/fuji/src/routes/+layout.svelte
- apps/honeycrisp/src/routes/+layout.svelte
- apps/opensidian/src/routes/+layout.svelte
- apps/dashboard/src/routes/+layout.svelte
- apps/tab-manager/src/entrypoints/sidepanel/App.svelte
- apps/zhongwen/src/routes/(signed-in)/+layout.svelte
- packages/auth/src/node/machine-auth.ts
- packages/auth/src/node/machine-auth.test.ts
- packages/cli/src/commands/auth.ts

Patch 1: Protected API resources
- Update resolveOAuthPrincipal so protected resources require workspaces:open.
- Prefer the Better Auth verifier scope option if local tests prove it works.
- Return an insufficient-scope result that HTTP routes can map to 403.
- Keep /workspace-identity as the key-release endpoint.
- Add focused tests for scoped token, missing scope, bad audience, bad issuer, malformed bearer input, and missing user.

Patch 2: Dead child document sync route
- Change Fuji and Honeycrisp child document sync URLs from /docs/${ydoc.guid} to /documents/${ydoc.guid}.
- Add a tiny route helper only if it removes repeated literals without hiding intent.
- Do not touch filesystem paths that intentionally use /docs as user document paths.

Patch 3: reauth-required workspace lifetime
- Change createSession so same-user reauth-required carries the existing signed-in payload.
- Dispose the payload only on signed-out, different user, or an explicit app-owned reload boundary.
- Update app gates that currently treat reauth-required as signed out.
- Add tests proving signed-in -> reauth-required -> signed-in preserves the same payload instance.
- Add tests proving signed-in user A -> signed-in user B disposes or refuses the live switch.

Patch 4: Machine auth
- Do not leave both machine auth paths half alive.
- Preferred path: replace device-code auth with loopback PKCE if CLI login is not already shipped through device authorization.
- If product evidence says device authorization is shipped, restore the Better Auth deviceAuthorization server plugin and test it against the production plugin set.
- Machine identity loading must use /workspace-identity, not /auth/get-session.
- Machine logout must revoke the OAuth refresh token through /auth/oauth2/revoke.

Patch 5: WebSocket normalization
- Keep bearer WebSocket sync as an OAuth protected resource.
- Reject duplicate credentials, including duplicate bearer subprotocol entries.
- Normalize the bearer subprotocol into Authorization once.
- Strip consumed bearer.* entries before forwarding to the Durable Object.
- Preserve the non-secret epicenter subprotocol.
- Make upgrade detection case-insensitive where the code branches on Upgrade.

Patch 6: Callback and extension durability
- Do not treat startSignIn success as signed-in until auth.state.status is signed-in.
- Add a shared callback helper only after one app proves the fixed flow.
- For WXT, decide locally whether auth launch belongs in the background entrypoint or whether sidepanel launch can be made resumable through storage.

MUST DO:
- Use bun for tests and scripts.
- Preserve existing uncommitted work. Do not revert user changes.
- Use the existing TypeScript and Svelte patterns.
- Keep AuthClient as state, startSignIn, signOut, fetch, and openWebSocket.
- Keep app code from constructing Authorization headers manually.
- Keep reauth-required distinct from signed-out.
- Update the spec checkboxes as work lands.

MUST NOT:
- Do not reintroduce cookie-first app auth.
- Do not add raw token getters to AuthClient.
- Do not make sync, workspace, chat, or UI own access tokens or refresh tokens.
- Do not mix billing cleanup into this patch.
- Do not start the deployable split.
- Do not keep a live workspace after real sign-out.
- Do not rename token storage shapes unless the sibling token-capability spec is explicitly in scope.
- Do not use npm, yarn, pnpm, or npx.
- Do not use em dashes or en dashes in source, specs, comments, docs, or commit messages.

Verification:
Run focused tests after each patch where possible:

bun test apps/api/src/auth
bun test packages/auth
bun test packages/svelte-utils
bun --cwd apps/fuji run typecheck
bun --cwd apps/honeycrisp run typecheck
bun --cwd apps/tab-manager run typecheck

Manual smoke checks:
- Fuji: sign in, create entry, edit rich text body, confirm child sync uses /documents, force refresh failure, confirm local entry remains visible.
- Honeycrisp: sign in, create note, edit rich text body, confirm child sync uses /documents, force refresh failure, confirm local note remains visible.
- Tab Manager: start sign-in from sidepanel, close and reopen during auth if possible, confirm there is no stuck PKCE transaction.

Final response:
- List files changed.
- State which patches landed and which remain.
- Report tests run and failures.
- Call out any conflict with the adjacent specs. If there is no conflict, say so plainly.
```
