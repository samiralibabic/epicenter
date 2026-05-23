# Fuji signed-in route boundary

**Date**: 2026-05-12
**Status**: Draft (updated 2026-05-12 for the nullable `Session<T>` reshape; see [Updated to match nullable Session](#updated-to-match-nullable-session))
**Author**: AI-assisted
**Branch**: not started
**Grounding**: local Fuji, Zhongwen, Honeycrisp route code; Svelte 5.45.2 and SvelteKit 2.49.0 from `package.json`; official Svelte, SvelteKit, Auth0, Google OAuth, and Microsoft Entra docs; DeepWiki checks against `sveltejs/svelte`, `sveltejs/kit`, and `better-auth/better-auth`.

## Updated to match nullable Session

The original draft of this spec gated route access on
`session.current.status === 'signed-in'` and reached the workspace through
`current.signedIn.fuji`. After `specs/20260512T220000-session-two-axis-cohesive-reshape.md`
landed, `Session<T>` is now `SessionPayload<T> | null` (no discriminant field),
`requireSignedIn` was renamed to `requireIdentity`, each app's
`getSignedInSession()` was renamed to `requireWorkspace()`, and the app-side
session module is now `src/lib/session.ts` (not `session.svelte.ts`). The
examples below have been rewritten to gate on `if (session.current)` and read
`current.workspace.fuji.idb.whenLoaded`. The route-ownership thesis is
unchanged.

## One-sentence thesis

```txt
In Fuji, every protected URL either renders authed content or bounces to /sign-in, which launches hosted Epicenter OAuth or renders why it couldn't; after sign-in, the user lands on /.
```

## Overview

Fuji currently renders a full sign-in fallback from `apps/fuji/src/routes/(signed-in)/+layout.svelte` and does not yet have an app-level `/sign-in` page. This spec chooses one owner for each concern: the signed-in route group owns access and workspace readiness, while a new sign-in page absorbs all unauthenticated traffic, bounces to hosted Epicenter OAuth, and is the only URL that renders OAuth launch failure UI.

`/sign-in` is a bounce route, not a sign-in form. It earns its keep as the error surface and bookmark target for unauthenticated users. The protected layout cannot render OAuth launch errors honestly because by definition it is a protected boundary; `/sign-in` exists so unauth UI has one stable home.

This spec **refuses `returnTo`**. After sign-in, the user always lands on `/`. Rationale lives in [Refusal: returnTo](#refusal-returnto). The refusal collapses the entire cross-package threading discussion, leaves `packages/oauth-client` and `@epicenter/auth` untouched, and removes a permanent invariant that did not appear in the product sentence.

This is a cleanup spec. It keeps `createSession`, `session.current`, `WorkspaceGate`, and hosted OAuth intact. After the [nullable `Session<T>` reshape](#updated-to-match-nullable-session), `session.current` is `SessionPayload<TWorkspace> | null`, so the route layout gates on `if (session.current)` and reaches the workspace through `current.workspace.fuji`.

## Motivation

### Current state

Fuji's protected layout currently does all of this:

```svelte
<!-- apps/fuji/src/routes/(signed-in)/+layout.svelte -->
{#if session.current}
	<WorkspaceGate pending={session.current.workspace.fuji.idb.whenLoaded}>
		<FujiAppShell>{@render children?.()}</FujiAppShell>
	</WorkspaceGate>
{:else}
	<div>
		<p>Sign in to Fuji</p>
		{#if signInError}<p>{signInError}</p>{/if}
		<Button
			disabled={signingIn}
			onclick={async () => {
				signInError = null;
				signingIn = true;
				try {
					const { error } = await auth.startSignIn();
					if (error) signInError = error.message;
				} finally {
					signingIn = false;
				}
			}}
		>
			...
		</Button>
	</div>
{/if}
```

That file currently owns six jobs:

```txt
route access
workspace readiness
app shell wrapping
sign-in screen rendering
sign-in button pending state
sign-in error state
```

Fuji does not currently have:

```txt
apps/fuji/src/routes/sign-in/+page.svelte
```

The current inline fallback owns a button handler:

```ts
let signingIn = $state(false);
let signInError = $state<string | null>(null);

async function startSignIn() {
	signInError = null;
	signingIn = true;
	try {
		const { error } = await auth.startSignIn();
		if (error) signInError = error.message;
	} finally {
		signingIn = false;
	}
}
```

That handler is not wrong. The stronger cleanup is that Fuji should not render an intermediate local sign-in screen at all. `auth.startSignIn()` already delegates to `createBrowserOAuthLauncher`, which creates an OAuth authorization URL and assigns `window.location.href` to the hosted API flow.

This creates problems:

1. **No public sign-in route**: a signed-out user can only begin Fuji sign-in by entering a protected route.
2. **Hybrid layout ownership**: a file named by a signed-in route group also owns signed-out UI.
3. **Unneeded local prompt**: hosted Epicenter already owns credential UI, provider choice, recovery, and future factors.
4. **False smell around `try/finally`**: the local button handler is fine, but the cleanest Fuji route does not need the button at all.

### Desired state

```txt
apps/fuji/src/routes/
  sign-in/
    +page.svelte
      owns:
        hosted OAuth launch
        launch loading state
        launch error display
        signed-in redirect back to app

  (signed-in)/
    +layout.svelte
      owns:
        redirect away when not signed in
        WorkspaceGate
        FujiAppShell
        child rendering
```

The protected layout becomes:

```svelte
<script lang="ts">
	import { goto } from '$app/navigation';
	import { Loading } from '@epicenter/ui/loading';
	import { WorkspaceGate } from '@epicenter/svelte/workspace-gate';
	import { session } from '$lib/session';
	import { auth } from '$platform/auth';
	import FujiAppShell from './components/FujiAppShell.svelte';

	let { children } = $props();

	const current = $derived(session.current);

	$effect(() => {
		if (!current) {
			void goto('/sign-in', { replaceState: true });
		}
	});
</script>

{#if current}
	<WorkspaceGate
		pending={current.workspace.fuji.idb.whenLoaded}
		onSignOut={() => auth.signOut()}
	>
		<FujiAppShell>{@render children?.()}</FujiAppShell>
	</WorkspaceGate>
{:else}
	<Loading class="h-dvh" />
{/if}
```

No `returnTo`. The protected layout knows nothing about the user's original path.

## Research findings

### Local route patterns

| App | Protected layout behavior | Dedicated sign-in route | Notes |
| --- | --- | --- | --- |
| Fuji | Inline sign-in fallback in `(signed-in)/+layout.svelte` | No | Public sign-in route is missing |
| Honeycrisp | Inline sign-in fallback in `(signed-in)/+layout.svelte` | No | Current pattern is coherent because no separate sign-in route exists |
| Opensidian | Inline sign-in fallback in `(signed-in)/+layout.svelte` | No | Same as Honeycrisp |
| Zhongwen | Redirects from `(signed-in)/+layout.svelte` to `/sign-in` | Yes | Cleanest local precedent for Fuji |
| Dashboard | Inline sign-in fallback in protected layout | No | Small admin-like app, no separate sign-in page |
| Tab Manager | Sidepanel-local gate with `{#await}` | Not SvelteKit route app | WXT entrypoint, not comparable to SvelteKit page routing |

Key finding: the split route model is already present in Zhongwen. The inline fallback model is not universally wrong; it becomes muddy once the product wants a real public sign-in route. Fuji is at that fork now.

### Svelte and SvelteKit grounding

SvelteKit's loading docs say route components render after their load functions and that layout load data is shared with child routes. They also include an auth warning: layout loads do not run on every request, including client navigation between child routes, and layout and page loads run concurrently unless the page waits for `parent()`. Source: [SvelteKit loading data docs](https://svelte.dev/docs/kit/load).

Implication for Fuji: do not move this guard into a `+layout.ts` load just for aesthetic purity. Fuji is an adapter-static SPA with `ssr = false`; its auth state is client-side and reactive. A component-level `$effect` that watches `session.current` is the honest boundary for mid-session sign-out or reauth-required transitions.

SvelteKit's auth best-practice page says cookies can be checked in server hooks and user data can be stored in `locals`. Source: [SvelteKit auth docs](https://svelte.dev/docs/kit/auth).

Implication for Fuji: that server-hook pattern is not the primary fit here because Fuji's app auth state is held by the browser-side Epicenter auth client, and the app disables SSR. The spec should not invent server auth plumbing for this cleanup.

Svelte's await block docs define pending, then, and catch branches for promise-driven rendering. Source: [Svelte await docs](https://svelte.dev/docs/svelte/await).

Implication for Fuji: `WorkspaceGate` or `{#await}` is the right shape for workspace readiness. A local `signingIn` flag would be appropriate for a click handler, but the preferred `/sign-in` route should not render a click target. It should launch hosted OAuth on mount and render loading or error UI.

SvelteKit's `$app/navigation` docs define `goto` as the client navigation primitive and include `replaceState` behavior in navigation APIs. Source: [SvelteKit `$app/navigation` docs](https://svelte.dev/docs/kit/%24app-navigation).

Implication for Fuji: `goto('/sign-in', { replaceState: true })` is an acceptable client-side redirect for this SPA route guard. It should be paired with a loading branch so the protected page does not flash stale signed-in UI while navigation happens.

DeepWiki check against `sveltejs/svelte` and `sveltejs/kit` matched this split:

```txt
user-triggered async action:
  local component state plus try/finally is acceptable

route protection and resource readiness:
  prefer route/load/redirect/structural rendering depending on where the state lives

Fuji-specific adjustment:
  because auth state is browser-reactive and SSR is disabled, keep the signed-in guard in component structure, not a server hook or server load
```

### Hosted OAuth launcher grounding

Fuji's auth client is already configured as an OAuth app:

```ts
export const auth = createOAuthAppAuth({
	baseURL: APP_URLS.API,
	clientId: EPICENTER_FUJI_OAUTH_CLIENT_ID,
	launcher: createBrowserOAuthLauncher({
		issuer: `${APP_URLS.API}/auth`,
		redirectUri: `${window.location.origin}/auth/callback`,
		resource: APP_URLS.API,
		...
	}),
});
```

`createBrowserOAuthLauncher.startSignIn()` first tries to complete a callback from the current URL. If there is no callback transaction, it creates an authorization URL and navigates the browser to it:

```ts
const urlResult = await client.createAuthorizationUrl();
await redirectTo(urlResult.data.toString());
return Ok(null);
```

Implication for Fuji: a local sign-in button is optional ceremony. The real credential boundary is already hosted OAuth. `/sign-in` is a launcher route that immediately calls `auth.startSignIn()`. The package signature stays `startSignIn(): Promise<Result<undefined, AuthError>>`. No `returnTo` parameter, no widened result, no transaction widening.

## Refusal: returnTo

This spec refuses the "return the user to their original URL after sign-in" feature. Sign-in always lands on `/`.

### Asymmetric wins record

```txt
Product sentence:
  Fuji is a journaling app where signed-in users edit and sync entries.

Candidate refusal:
  returnTo (preserve the user's original path across sign-in)

Code family it deletes:
  - OAuthTransaction.returnTo field in packages/oauth-client
  - OAuthLauncher.startSignIn({ returnTo }) input
  - AuthClient.startSignIn({ returnTo }) input in @epicenter/auth
  - AuthClient.startSignIn result widening to { returnTo: string | null }
  - URL ?returnTo= round-trip plumbing
  - safeReturnTo predicate and its three call sites
  - sessionStorage helper (consumeReturnTo / rememberReturnTo)
  - "Validation owner" doctrine across three layers
  - "Opaque passthrough" doctrine in two packages
  - Tests for the returnTo round-trip at every layer
  - Hostile-input verification in acceptance criteria
  - Two non-goal lines about state encoding and validation placement

User loss:
  After signing in from a deep link or after mid-session re-auth,
  the user lands on / instead of their original protected path.
  Cost is at most ~2 clicks to navigate back to the entry they wanted.

Decision:
  Refuse. The feature is not in the product sentence. Frequency is rare
  for a personal journaling app with auto-refresh tokens. Severity is
  mild. Reversal cost is low: if real users report the pain, a future
  spec can add the Fuji-local sessionStorage variant in ~30 LOC without
  touching any package.
```

### Scenarios honestly priced

| Scenario | With returnTo | Without (this spec) | Frequency for Fuji |
| --- | --- | --- | --- |
| Signed-out user opens deep link to `/entries/abc` | Lands on `/entries/abc` | Lands on `/`, clicks into entry | Rare (no email-driven deep links yet) |
| Mid-session token revocation while editing | Re-auth, lands back on `/entries/abc` (URL only; edit buffer is gone either way because workspace was disposed) | Re-auth, lands on `/`, clicks into entry | Very rare (access tokens auto-refresh) |
| Stale bookmark to specific entry | Lands on entry | Lands on `/`, navigates from entry list | Rare |
| Signed-in user opens `/sign-in` directly | Lands on `/` | Lands on `/` | Same |
| OAuth launch error | Renders on `/sign-in` | Renders on `/sign-in` | Same |

The mid-session case looks worst on paper but is the one the workspace lifecycle already mishandles independently: the protected layout disposes the signed-in payload when auth flips, so the in-memory edit context is gone with or without `returnTo`. Restoring the URL alone does not restore the user's place in the entry.

### When to revisit

Add a Fuji-local `returnTo` (sessionStorage variant, ~30 LOC, app-only, no package changes) if any of the following becomes true:

```txt
A specific user reports landing on / as a frustration tied to a concrete workflow.
Fuji ships email-driven deep links or marketing links into specific entries.
Mid-session re-auth becomes a real flow (e.g. a planned device-revocation feature).
A second app in this repo independently asks for the same behavior, suggesting
a shared @epicenter/svelte helper is worth extracting.
```

Until then, sign-in lands on `/`.

### Server `try/finally` is a different category

`apps/api/src/app.ts` uses `try/finally` for request-scoped resource lifetime:

```ts
try {
	await client.connect();
	c.set('db', drizzle(client, { schema }));
	c.set('afterResponse', afterResponse);
	await next();
} finally {
	c.executionCtx.waitUntil(
		afterResponse.drain().then(() => client.end()),
	);
}
```

That is not evidence against local Svelte action state. It is a different invariant:

```txt
server middleware finally:
  guarantee cleanup after request handling

sign-in launcher route:
  calls hosted OAuth and shows launch failure if redirect cannot start

workspace readiness:
  structural rendering around a promise
```

The cleanup does not remove `try/finally` because it is bad. It removes the local button because hosted OAuth is already the sign-in UI.

## Design decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Protected route owner | 2 coherence | `(signed-in)/+layout.svelte` owns route access and workspace readiness only | Matches the one-sentence thesis and removes hybrid ownership |
| Sign-in launch owner | 2 coherence | `sign-in/+page.svelte` calls `auth.startSignIn()` on mount | The local route is only a public launcher for hosted OAuth |
| Redirect mechanism | 1 evidence | `$effect` with `goto('/sign-in', { replaceState: true })` | Fuji is an SSR-disabled SPA; SvelteKit docs warn layout loads are not a complete reactive auth boundary |
| Return path preservation | 2 coherence | Refused. Sign-in always lands on `/` | Not in Fuji's product sentence; rare and mild user impact; reversal cost is low. See [Refusal: returnTo](#refusal-returnto) |
| Loading during redirect | 2 coherence | Render `<Loading class="h-dvh" />` while not signed in inside the protected layout | Avoids rendering signed-out UI inside the signed-in route group |
| Workspace readiness | 1 evidence | Keep `WorkspaceGate pending={current.workspace.fuji.idb.whenLoaded}` | Matches current code and Svelte's structural async rendering model |
| Inline sign-in fallback | 2 coherence | Move out of Fuji protected layout into a new `/sign-in` page | Public sign-in route and protected app boundary should not be the same file |
| Shared sign-in component | 3 taste | Do not extract | The target has no reusable local sign-in screen |
| Honeycrisp and Opensidian | Deferred | Leave unchanged | They do not currently have dedicated sign-in routes, so their inline fallback is coherent enough for this spec |
| Zhongwen | Deferred | Leave unchanged | Already uses the target route split |

## Architecture

Ownership after the cleanup:

```txt
apps/fuji/src/routes/sign-in/+page.svelte
  owns:
    hosted OAuth launch
    launch loading state
    launch error display
    redirect away after signed-in auth state appears

apps/fuji/src/routes/(signed-in)/+layout.svelte
  owns:
    current = session.current
    redirect to /sign-in when current is null
    WorkspaceGate pending state
    FujiAppShell around children

apps/fuji/src/lib/session.ts
  owns:
    auth-state to Fuji workspace lifecycle
    workspace payload construction
    `requireWorkspace()` invariant for descendants

apps/fuji/src/routes/auth/callback/+page.svelte
  owns:
    completing the OAuth callback through auth.startSignIn()
    callback error display
    redirect to app after callback success
```

Flow for a signed-out deep link:

```txt
1. User opens /entries/abc.
2. `(signed-in)/+layout.svelte` mounts.
3. `session.current` is null.
4. Layout calls `goto('/sign-in', { replaceState: true })`.
5. Layout renders `<Loading class="h-dvh" />` while navigation settles.
6. `/sign-in/+page.svelte` calls `auth.startSignIn()` on mount.
7. The browser navigates to hosted Epicenter OAuth.
8. Callback route completes auth via `auth.startSignIn()`.
9. Callback route navigates to `/`.
10. Signed-in layout sees `current` is non-null.
11. `WorkspaceGate` waits for `current.workspace.fuji.idb.whenLoaded`.
12. `FujiAppShell` renders the app home.
```

The user opened `/entries/abc` and now sees `/` with the entry list. To reach the original entry, they click into it. This is the accepted cost of refusing `returnTo`.

Flow for mid-session sign-out:

```txt
1. User is on a protected Fuji route.
2. `auth.state` changes to signed-out.
3. `createSession` disposes the workspace payload.
4. `session.current` is null.
5. Protected layout effect navigates to `/sign-in`.
6. Protected layout renders only loading during the transition.
7. After re-auth, callback redirects to `/`.

Note: same-user `reauth-required` no longer disposes the workspace payload, so
this flow is now only triggered by real sign-out (or a different user signing
in). During `reauth-required`, `session.current` keeps the same
`SessionPayload` reference and the protected layout stays mounted.
```

## Implementation plan

### Phase 1: Narrow Fuji protected layout

- [ ] Remove `Button` and `LoaderCircle` imports from `apps/fuji/src/routes/(signed-in)/+layout.svelte`.
- [ ] Remove `signingIn` and `signInError` state from the protected layout.
- [ ] Add `Loading` and `goto` imports.
- [ ] Add a `$effect` that, when `session.current` is null, calls `goto('/sign-in', { replaceState: true })`.
- [ ] Replace the signed-out fallback with `<Loading class="h-dvh" />`.
- [ ] Keep the signed-in branch and `WorkspaceGate` behavior intact.

### Phase 2: Create the Fuji sign-in page

- [ ] Add `apps/fuji/src/routes/sign-in/+page.svelte`.
- [ ] Add an effect that redirects to `/` when `auth.state.status === 'signed-in'`.
- [ ] Add an effect that calls `auth.startSignIn()` when not signed in. No parameters.
- [ ] Render `<Loading class="h-dvh" label="Signing in..." />` while the OAuth launch is pending.
- [ ] Render destructive text if `auth.startSignIn()` returns an error. This is the only Fuji route where OAuth launch errors render.
- [ ] Do not add a local sign-in button. `/sign-in` is a bounce route, not a form.

### Phase 3: Confirm callback navigation lands on `/`

- [ ] `apps/fuji/src/routes/auth/callback/+page.svelte` already calls `auth.startSignIn()` and `goto('/', { replaceState: true })` on success. Leave as-is.
- [ ] Verify the existing callback error display still surfaces failures.

### Phase 4: Prove behavior

- [ ] Run `bun run --filter @epicenter/fuji typecheck` if package filtering is available in this repo.
- [ ] If package filtering is not available, run the Fuji app's local typecheck script from `apps/fuji`.
- [ ] Open Fuji locally and verify:
  - signed-out deep link redirects to `/sign-in` (no query params)
  - after OAuth callback, the user lands on `/` regardless of the original deep link
  - signed-in `/sign-in` redirects to `/`
  - `/sign-in` renders an error message when `auth.startSignIn` returns an error (simulate by pointing the launcher at a bad issuer)
  - protected routes still render through `WorkspaceGate`
  - no sign-in UI remains in `(signed-in)/+layout.svelte`

## Non-goals

```txt
Do not redesign createSession.
Do not move Fuji auth into server hooks.
Do not replace WorkspaceGate.
Do not change apps/api/src/app.ts request middleware.
Do not normalize Honeycrisp, Opensidian, Dashboard, or Tab Manager in this spec.
Do not introduce a shared SignInCard component.
Do not add returnTo, ?returnTo, sessionStorage helpers, or any mechanism to preserve the user's original URL across sign-in. See Refusal: returnTo. Sign-in always lands on /.
Do not extend packages/oauth-client or @epicenter/auth in this spec. Both packages stay untouched.
```

## Risks and checks

| Risk | Check |
| --- | --- |
| Redirect loop if `/sign-in` is accidentally placed under `(signed-in)` | Create `apps/fuji/src/routes/sign-in/+page.svelte` as a sibling of `(signed-in)`, not a child |
| Brief blank or flash during redirect | Protected layout renders `Loading`, not sign-in UI and not children |
| Mid-session sign-out after child mounted | `session.current` change triggers the protected layout branch and unmounts children |
| TypeScript narrowing regression | Signed-in branch still guards `current.workspace` access through the `if (current)` truthy narrowing |
| User confusion landing on `/` after deep link | Accepted cost. Reversible by adding the Fuji-local sessionStorage variant later if real users report friction |

## Open questions

1. Should Honeycrisp and Opensidian also get dedicated sign-in pages?

   Not in this spec. The inline fallback is less muddy there because no separate sign-in route exists. If the product wants consistent app-level routes, write a follow-up cleanup that creates `/sign-in` for each app first, then removes inline fallbacks.

2. Should the protected layout use `goto` or SvelteKit `redirect` from a load function?

   For Fuji today, use `goto`. `redirect` from load is cleaner for server-known auth, but Fuji disables SSR and the live auth state is client reactive. A load-only guard would still need component-level handling for mid-session changes.

3. Older specs (`20260511T092357-auth-hosted-sign-in-clean-break.md`, `20260511T105846-auth-oauth-everywhere-clean-break.md`, `20260511T150000-final-oauth-auth-architecture.md`, `20260512T100428-app-side-oauth-migration.md`, `20260512T111335-post-oauth-audit-remediation.md`, `20260512T114350-auth-token-capability-boundary.md`) propose `startSignIn({ returnTo })` API shapes that this spec refuses. None of those shapes shipped to code. Decision deferred: either annotate those specs as superseded by this refusal, or leave them as historical drafts.

## Acceptance criteria

```txt
Fuji has exactly one sign-in entrypoint: apps/fuji/src/routes/sign-in/+page.svelte.
Fuji protected layout has no sign-in button state.
Fuji protected layout redirects when session.current is null to /sign-in.
Fuji /sign-in launches hosted Epicenter OAuth without rendering a local sign-in button.
Fuji /auth/callback navigates to / on success.
Fuji protected layout still gates signed-in content with WorkspaceGate.
Fuji signed-in descendants continue to use requireWorkspace().
packages/oauth-client is unchanged.
@epicenter/auth is unchanged.
Typecheck passes for Fuji.
```
