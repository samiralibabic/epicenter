# Zhongwen workspace context + auth listener collapse

**Date**: 2026-05-05
**Status**: Implemented
**Author**: AI-assisted, grounded against DeepWiki, Svelte 5 docs, and yjs source
**Branch**: feat/encrypted-local-workspace-storage
**Follows**: `specs/20260505T040000-route-loader-singleton-auth-collapse.md`

## One-sentence thesis

The workspace bundle owns only its own resources, the layout owns the auth listener (with one callback handling sign-out, user-switch, and key-refresh together), and the workspace handle is published through Svelte 5's built-in `createContext` instead of via the SvelteKit `data` prop, eliminating the `hasDisposed` flag and the `let` for "previous user id."

## Why this spec exists

After the route-loader pilot landed (spec `T040000`), three smells accumulated as we tried to keep the workspace bundle self-contained:

```
1. browser.ts grew an `auth: AuthClient` parameter and an internal
   auth.onChange subscription for key refresh. The bundle now knew about auth.

2. To keep dispose idempotent across the wipe-then-unmount path, browser.ts
   needed a `let hasDisposed = false` flag. Module-level mutable state in
   the workspace factory.

3. The (protected)/+layout.svelte's auth listener handled only sign-out and
   user-switch. Key refresh was elsewhere (in browser.ts). Two listeners,
   two cleanup paths, two halves of a single concern.

4. data.zhongwen flowed through SvelteKit's typed `data` prop. That's idiomatic
   for *data*, but the workspace is a disposable client, not data. The
   `data` prop typing reflected that mismatch awkwardly.
```

This spec collapses all four into a single coherent shape.

## Asymmetric refusals

```
Refusal 1: workspace bundle takes auth
  Deletes:
    - `auth: AuthClient` parameter on openZhongwen
    - the unsubscribeAuth captured inside the bundle
    - the `let hasDisposed = false` idempotency flag
    - the explicit `[Symbol.dispose]` override (spread provides it)
  User loss: none; layout already has auth, can call applyKeys directly

Refusal 2: separate listeners for navigation vs key-refresh
  Deletes:
    - the workspace's internal auth.onChange subscription
    - the duplicate cleanup path
  Replaces: with one listener in (protected)/+layout.svelte handling all
            three branches (sign-out, user-switch, key-refresh)
  User loss: none

Refusal 3: workspace lives in the SvelteKit `data` prop
  Deletes:
    - `zhongwen` field on (protected)/+layout.ts's load return
    - PageData/LayoutData carrying a non-data client
  Replaces: with Svelte 5's createContext (returns typed [get, set] tuple)
  User loss: none; createContext is built into Svelte 5.40+, throws on
             missing provider, generates unique symbol key automatically
```

## Grounding

### yjs Doc.destroy is idempotent

DeepWiki on `yjs/yjs`:

```
Q: Is Y.Doc.prototype.destroy() idempotent?
A: Yes. Doc sets isDestroyed = true on first call and emits 'destroy'
   exactly once. The base ObservableV2.destroy() then unregisters all
   event handlers. Subsequent calls are inert.
   "It is not the caller's responsibility to guard against multiple
    calls to destroy()."
```

That removes the entire reason `hasDisposed` existed. Calling `bundle[Symbol.dispose]()` after `wipe()` is safe.

### Svelte 5.40+ ships createContext

DeepWiki on `sveltejs/svelte`:

```
Q: Canonical typed context in Svelte 5?
A: createContext<T>() (since v5.40.0). Returns [get, set] tuple.
   Generates unique internal key automatically. get() throws "Context
   was not set in a parent component" if no provider mounted above.
```

Catalog confirms `svelte: ^5.45.2`. The built-in is available.

We compared to Runed's `Context` class:

| | Svelte's createContext | Runed Context |
|---|---|---|
| Built into Svelte? | yes | no, requires runed dep |
| API | `[get, set] = createContext<T>()` | `new Context<T>('name')` |
| Throws on missing | yes | yes (`.get()`) |
| Symbol key | auto | auto |
| Fallback | no | `.getOr(fallback)` |
| Reactivity | none | none (just typed wrapper) |

For our case (workspace always exists inside `(protected)`, no fallback needed) Svelte's built-in is sufficient. Zero new dependencies.

### SvelteKit load is for pure data, not lifecycle

From the previous spec's DeepWiki query:

```
Q: Where should disposal of a load-constructed resource live?
A: SvelteKit docs do not mention disposal patterns within load.
   "Load functions are designed to be pure, without side-effects that
    manage external resources with complex lifecycles."
   "Better to manage resource lifecycles within Svelte components
    using onMount, onDestroy, or $effect."
```

This validates moving construction into `+layout.svelte` and using context for child access. `load()` becomes a pure identity gate.

## Design decisions

| Decision | Class | Choice | Rationale |
|---|---|---|---|
| Auth listener location | 2 coherence | `(protected)/+layout.svelte` (single listener, three branches) | One subscription per layout instance; closure-captures `data.identity.user.id`; all auth-driven policy lives in the layout |
| Workspace construction site | 2 coherence | `(protected)/+layout.svelte` script body, const | Svelte 5 canonical for non-prop-reactive resources; resource available immediately on first render |
| Workspace teardown site | 2 coherence | `onDestroy` adjacent to construction | Pattern A canonical per DeepWiki; `onDestroy` is more semantic than empty-body `$effect` cleanup |
| Workspace handle propagation | 2 coherence | Svelte 5 `createContext` | Built into Svelte 5.40+; typed tuple; throws on missing provider; zero new deps |
| Bundle parameter type | 2 coherence | `{ identity: AuthIdentity }` only | The bundle owns local data, not auth coordination; keep it narrow |
| `hasDisposed` flag | 1 evidence | Removed | yjs `Doc.destroy()` is idempotent; flag was unnecessary defensive code |
| Explicit `[Symbol.dispose]` override on bundle | 2 coherence | Removed | Spread from `doc` provides it; override called the same method indirectly |
| `wipe` keeps disposing internally | 1 evidence | Yes | `indexedDB.deleteDatabase` blocks while connections are open; must close before deleting |
| Sign-out navigation primitive | 1 evidence | `goto('/sign-in', { replaceState: true })` | DeepWiki: goto is more idiomatic than invalidateAll for explicit nav; replaceState avoids back-button bouncing |
| User-switch navigation primitive | 3 taste | `window.location.reload()` | Rare event; full reset is simpler than orchestrating dispose + remount |
| Same-user key refresh | 2 coherence | `zhongwen.encryption.applyKeys(next.encryptionKeys)` inline in the same listener | One listener, three branches, all visible in one place |

## Architecture

### File-by-file

```
$lib/auth.ts                   ← const auth singleton + HMR dispose; nothing else
$lib/zhongwen/browser.ts       ← openZhongwen({ identity }) + getZhongwen/setZhongwen context pair
(protected)/+layout.ts         ← pure auth gate; returns { identity }
(protected)/+layout.svelte     ← const construct + setZhongwen + onDestroy x2 + onChange listener
(protected)/+page.svelte       ← getZhongwen() + UI
sign-in/+page.ts               ← redirect signed-in users to /
sign-in/+page.svelte           ← form + onChange listener (mirror of (protected))
chat-state.svelte.ts           ← getZhongwen() inside; takes no args
```

### Lifecycle flow (signed-in user mounts /)

```
1. routes/+layout.ts evaluates: ssr=false
2. (protected)/+layout.ts load():
     await auth.whenReady
     identity = auth.identity (narrowed by !identity → redirect)
     return { identity }
3. (protected)/+layout.svelte mounts:
     const zhongwen = openZhongwen({ identity: data.identity })
     setZhongwen(zhongwen)               ← context published
     onDestroy(() => zhongwen[Symbol.dispose]())
     unsubscribe = auth.onChange(...)
     onDestroy(unsubscribe)
4. (protected)/+page.svelte mounts:
     const zhongwen = getZhongwen()      ← context read
     const chatState = createChatState() ← createChatState calls getZhongwen too
5. UI renders
```

### Lifecycle flow (sign-out from /)

```
1. UI: await auth.signOut()
2. auth.onChange fires with null
3. Layout's listener: goto('/sign-in', { replaceState: true })
4. (protected) layout unmounts
5. onDestroy callbacks fire:
     - zhongwen[Symbol.dispose]() → ydoc.destroy() → idb closes, BC closes
     - unsubscribe() → listener detached
6. /sign-in route mounts
```

### Lifecycle flow (forget device)

```
1. UI: await zhongwen.wipe()
     - doc[Symbol.dispose]() → ydoc.destroy() (closes idb connection)
     - await idb.whenDisposed
     - wipeOwnerLocalYjsData → indexedDB.deleteDatabase succeeds
2. UI: await auth.signOut()
3. auth.onChange null → goto('/sign-in')
4. Layout unmounts → onDestroy fires zhongwen[Symbol.dispose]() AGAIN
5. ydoc.destroy() is idempotent (yjs sets isDestroyed flag) → no-op
6. /sign-in route mounts
```

### Lifecycle flow (cross-tab user switch)

```
1. Tab B signs in as different user; cookie updates
2. Tab A's auth.onChange fires with next.user.id !== data.identity.user.id
3. Layout's listener: window.location.reload()
4. Browser reloads everything; fresh modules, fresh workspace for new user
```

### Lifecycle flow (same-user key refresh)

```
1. auth.onChange fires with next.user.id === data.identity.user.id
2. Layout's listener: zhongwen.encryption.applyKeys(next.encryptionKeys)
3. Workspace is updated in place; no remount, no dispose
```

## Why both `wipe` and `[Symbol.dispose]`?

These are different operations with different semantics:

| | `[Symbol.dispose]()` | `wipe()` |
|---|---|---|
| Purpose | release in-memory resources | release resources AND delete persisted data |
| What it does | calls `ydoc.destroy()` | dispose + `wipeOwnerLocalYjsData` |
| When called | layout unmount (via onDestroy) | user clicks "Forget device" |
| Effect on IndexedDB | closes connection only | closes connection then deletes database |

`wipe` must call dispose internally because `indexedDB.deleteDatabase(name)` blocks while connections are open. The deletion can only proceed after the IDB attachment's `ydoc.once('destroy', ...)` listener has fired and closed the connection.

After `wipe()` completes, the user is signed out by the UI handler, which triggers the layout's auth listener to navigate to `/sign-in`, which unmounts the layout, which fires `onDestroy` and disposes the bundle a second time. Because yjs `Doc.destroy()` is idempotent (sets `isDestroyed = true` on first call, ignores subsequent), this second disposal is a no-op. No flag needed.

## Why one auth listener with three branches?

The three transitions (`sign-out`, `user-switch`, `key-refresh`) are all "auth changed; what should this layout do?" Splitting them across two listeners (one in workspace, one in layout) creates two cleanup paths and hides the `applyKeys` policy inside the workspace factory. Combining them in the layout:

- One subscription, one unsubscribe
- All three branches visible in one block
- Layout owns the policy (it has access to `data.identity.user.id`, `goto`, `window`, and the workspace handle)
- The workspace bundle has no opinion about auth

```svelte
const unsubscribe = auth.onChange((next) => {
    if (next === null) return void goto('/sign-in', { replaceState: true });
    if (next.user.id !== data.identity.user.id) return window.location.reload();
    zhongwen.encryption.applyKeys(next.encryptionKeys);
});
onDestroy(unsubscribe);
```

## Why context instead of `data.zhongwen`?

The SvelteKit `data` prop carries values that flow from `load()`. Conceptually `load()` is for *data fetching*, not resource construction. Putting the workspace handle in `data` works but conflates two roles.

Svelte 5's `createContext` is designed for "value provided at one component, consumed by descendants." That's exactly the workspace's lifetime: provided at `(protected)/+layout.svelte`, consumed by `+page.svelte` and `chat-state.svelte.ts`.

The split:

```
data.identity   ← narrowed AuthIdentity, proven by load gate, lives in `data`
zhongwen handle ← disposable client, lives in component context
```

`data` carries proven facts. Context carries scoped clients. Each tool used for what it's for.

## Implementation summary

What changed in this pass (relative to T040000's end state):

```
apps/zhongwen/src/lib/zhongwen/browser.ts
  - dropped `auth: AuthClient` parameter
  - removed internal auth.onChange subscription
  - removed `let hasDisposed` flag
  - removed explicit [Symbol.dispose] override (spread provides it)
  + added `export const [getZhongwen, setZhongwen] = createContext<Zhongwen>()`

apps/zhongwen/src/routes/(protected)/+layout.svelte
  - openZhongwen called with { identity } only (no auth)
  - listener now handles three branches: sign-out goto, user-switch reload,
    same-user applyKeys
  + goto uses { replaceState: true } so back-button doesn't bounce

apps/zhongwen/src/routes/sign-in/+page.svelte
  + goto uses { replaceState: true }

apps/zhongwen/src/lib/chat/chat-state.svelte.ts
  - createChatState() takes no args
  + reads zhongwen via getZhongwen() at script init

apps/zhongwen/src/routes/(protected)/+page.svelte
  + reads zhongwen via getZhongwen() at script init
```

## Success criteria

- [x] `browser.ts` does not import `AuthClient` or any auth listener
- [x] No `let hasDisposed` or any dispose-idempotency flag in `browser.ts`
- [x] No explicit `[Symbol.dispose]` override on the bundle return
- [x] `(protected)/+layout.svelte` has exactly one `auth.onChange` listener with three branches
- [x] `getZhongwen`/`setZhongwen` are exported from `browser.ts` via `createContext`
- [x] `chat-state.svelte.ts` and `(protected)/+page.svelte` consume zhongwen via `getZhongwen()`
- [x] `(protected)/+layout.ts` returns `{ identity }` only (no zhongwen)
- [x] `bun run typecheck` produces no zhongwen-specific errors

## References

- `apps/zhongwen/src/lib/zhongwen/browser.ts`
- `apps/zhongwen/src/routes/(protected)/+layout.svelte`
- `apps/zhongwen/src/routes/(protected)/+page.svelte`
- `apps/zhongwen/src/routes/sign-in/+page.svelte`
- `apps/zhongwen/src/lib/chat/chat-state.svelte.ts`
- yjs `Doc.destroy` idempotence (DeepWiki)
- Svelte 5.40+ `createContext` (DeepWiki + svelte docs)
- SvelteKit `load` purity (DeepWiki + load docs)
- `specs/20260505T040000-route-loader-singleton-auth-collapse.md` (immediate predecessor)

## Final shape (reference)

```ts
// $lib/zhongwen/browser.ts
import type { AuthIdentity } from '@epicenter/auth';
import {
	attachOwnedBroadcastChannel,
	wipeOwnerLocalYjsData,
} from '@epicenter/workspace';
import { createContext } from 'svelte';
import { openZhongwen as openZhongwenDoc } from './index';

export function openZhongwen({ identity }: { identity: AuthIdentity }) {
	const userId = identity.user.id;
	const doc = openZhongwenDoc({ encryptionKeys: identity.encryptionKeys });
	const idb = doc.encryption.attachIndexedDb(doc.ydoc, { userId });
	attachOwnedBroadcastChannel(doc.ydoc, { userId });

	return {
		...doc,
		whenLoaded: idb.whenLoaded,
		async wipe() {
			doc[Symbol.dispose]();
			await idb.whenDisposed;
			await wipeOwnerLocalYjsData({
				userId,
				ydocGuids: [doc.ydoc.guid],
			});
		},
	};
}

export type Zhongwen = ReturnType<typeof openZhongwen>;
export const [getZhongwen, setZhongwen] = createContext<Zhongwen>();
```

```svelte
<!-- (protected)/+layout.svelte -->
<script lang="ts">
	import { goto } from '$app/navigation';
	import { onDestroy } from 'svelte';
	import { auth } from '$lib/auth';
	import { openZhongwen, setZhongwen } from '$lib/zhongwen/browser';

	let { data, children } = $props();

	// svelte-ignore state_referenced_locally
	const zhongwen = openZhongwen({ identity: data.identity });
	setZhongwen(zhongwen);
	onDestroy(() => zhongwen[Symbol.dispose]());

	const unsubscribe = auth.onChange((next) => {
		if (next === null) return void goto('/sign-in', { replaceState: true });
		if (next.user.id !== data.identity.user.id) return window.location.reload();
		zhongwen.encryption.applyKeys(next.encryptionKeys);
	});
	onDestroy(unsubscribe);
</script>

{@render children()}
```

## Review

**Completed**: 2026-05-04
**Branch**: `feat/encrypted-local-workspace-storage`
**Commit**: `ef64f70af`

### Summary

Zhongwen now uses singleton auth in `$lib/auth.ts`, a gate-only `(protected)/+layout.ts` that returns `{ identity }` only, script-body workspace construction in `(protected)/+layout.svelte` published through `createContext`, and a single `auth.onChange` listener handling sign-out (`goto`), user-switch (`reload`), and same-user key refresh (`applyKeys`) in three branches. The workspace bundle no longer takes `auth`, has no `hasDisposed` flag, and no explicit `[Symbol.dispose]` override.

### Verification

Targeted typechecks pass for `@epicenter/auth`, `@epicenter/auth-svelte`, and `@epicenter/zhongwen` itself. Workspace-wide `bun run typecheck` remains blocked by pre-existing diagnostics in `packages/ui`, `packages/svelte-utils/src/from-table.svelte.ts`, and unrelated app surfaces. Manual smokes from the success-criteria list are pending and stack with T035000 / T040000 / T233223 manual smokes into one QA pass.

### Follow-ups

- Roll out this shape to `apps/fuji`, `apps/honeycrisp`, `apps/opensidian` (new rollout spec).
- Migrate `apps/tab-manager` to a WXT-shaped equivalent: reactive `{#if auth.identity}` gate at the sidepanel root, `SignedIn` component owns construction + listener + dispose. Different gate trigger, identical lifecycle code (new WXT bootstrap spec).
- Delete `packages/auth-workspace` once the rollout and the WXT migration land.
- Implement T233223's residual cleanups (delete SYNC_STATUS protocol, `hasLocalChanges`, safe-sign-out branch in `account-popover.svelte`) once no caller depends on the pre-sign-out sync gate.
