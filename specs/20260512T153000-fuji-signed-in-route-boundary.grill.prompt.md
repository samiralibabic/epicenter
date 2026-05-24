# Grill and DeepWiki prompt: Fuji signed-in route boundary

Use this prompt to stress-test `specs/20260512T153000-fuji-signed-in-route-boundary.md` in a fresh coding-agent thread.

```txt
Use the grill-me skill.

Interview me relentlessly about the Fuji signed-in route boundary spec until we reach shared understanding. Ask one question at a time. For each question, include your recommended answer before waiting for me.

Before asking questions, ground the spec against:
  - local code
  - DeepWiki for better-auth/better-auth
  - DeepWiki for sveltejs/svelte and sveltejs/kit
  - official OAuth/OIDC docs when needed

Spec under review:
  specs/20260512T153000-fuji-signed-in-route-boundary.md

Code under review:
  packages/oauth-client/src/index.ts
  packages/auth/src/auth-contract.ts
  packages/auth/src/create-oauth-app-auth.ts
  packages/auth-svelte/src/create-auth.svelte.ts
  apps/fuji/src/lib/platform/auth/auth.ts
  apps/fuji/src/routes/(signed-in)/+layout.svelte
  apps/fuji/src/routes/sign-in/+page.svelte (target file, currently missing before implementation)
  apps/fuji/src/routes/auth/callback/+page.svelte
  apps/fuji/src/lib/session.svelte.ts
  apps/zhongwen/src/routes/(signed-in)/+layout.svelte
  apps/zhongwen/src/routes/sign-in/+page.svelte
  apps/api/src/app.ts

Grill goals:
  1. Prove whether `/sign-in` should be a hosted OAuth launcher instead of a local button page.
  2. Prove whether the protected layout should use `goto('/sign-in?returnTo=...')` for an SSR-disabled SvelteKit app.
  3. Challenge whether `returnTo` belongs in `packages/oauth-client` transaction state.
  4. Challenge the proposed `AuthClient.startSignIn({ returnTo })` API shape and result data shape.
  5. Challenge whether Better Auth `callbackURL` should be used instead, and explain why or why not.
  6. Challenge open-redirect protections for `returnTo`.
  7. Challenge whether this spec should include Honeycrisp and Opensidian or stay Fuji-only.
  8. Challenge whether the current inline fallback is actually better product behavior.
  9. End with the one-sentence test. If the system cannot be named in one concrete sentence, do not call the spec ready.

DeepWiki questions to ask if not already answered:
  1. In better-auth/better-auth oauth-provider mode, is the OAuth client's `state` preserved and returned unchanged to `redirect_uri`?
  2. How is Better Auth social sign-in `callbackURL` different from oauth-provider client `state`?
  3. In SvelteKit with `ssr = false`, is a component-level `goto` guard appropriate for browser-reactive auth state?
  4. What security constraints apply when using OAuth `state` or local transaction storage to remember app return paths?

If a question can be answered by reading code, read the code instead of asking me.

Output expected:
  - Findings first, ordered by severity.
  - Then unresolved questions.
  - Then concrete edits to improve the spec.
  - Do not implement the feature. This is a spec grill only.
```
