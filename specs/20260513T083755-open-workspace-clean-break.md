# Collapse `attachSync` + `attachPresence` + `attachRpc` + `createRemoteClient` into `openWorkspace`

**Date**: 2026-05-13
**Status**: In Progress (Phases 1, 3, 4, 5 landed; Phases 2, 6, 7 pending)
**Author**: AI-assisted (Claude)
**Branch**: refactor/standardize-symbol-dispose
**Supersedes**: refines and replaces the direction in
- `specs/20260430T103959-split-attach-sync-into-transport-presence-rpc.md`
- `specs/20260430T114949-peer-presence-rename-and-sync-split.md`
- `specs/20260504T231540-attach-sync-trim-to-supervisor-superseded.md` (already marked superseded)

The two earlier split specs argued for chaining `attachSync().attachPresence().attachRpc()`. This spec reverses that direction: the chain is ceremony for the common case, and a real audit shows no app uses the lower-level surface anyway.

## One-Sentence Test

`openWorkspace(ydoc, { url, identity, actions })` returns a workspace with your local action registry and a peers surface for invoking remote actions, refusing self-RPC, the proxy form, full schemas in awareness, and the three-step attach chain so the call-site tax collapses without losing capability.

## Overview

Today an app workspace opens with three statements: `attachSync(ydoc, ...)`, `sync.attachPresence({ peer })`, and `sync.attachRpc(actions)`, then wraps them with `createRemoteClient({ awareness, rpc })` to get the actually-callable surface. Four primitives are paid for at every workspace factory. An audit of `apps/*` confirms **no app code calls the lower-level `rpc.rpc(...)` surface directly**. Every workspace already collapses presence and RPC into a `remote` client and routes by peer id.

This spec replaces the four-primitive chain with one primitive:

```ts
const ws = openWorkspace(ydoc, {
	url,
	identity: { id, name, platform },
	actions,
});

await ws.actions.tabs.close({ tabIds: [1] });
const mac = ws.peers.find<MacActions>('macbook-pro');
await mac?.invoke('whispering.startRecording', { deviceId: 'default' });
```

Content docs (workspace internals that sync bytes without participating in cross-runtime RPC) get a sibling primitive `attachYjsSync(ydoc, { url })` with no presence and no actions.

This is a clean break. No deprecation period, no compatibility shims. The 7 workspace factories rewrite in one pass; old exports are removed.

## Motivation

### Current State

A representative workspace factory today (`apps/fuji/src/routes/(signed-in)/fuji/browser.ts:99-115`):

```ts
const sync = attachSync(ydoc, {
	url: websocketUrl(`${APP_URLS.API}/workspaces/${ydoc.guid}`),
	waitFor: idb.whenLoaded,
	getToken: () => auth.getToken(),
});

const awareness = attachAwareness(ydoc, peerPresenceDefs, {
	peer: { id: getOrCreateInstallationId(), name: 'Fuji', platform: 'web' },
});

const rpc = sync.attachRpc(actions);

const remote = createRemoteClient({ awareness, rpc });
```

Three local variables. Four primitives. One workspace.

The audit:

```
grep "rpc\.rpc(" apps/*/src/**/*.ts             -> 0 hits in app code, only in tests/docs
grep "createRemoteClient" apps/*/src/**/*.ts    -> 7 workspace factories, identical pattern
grep "remote\.actions(" apps/*/src/**/*.ts      -> exclusive remote-call form
grep "remote\.invoke(" apps/*/src/**/*.ts       -> CLI/daemon dynamic-dispatch form
grep "remote\.describe(" apps/*/src/**/*.ts     -> CLI introspection only
```

Nobody uses the low-level transport. The split was paid for, then collapsed back into `createRemoteClient` at every call site.

### What's actually wrong

1. **Four primitives for one concept.** Sync, presence, RPC, and the bound remote client are always set up together. Splitting them creates four constructors to compose, four imports, four mocks in tests.
2. **Self-RPC is a stringly-typed error.** `attach-sync.ts:805-810` returns `RpcError.ActionFailed({ cause: 'Cannot RPC to self, call the action directly' })`. The cause is a string. There is no defined variant. Callers cannot exhaustively switch on it.
3. **`rpc.rpc(...)` is a public surface that should be internal.** Every doc example and type comment chains `rpc.rpc(...)` (note the doubled name), but no app code calls it. The shape exists only to expose the wire to tests.
4. **`createRemoteClient({ awareness, rpc })` is the same workspace, written twice.** It takes two of the workspace's own attachments and binds them back together. The factory call is mechanical and identical across all 7 apps.
5. **Action discovery is a roundtrip per peer.** Rendering "list devices and their actions" requires N calls to `system.describe`. UIs work around this by deferring discovery or caching brittlely.
6. **Conditional types and silent no-ops.** `attachAwareness` and `attachRpc` are optional today; `SyncAttachment` advertises methods that no-op when their config wasn't passed. The type lies.

### Asymmetric Wins Claimed

Each refusal collapses meaningful complexity:

| Refuse | Win |
| --- | --- |
| The 3-step attach chain | One config, one return, one mental model; 7 factories collapse to one statement |
| `createRemoteClient` as a separate factory | The workspace IS the remote client; no two-step bind |
| `peer.actions` proxy | One canonical dispatch path (`peer.invoke`); deletes `buildProxy` Proxy implementation |
| Full schemas in awareness | ~17x smaller per-peer awareness state with no functional loss |
| Self in `peers.list()` | Self-RPC becomes type-impossible; no `isSelf` branching anywhere |
| Backwards-compat shims | 7 factories rewrite once, in one PR; no two-API world to maintain |
| Conditional return types | `identity` and `actions` always required; content docs use `attachYjsSync` sibling |
| `device` as a public noun | Stays as `peer`, no collision with app-level Device tables in Tab Manager and Whispering |

What survives unchanged:

- `attachAwareness` for custom typed presence (cursors, selections) stays orthogonal
- `defineQuery` and `defineMutation` action definitions stay identical
- `Actions` registry type stays
- Wire protocol (`encodeRpcRequest`, `MESSAGE_TYPE.*`) stays internal
- `wellcrafted/result` `Result` and `defineErrors` patterns stay

## Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Public primitive name | `openWorkspace` | Matches existing `open*` doc factory pattern in the repo; `connect*` overemphasizes network at the expense of the local action registry |
| Self-identity config key | `identity` | Matches `PeerIdentity` type name; not ambiguous with auth identity at this layer |
| Two surfaces (local vs remote) | Local: `ws.actions.*` direct call. Remote: `ws.peers.find(id).invoke(path, input)` | Honest about different failure modes; refuses Option 1's `devices.get(selfId).actions` |
| Self in `peers.list()` | Excluded entirely | Type-level self-RPC impossibility; no `isSelf` UI branching |
| Remote dispatch surface | `peer.invoke(path, input)` only | One canonical path; admits the wire; supports both typed and dynamic callers via generic |
| Action discovery | Dot-paths in awareness, full schemas via `describe` | Synchronous listing/routing for ~600 B awareness state vs ~10 KB for full schemas |
| Content-doc sync primitive | `attachYjsSync` sibling | Refuses to make content docs pay for presence/RPC machinery they never use |
| Migration | Clean break, one PR | 7 factories, all in this monorepo, no external consumers; cohesive-clean-breaks principle |
| Identity field publication | Awareness state `{ identity, actionPaths }` | Replaces existing `{ peer }` shape; one-time wire migration |
| `attachAwareness` for custom presence | Unchanged | Cursors, typing indicators, custom states remain orthogonal |

## Architecture

### Before

```txt
+----------------------------+
| attachSync(ydoc, config)   |  <- WebSocket supervisor + Y.Doc sync
|                            |
| returns:                   |
|   status, whenConnected    |
|   attachRpc(actions)       |  <- two-step: RPC sub-protocol
+----------------------------+
        |
        v
+----------------------------+
| attachAwareness(ydoc,      |  <- separate, peer presence definitions
| peerPresenceDefs,          |
| { peer })                  |
+----------------------------+
        |
        +-- presence ----+
        |                |
        v                v
+----------------------------+
| createRemoteClient(        |  <- glues presence + RPC, separate factory
| { awareness, rpc })        |
+----------------------------+
   |
   +- .actions(peerId)  -> Proxy wrapping invokeRemoteAction
   +- .invoke(peerId, action, input)
   +- .describe(peerId)
```

Every workspace factory pays for four constructor calls and three local variables to compose what is effectively one concept.

### After

```txt
+----------------------------+
| openWorkspace(          |
|   ydoc,                    |
|   { url,                   |
|     identity,              |
|     actions,               |
|     waitFor?, getToken? }  |
| )                          |
+----------------------------+
        |
        v
+----------------------------+
| Workspace                  |
|                            |
| identity                   |
| actions                    |  <- local registry, direct call
| status, whenConnected      |
| reconnect, goOffline,      |
| dispose                    |
|                            |
| peers                      |  <- remote surface
|   .list()                  |  <- online peers, NEVER self
|   .find<T>(peerId)         |  <- Peer<T> | undefined
|   .observe(callback)       |
+----------------------------+
        |
        v
+----------------------------+
| Peer<TActions>             |
|                            |
| id                         |  <- stable peer id
| identity                   |  <- full identity
| actionPaths                |  <- string[] from awareness
| invoke<TMap>(path, input)  |  <- typed dispatch
| describe()                 |  <- ActionManifest, on demand
+----------------------------+

(content docs, no presence/RPC):

+----------------------------+
| attachYjsSync(ydoc,        |
|   { url, waitFor?,         |
|     getToken? })           |
+----------------------------+
        |
        v
+----------------------------+
| YjsSyncAttachment          |
|                            |
| status, whenConnected      |
| reconnect, goOffline,      |
| whenDisposed               |
+----------------------------+
```

### Wire shape (awareness)

Today each peer publishes:

```ts
{ peer: { id, name, platform } }
```

Action discovery requires a roundtrip to `system.describe`.

After this spec:

```ts
{
	identity: { id, name, platform },
	// alphabetically sorted, computed once at openWorkspace startup,
	// never mutated mid-connection
	actionPaths: ['tabs.close', 'tabs.list', 'whispering.startRecording', 'whispering.stopRecording'],
}
```

`actionPaths` is published in **alphabetical sort order** computed once via `Object.keys(walkActions(actions)).sort()` at workspace startup. Two peers running the same code publish byte-identical arrays, so awareness updates do not ping-pong on irrelevant ordering differences.

Size comparison (20 actions per peer, typical app):

| Field | Approx size |
| --- | --- |
| `identity` | ~80 B |
| `actionPaths` (20 strings of ~30 B) | ~600 B |
| Full manifest with input/output schemas | ~10 KB |

The dot-paths-only choice keeps awareness state bounded (~1 KB per peer) while enabling synchronous listing and capability-based routing without roundtrips. Full schemas are fetched via `peer.describe()` only when introspection callers need them (CLI listing with details, AI tool generation).

### Self-RPC protection (three layers)

1. **Type-level**: `ws.peers.find(id)` and `ws.peers.list()` return `Peer<T> | undefined` and `Peer<T>[]`. The local self is not exposed through `peers`. It is reachable only as `ws.actions.*`, which is a direct function registry, not a wire dispatch. The type system has no path that routes a self-call through the wire.
2. **Runtime filter**: `peers.list()` and `peers.find()` filter awareness states where `state.identity.id === ws.identity.id`. Even if a stale awareness entry exists for self, it is excluded from the public surface.
3. **Wire fallback**: If a self-clientId ever reaches the wire layer (deserialized peer reference, test fixture, future bug), the workspace returns a defined error `SelfInvocationError` instead of the current stringly-typed `RpcError.ActionFailed`. This error variant lives in **`@epicenter/workspace`**, not `@epicenter/sync`: the concept of "self" only exists where `identity` exists, which is the workspace layer.

   ```ts
   // packages/workspace/src/document/peer.ts (alongside PeerLeftError)
   export const SelfInvocationError = defineErrors({
   	SelfInvocation: ({ action }: { action: string }) => ({
   		message: `[openWorkspace] cannot RPC to self for "${action}"; call ws.actions.${action} directly`,
   		action,
   	}),
   });
   export type SelfInvocationError = InferErrors<typeof SelfInvocationError>;
   ```

## API Specification

### `openWorkspace`

```ts
export type OpenWorkspaceConfig = {
	/** Standard sync config */
	url: string;
	waitFor?: Promise<unknown>;
	getToken?: () => string | null | Promise<string | null>;
	openWebSocket?: OpenWebSocket;
	log?: Logger;

	/** Required: this runtime's stable identity */
	identity: PeerIdentity;

	/** Required: action registry, may be empty `{}` for a workspace that only consumes */
	actions: Actions;
};

export function openWorkspace<TActions extends Actions>(
	ydoc: Y.Doc,
	config: OpenWorkspaceConfig & { actions: TActions },
): Workspace<TActions>;
```

### Return type

```ts
export type Workspace<TActions extends Actions = Actions> = {
	// Identity and local actions
	readonly identity: PeerIdentity;
	readonly actions: TActions;

	// Sync lifecycle
	readonly status: SyncStatus;
	readonly whenConnected: Promise<void>;
	readonly whenDisposed: Promise<void>;
	onStatusChange(listener: (status: SyncStatus) => void): () => void;
	reconnect(): void;
	goOffline(): void;
	dispose(): void;

	// Remote surface
	readonly peers: PeersSurface;
};
```

### `PeersSurface`

```ts
export type PeersSurface = {
	/** Online peers, never including self, in clientId-ascending order. */
	list(): Peer[];

	/** Find by stable peer id. Returns undefined if not currently online. */
	find<TActions = unknown>(peerId: string): Peer<TActions> | undefined;

	/**
	 * Subscribe to changes in the peer list. Bare callback; no delta argument.
	 * Snapshot reads via `list()` are cheap, so a delta API would double the
	 * surface for marginal benefit. Returns unsubscribe fn.
	 */
	observe(callback: () => void): () => void;
};
```

### `Peer`

```ts
export type Peer<TActions = unknown> = {
	readonly id: string;
	readonly identity: PeerIdentity;
	/**
	 * Sorted alphabetically. Computed once at peer publication; never mutated
	 * during a connection. Two peers with the same action set produce
	 * byte-identical `actionPaths` arrays.
	 */
	readonly actionPaths: readonly string[];

	/**
	 * Invoke a remote action by dot-path. The generic narrows path autocomplete
	 * and input/output types when called as `peer.invoke<TMap>(...)`. When the
	 * peer was obtained with `peers.find<TActions>(id)`, types narrow automatically.
	 */
	invoke<
		TMap extends RpcActionMap = InferSyncRpcMap<TActions>,
		TPath extends string & keyof TMap = string & keyof TMap,
	>(
		path: TPath,
		input: TMap[TPath]['input'],
		options?: RemoteCallOptions,
	): Promise<Result<TMap[TPath]['output'], RemoteCallError>>;

	/**
	 * Fetch the peer's full action manifest including input/output schemas.
	 * Roundtrips via `system.describe`. Used by CLI introspection and AI tool
	 * generation; typed TS callers should `import type` from the host app.
	 */
	describe(options?: RemoteCallOptions): Promise<Result<ActionManifest, RemoteCallError>>;
};
```

### `ActionManifest`

The wire shape returned by `peer.describe()` is the existing `ActionManifest` in `packages/workspace/src/shared/actions.ts:80-95`. Reproduced here for spec self-containment:

```ts
import type { TSchema } from 'typebox';

export type ActionMeta<
	TInput extends TSchema | undefined = TSchema | undefined,
> = {
	type: 'query' | 'mutation';
	title?: string;
	description?: string;
	/** The live TypeBox TSchema for input. Absent if the action takes no input. */
	input?: TInput;
};

export type ActionManifest = Record<string, ActionMeta>;
```

Notes:
- **TypeBox**, not raw JSON Schema. The `input` field is the live `TSchema` (which is itself JSON-Schema-compatible structurally, so it survives the wire round-trip). Consumers can hand a `TSchema` directly to TypeBox's `Value.Check` or convert to JSON Schema for AI tool definitions.
- **No `output` schema in the manifest.** Output types are derived at compile time via `InferSyncRpcMap<TActions>` (which uses `Awaited<TOutput> extends Result<...>` to walk the handler return type). The wire layer does not validate outputs. This matches the file-level comment in `actions.ts:74-78`: "There is no separate wire form."
- `title` and `description` flow through to CLI listings and AI tool descriptions.
- `system.describe` returns this directly. `describeActions(actions)` walks the local registry to produce it.

If a future spec adds runtime output validation, this manifest gains an optional `output?: TSchema` field. Out of scope here.

### `RemoteCallError`

```ts
export type RemoteCallError =
	| RpcError              // wire-level: timeout, disconnected, malformed
	| SelfInvocationError   // self-RPC attempted (wire fallback only)
	| PeerLeftError;        // peer disconnected mid-call

export const PeerLeftError = defineErrors({
	PeerLeft: ({ peerId, action }: { peerId: string; action: string }) => ({
		message: `peer "${peerId}" disconnected before "${action}" response arrived`,
		peerId,
		action,
	}),
});
export type PeerLeftError = InferErrors<typeof PeerLeftError>;
```

`PeerNotFound` is no longer an error variant returned by invocation: if `peers.find(id)` returns undefined, the caller never gets a Peer to invoke against. The "wait for peer" timeout (`waitForPeerMs`) in the current `createRemoteClient` is intentionally dropped; if you want to await a peer, do it explicitly:

```ts
const mac = await waitForPeer(ws.peers, 'macbook-pro', { timeoutMs: 5000 });
if (!mac) return notFoundUi();
await mac.invoke('whispering.startRecording', { deviceId });
```

A `waitForPeer(peers, peerId, options)` helper exists for this pattern.

### `attachYjsSync` (content-doc sibling)

```ts
export type AttachYjsSyncConfig = {
	url: string;
	waitFor?: Promise<unknown>;
	getToken?: () => string | null | Promise<string | null>;
	openWebSocket?: OpenWebSocket;
	log?: Logger;
};

export type YjsSyncAttachment = {
	readonly status: SyncStatus;
	readonly whenConnected: Promise<void>;
	readonly whenDisposed: Promise<void>;
	onStatusChange(listener: (status: SyncStatus) => void): () => void;
	reconnect(): void;
	goOffline(): void;
};

export function attachYjsSync(ydoc: Y.Doc, config: AttachYjsSyncConfig): YjsSyncAttachment;
```

No `identity`, no `actions`, no `peers`. Just bytes over the supervised WebSocket. Content docs (per-document attachments inside a workspace, e.g., rich-text bodies) use this.

### Awareness state schema

```ts
// packages/workspace/src/document/peer-identity.ts (updated)

export const PeerAwarenessState = type({
	identity: PeerIdentity,
	actionPaths: 'string[]',
});
export type PeerAwarenessState = typeof PeerAwarenessState.infer;
```

The old `{ peer: PeerIdentity }` shape is removed. This is a wire-incompatible change. All Epicenter sync clients in the monorepo update together. **No read-compat for the old shape, no version handshake, no transition window.** During deploy rollouts, peers running the old code are dropped as malformed-state with a warning and appear offline to new peers. The trade-off is accepted: old/new visibility is a transient deploy concern, not a long-term coexistence requirement.

### Custom awareness coexistence

The standard awareness state (`identity`, `actionPaths`) is published by `openWorkspace` internally. Apps that also want custom awareness fields (cursors, typing indicators, selection state) extend the underlying awareness via the existing `attachAwareness` primitive against `ws.awareness`:

```ts
const ws = openWorkspace(ydoc, { url, identity, actions });

// Custom cursor presence on the same awareness instance:
const cursors = attachAwareness(ws.awareness, { cursor: Cursor }, {
	cursor: { x: 0, y: 0 },
});
```

`ws.awareness` is the underlying `Awareness` handle. Reserved keys are `identity` and `actionPaths`; custom fields must use any other key. `attachAwareness` merges fields rather than overwriting, so both `identity` and `cursor` coexist in a single published state.

### Workspace lifecycle

```ts
ws.dispose();
// Sugar for ydoc.destroy(). Both cascade to all attached primitives via the
// standard ydoc destroy listener. If the app owns ydoc separately and prefers
// to destroy it directly, ws.dispose() is unnecessary.
```

## Caller examples

### App workspace (after)

`apps/fuji/src/routes/(signed-in)/fuji/browser.ts`:

```ts
const ws = openWorkspace(ydoc, {
	url: websocketUrl(`${APP_URLS.API}/workspaces/${ydoc.guid}`),
	waitFor: idb.whenLoaded,
	getToken: () => auth.getToken(),
	identity: { id: getOrCreateInstallationId(), name: 'Fuji', platform: 'web' },
	actions,
});
```

One statement. Replaces the four-statement chain.

### Local invocation

```ts
const { data, error } = await ws.actions.entries.create({
	title: 'Hello world',
});
```

Direct function call. No proxy, no wire, no Result wrapping beyond what `defineMutation` returns.

### Remote invocation, typed

```ts
import type { WhisperingActions } from '@org/whispering';

const mac = ws.peers.find<WhisperingActions>('macbook-pro');
if (!mac) return userMessage("Mac isn't connected");

const result = await mac.invoke('whispering.startRecording', {
	deviceId: 'default',
});
//                ^^^^ autocompletes from keyof InferSyncRpcMap<WhisperingActions>
//                                      ^^^ input narrowed to that action's schema
// result: Result<{ recordingId: string }, RemoteCallError>
```

### Remote invocation, capability-based

```ts
const recorder = ws.peers.list()
	.find(p => p.actionPaths.includes('whispering.startRecording'));
if (!recorder) return userMessage('No connected device can record');
await recorder.invoke<WhisperingActions>('whispering.startRecording', { deviceId });
```

No dedicated `peers.hosts(path)` helper. Standard array methods on `peers.list()` cover capability-based picks at the cost of one extra line. If a pattern emerges where the majority of remote-call code repeats this filter, add a helper later; YAGNI for v1.

### Type export convention

To get types across the wire, each app that hosts callable actions exports its action map type:

```ts
// apps/whispering/src/lib/whispering/actions.ts
export const actions = { whispering: { startRecording: defineMutation({...}) } };
export type WhisperingActions = typeof actions;
export type WhisperingActionMap = InferSyncRpcMap<WhisperingActions>;

// caller (any other app):
import type { WhisperingActions } from '@org/whispering/actions';
const mac = ws.peers.find<WhisperingActions>('macbook-pro');
await mac?.invoke('whispering.startRecording', { deviceId });
```

Action maps travel by `import type` (TypeScript), not by wire schema. Runtime introspection via `peer.describe()` is for CLI and AI tool consumers; typed TS callers never need it.

### Remote invocation, dynamic (CLI, AI tools)

```ts
// epicenter call macbook-pro tabs.close --tabIds 1,2
const peer = ws.peers.find(argv.peerId);
if (!peer) return exit(`peer ${argv.peerId} not online`);
const result = await peer.invoke(argv.action, parsedInput);
// no generic -> falls back to DefaultRpcMap, input/output are unknown
```

### Content doc

```ts
// rich text body of an entry, syncs independently of the workspace
const bodyDoc = new Y.Doc({ guid: entry.bodyDocGuid });
const idb = attachIndexedDb(bodyDoc);
const sync = attachYjsSync(bodyDoc, {
	url: websocketUrl(`${APP_URLS.API}/docs/${entry.bodyDocGuid}`),
	waitFor: idb.whenLoaded,
	getToken: () => auth.getToken(),
});
```

No peers, no actions, no identity.

## Files Touched

### New files

| File | Purpose |
| --- | --- |
| `packages/workspace/src/document/open-workspace.ts` | Main primitive. Owns sync supervisor + presence + RPC internally. |
| `packages/workspace/src/document/attach-yjs-sync.ts` | Sibling primitive for content docs. No presence, no RPC. |
| `packages/workspace/src/document/peer.ts` | `Peer` interface, `PeersSurface` implementation, `waitForPeer` helper. |
| `packages/workspace/src/document/open-workspace.test.ts` | Replaces most of `attach-sync.test.ts`. |
| `packages/workspace/src/document/attach-yjs-sync.test.ts` | Supervisor and sync-protocol tests for the content-doc primitive. |
| `packages/workspace/src/document/peer.test.ts` | Peer surface tests, replaces `remote-actions.test.ts`. |

### Renamed or rewritten

| File | Change |
| --- | --- |
| `packages/workspace/src/document/attach-sync.ts` | **Delete.** Internals move to `open-workspace.ts` (presence + RPC paths) and `attach-yjs-sync.ts` (sync-only path). The shared supervisor logic factors into `packages/workspace/src/document/internal/sync-supervisor.ts` if duplication crosses a threshold; otherwise it inlines. |
| `packages/workspace/src/document/peer-identity.ts` | Update awareness shape from `{ peer: PeerIdentity }` to `{ identity: PeerIdentity, actionPaths: string[] }`. Keep `PeerAwarenessState` name (now refers to the new shape). Drop `ResolvedPeer` (no longer used). |
| `packages/workspace/src/document/peer-presence.ts` | **Delete.** Moves into `open-workspace.ts` internally; not a separate sub-attachment anymore. |
| `packages/workspace/src/rpc/remote-actions.ts` | **Delete.** `createRemoteClient`, `buildProxy`, `invokeRemoteAction`, `waitForPeer` all migrate to `peer.ts`. `PeerAddressError` becomes `PeerLeftError` (no `PeerNotFound`; absence is encoded as `undefined`). |
| `packages/workspace/src/rpc/types.ts` | Keep. `InferSyncRpcMap`, `RpcActionMap`, `DefaultRpcMap` unchanged. Update docstring examples from `rpc.rpc(...)` to `peer.invoke(...)`. |
| `packages/workspace/src/shared/actions.ts` | Keep. Update `RemoteActionProxy` references in docstrings; the proxy type itself is removed. |
| `packages/workspace/src/index.ts` | Export `openWorkspace`, `attachYjsSync`, `Workspace`, `Peer`, `PeersSurface`, `PeerIdentity`, `PeerAwarenessState`, error variants. Remove exports of `attachSync`, `SyncRpcAttachment`, `SyncAttachment`, `createRemoteClient`, `RemoteClient`, `RemoteClientOptions`, `attachPeerPresence`, `peerPresenceDefs`. |
| `packages/sync/src/rpc-errors.ts` | Untouched. `SelfInvocationError` lives in `@epicenter/workspace`, not `@epicenter/sync`, because "self" is a workspace-layer concept. Existing `RpcError` variants stay. |
| `packages/workspace/src/document/peer.ts` | Defines `SelfInvocationError` and `PeerLeftError` alongside the `Peer` interface and `PeersSurface` implementation. |

### App-level migrations (7 factories, identical pattern)

| File | Change |
| --- | --- |
| `apps/fuji/src/routes/(signed-in)/fuji/browser.ts:99-115` | Collapse 4-statement attach chain to `openWorkspace(...)`. Drop `createRemoteClient(...)`. Rename `remote` -> `ws.peers` callers. |
| `apps/fuji/src/routes/(signed-in)/fuji/daemon.ts:60-70` | Same. |
| `apps/honeycrisp/src/routes/(signed-in)/honeycrisp/browser.ts:99-115` | Same. |
| `apps/honeycrisp/src/routes/(signed-in)/honeycrisp/daemon.ts:45-55` | Same. |
| `apps/opensidian/src/lib/opensidian/browser.ts:110-120` | Same. Content docs in `opensidian` use `attachYjsSync`. |
| `apps/opensidian/src/lib/opensidian/daemon.ts:48-60` | Same. |
| `apps/zhongwen/src/routes/(signed-in)/zhongwen/daemon.ts:45-55` | Same. |
| `apps/tab-manager/src/lib/tab-manager/extension.ts:60-70` | Same. |
| `apps/tab-manager/src/lib/workspace/rpc-contract.ts` | Update docstring `rpc.rpc(...)` examples to `peer.invoke(...)`. |
| `apps/fuji/src/routes/(signed-in)/fuji/client.ts` | Replace `remote.actions(peerId)` and `remote.describe(peerId)` with `ws.peers.find(peerId)?.invoke(...)` and `?.describe()`. |
| (analogous client files in each app) | Same pattern. |

### Tests

| File | Change |
| --- | --- |
| `packages/workspace/src/document/attach-sync.test.ts` | **Delete.** Coverage replaced by `open-workspace.test.ts` (presence + RPC paths) and `attach-yjs-sync.test.ts` (sync-only path). |
| `packages/workspace/src/rpc/remote-actions.test.ts` | **Delete.** Coverage replaced by `peer.test.ts`. |
| `packages/workspace/src/document/peer-presence.test.ts` | Fold into `peer.test.ts`. |
| `packages/workspace/src/document/system-describe.test.ts` | Update to use `peer.describe()`. |
| `packages/workspace/src/rpc/types.test.ts` | Update examples; types untouched. |
| `packages/workspace/src/ai/tool-bridge.test.ts` | Update if AI tools consume action manifests through the new `ws.peers` surface. |
| `packages/cli/src/daemon/*.test.ts` | Update daemon mocks to use `Workspace` shape. |

### CLI

| File | Change |
| --- | --- |
| `packages/cli/src/daemon/run-handler.ts` | Already resolves against `workspace.actions`. Update to `Workspace` type. |
| `packages/cli/src/daemon/app.ts` | `/peers` route reads `workspace.peers.list()`. `/run` uses `workspace.peers.find(id)?.invoke(action, input)`. |
| `packages/cli/src/util/peer-wait.ts` | Replace bespoke awareness walking with `waitForPeer(workspace.peers, peerId, options)` helper. |
| `packages/cli/src/load-config.ts` | Update `DaemonRuntime` type to require `Workspace` instead of separate `{ sync, awareness, rpc, actions }`. |

### Daemon types

| File | Change |
| --- | --- |
| `packages/workspace/src/daemon/types.ts` | `DaemonRuntime` requires `Workspace<TActions>`. The earlier 3-field shape (`sync`, `presence`, `rpc`) collapses. |
| `packages/workspace/src/daemon/run-handler.ts` | Same. |
| `packages/workspace/src/daemon/app.ts` | Update peer-listing route to use `workspace.peers.list()`. |

### Documentation

| File | Change |
| --- | --- |
| `packages/workspace/SYNC_ARCHITECTURE.md` | Rewrite around `openWorkspace` + `attachYjsSync`. |
| `packages/workspace/CLAUDE.md` | Update if it references the old chain. |

## Phased Implementation Plan

### Phase 0: prep and audit

- [x] **0.1** Confirm no external (out-of-monorepo) consumers of `attachSync`, `createRemoteClient`, `attachPresence`, or `attachRpc` exist. Search npm registry and any sibling repos.
- [x] **0.2** Confirm `apps/api/src/base-sync-room.ts` does not validate awareness state schema server-side.
  > **Note**: confirmed; the room only relays awareness frames via `y-protocols/awareness`, no content validation.
- [x] **0.3** Confirm `apps/api` does not echo or relay action manifests.
- [x] **0.4** Inventory all consumers of the old surfaces.
  > **Note**: 8 factories (not 7) found across `fuji`, `honeycrisp`, `opensidian`, `zhongwen`, `tab-manager`; the zhongwen browser is the only "headless" workspace (no factory). The spec's 7-vs-8 count was minor.

### Phase 1: implement new primitives alongside old

- [x] **1.1** Create `peer.ts` with `Peer`, `PeersSurface`, `waitForPeer`.
  > **Deviation**: the supervisor is injected via a `PeerWireHooks.sendRequest` callback, not via direct `raw.send`/`onMessage`. Keeps `peer.ts` decoupled from supervisor internals; the mock for tests is one function.
- [x] **1.2** Create `open-workspace.ts`.
  > **Deviation**: instead of "wrapping" `attachSync` while it still exists, the supervisor is renamed to `internal/sync-supervisor.ts` and refactored to accept an `Awareness` + `onRpcRequest` handler. Cleaner than nesting, and Phase 5 deletion is the same `git mv`.
- [x] **1.3** Create `attach-yjs-sync.ts`. Calls the supervisor with no `awareness` and no `onRpcRequest`.
- [x] **1.4** Update `peer-identity.ts` to publish `{ identity, actionPaths }`.
  > **Deviation**: split into `peerAwarenessSchema` (field-keyed record consumed by `attachAwareness`) and `PeerAwarenessState` (runtime TS shape). The combined arktype value isn't a schema record, and `attachAwareness` validates per-field.
- [x] **1.5** Add `SelfInvocationError` and `PeerLeftError` in `peer.ts`.
- [x] **1.6** Publish `actionPaths` sorted alphabetically at startup.
- [x] **1.7** Filter self by `identity.id`; emit `SelfInvocationError` from the wire boundary in `open-workspace.ts` (not from the supervisor).
  > **Deviation**: the supervisor lost its self-RPC check entirely; self is a workspace-layer concept. `open-workspace.ts` intercepts before calling `supervisor.sendRpcRequest`.

### Phase 2: tests for new primitives

- [ ] **2.1** Write `open-workspace.test.ts` covering: identity publication, action paths in awareness, alphabetical sort of `actionPaths`, peers.list excludes self, peers.find returns undefined for self, invoke roundtrips, peer-disconnect-mid-call produces `PeerLeftError`, self-clientId wire fallback returns `SelfInvocationError`, custom-awareness fields coexist with identity/actionPaths via `attachAwareness(ws.awareness, ...)`.
- [ ] **2.2** Write `attach-yjs-sync.test.ts` covering: supervisor lifecycle, status transitions, no presence emission, no RPC dispatcher.
- [ ] **2.3** Write `peer.test.ts` covering: typed invoke narrowing (via generic), dynamic invoke fallback to `DefaultRpcMap`, describe roundtrip, waitForPeer helper.
- [ ] **2.4** Add **type-level assertions** in `open-workspace.test.ts` and `peer.test.ts`:
  - `ws.actions` is typed as `TActions` (the inferred config type).
  - `ws.peers.find<T>(id)` returns `Peer<T> | undefined`.
  - `peer.invoke('not.a.real.path', ...)` is a type error when typed.
  - `peer.invoke(dynamicString, ...)` falls back to `DefaultRpcMap` when no generic.
  - `ws.peers.find` does not expose self in the return shape.

### Phase 3: migrate all app workspace factories atomically

- [x] **3.1** `apps/fuji/.../browser.ts`.
- [x] **3.2** `apps/fuji/.../daemon.ts`.
- [x] **3.3** `apps/honeycrisp/.../browser.ts`, `daemon.ts`, and `script.ts` (Bun script switched to `attachYjsSync`).
- [x] **3.4** `apps/opensidian/.../browser.ts`, `daemon.ts`, and `script.ts` (content docs through `attachYjsSync`).
- [x] **3.5** `apps/zhongwen/.../daemon.ts` and `script.ts`.
- [x] **3.6** `apps/tab-manager/.../extension.ts`.
- [x] **3.7** `AccountPopover` (packages/svelte-utils) plus 4 caller sites consume `bundle.workspace` directly instead of `bundle.sync`.

> **Deviation**: bundle return shape exposes `workspace` as a named field rather than spread. Spreading `Workspace` would lose the `status` getter (snapshot once at spread time). Callers do `fuji.workspace.peers.list()` etc., which is more honest.

### Phase 4: migrate CLI and daemon types

- [x] **4.1** `DaemonRuntime<TActions>` requires `workspace: Workspace<TActions>`.
- [x] **4.2** `daemon/run-handler.ts` (correct location; the spec's path was outdated).
- [x] **4.3** `daemon/app.ts` `/peers` and `/run` route handlers. `PeerSnapshot` wire row now carries `{ identity, actionPaths }`.
- [x] **4.4** `daemon/run-handler.ts` uses the `waitForPeer` helper from `peer.ts` directly; no separate `cli/util/peer-wait.ts` needed.
- [x] **4.5** `cli/src/load-config.ts` structural check looks for `workspace.peers.list`, `workspace.peers.observe`, `workspace.onStatusChange`.

> **Deviation**: `RunError.PeerNotFound` is now a top-level variant in the daemon's `/run` response (was an embedded `cause`). Cleaner: the daemon knows the peer never resolved before it ever called `peer.invoke`. The CLI exits 3 directly on this variant; `RemoteCallFailed.cause` is the new `RemoteCallError = RpcError | SelfInvocationError | PeerLeftError`.

### Phase 5: delete legacy

- [x] **5.1** `attach-sync.ts` (renamed to `internal/sync-supervisor.ts` with API refactor).
- [x] **5.2** `peer-presence.ts` (already gone before this spec started; no-op).
- [x] **5.3** `remote-actions.ts`.
- [x] **5.4** `attach-sync.test.ts`.
- [x] **5.5** `remote-actions.test.ts`.
- [x] **5.6** `peer-presence.test.ts` (already gone before this spec started; no-op).
- [x] **5.7** Old exports removed from `packages/workspace/src/index.ts`.

### Phase 6: documentation

- [ ] **6.1** Rewrite `packages/workspace/SYNC_ARCHITECTURE.md` around the new shape.
- [ ] **6.2** Update `packages/workspace/CLAUDE.md` if it references the old chain.
- [ ] **6.3** Update the `auth` and `attach-primitive` skills if they document the old chain.
- [ ] **6.4** Update `specs/20260430T103959-...md` and `specs/20260430T114949-...md` headers to mark them superseded by this spec.
- [ ] **6.5** Add a short "How to Read This Stack" section to `packages/workspace/README.md`:
  - `openWorkspace` is the workspace entry point.
  - `ws.actions` is the local registry, callable directly.
  - `ws.peers` is the remote surface; `peer.invoke(path, input)` dispatches.
  - `attachYjsSync` is the content-doc sibling, sync-only.

### Phase 7: verify

- [ ] **7.1** `bun test packages/workspace/src/document`.
- [ ] **7.2** `bun test packages/workspace/src/rpc`.
- [ ] **7.3** `bun test packages/cli`.
- [ ] **7.4** `bun run typecheck` across the monorepo.
- [ ] **7.5** Manual smoke for each app:
  - Open the app, sign in, observe `peers.list()` populates from connected peers.
  - Trigger one local action; verify it bypasses the wire.
  - Trigger one remote action; verify it roundtrips and returns Result.
  - Disconnect a peer mid-call; verify `PeerLeftError`.
  - Attempt self-RPC via dev console with a self-clientId; verify `SelfInvocationError`.
- [ ] **7.6** Grep for stale names; any hit other than docs should fail review:

```bash
rg 'attachSync\(|createRemoteClient|SyncRpcAttachment|attachPeerPresence|peerPresenceDefs|PeerAddressError|ResolvedPeer|PeerAwarenessState|\.rpc\.rpc\(|remote\.actions\(|remote\.invoke\(|remote\.describe\(' packages apps
```

## Edge Cases

### Empty action registry

A workspace that consumes remote actions but exposes none passes `actions: {}`. `openWorkspace` accepts it. `actionPaths` publishes as `[]`. The peer is fully visible to others but they cannot call any action on it.

### Peer with no overlap

A peer in the same room that has zero actions in common with the caller. Caller sees `peer.actionPaths` is empty; `peer.invoke('anything', ...)` returns `Err(RpcError.ActionNotFound)` from the host's dispatch layer. No type-level prevention; the type-level constraint via `TActions` is opt-in via the generic.

### Self-clientId in a deserialized reference

A test fixture or persisted UI state encodes a clientId that happens to equal the current `ydoc.clientID` after reconnect. The Peer surface filters by `identity.id`, not by clientId, so this is mostly transparent. The wire-layer fallback catches the residual case if it slips through.

### Peer disconnects mid-call

The supervisor receives the awareness state removal; `open-workspace.ts` watches its own pending-RPC map for any request whose `targetClientId` matches the removed clientId and resolves them with `PeerLeftError`. This mirrors today's `createRemoteClient` behavior in `remote-actions.ts:147-167`, lifted into the workspace.

### Multiple peers with the same identity.id

Multiple tabs in the same browser may share an installation id. `peers.find(id)` returns the lowest clientId match; `peers.list()` includes all matching entries. Callers that care about uniqueness either fall through to leader election (out of scope) or pick by additional criteria from `peer.identity`.

### Awareness state malformed

A peer publishes awareness state that fails `PeerAwarenessState` validation. `peers.list()` and `peers.find()` drop it with a warning. The peer behaves like it isn't connected. This mirrors today's behavior in `peer-presence.ts`.

### `attachYjsSync` content doc inside a workspace

A workspace's `entries` table stores `bodyDocGuid`s. When an entry is opened, the app calls `attachYjsSync` for the body doc against the same URL pattern. Both docs share auth (`getToken`) but are independent connections. No identity, no peers; the body doc is bytes only.

### CLI invoking against an offline peer

`epicenter call macbook-pro tabs.close` against a not-currently-online peer: `ws.peers.find('macbook-pro')` returns undefined; CLI exits with "peer not online" error. To wait, the user passes `--wait` and the CLI uses `waitForPeer(ws.peers, 'macbook-pro', { timeoutMs: 30000 })`.

### Action path published in awareness but action removed

Race window: peer A publishes `actionPaths: ['old.action']`, then removes the action and reconnects with `actionPaths: ['new.action']`. During the gap, peer B's `peer.invoke('old.action', ...)` returns `RpcError.ActionNotFound` from peer A's dispatch layer. Not a wire-layer bug; the same race exists today and is acceptable.

### Checking whether self hosts an action

`peers.list()` excludes self, so capability-based picks across `peers.list().filter(...)` never include self. To check "do I host this action", inspect the local registry directly: `walkActions(ws.actions).some(a => a.path === target)`. A `ws.hosts(path)` helper is intentionally not provided; the local-vs-remote asymmetry is honest.

### Dispose without owning ydoc

`ws.dispose()` is sugar for `ydoc.destroy()` and cascades through the standard destroy listener. If the calling app owns the ydoc separately (rare; most apps let `openWorkspace` own it), calling `ydoc.destroy()` directly produces the same teardown. Both code paths are idempotent.

## Open Questions

These are decisions intentionally deferred past v1. The remaining questions where v1 behavior is locked elsewhere in the spec (observe signature, actionPaths sort, custom-awareness composition) are not repeated here.

1. **Should `peer.describe()` cache by some manifest hash?**
   - Argument for: AI tool flows fetch describe per peer per session; cache avoids repeated roundtrips.
   - Argument against: complexity, awareness-state-grows-by-one-hash, manifest changes mid-session are rare.
   - **Recommendation**: no cache in v1. Caller can cache if they want. Revisit if AI tool flows feel slow.

2. **Should `peer.invoke` accept an `AbortSignal`?**
   - Current code uses per-call `timeout`.
   - **Recommendation**: add `AbortSignal` support in a follow-up if a real consumer needs cooperative cancel. Out of scope here.

3. **Should a `ws.hosts(path)` self-check helper exist later?**
   - Argument for: symmetry with patterns that currently use `peers.list().filter(...)`.
   - Argument against: the local-vs-remote asymmetry is honest; you have functions locally, you dispatch by name remotely.
   - **Recommendation**: defer. Add only if a real call-site pattern justifies it.

## Success Criteria

- [ ] `openWorkspace` exists and is the only public attach primitive for app workspaces.
- [ ] `attachYjsSync` exists and is the only public attach primitive for content docs.
- [ ] No file in `apps/*` imports `attachSync`, `createRemoteClient`, `attachPeerPresence`, or `peerPresenceDefs`.
- [ ] No file in `apps/*` declares the four-statement workspace attach chain.
- [ ] `packages/workspace/src/index.ts` does not export `attachSync`, `SyncAttachment`, `createRemoteClient`, `RemoteClient`, `RemoteClientOptions`, `attachPeerPresence`, `peerPresenceDefs`, `ResolvedPeer`.
- [ ] `packages/workspace/src/document/peer.ts` exports both `SelfInvocationError` and `PeerLeftError`.
- [ ] `packages/sync/src/rpc-errors.ts` is unchanged (no new variants).
- [ ] Awareness state published by every app uses `{ identity, actionPaths }`, not `{ peer }`.
- [ ] `actionPaths` is alphabetically sorted and identical across peers running the same code.
- [ ] `peers.list()` never includes self in any tested scenario.
- [ ] `peer.invoke(path, input)` narrows path autocomplete and input/output types when the peer was obtained with `peers.find<TActions>(id)`.
- [ ] Self-clientId reaching the wire layer (test-injected) returns `Err(SelfInvocationError)`, not `RpcError.ActionFailed`.
- [ ] Custom awareness fields composed via `attachAwareness(ws.awareness, ...)` coexist with `identity`/`actionPaths` without overwriting.
- [ ] Type-level test assertions in `peer.test.ts` confirm: typed `peers.find<T>` narrows; `peer.invoke('not.a.real.path', ...)` is a type error; dynamic `peer.invoke(string, unknown)` falls back to `DefaultRpcMap`.
- [ ] `bun test` passes for `packages/workspace`, `packages/cli`, and each app.
- [ ] Monorepo typecheck passes.
- [ ] `SYNC_ARCHITECTURE.md` describes the new shape and no longer references the old chain.

## References

- `packages/workspace/src/document/attach-sync.ts` -> the file being collapsed. RPC dispatcher at `:780-859`, self-RPC string error at `:805-810`.
- `packages/workspace/src/rpc/remote-actions.ts` -> the file being deleted. `buildProxy` at `:255-268`, `waitForPeer` at `:199-247`, `PeerAddressError` at `:26-55`.
- `packages/workspace/src/document/peer-identity.ts` -> awareness shape to update.
- `packages/workspace/src/rpc/types.ts:35` -> `InferSyncRpcMap`, untouched, used by the new `peer.invoke` generic.
- `packages/workspace/src/shared/actions.ts` -> `Actions`, `walkActions`, `describeActions`, untouched.
- `apps/fuji/src/routes/(signed-in)/fuji/browser.ts:99-115` -> representative factory to migrate first.
- `specs/20260430T103959-split-attach-sync-into-transport-presence-rpc.md` -> earlier split direction; this spec reverses it.
- `specs/20260430T114949-peer-presence-rename-and-sync-split.md` -> earlier refinement of the split; this spec reverses it.
- `specs/20260504T231540-attach-sync-trim-to-supervisor-superseded.md` -> already superseded; referenced for context.
- `specs/20260425T000000-device-actions-via-awareness.md` -> earlier discussion of actions-in-awareness; this spec lands the dot-paths-only version.

## Review

**Status (2026-05-13)**: Phases 0, 1, 3, 4, 5 landed in three commits on
`refactor/standardize-symbol-dispose`. Workspace, CLI, and 21 of 22
packages typecheck clean. The 22nd (`@epicenter/dashboard`) has pre-
existing billing/chart errors unrelated to this spec.

### Commits

1. `feat(workspace): collapse attach chain into openWorkspace primitive`
   New primitives, supervisor rename, daemon types/routes, dead-file
   deletion. 18 files changed.
2. `refactor(...): migrate to openWorkspace`
   Eight app factories + three Bun scripts + `AccountPopover` and its
   four callers. 16 files changed.
3. `refactor(cli): consume Workspace from daemon runtime`
   CLI `peers`/`run`/`up` commands, `load-config` shape check, run-
   error rewrites, inline-actions fixture. 8 files changed.

### Deviations from spec (load-bearing ones)

- **`Workspace.dispose()` -> `[Symbol.dispose]`** to match the repo
  convention standardized in the merged-in
  `refactor/standardize-symbol-dispose` branch. Spec used `dispose()`.
- **`peer-identity.ts` split** into `peerAwarenessSchema` (record
  consumed by `attachAwareness`) and `PeerAwarenessState` (TS shape).
  The spec showed a combined arktype which couldn't satisfy
  `AwarenessSchema = Record<string, CombinedStandardSchema>`.
- **`attachAwareness` takes `Awareness`, not `Y.Doc`.** Always. The
  function's job is to type-wrap an existing awareness; creating one
  is `new Awareness(doc)` and not this function's concern. Production
  callers all go through `openWorkspace` (which constructs the
  awareness) so the migration cost is zero outside the helper's own
  test file. Honest single shape over a permissive union.
- **`RunError.PeerNotFound` is top-level**, not buried in
  `RemoteCallFailed.cause`. `PeerNotFound` is a "peer never resolved"
  signal owned by the daemon's `waitForPeer` call; `RemoteCallFailed`
  is for wire-level failures after a `peer.invoke`. Splitting them
  reads more honestly than synthesizing a fake cause.
- **`Peer.clientID` is exposed** (spec hid it). The `epicenter peers`
  table surfaces it for multi-tab disambiguation; hiding it forced
  callers back to raw awareness, which defeated the surface.
- **Bundle return shape exposes `workspace` as a named field** rather
  than spreading the `Workspace`. Spreading drops the `status` getter
  (snapshot at spread time). `bundle.workspace.peers.list()` reads
  more honestly than `bundle.peers.list()`.

### Still pending (handed back for follow-up)

- **Phase 2**: tests. `open-workspace.test.ts`, `peer.test.ts`, and
  `attach-yjs-sync.test.ts` (plus the type-level assertions per spec
  2.4) haven't been written. The deleted `attach-sync.test.ts` and
  `remote-actions.test.ts` were behavior-covered by their now-deleted
  primitives; equivalent coverage on the new surfaces is owed.
- **Phase 6**: docs. `SYNC_ARCHITECTURE.md`, the "How to Read This
  Stack" section in the workspace README, and the supersedes headers
  on the two earlier split specs haven't been written. Stale jsdoc
  in `shared/actions.ts` and `rpc/types.ts` (mentions `createRemoteClient`,
  `rpc.rpc(...)`) hasn't been swept.
- **Phase 7.5**: manual smoke for each app. Type-check passes; the
  five user-facing scenarios (peer list populates, local action
  bypasses wire, remote action roundtrips, peer-left mid-call,
  self-RPC fallback) haven't been exercised.

### Verification snapshot

```
$ bun run typecheck
21/22 packages green. @epicenter/dashboard fails on pre-existing
billing/UsageChart errors unrelated to this spec.

$ rg 'attachSync\(|createRemoteClient|SyncRpcAttachment|attachPeerPresence|peerPresenceDefs|PeerAddressError|ResolvedPeer|\.rpc\.rpc\(|remote\.actions\(|remote\.invoke\(|remote\.describe\(' packages apps --type ts
# Hits only in JSDoc comments inside shared/actions.ts and rpc/types.ts.
# Phase 6 will sweep them.
```

### Carry-over context for follow-up agents

- The dashboard typecheck failure pre-existed; it's not blocking
  this PR. There's a stash entry (`stash@{0}`) titled "wip: dashboard
  formatting fixes (unrelated to openWorkspace work)" with three
  partial fixes; the user's working tree also has further uncommitted
  dashboard work outside that stash.
- The supervisor's transport-level self-check (`target === ydoc.clientID`)
  was removed; the workspace-layer self-check in `open-workspace.ts`
  is now load-bearing for `SelfInvocationError`. If anyone reintroduces
  a direct caller of `supervisor.sendRpcRequest` outside of `openWorkspace`,
  the self check has to come back at that boundary.
- `Phase 6` should update the `auth` and `attach-primitive` skill
  docs in addition to `SYNC_ARCHITECTURE.md`.
