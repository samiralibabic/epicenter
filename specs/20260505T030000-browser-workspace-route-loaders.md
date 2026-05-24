# Browser workspace bootstrap via SvelteKit route loaders

**Date**: 2026-05-05
**Status**: Implemented zhongwen pilot, revised by 20260505T040000 then 20260505T060000
**Author**: AI-assisted, grounded against live code, DeepWiki, and SvelteKit docs
**Branch**: not started
**Depends on**: `specs/20260505T020000-collapse-owner-scoping-onto-coordinator.md`
**Pairs with**: `specs/20260505T035000-primitive-cleanup-post-collapse.md`
**Defers**: WXT sidepanel bootstrap for tab-manager

## One-sentence thesis

SvelteKit browser apps construct authenticated workspaces in authed route-group `+layout.ts` loaders, pass the workspace through typed `data`, and redirect signed-out users to a separate sign-in route group; module-level `client.ts` singletons disappear for SvelteKit apps only.

## Clean-break rule

This spec does not need every intermediate commit to keep every SvelteKit app
runnable. During implementation, it is acceptable for imports, routes, or app
shells to break while the old singleton path is being removed. The required
final state is:

```txt
signed-out routes do not construct workspaces
signed-in routes construct workspaces from a proven signed-in identity
SvelteKit apps do not import module-level workspace client singletons
browser factories do not null-check auth.identity
no compatibility wrapper preserves the old client.ts path
```

Prefer deleting the old path and fixing the compile fallout over building a
temporary bridge that keeps both boot models alive.

## Why this spec exists

The current browser bootstrap checks the same invariant too late and too often:

```ts
export const auth = createCookieAuth({ baseURL: APP_URLS.API });
await auth.whenReady;
if (auth.identity === null) {
	throw new Error('Cannot open Fuji workspace: auth identity is required.');
}
export const fuji = openFuji({ auth, peer });
```

Then the factory checks it again:

```ts
const identity = auth.identity;
if (identity === null) {
	throw new Error('openFuji requires signed-in auth.identity. Await auth.whenReady first.');
}
```

The invariant is simple: browser workspace factories require a signed-in auth identity. Today that invariant is enforced at module import time, which gives SvelteKit no route-level signed-out path. It also leaves `bindAuthWorkspaceScope` to reload the page on sign-out or identity change.

The asymmetric win is not "delete auth handling." It is "move signed-in workspace construction to the route boundary that already owns whether this route can render."

## Grounding

SvelteKit supports this shape for the SvelteKit apps:

- Official SvelteKit docs say universal `load` functions run in the browser when SSR is disabled.
- Layout `load` data is available to child layouts and pages through `data`.
- `redirect(status, location)` is the framework primitive for route redirects during request or load handling.
- `invalidateAll()` reruns all load and query functions for the active page and resolves after the page updates.

DeepWiki did not have enough SvelteKit-specific detail in `sveltejs/svelte`, so the SvelteKit points above are grounded in official Svelte docs instead.

DeepWiki did answer the WXT question: WXT supports Svelte through `@wxt-dev/module-svelte`, but extension entrypoints like sidepanel are static HTML entrypoints. It does not provide SvelteKit `+layout.ts` loaders or `redirect()` semantics. That means tab-manager is not part of this SvelteKit route-loader migration.

Better Auth supports reactive client session state and subscriptions. That backs the decision to react to sign-in and sign-out without a full page reload.

## Scope

In scope:

```txt
apps/fuji
apps/honeycrisp
apps/opensidian
apps/zhongwen
```

Out of scope for this spec:

```txt
apps/tab-manager
```

Tab-manager is a WXT sidepanel. It should get its own bootstrap spec that replaces module-level throws with a sidepanel-local state gate. It cannot be migrated by copying SvelteKit route-loader code.

## Desired route shape

Use route groups so the sign-in page does not inherit the authed workspace loader:

```txt
apps/fuji/src/routes/
  +layout.svelte
  (public)/
    sign-in/
      +page.svelte
  (authed)/
    +layout.ts
    +layout.svelte
    +page.svelte
    entries/[id]/+page.svelte
    trash/+page.svelte
```

The public route owns only auth UI. The authed route owns workspace construction.
The SPA `/sign-in` route is separate from the API server's `/sign-in` route in
`apps/api/src/app.ts`: they live on different origins (`fuji.epicenter.so`,
`zhongwen.epicenter.so`, etc. versus `api.epicenter.so`). The SPA page starts
the Better Auth redirect and uses the app origin as the callback URL; the API
page still owns first-party auth rendering for device, consent, and direct API
sign-in flows.

## Desired loader shape

```ts
import { isSignedIn } from '@epicenter/auth';
import { createCookieAuth } from '@epicenter/auth-svelte';
import { APP_URLS } from '@epicenter/constants/vite';
import { invalidateAll } from '$app/navigation';
import { redirect } from '@sveltejs/kit';
import { openFuji } from '$lib/fuji/browser';

export const ssr = false;

let cached:
	| {
			auth: ReturnType<typeof createCookieAuth>;
			fuji: ReturnType<typeof openFuji>;
			unsubscribe: () => void;
	  }
	| null = null;

export async function load() {
	if (cached && cached.auth.identity !== null) {
		return { auth: cached.auth, fuji: cached.fuji };
	}

	const auth = cached?.auth ?? createCookieAuth({ baseURL: APP_URLS.API });
	await auth.whenReady;

	if (!isSignedIn(auth)) {
		cached?.unsubscribe();
		auth[Symbol.dispose]();
		cached = null;
		redirect(307, '/sign-in');
	}

	const fuji = openFuji({
		auth,
		peer: {
			id: getOrCreateInstallationId(localStorage),
			name: 'Fuji',
			platform: 'web',
		},
	});

	const unsubscribe = auth.onChange((next) => {
		if (next === null) {
			cached?.unsubscribe();
			cached?.fuji[Symbol.dispose]();
			cached?.auth[Symbol.dispose]();
			cached = null;
			void invalidateAll();
			return;
		}

		if (next.user.id !== fuji.userId) {
			cached?.unsubscribe();
			cached?.fuji[Symbol.dispose]();
			cached?.auth[Symbol.dispose]();
			cached = null;
			void invalidateAll();
			return;
		}

		fuji.encryption.applyKeys(next.encryptionKeys);
	});

	cached = { auth, fuji, unsubscribe };
	return { auth, fuji };
}
```

This is sample shape, not copy-paste implementation. Each app still owns its peer setup and child-document bundle shape.

## Type boundary

Add the signed-in auth type to core auth, then re-export it from auth-svelte:

```ts
export type SignedInAuth = AuthClient & {
	readonly identity: AuthIdentity;
};

export function isSignedIn(auth: AuthClient): auth is SignedInAuth {
	return auth.identity !== null;
}
```

Browser factories then take only what they need:

```ts
export function openFuji({
	auth,
	peer,
}: {
	auth: SignedInAuth;
	peer: PeerIdentity;
}) {
	const userId = auth.identity.user.id;
	// no null check here
}
```

This removes the factory throw because the route loader owns the signed-in invariant.

## What happens to `bindAuthWorkspaceScope`

Do not delete `packages/auth-workspace` in the same wave that introduces the loader pattern.

The package currently owns real concurrency behavior:

- it applies the initial identity
- it deduplicates same-user key refreshes
- it enters a terminal state on sign-out or user switch
- it serializes overlapping auth emissions
- it unsubscribes cleanly

The SvelteKit loader should not blindly copy this state machine. The route
boundary changes the problem:

- initial identity is checked directly after `await auth.whenReady`
- same-user duplicate sessions are already filtered by `createAuthCore`
- identical keyrings are already ignored by `encryption.applyKeys`
- terminal transitions can dispose synchronously, clear the loader cache, and
  let `invalidateAll()` rerun the route

The pilot should prove that this smaller handler covers the live behavior. If
an async terminal callback remains after the pilot, keep or shrink
`bindAuthWorkspaceScope` instead of deleting it.

The implementation order is:

```txt
1. Build loader path in one SvelteKit app.
2. Stop importing `bindAuthWorkspaceScope` from that app.
3. Verify sign-in, sign-out, identity switch, key refresh, HMR, and forget device.
4. Roll out to the other SvelteKit apps.
5. Verify again.
6. Delete `packages/auth-workspace` only if tab-manager has also moved off it in its own WXT spec.
```

That follows the wave-ordering rule: stop importing the old path, prove the new path, then delete.

## `forgetDevice`

`forgetXDevice` should become a bundle method for each migrated app:

```ts
async forgetDevice() {
	await this.wipe();
	await auth.signOut();
}
```

The route-level auth handler owns the redirect. The method owns only local device cleanup plus sign-out.

## Implementation plan

### Phase 1: Auth type

- [ ] Add `SignedInAuth` and `isSignedIn()` to `packages/auth`.
- [ ] Re-export both from `packages/auth-svelte`.
- [ ] Add a small type test or compile-time usage in an existing auth test.

### Phase 2: Pilot zhongwen

- [ ] Move signed-in workspace construction into an authed route-group `+layout.ts`.
- [ ] Move the signed-out branch from `+page.svelte` into a public `sign-in/+page.svelte`.
- [ ] Change `openZhongwen({ auth })` to require `SignedInAuth`.
- [ ] Remove the runtime null check from `openZhongwen`.
- [ ] Add `userId` and `forgetDevice()` to the returned bundle.
- [ ] Stop importing `apps/zhongwen/src/lib/zhongwen/client.ts`.
- [ ] Delete `apps/zhongwen/src/lib/zhongwen/client.ts` once its imports are gone. Do not keep a compatibility singleton.

### Phase 3: Verify zhongwen

- [ ] Signed-out navigation reaches `/sign-in`.
- [ ] Sign-in reaches the authed route and opens the workspace.
- [ ] Same-user key refresh reapplies encryption keys without reconstructing the workspace.
- [ ] Sign-out clears the loader cache, disposes the workspace, and redirects.
- [ ] User switch clears the loader cache, disposes the workspace, and reruns the loader.
- [ ] The auth client is disposed when the cached workspace is discarded.
- [ ] HMR does not accumulate auth listeners.
- [ ] `forgetDevice()` wipes local data, signs out, and lands on sign-in.

### Phase 4: Roll out to SvelteKit apps

> **Note**: this phase's pilot shape is superseded. See `20260505T060000-zhongwen-context-and-listener-collapse.md` for the canonical shape (singleton auth, gate-only loader, script-body workspace construction, `createContext` for the handle, single `auth.onChange` listener with three branches in `(protected)/+layout.svelte`, `onDestroy` for both unsubscribe and dispose). The fuji / honeycrisp / opensidian rollout will use that shape, tracked in a follow-up rollout spec.

- [ ] Apply the canonical T060000 shape to `apps/fuji`.
- [ ] Apply the canonical T060000 shape to `apps/honeycrisp`.
- [ ] Apply the canonical T060000 shape to `apps/opensidian`.
- [ ] Keep app-specific peer construction, sync attachment, and child-doc cache wiring inline. Do not add a generic loader helper unless the final four loaders are visibly identical.

### Phase 5: Stop imports and remove old files

- [ ] Delete SvelteKit app `client.ts` files after imports are gone. App breakage during this wave is acceptable; stale singleton paths in the final tree are not.
- [ ] Final grep for SvelteKit apps:
  - `await auth.whenReady` at module top level
  - `if (auth.identity === null) throw`
  - `bindAuthWorkspaceScope`
  - `forgetFujiDevice`, `forgetHoneycrispDevice`, `forgetOpensidianDevice`, `forgetZhongwenDevice`

### Phase 6: Separate WXT spec

- [ ] Write a tab-manager sidepanel bootstrap spec.
- [ ] Replace tab-manager's module-level throw with a sidepanel state gate.
- [ ] Only after tab-manager no longer imports `bindAuthWorkspaceScope`, delete `packages/auth-workspace`.

## Resolved decisions and deferrals

1. Use `(authed)` for the protected route group. The grouping names the
   invariant. Product-specific names hide the boundary this spec is creating.

2. Put `SignedInAuth` and `isSignedIn()` in core auth, then re-export them
   from auth-svelte. The type is not Svelte-specific.

3. Do not share loader logic yet. Four copies are easier to read than a helper
   that hides peer setup, sign-in routes, and disposal policy.

4. Do not copy key-refresh serialization from `bindAuthWorkspaceScope` at the
   start. The loader should use a small
   same-user handler because key application is synchronous and already deduped.
   Reintroduce serialization only if the pilot finds a remaining async terminal
   path.

5. Defer tab-manager to a WXT sidepanel bootstrap spec. DeepWiki confirms WXT
   entrypoints are static extension pages, not SvelteKit routes with loaders.

## Success criteria

- [ ] The four SvelteKit browser apps no longer import their `client.ts` singleton.
- [ ] The four SvelteKit browser factories require `SignedInAuth`.
- [ ] The four SvelteKit browser factories contain no null-identity throw.
- [ ] Signed-out users reach a public sign-in route.
- [ ] Sign-out and identity switch do not call `window.location.reload()`.
- [ ] Key refresh updates encryption keys without reconstructing the workspace.
- [ ] `packages/auth-workspace` is not deleted until tab-manager has its own replacement.

## References

- `apps/{fuji,honeycrisp,opensidian,zhongwen}/src/lib/{app}/client.ts`
- `apps/{fuji,honeycrisp,opensidian,zhongwen}/src/lib/{app}/browser.ts`
- `apps/zhongwen/src/routes/+page.svelte`
- `packages/auth-workspace/src/index.ts`
- `packages/auth-workspace/src/index.test.ts`
- `packages/auth/src/create-auth.ts`
- `packages/auth-svelte/src/create-auth.svelte.ts`
- SvelteKit load docs: https://svelte.dev/docs/kit/load
- SvelteKit navigation docs: https://svelte.dev/docs/kit/$app-navigation
- SvelteKit redirect reference: https://svelte.dev/docs/kit/@sveltejs-kit
