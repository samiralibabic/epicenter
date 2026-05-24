# Peer Addressed Remote Client API

**Date**: 2026-05-01
**Status**: Implemented
**Author**: AI-assisted
**Branch**: `codex/explicit-daemon-host-config`
**Depends on**: `specs/20260501T180000-awareness-source-of-truth.md`

## Overview

The awareness source of truth refactor removed `sync.attachPresence`, but it left one transitional concept behind: `PeerDirectory`. This spec removes that middle object. Awareness remains the only state owner, sync transports awareness, and the high-level remote client resolves peer ids from awareness when it invokes actions.

One sentence:

```txt
A Y.Doc owns one typed awareness state; sync transports it; remote RPC resolves peer ids from awareness when invoking actions.
```

## Motivation

### Current State

The current post-refactor call site creates awareness, sync, peer directory, RPC, and sometimes a remote client:

```ts
const awareness = attachAwareness(doc.ydoc, {
	schema: { peer: PeerIdentity },
	initial: { peer },
});

const sync = attachSync(doc, {
	url,
	getToken,
	waitFor: idb,
	awareness,
});

const peerDirectory = createPeerDirectory({ awareness, sync });
const rpc = sync.attachRpc(doc.actions);
const remote = createRemoteClient({ peerDirectory, rpc });
```

Daemon runtimes expose the same transitional object:

```ts
return {
	actions: doc.actions,
	awareness,
	sync,
	peerDirectory,
	rpc,
	async [Symbol.asyncDispose]() {
		doc[Symbol.dispose]();
		await sync.whenDisposed;
	},
};
```

`PeerDirectory` currently does four things:

```txt
PeerDirectory
  peers()       -> awareness.peers(), reshaped to { peer }
  find(id)      -> awareness.peers(), sorted by client id, filtered by peer.id
  waitForPeer() -> find(id), plus observe(), plus timeout
  observe()     -> awareness.observe()
```

That creates problems:

1. `PeerDirectory` owns no state. Its canonical data is still `awareness.peers()`.
2. `createPeerDirectory({ awareness, sync })` makes peer lookup depend on sync, even though sync status is only used to phrase miss errors.
3. `peerDirectory.peers()` duplicates `awareness.peers()`, so readers have to ask which peer list is authoritative.
4. `createRemoteClient({ peerDirectory, rpc })` requires callers to build a peer lookup object before they can do peer-addressed RPC.
5. `PeerMiss` lives in `attach-sync.ts`, but peer-id lookup is not a sync transport concern.
6. Names like `peer-presence.ts`, `PeerPresenceState`, and `peerDirectory` preserve old vocabulary after awareness became the source of truth.

### Desired State

App bundles compose the real primitives directly:

```ts
const awareness = attachAwareness(doc.ydoc, {
	schema: { peer: PeerIdentity },
	initial: { peer },
});

const sync = attachSync(doc, {
	url,
	getToken,
	waitFor: idb,
	awareness,
});

const rpc = sync.attachRpc(doc.actions);
const remote = createRemoteClient({ awareness, rpc });

return {
	...doc,
	awareness,
	sync,
	rpc,
	remote,
};
```

Daemon runtimes expose only what the daemon needs:

```ts
return {
	actions: doc.actions,
	awareness,
	sync,
	remote,
	async [Symbol.asyncDispose]() {
		doc[Symbol.dispose]();
		await sync.whenDisposed;
	},
};
```

The daemon `/peers` route reads awareness directly:

```ts
for (const [clientID, state] of runtime.awareness.peers()) {
	rows.push({
		route,
		clientID,
		peer: state.peer,
	});
}
```

The daemon `/run` route asks the remote client to invoke by peer id:

```ts
const result = await runtime.remote.invoke(peerTarget, localPath, actionInput, {
	waitForPeerMs: waitMs,
	timeout: remaining,
});
```

## Hard Requirements

- Use `bun`, not npm, yarn, or pnpm.
- Do not use em dashes or en dashes in source, docs, comments, or commit messages.
- Do not reintroduce `sync.attachPresence`, `attachPresence`, `attachFields`, or peer-specific awareness attachment APIs.
- Do not construct raw `YAwareness` anywhere except inside `attachAwareness`.
- Do not keep compatibility aliases for `PeerDirectory`, `createPeerDirectory`, or `peerDirectory`.
- Do not pass `sync` or `getStatus` into peer lookup helpers.
- Do not reintroduce `PeerIdentityInput` or peer id generics.
- Do not make generic awareness know about a special `peer` field.

## Research Findings

### Clean Break Audit

The clean-break sentence is:

```txt
Awareness owns state, sync transports it, and remote RPC reads awareness to address peers.
```

Every public object should map to one verb:

| Surface | Verb | Keep |
| --- | --- | --- |
| `attachAwareness` | owns typed ephemeral state | Yes |
| `attachSync` | transports document updates and awareness frames | Yes |
| `sync.attachRpc` | transports action calls by Yjs client id | Yes |
| `createRemoteClient` | invokes actions by stable peer id | Yes |
| `createPeerDirectory` | wraps awareness reads | No |

Key finding: `PeerDirectory` is a wrapper, not an owner. Deleting it makes the source of truth obvious at each call site.

### Caller Map

Current production usage falls into three groups:

```txt
Constructors:
  apps/fuji browser and daemon
  apps/honeycrisp browser and daemon
  apps/opensidian browser and daemon
  apps/tab-manager extension
  apps/zhongwen daemon
  examples/notes-cross-peer

Peer listing:
  packages/workspace/src/daemon/app.ts
  packages/cli/src/commands/up.ts

Peer-addressed RPC:
  packages/workspace/src/rpc/remote-actions.ts
  packages/workspace/src/daemon/run-handler.ts
```

Key finding: there is no standalone product surface that needs a directory object. The only real consumers are peer listing and peer-addressed RPC.

Implication: `/peers` should read awareness. Remote invocation should resolve peers internally.

### Attach Primitive Rules

`attach*` means side effects at call time. `create*` means pure construction. `createPeerDirectory` is pure construction, but the returned object mostly forwards to awareness.

Key finding: a factory earns its keep when it becomes a stable service boundary. `PeerDirectory` does not. It adds vocabulary without moving ownership.

Implication: remove the factory rather than renaming it to `createPeerLookup`.

### Factory Function Composition

Factory functions should take dependencies first and options second:

```ts
const remote = createRemoteClient({ awareness, rpc });
```

This is the right shape because both dependencies are stable resources. `awareness` resolves peer ids. `rpc` sends actions after a peer id has resolved to a client id.

Rejected shape:

```ts
const remote = createRemoteClient({
	peerDirectory,
	rpc,
});
```

This makes the caller construct an adapter that only the remote client really needs.

### Error Ownership

The current `RpcError` type in `@epicenter/sync` includes `PeerNotFound` and `PeerLeft`. Those errors are not pure sync wire errors when they refer to stable peer ids from awareness.

Current split:

```txt
@epicenter/sync RpcError
  PeerOffline      wire target client id is not connected
  Timeout          wire call timed out
  ActionNotFound   remote action path missing
  ActionFailed     remote handler failed
  Disconnected     local transport disconnected
  PeerNotFound     stable peer id not in awareness
  PeerLeft         stable peer id left awareness mid-call
```

Cleaner split:

```txt
@epicenter/sync RpcError
  PeerOffline
  Timeout
  ActionNotFound
  ActionFailed
  Disconnected

@epicenter/workspace PeerAddressError
  PeerNotFound
  PeerLeft
```

Key finding: peer-id lookup is workspace behavior because awareness and `PeerIdentity` live in workspace. It should not be defined in the sync protocol package.

Implication: `RemoteCallError` should be `WireRpcError | PeerAddressError`, where `WireRpcError` excludes peer-id address errors while those variants still exist in `@epicenter/sync`.

## Proposed API

### App Composition

```ts
const awareness = attachAwareness(doc.ydoc, {
	schema: { peer: PeerIdentity },
	initial: { peer },
});

const sync = attachSync(doc, {
	url,
	getToken,
	waitFor: idb,
	awareness,
});

const rpc = sync.attachRpc(doc.actions);
const remote = createRemoteClient({ awareness, rpc });

return {
	...doc,
	awareness,
	sync,
	rpc,
	remote,
};
```

### Daemon Runtime

```ts
export type PeerAwarenessSchema = AwarenessSchema & {
	peer: typeof PeerIdentity;
};

export type PeerAwarenessState = {
	peer: PeerIdentity;
};
```

```ts
export type DaemonRuntime = {
	[Symbol.asyncDispose](): MaybePromise<void>;
	actions: Actions;
	awareness: AwarenessAttachment<PeerAwarenessSchema>;
	sync: SyncAttachment;
	remote: RemoteClient;
};
```

The exact generic spelling may need adjustment. The invariant is the important part:

```txt
DaemonRuntime.awareness must be an awareness attachment whose schema includes peer: PeerIdentity.
```

### Remote Client

```ts
export type RemoteClientOptions<
	TSchema extends PeerAwarenessSchema,
> = {
	awareness: AwarenessAttachment<TSchema>;
	rpc: SyncRpcAttachment;
};

export type WireRpcError = Exclude<
	RpcError,
	{ name: 'PeerNotFound' | 'PeerLeft' }
>;

export type RemoteCallError = WireRpcError | PeerAddressError;

export type RemoteClient = {
	actions<T>(peerId: string): RemoteActionProxy<T, RemoteCallError>;
	describe(
		peerId: string,
		options?: RemotePeerCallOptions,
	): Promise<Result<ActionManifest, RemoteCallError>>;
	invoke<
		TMap extends RpcActionMap = DefaultRpcMap,
		TAction extends string & keyof TMap = string & keyof TMap,
	>(
		peerId: string,
		action: TAction,
		input?: TMap[TAction]['input'],
		options?: RemotePeerCallOptions,
	): Promise<Result<TMap[TAction]['output'], RemoteCallError>>;
};
```

Remote call options extend the current RPC timeout option:

```ts
export type RemotePeerCallOptions = {
	timeout?: number;
	waitForPeerMs?: number;
};
```

`timeout` is the RPC response budget after peer resolution. `waitForPeerMs` is the awareness wait budget before the RPC frame is sent.

### Peer Address Errors

```ts
export const PeerAddressError = defineErrors({
	PeerNotFound: ({
		peerTarget,
		sawPeers,
		waitMs,
	}: {
		peerTarget: string;
		sawPeers: boolean;
		waitMs: number;
	}) => ({
		message: `no peer matches peer id "${peerTarget}"`,
		peerTarget,
		sawPeers,
		waitMs,
	}),
	PeerLeft: ({
		peerTarget,
		targetClientId,
		peerState,
	}: {
		peerTarget: string;
		targetClientId: number;
		peerState: PeerAwarenessState;
	}) => ({
		message: `peer "${peerTarget}" disconnected before RPC response arrived`,
		peerTarget,
		targetClientId,
		peerState,
	}),
});
export type PeerAddressError = InferErrors<typeof PeerAddressError>;
```

`emptyReason` stays out of this error. It is a daemon and CLI presentation detail because it comes from `runtime.sync.status`, not awareness.

### Remote Invocation Flow

```txt
remote.invoke(peerId, action, input, options)
  |
  +-- resolve peer id from awareness.peers()
  |     |
  |     +-- if missing and waitForPeerMs <= 0:
  |     |     return PeerAddressError.PeerNotFound
  |     |
  |     +-- if missing and waitForPeerMs > 0:
  |           observe awareness until match or timeout
  |
  +-- call rpc.rpc(clientId, action, input, { timeout })
  |
  +-- while call is pending:
        observe awareness; if peer id disappears, return PeerAddressError.PeerLeft
```

## Alternative APIs That Also Succeed

### A: Remote Client Owns Peer Addressing

```ts
const remote = createRemoteClient({ awareness, rpc });
await remote.invoke(peerId, 'tabs.close', input, { waitForPeerMs: 1000 });
await remote.actions<TabActions>(peerId).tabs.close(input);
```

This is the recommended shape.

It succeeds because peer lookup is only needed to invoke remote actions. The caller passes the two real dependencies, and the remote client owns the private mechanics of stable peer id to Yjs client id resolution.

### B: Peer Resolver Factory

```ts
const peerResolver = createPeerResolver(awareness);
const remote = createRemoteClient({ peerResolver, rpc });
```

This also succeeds if peer lookup becomes a reusable public feature outside remote RPC. It fixes the current smell because it does not depend on sync and does not pretend to own state.

Trade-off: it keeps one extra noun in every app factory. Today that noun has no independent product value, so it should not be the default.

### C: Pure Peer Helpers

```ts
const peer = findPeer(awareness, peerId);
const peer = await waitForPeer(awareness, peerId, { timeoutMs });
```

This succeeds for internal implementation. It is direct and honest: pass awareness, get peer resolution.

Trade-off: making these the public main path spreads `findPeer(awareness, id)` calls through consumers. The factory-composition rule says repeated `fn(resource, ...)` calls should become a service when the behavior is a stable capability. Here, that service is the remote client.

### D: Generic Awareness Index

```ts
const peerIndex = createAwarenessIndex(awareness, {
	field: 'peer',
	key: (state) => state.peer.id,
});
```

This succeeds as a general library design, but it is premature for this codebase. There is one standard peer field today, and no caller needs arbitrary indexed awareness fields.

Trade-off: it creates a generic indexing product before the second use case exists.

## Rejected APIs

### Peer Directory With Sync

```ts
const peerDirectory = createPeerDirectory({ awareness, sync });
```

Rejected. Peer lookup should not know transport status.

### Peer Lookup With Status Getter

```ts
const peers = createPeerLookup(awareness, {
	getStatus: () => sync.status,
});
```

Rejected. This removes the direct sync dependency but still mixes peer lookup with status presentation.

### Awareness Method Plugins

```ts
const peers = awareness.asPeerLookup();
```

Rejected. Generic awareness should not know that a field named `peer` has special behavior.

### Sync-Owned Awareness

```ts
const sync = attachSync(ydoc, {
	awareness: {
		schema: { peer: PeerIdentity },
		initial: { peer },
	},
});
```

Rejected. This makes sync own awareness construction again.

## Architecture

### Current Shape

```txt
openFuji()
  |
  +-- attachAwareness(ydoc, { schema, initial })
  |
  +-- attachSync(ydoc, { awareness })
  |
  +-- createPeerDirectory({ awareness, sync })
  |     |
  |     +-- peers()
  |     +-- find()
  |     +-- waitForPeer()
  |     +-- observe()
  |
  +-- sync.attachRpc(actions)
  |
  +-- createRemoteClient({ peerDirectory, rpc })
```

Problem:

```txt
awareness.peers() and peerDirectory.peers() both look canonical.
```

### Target Shape

```txt
openFuji()
  |
  +-- attachAwareness(ydoc, { schema, initial })
  |     |
  |     +-- owns raw YAwareness
  |     +-- validates typed state
  |
  +-- attachSync(ydoc, { awareness })
  |     |
  |     +-- transports Y.Doc updates
  |     +-- transports awareness frames
  |
  +-- sync.attachRpc(actions)
  |     |
  |     +-- sends actions by Yjs client id
  |
  +-- createRemoteClient({ awareness, rpc })
        |
        +-- resolves peer id from awareness
        +-- sends actions through rpc
```

There is one peer list:

```txt
runtime.awareness.peers()
```

There is one high-level peer-addressed RPC surface:

```txt
runtime.remote.invoke(peerId, action, input, options)
runtime.remote.actions<T>(peerId).some.action(input, options)
```

## Design Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Peer state owner | `attachAwareness` | Peer identity is one field in the typed awareness state. |
| Peer listing | Read `runtime.awareness.peers()` directly | Listing peers is just reading awareness. A directory object duplicates that read. |
| Peer-addressed RPC | `createRemoteClient({ awareness, rpc })` | Peer lookup only exists to choose the RPC target client id. |
| Daemon runtime | expose `awareness`, `sync`, `remote`, and `actions` | The daemon needs peer listing, status, remote invocation, and local action roots. It does not need `peerDirectory` or low-level `rpc`. |
| Peer miss status text | compute in daemon or CLI boundary | Offline wording comes from `sync.status`, not from peer lookup. |
| Peer errors | move peer-id errors to workspace | Stable peer ids and `PeerIdentity` are workspace concepts, not sync protocol concepts. |
| Helper exports | keep peer resolution private at first | Export helpers only if a non-RPC caller appears. |
| Compatibility | no aliases | A clean break should leave one canonical path. |

## Implementation Plan

### Phase 1: Rename Peer Identity Types

- [x] **1.1** Rename `packages/workspace/src/document/peer-presence-defs.ts` to `peer-identity.ts`.
- [x] **1.2** Keep `PeerIdentity` and `PeerRuntime`.
- [x] **1.3** Rename `PeerPresenceState` to `PeerAwarenessState` or `PeerState`.
- [x] **1.4** Keep `ResolvedPeer` only if it is used internally by remote action resolution.
- [x] **1.5** Update imports from `peer-presence-defs.js` to `peer-identity.js`.
- [x] **1.6** Update docs that mention `presence` for peer identity.

### Phase 2: Delete Peer Directory

- [x] **2.1** Delete `PeerDirectory` and `createPeerDirectory`.
- [x] **2.2** Delete `packages/workspace/src/document/peer-presence.ts` unless it is repurposed as a private non-exported helper file.
- [x] **2.3** Remove `createPeerDirectory` from `packages/workspace/src/index.ts`.
- [x] **2.4** Remove every `peerDirectory` field from app and daemon bundles.
- [x] **2.5** Replace `peerDirectory.peers()` with `awareness.peers()` where listing peers.
- [x] **2.6** Replace `peerDirectory.observe()` with `awareness.observe()` where watching join and leave events.

### Phase 3: Make Remote Client Own Peer Addressing

- [x] **3.1** Change `createRemoteClient({ peerDirectory, rpc })` to `createRemoteClient({ awareness, rpc })`.
- [x] **3.2** Add private `findPeer(awareness, peerId)` and `waitForPeer(awareness, peerId, { timeoutMs })` helpers inside `remote-actions.ts` or a private `peer-addressing.ts`.
- [x] **3.3** Add `remote.invoke(peerId, action, input, options)` and route `actions<T>(peerId)` through the same sender.
- [x] **3.4** Preserve deterministic duplicate handling by sorting Yjs client ids before selecting a matching peer id.
- [x] **3.5** Observe awareness during in-flight calls and return `PeerAddressError.PeerLeft` if the target peer disappears.
- [x] **3.6** Support `waitForPeerMs` for `invoke`, `describe`, and proxy leaves if the type surface can stay coherent.
- [x] **3.7** Update `RemoteActionProxy` to carry a generic error type if needed, for example `RemoteActionProxy<T, TError = RpcError>`.

### Phase 4: Move Peer Address Errors

- [x] **4.1** Define `PeerAddressError` in `packages/workspace/src/rpc/remote-actions.ts` or a sibling `peer-addressing.ts`.
- [x] **4.2** Define `WireRpcError = RpcError` after removing `PeerNotFound` and `PeerLeft` from `@epicenter/sync`.
- [x] **4.3** Define `RemoteCallError = WireRpcError | PeerAddressError`.
- [x] **4.4** Move stable peer-id `PeerNotFound` behavior out of `@epicenter/sync` if no wire consumer needs it.
- [x] **4.5** Move stable peer-id `PeerLeft` behavior out of `@epicenter/sync` if no wire consumer needs it.
- [x] **4.6** Keep sync wire errors in `@epicenter/sync`: `PeerOffline`, `Timeout`, `ActionNotFound`, `ActionFailed`, and `Disconnected`.
- [x] **4.7** Update CLI error rendering for `RemoteCallError`.

### Phase 5: Update Daemon Runtime Contract

- [x] **5.1** Update `DaemonRuntime` to require `awareness`, `sync`, `remote`, `actions`, and `[Symbol.asyncDispose]`.
- [x] **5.2** Remove `rpc` from `DaemonRuntime` unless a daemon route still needs low-level client-id RPC.
- [x] **5.3** Update `hasDaemonRuntimeShape` in `packages/cli/src/load-config.ts`.
- [x] **5.4** Update daemon `/peers` to read `runtime.awareness.peers()`.
- [x] **5.5** Update CLI `up` peer snapshots and awareness subscriptions to use `runtime.awareness`.
- [x] **5.6** Update daemon `/run` to call `runtime.remote.invoke(...)`.
- [x] **5.7** Convert `PeerAddressError.PeerNotFound` to `RunError.PeerMiss` at the `/run` boundary and add `emptyReason` from `runtime.sync.status`.

### Phase 6: Update Apps, Examples, And Docs

- [x] **6.1** Update Fuji browser and daemon factories.
- [x] **6.2** Update Honeycrisp browser and daemon factories.
- [x] **6.3** Update Opensidian browser and daemon factories.
- [x] **6.4** Update Tab Manager extension factory.
- [x] **6.5** Update Zhongwen daemon factory.
- [x] **6.6** Update `examples/notes-cross-peer`.
- [x] **6.7** Update `packages/workspace/src/document/README.md`.
- [x] **6.8** Update `packages/workspace/SYNC_ARCHITECTURE.md`.
- [x] **6.9** Update `packages/workspace/README.md` and `packages/cli/README.md`.
- [x] **6.10** Add a short note to the previous awareness spec saying this spec supersedes the transitional `PeerDirectory` target.

### Phase 7: Tests And Verification

- [x] **7.1** Update `remote-actions.test.ts` to construct `awareness` directly.
- [x] **7.2** Add remote tests for immediate peer miss, waited peer resolution, peer leaving mid-call, and duplicate peer ids.
- [x] **7.3** Update daemon app, run handler, and list route tests.
- [x] **7.4** Update CLI load config and `up` tests.
- [x] **7.5** Update attach sync tests that currently use `createPeerDirectory`.
- [x] **7.6** Run focused checks:

```bash
bun test packages/workspace/src/document
bun test packages/workspace/src/rpc
bun test packages/workspace/src/daemon
bun test packages/cli
```

- [x] **7.7** Run typechecks:

```bash
bun --cwd packages/workspace typecheck
bun typecheck
```

- [x] **7.8** Run stale-name search:

```bash
rg "sync\\.attachPresence|attachPresence|createPeerDirectory|PeerDirectory|peerDirectory|peer-presence|PeerPresence|PeerIdentityInput" packages apps examples
```

Expected result: no production matches. Run a separate docs search after that and update active docs to the new shape. Historical specs may keep old names only when they clearly say a newer spec supersedes them.

## Edge Cases

### Duplicate Peer Ids

Two live clients can publish the same stable peer id. The current behavior sorts client ids and picks the lowest matching client id.

Expected behavior:

1. Preserve deterministic selection.
2. Do not throw just because duplicates exist.
3. Consider a later diagnostic if duplicates become a real debugging problem.

### Peer Appears During Wait

`remote.invoke(peerId, action, input, { waitForPeerMs: 1000 })` should observe awareness and send the RPC if the peer appears before the timeout.

Expected behavior:

1. No RPC frame is sent before a peer resolves.
2. Timeout returns `PeerAddressError.PeerNotFound`.
3. The error carries `peerTarget`, `sawPeers`, and `waitMs`.

### Peer Leaves Mid Call

A peer can disappear from awareness after the RPC frame is sent but before the response returns.

Expected behavior:

1. The remote client resolves the call with `PeerAddressError.PeerLeft`.
2. The error carries the original `targetClientId` and `peerState` captured at send time.
3. The lower-level RPC promise may later resolve; the high-level call should settle only once.

### Sync Offline But Awareness Has Old States

`attachSync` should already remove remote awareness states during offline or disconnect cleanup. If no peer is visible, the remote client should only report that no peer was found.

Expected behavior:

1. Remote client returns peer-addressing information only.
2. Daemon `/run` adds offline context by reading `runtime.sync.status`.
3. Peer lookup helpers do not import or receive sync status.

### Malformed Awareness State

Remote awareness can contain invalid JSON for the declared schema.

Expected behavior:

1. `awareness.peers()` excludes malformed states.
2. Remote peer resolution only sees validated states.
3. Invalid states do not crash `remote.invoke`.

### No Awareness On Sync

Some documents may use `attachSync` without awareness.

Expected behavior:

1. Document sync still works.
2. `createRemoteClient` cannot be constructed without an awareness attachment that includes `peer`.
3. Daemon runtimes that support `/peers` and `run --peer` must provide peer awareness.

## Open Questions

1. Should `PeerNotFound` and `PeerLeft` be removed from `@epicenter/sync` in this same change?

   Recommendation: yes, if the test diff stays manageable. They describe stable peer-id addressing, not the wire protocol. If the diff becomes too large, first stop constructing them from workspace remote code, then remove them in a follow-up cleanup.

2. Should `waitForPeerMs` be part of `RemoteCallOptions` or only `RemotePeerCallOptions`?

   Recommendation: prefer `RemotePeerCallOptions` in `remote-actions.ts`. If the proxy type makes that awkward, add an error generic to `RemoteActionProxy` and keep low-level `rpc.rpc` options focused on `timeout`.

3. Should peer resolution helpers be exported?

   Recommendation: no. Keep them private until there is a caller that needs peer lookup without remote invocation or peer listing.

4. Should `awareness.raw` be hidden in this change?

   Recommendation: no. Hiding raw awareness is a separate boundary cleanup. This spec should remove the peer directory concept without also changing editor-binding escape hatches.

## Success Criteria

- [x] App factories create `awareness`, pass it to `attachSync`, create `rpc`, and create `remote` from `{ awareness, rpc }`.
- [x] No production code imports or constructs `createPeerDirectory`.
- [x] No runtime contract exposes `peerDirectory`.
- [x] Daemon `/peers` reads from `runtime.awareness.peers()`.
- [x] Daemon `/run` calls `runtime.remote.invoke(...)`.
- [x] Peer-id miss errors no longer live in `attach-sync.ts`.
- [x] `@epicenter/sync` no longer owns stable peer-id addressing errors, unless explicitly deferred in the implementation notes.
- [x] Focused workspace, RPC, daemon, and CLI tests pass.
- [x] Broad typecheck is run, or unrelated failures are recorded with concrete file paths.
- [x] Stale-name search has no production matches for deleted names.

## Implementation Notes

Implemented in one cleanup pass. The final public call site is:

```ts
const awareness = attachAwareness(ydoc, {
	schema: { peer: PeerIdentity },
	initial: { peer },
});

const sync = attachSync(ydoc, { awareness });
const rpc = sync.attachRpc(actions);
const remote = createRemoteClient({ awareness, rpc });
```

The remote client now owns stable peer-id resolution. It reads from `awareness.peers()`, selects duplicate peer ids deterministically by lowest Yjs client id, waits for peers when `waitForPeerMs` is set, and returns `PeerAddressError.PeerLeft` if the exact target client disappears while a call is in flight.

`RunError.PeerMiss` remains at the daemon route boundary. That is intentional: peer miss presentation still needs `runtime.sync.status` to explain offline and startup states, but peer lookup itself does not depend on sync.

Verification completed:

```bash
bun test packages/workspace/src/document
bun test packages/workspace/src/rpc
bun test packages/workspace/src/daemon
bun test packages/cli
bun --cwd packages/workspace typecheck
```

`bun typecheck` still fails on unrelated existing Svelte and app issues, including `apps/landing` missing `@astrojs/svelte`, `packages/svelte-utils/src/from-table.svelte.ts` expecting the old table result shape, `packages/ui` `#/utils` resolution from downstream package checks, and unrelated Tab Manager chat and command-palette errors.

The stale-name search has no production matches:

```bash
rg "sync\\.attachPresence|attachPresence|createPeerDirectory|PeerDirectory|peerDirectory|peer-presence|peer-presence-defs|PeerPresence|PeerIdentityInput|RpcError\\.PeerNotFound|RpcError\\.PeerLeft" packages apps examples
```

## References

- `packages/workspace/src/document/attach-awareness.ts`: owns typed awareness state and raw `YAwareness`.
- `packages/workspace/src/document/attach-sync.ts`: transports awareness frames when an awareness attachment is provided.
- `packages/workspace/src/document/peer-presence.ts`: transitional peer directory implementation to delete.
- `packages/workspace/src/document/peer-presence-defs.ts`: peer identity definitions to rename.
- `packages/workspace/src/rpc/remote-actions.ts`: target home for peer-addressed remote invocation.
- `packages/workspace/src/rpc/types.ts`: low-level RPC map types and docs.
- `packages/workspace/src/shared/actions.ts`: remote proxy types and `RemoteCallOptions`.
- `packages/workspace/src/daemon/types.ts`: daemon runtime contract.
- `packages/workspace/src/daemon/app.ts`: `/peers` route.
- `packages/workspace/src/daemon/run-handler.ts`: `/run` local and remote dispatch.
- `packages/workspace/src/daemon/run-errors.ts`: route-level error normalization for CLI rendering.
- `packages/cli/src/load-config.ts`: runtime shape check at user config boundary.
- `packages/cli/src/commands/up.ts`: daemon startup peer snapshot and awareness subscription.
- `packages/cli/src/commands/run.ts`: CLI rendering for peer miss and remote call errors.
- `apps/fuji/src/lib/fuji/browser.ts`: browser bundle call site.
- `apps/fuji/src/lib/fuji/daemon.ts`: daemon bundle call site. Apply the same pattern to Honeycrisp, Opensidian, Zhongwen, Tab Manager, and `examples/notes-cross-peer`.
