# Auth Session Storage Boot Cache Clean Break

**Date**: 2026-05-03
**Status**: Implemented
**Author**: AI-assisted

## One-Sentence Test

`AuthSession` storage is a boot cache for the last known local session; `AuthClient` and Better Auth own live authentication state.

Everything in this spec should serve that sentence. If a storage method exists to coordinate tabs, extension contexts, sync lifecycle, or UI reactivity, it is probably in the wrong layer.

## Overview

Remove storage-level watching from the core auth contract. Keep durable `AuthSession` storage for startup, refresh, offline local reads, machine auth, and encryption key recovery. Stop treating storage as a notification bus.

The desired contract is small:

```ts
export type SessionStorage = {
	load(): MaybePromise<AuthSession | null>;
	save(value: AuthSession | null): MaybePromise<void>;
};
```

Live changes should flow through `auth.snapshot` and `auth.onSnapshotChange()`. Browser tab and extension-context coordination should come from Better Auth's session client behavior, explicit app-level signals, focus refetch, sync failures, or server rejection. It should not come from hidden storage callbacks.

## Motivation

### Current State

Core auth previously accepted a storage object with an optional storage callback:

```ts
export type SessionStorage = {
	load(): MaybePromise<AuthSession | null>;
	save(value: AuthSession | null): MaybePromise<void>;
};
```

`createAuth()` also subscribed to that callback when it existed. That subscription is now removed.

Browser stores can implement their own observation because `createPersistedState()` and the tab-manager extension storage wrapper already expose callback APIs:

```txt
createPersistedState()
  localStorage write
  storage event from another tab
  focus re-read
  watch(listener)

createStorageState()
  chrome.storage write
  storage item watch
  watch(listener)
```

Machine auth cannot honestly implement it:

```ts
export function createMachineAuthClient(): AuthClient {
	const sessionStorage = createKeychainMachineAuthSessionStorage();
	return createAuth({
		baseURL: EPICENTER_API_URL,
		sessionStorage: {
			load: sessionStorage.load,
			save: sessionStorage.save,
		},
	});
}
```

This creates problems:

1. **Storage has two jobs**: it persists the session and also sometimes coordinates live auth changes. That makes the contract harder to explain.

2. **The watcher is not needed for local auth changes**: `createAuth()` already updates `snapshot` directly on sign-in, sign-out, Better Auth session emissions, and token rotation. The UI does not wait for storage to echo a write.

3. **The watcher duplicates Better Auth behavior**: Better Auth already has a client session atom, refetch behavior, focus refetch, and a localStorage-backed broadcast channel for session updates.

4. **The watcher hides product policy**: cross-tab logout, extension-context auth propagation, and sync invalidation are product behaviors. Encoding them as "storage changed" makes the storage layer own policy it cannot fully guarantee.

5. **The machine path exposes the mismatch**: keychain storage is durable, not observable. The clean shape for machine auth is `load` and `save`.

### Desired State

Keep storage as a boot cache:

```txt
AuthSession storage
  load: read last known session at startup
  save: persist local auth changes and token rotation
```

Remove storage as a live coordination surface:

```txt
Deleted
  storage callback APIs
  SessionStateAdapter callback APIs
  createAuth storage callback subscription
  tests that simulate future auth changes by mutating storage
```

Runtime auth changes should use the auth runtime:

```txt
Better Auth client session
  emits server session changes
  refetches on focus
  broadcasts sign-out/update events across browser tabs

createAuth
  reconciles Better Auth session into AuthSession
  stores the last known AuthSession
  exposes auth.snapshot and auth.onSnapshotChange

workspace consumers
  bindAuthWorkspaceScope listens to auth.onSnapshotChange
  attachSync listens to auth.onSnapshotChange
```

## Research Findings

### Better Auth Client Behavior

Better Auth `1.5.6` includes a client session refresh manager. The installed package shows these mechanisms:

```txt
better-auth/dist/client/session-refresh.mjs
  refetchOnWindowFocus defaults to true
  refetchInterval is configurable
  online events can trigger refetch
  localStorage broadcast messages trigger a session signal update

better-auth/dist/client/broadcast-channel.mjs
  writes better-auth.message into localStorage
  listens for storage events
  notifies session listeners when event === "session"

better-auth/dist/client/config.mjs
  sign-out broadcasts a session update
  update-user and update-session broadcast session updates
```

The Better Auth docs describe `useSession()` as the client-side session reader with a `refetch` function and client options such as `refetchOnWindowFocus`. The session management docs describe the server session as cookie-based, with `/get-session` returning the current session.

Implication: browser tab coordination should start from Better Auth's session machinery, not from our own persisted `AuthSession` storage callbacks.

### Current Epicenter Runtime Signals

The app-facing signal is already `auth.snapshot`:

```txt
@epicenter/auth
  auth.onSnapshotChange(fn)

@epicenter/auth-svelte
  mirrors auth.snapshot into $state

@epicenter/auth-workspace
  bindAuthWorkspaceScope subscribes to auth.onSnapshotChange

@epicenter/workspace
  attachSync subscribes to auth.onSnapshotChange and reconnects on token change
```

Storage callback observation is not the only way, or even the main way, the UI and sync layer hear about auth changes.

### Browser Tabs

If Tab A signs out through Better Auth:

```txt
Tab A
  client.signOut()
  Better Auth broadcasts session update

Tab B
  Better Auth broadcast handler updates session signal
  client.useSession.subscribe emits null
  createAuth writes signedOut snapshot
```

This path does not require storage callbacks.

If Tab A signs in and Tab B is currently signed out, Better Auth may not broadcast the exact same way for every sign-in path. That is acceptable if we choose this invariant:

```txt
Sign-out should propagate quickly.
Sign-in in another tab does not have to silently sign in this tab.
Focus refetch and reload can recover.
```

### Extension Contexts

Extension contexts are less uniform than browser tabs:

```txt
side panel
  window exists
  Better Auth browser client behavior can run

background service worker
  no stable window/localStorage model
  Better Auth localStorage broadcast is not a universal signal
```

If extension-wide auth notification becomes a product requirement, it should be explicit:

```txt
extension auth coordinator
  chrome.runtime messaging
  or chrome.storage event bridge
  or command-specific recheck
```

It should not be hidden inside the generic `SessionStorage` contract.

### Cloudflare Durable Objects

Durable Object storage is not a client auth notification primitive. Cloudflare documents Durable Object storage as private storage attached to a Durable Object instance, useful for state that must survive eviction or restart. It is strongly consistent storage for that object, not a built-in broadcast channel for browser auth state.

Using Durable Objects for auth invalidation would mean building a separate WebSocket or event product:

```txt
client tabs
  connect to auth event channel

server
  emits auth change events

clients
  refetch auth on event
```

That is much heavier than the current need. Keep it out of this cleanup.

## Design Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Storage role | Boot cache only | Durable storage should recover the last known session. It should not coordinate live auth state. |
| Live auth state | `auth.snapshot` | The runtime already has one public state signal. UI, workspace lifecycle, and sync consume it. |
| Cross-tab browser auth | Rely on Better Auth plus focus/refetch | Better Auth already has session refetch, localStorage broadcast for session updates, and `useSession().refetch`. |
| Extension auth propagation | Defer explicit bridge | Extension service workers and side panels have different runtime constraints. A hidden storage callback is not a clean invariant. |
| Machine auth | Load/save only | Keychain storage cannot watch external changes without polling or OS-specific machinery. |
| SessionStorage API | Remove `watch` | The clean contract is persistence only: `load` and `save`. |
| Better Auth client options | Investigate explicit `sessionOptions` | If focus refetch or polling needs tuning, configure Better Auth directly instead of layering storage notifications. |

## Architecture

Current shape:

```txt
              +----------------------+
              | SessionStorage       |
              | load/save/watch      |
              +----------+-----------+
                         |
                         v
              +----------------------+
              | createAuth           |
              | storage load         |
              | storage callback     |
              | Better Auth session  |
              | token rotation       |
              +----------+-----------+
                         |
                         v
              +----------------------+
              | auth.snapshot        |
              +----------------------+
```

Target shape:

```txt
              +----------------------+
              | SessionStorage       |
              | load/save            |
              +----------+-----------+
                         |
                         v
              +----------------------+
              | createAuth           |
              | boot cache load      |
              | Better Auth session  |
              | token rotation       |
              +----------+-----------+
                         |
                         v
              +----------------------+
              | auth.snapshot        |
              +----------+-----------+
                         |
          +--------------+--------------+
          |                             |
          v                             v
+----------------------+      +----------------------+
| Svelte UI            |      | workspace sync       |
| auth-svelte $state   |      | attachSync reconnect |
+----------------------+      +----------------------+
```

Better Auth remains the browser session authority:

```txt
Better Auth cookie/session
  /auth/get-session
  useSession atom
  focus refetch
  broadcast sign-out/update
        |
        v
createAuth Better Auth subscription
        |
        v
AuthSession snapshot
        |
        v
save last known AuthSession
```

## Implementation Plan

### Phase 1: Remove Storage Watching From Core Auth

- [x] **1.1** Change `SessionStorage` in `packages/auth/src/session-store.ts` to only include `load()` and `save()`.
- [x] **1.2** Change `SessionStateAdapter` in `packages/auth/src/create-auth.ts` to only require `get()`, `set()`, and optional `whenReady`.
- [x] **1.3** Update `createSessionStorageAdapter()` so it no longer accepts or returns callback watching.
- [x] **1.4** Delete the storage callback subscription block and its disposer from `createAuth()`.
- [x] **1.5** Remove tests that simulate future auth changes by calling a storage callback.
- [x] **1.6** Keep tests for storage load success, async load, load failure, disposal during load, local snapshot writes, token rotation persistence, and Better Auth session reconciliation.

### Phase 2: Reframe Browser Auth Around Better Auth Session Events

- [x] **2.1** Verify `client.useSession.subscribe()` still drives sign-in and sign-out behavior in core tests.
- [x] **2.2** Add or keep a test proving Better Auth `null` session emission drives `signedOut` when the current snapshot is signed in.
- [x] **2.3** Add or keep a test proving response-header token rotation updates `AuthSession.token` and persists it through `save()`.
- [x] **2.4** Decide whether `createAuthClient()` should pass explicit Better Auth `sessionOptions`.

Candidate:

```ts
const client = createAuthClient({
	baseURL,
	basePath: '/auth',
	sessionOptions: {
		refetchOnWindowFocus: true,
	},
	plugins: [InferPlugin<EpicenterCustomSessionPlugin>()],
	fetchOptions: { ... },
});
```

Only add this if the option is valid for the vanilla Better Auth client and improves readability. Do not add an option just to restate Better Auth's default.

### Phase 3: Update App Storage Adapters

- [x] **3.1** Update browser app auth setup to keep using `createSessionStorageAdapter(session)` if the adapter still earns its keep.
- [x] **3.2** Consider whether `createSessionStorageAdapter()` is now too thin. With callback watching gone, it is mostly:

```ts
return {
	async load() {
		await state.whenReady;
		return state.get();
	},
	save: state.set,
};
```

- [x] **3.3** If it is too thin, either keep it as a named bridge for Svelte/persisted-state stores or inline storage objects at app call sites. Count callers before deciding.

### Phase 4: Extension Follow-up, Only If Needed

- [x] **4.1** Confirm whether tab-manager has more than one live auth-consuming extension context.
- [x] **4.2** If side panel is the only auth UI, accept focus/refetch/reload semantics.
- [x] **4.3** If background or other extension contexts require immediate auth changes, design an explicit extension-level auth event bridge using `chrome.runtime` or `chrome.storage`.
- [x] **4.4** Do not put extension messaging back into generic `SessionStorage`.

### Phase 5: Documentation And Specs

- [x] **5.1** Update auth skill documentation to describe storage as a boot cache.
- [x] **5.2** Update existing clean-break specs that still show callback watching.
- [x] **5.3** Search for stale storage callback references across `packages`, `apps`, `docs`, and `specs`.

## Edge Cases

### Tab A Signs Out, Tab B Is Open

Expected behavior after the cleanup:

```txt
Tab A signs out through Better Auth.
Better Auth broadcasts/refetches session state.
Tab B receives Better Auth session update if the Better Auth browser signal reaches it.
If not, Tab B corrects on focus, reload, explicit refetch, or server rejection.
```

The storage layer is not responsible for this.

### Tab A Signs In, Tab B Is Open And Signed Out

Expected behavior:

```txt
Tab B may remain signed out until focus, reload, explicit refetch, or Better Auth session signal.
```

This is acceptable. Silent sign-in across tabs is not a core product invariant.

### Extension Side Panel Signs Out

Expected behavior:

```txt
The active side panel updates immediately through its own AuthClient.
Other extension contexts may need focus, reload, command retry, or explicit extension messaging.
```

If this becomes unacceptable, build an extension-specific signal.

### Machine Auth Logs Out In Another Process

Expected behavior:

```txt
Current process does not get a keychain event.
It discovers invalid auth on status check, sync reconnect, or server rejection.
```

This is already true. Polling the keychain would add more machinery than the invariant needs.

### Offline Boot

Expected behavior:

```txt
createAuth loads the last known AuthSession.
Local workspace code can access user and encryption keys.
Server-backed actions may fail until connectivity returns.
```

This is the main reason durable `AuthSession` storage still matters.

## Open Questions

1. **Should we explicitly configure Better Auth `sessionOptions`?**

   Better Auth defaults `refetchOnWindowFocus` to true in the installed client. We can leave the default alone, or pass it explicitly so the auth invariant is visible at our call site.

   Recommendation: do not pass defaults unless tests show the default is unclear or unstable. If we configure anything, configure only browser auth clients, not machine auth.

2. **Should `createAuth` expose a manual `refetchSession()` method?**

   This would let extension contexts or workspace error handlers ask the auth client to re-read Better Auth state directly. It would also widen the public API.

   Recommendation: defer. Prefer using existing Better Auth session behavior and server rejection first. Add a method only if a concrete caller needs it.

3. **Should `auth.fetch` sign out on 401?**

   This would make server rejection an explicit invalidation path. It is product-sensitive because a single 401 might come from a non-auth route, a transient server issue, or a stale token.

   Recommendation: defer. If added, it should be narrow: only for known auth/session invalidation responses.

4. **Should extension auth have a dedicated coordinator?**

   If multiple extension contexts must stay live in lockstep, an explicit coordinator is cleaner than storage callbacks.

   Recommendation: defer until tab-manager proves the need.

## Success Criteria

- [x] `SessionStorage` has only `load` and `save`.
- [x] `createAuth()` no longer subscribes to storage changes.
- [x] `createSessionStorageAdapter()` no longer requires callback watching.
- [x] Machine auth passes `{ load, save }` without optional watcher behavior.
- [x] Browser apps still boot from persisted `AuthSession`.
- [x] Better Auth session emissions still drive signed-in and signed-out snapshots.
- [x] Token rotation still persists through `SessionStorage.save()`.
- [x] `bindAuthWorkspaceScope` and `attachSync` still react through `auth.onSnapshotChange`.
- [x] Tests cover storage as boot cache, not storage as live coordination.
- [x] No code or docs describe `SessionStorage` as a live watcher.

## References

Local files:

- `packages/auth/src/create-auth.ts`
- `packages/auth/src/session-store.ts`
- `packages/auth/src/create-auth.test.ts`
- `packages/auth/src/node/machine-auth.ts`
- `packages/auth-svelte/src/create-auth.svelte.ts`
- `packages/auth-workspace/src/index.ts`
- `packages/workspace/src/document/attach-sync.ts`
- `packages/svelte-utils/src/persisted-state.svelte.ts`
- `apps/tab-manager/src/lib/state/storage-state.svelte.ts`
- `apps/tab-manager/src/lib/tab-manager/client.ts`
- `apps/api/src/app.ts`

Installed Better Auth source inspected:

- `node_modules/.bun/better-auth@1.5.6+d078191ba5035c0f/node_modules/better-auth/dist/client/session-refresh.mjs`
- `node_modules/.bun/better-auth@1.5.6+d078191ba5035c0f/node_modules/better-auth/dist/client/session-atom.mjs`
- `node_modules/.bun/better-auth@1.5.6+d078191ba5035c0f/node_modules/better-auth/dist/client/broadcast-channel.mjs`
- `node_modules/.bun/better-auth@1.5.6+d078191ba5035c0f/node_modules/better-auth/dist/client/config.mjs`

External references:

- [Better Auth Basic Usage](https://better-auth.com/docs/basic-usage)
- [Better Auth Client Concepts](https://better-auth.com/docs/concepts/client)
- [Better Auth Session Management](https://better-auth.com/docs/concepts/session-management)
- [Better Auth Options](https://better-auth.com/docs/reference/options)
- [Cloudflare Durable Object Storage API](https://developers.cloudflare.com/durable-objects/api/storage-api/)
- [Cloudflare Durable Object Storage Best Practices](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/)

## Review

**Completed**: 2026-05-03

### Summary

`SessionStorage` is now a boot cache with only `load()` and `save()`. `createAuth()` no longer subscribes to storage changes; Better Auth session emissions, response-header token rotation, `auth.snapshot`, and `auth.onSnapshotChange()` own live auth state.

### Decisions

- Kept `createSessionStorageAdapter()` as the named bridge from persisted state helpers into auth storage. It is thin, but it preserves one obvious call site across browser apps and keeps `whenReady` handling out of app setup.
- Did not add explicit Better Auth `sessionOptions`. The installed Better Auth client already defaults focus refetch on, and restating defaults would add noise without changing behavior.
- Did not add extension messaging or a public `refetchSession()`. Tab-manager currently routes live auth use through the side panel client, workspace auth binding, and `auth.fetch`; broader extension coordination should be a separate product decision.

### Verification

- `bun --filter @epicenter/auth test`
- `bun --filter @epicenter/auth typecheck`
- Stale storage callback reference search across `packages`, `apps`, `docs`, `specs`, and auth skill docs
