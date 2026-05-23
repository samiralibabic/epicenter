# Split `attachSync` into sync, presence, and RPC attachments

**Status**: ready for review
**Date**: 2026-04-30
**Supersedes**: nothing directly; refines the architectural assumptions baked into `packages/workspace/src/document/attach-sync.ts` and consumed by `packages/workspace/src/rpc/peer.ts`.

**Refined by**: `specs/20260430T114949-peer-presence-rename-and-sync-split.md`. Use that newer spec for implementation. It keeps the sync, presence, and RPC split from this document, but updates the vocabulary from `device` to `peer` and makes `workspace.actions` the explicit public action registry root.

## Why this exists

Today `attachSync` is a god-object. It bundles four jobs into one closure and one return type:

1. **Y.Doc sync.** WebSocket lifecycle, supervisor, backoff, auth, liveness, and the Y.Doc STEP1/STEP2/UPDATE protocol.
2. **Presence.** Awareness instance, the standard "I am a device" schema, `peers()` / `find()` / `observe()`.
3. **RPC.** `pendingRequests` map, request/response correlation, `system.*` injection, action dispatch.
4. **Lifecycle plumbing.** `whenConnected`, `whenDisposed`, `goOffline`, `reconnect`, status emitter.

Two costs show up at the API boundary.

**The type lies.** `SyncAttachment` exposes `peers()`, `find()`, `observe()`, and `rpc()` unconditionally. At runtime, those silently no-op when the doc was constructed without `device` or without `actions`. A consumer reading the type believes the methods always work; the runtime disagrees.

**Bad wire data crosses boundaries silently.** A buggy peer publishing `{ device: null }` can crash `find()` deep in caller code. Inbound RPC payloads reach action handlers as `unknown` and outbound RPC responses are trust-cast into typed results.

The clean answer is to keep `attachSync` as the Y.Doc sync layer and move presence and RPC into explicit sibling attachments.

## Decision

Use one required sync attachment and two optional attachments created from it:

```ts
const sync = attachSync(ydoc, {
  url,
  waitFor,
  getToken,
});

const presence = sync.attachPresence({
  device,
});

const rpc = sync.attachRpc({
  actions,
});
```

The minimal primitive set is:

```ts
attachSync(ydoc, config) -> SyncAttachment
sync.attachPresence(config) -> PresenceAttachment
sync.attachRpc(config) -> RpcAttachment
peer({ rpc, presence }, deviceId) -> RemoteActions<T>
describePeer({ rpc, presence }, deviceId) -> Promise<Result<ActionManifest, RpcError>>
```

`attachSync` stays named `attachSync` because it does synchronize the Y.Doc. Calling it `attachTransport` undersells the main job. It is not just a byte pipe; it owns the WebSocket and the Y.Doc sync protocol.

Presence and RPC are side-effectful at call time. They register message handlers and lifecycle cleanup, so they are `attach*`, not `create*`. Because they attach to a sibling attachment in the same package, they should be methods on the sync coordinator rather than top-level functions.

The dependency graph is visible without making normal app code noisy:

```txt
ydoc
  |
  v
attachSync
  owns: WebSocket, reconnection, auth, liveness, Y.Doc sync protocol
  exposes: lifecycle, sync status, send/onMessage for sibling attachments
  |
  +-- sync.attachPresence()
  |     owns: standard device presence over Yjs awareness
  |     exposes: peers, find, observe
  |
  +-- sync.attachRpc()
        owns: request/response correlation and action dispatch
        exposes: rpc(clientId, action, input, options)
```

## Why not `attachTransport`

`attachTransport` was tempting because the returned value is the thing presence and RPC ride on. But the name is too low-level for what the primitive actually does.

`attachSync` does three non-optional things:

1. Opens and supervises the WebSocket.
2. Runs the Y.Doc sync protocol over that socket.
3. Reports sync lifecycle state to app code.

That means `sync` is still the right app-facing name:

```ts
fuji.sync.status;
fuji.sync.reconnect();
fuji.sync.goOffline();
```

The internal fact that sync also multiplexes presence and RPC frames does not make transport the better noun. Transport is an implementation role. Sync is the product-facing capability.

## Why methods, not top-level attachments

The local attach primitive rule is: if a sibling attachment registers into a coordinator in the same package, prefer a method on the coordinator.

This mirrors encryption:

```ts
const encryption = attachEncryption(ydoc);
const tables = encryption.attachTables(ydoc, defs);
const kv = encryption.attachKv(ydoc, defs);
```

The sync split follows the same shape:

```ts
const sync = attachSync(ydoc, syncOptions);
const presence = sync.attachPresence(presenceOptions);
const rpc = sync.attachRpc(rpcOptions);
```

That reads better than:

```ts
const sync = attachSync(ydoc, syncOptions);
const presence = attachPresence(sync, presenceOptions);
const rpc = attachRpc(sync, rpcOptions);
```

Both are technically valid, but the method form says the important thing: presence and RPC are sub-protocols registered onto the sync attachment.

## What each primitive owns

### `attachSync(ydoc, config) -> SyncAttachment`

```ts
type SyncAttachment = {
  whenConnected: Promise<unknown>;
  whenDisposed: Promise<unknown>;
  readonly status: SyncStatus;
  onStatusChange(listener: (status: SyncStatus) => void): () => void;
  goOffline(): void;
  reconnect(): void;

  attachPresence(config: PresenceConfig): PresenceAttachment;
  attachRpc(config: RpcConfig): RpcAttachment;

  raw: {
    send(frame: Uint8Array): void;
    onMessage(typeByte: number, handler: (payload: Uint8Array) => void): () => void;
  };
};
```

Owns:

- WebSocket lifecycle: connect, reconnect, backoff, auth via subprotocol, liveness ping/pong.
- Y.Doc sync protocol: STEP1, STEP2, UPDATE. This is not optional.
- Master and cycle `AbortController` hierarchy.
- Status emitter and `whenConnected` / `whenDisposed` settling.
- Frame dispatch table for sibling sub-protocols. Sync messages are handled internally; presence and RPC register their handlers.

Does not own:

- Awareness state or peer lookup.
- RPC request ids, pending requests, action dispatch, or `system.*` injection.

Validates:

- WebSocket close-event reasons through `parsePermanentFailure`.
- Frame type bytes. Unknown types are logged and dropped.
- Y.Doc sync frames are delegated to y-protocols.

### `sync.attachPresence(config) -> PresenceAttachment`

```ts
type PresenceAttachment = {
  peers(): Map<number, PeerAwarenessState>;
  find(deviceId: string): FoundPeer | undefined;
  observe(callback: () => void): () => void;
  raw: { awareness: YAwareness };
};

type PresenceConfig = {
  device: DeviceDescriptor;
  log?: Logger;
};
```

Owns:

- A standard `Awareness` instance for `{ device }` presence.
- Local device publication before return.
- Receiving awareness frames from `sync.raw.onMessage`.
- Sending local awareness updates through `sync.raw.send`.
- `peers()`, `find()`, and `observe()` convenience methods.

Implementation note: this should reuse the existing `attachAwareness` / `createAwareness` machinery and `standardAwarenessDefs`. It is not a replacement for the general typed-awareness primitive. It is the standard device-presence bridge over sync.

Validates:

- Inbound awareness states against the standard `DeviceDescriptor` schema. Malformed states are dropped and logged.

Does not handle:

- Custom awareness schemas like cursors or typing indicators. Those continue to use `attachAwareness` / `createAwareness` directly.

### `sync.attachRpc(config) -> RpcAttachment`

```ts
type RpcAttachment = {
  rpc<TMap extends RpcActionMap = DefaultRpcMap, TAction extends string & keyof TMap = string & keyof TMap>(
    target: number,
    action: TAction,
    input?: TMap[TAction]['input'],
    options?: RemoteCallOptions,
  ): Promise<Result<TMap[TAction]['output'], RpcError>>;
};

type RpcConfig = {
  actions?: Record<string, unknown>;
  log?: Logger;
};
```

Owns:

- `pendingRequests` map and request/response correlation by request id.
- Outbound request encoding and inbound response decoding.
- Inbound action dispatch through `resolveActionPath` and `invokeAction`.
- The `system.*` injection. `system.describe` returns the full local manifest.
- Per-call timeout, disconnected-while-pending cleanup, and `RpcError.Disconnected`.

Depends on:

- `sync.raw.onMessage` to receive RPC frames.
- `sync.raw.send` to send RPC frames.

Does not depend on:

- Presence. RPC mechanically targets a clientId. Presence is only needed by `peer()` when the caller wants to address a logical device id.

Validates:

- Inbound action inputs against the handler's input schema when declared through `defineQuery` / `defineMutation`.
- Inbound `RpcError` response shape through the existing `isRpcError`.
- Outbound response payloads against the caller's expected output schema when the action declares one.

New error variants:

```ts
InvalidInput: ({ action, cause }: { action: string; cause: unknown }) => ({
  message: `[rpc] inbound input for "${action}" failed validation: ${extractErrorMessage(cause)}`,
  action,
  cause,
}),

InvalidResponse: ({ action, peer, cause }: { action: string; peer: string; cause: unknown }) => ({
  message: `[rpc] peer "${peer}" returned a malformed response for "${action}": ${extractErrorMessage(cause)}`,
  action,
  peer,
  cause,
}),
```

## Composition examples

A workspace doc that wants sync, presence, and RPC:

```ts
const doc = openFujiDoc();

const idb = attachIndexedDb(doc.ydoc);
attachBroadcastChannel(doc.ydoc);

const sync = attachSync(doc.ydoc, {
  url: websocketUrl(`${APP_URLS.API}/workspaces/${doc.ydoc.guid}`),
  waitFor: idb.whenLoaded,
  getToken: () => auth.getToken(),
});

const presence = sync.attachPresence({
  device,
});

const rpc = sync.attachRpc({
  actions: doc,
});

return {
  ...doc,
  idb,
  sync,
  presence,
  rpc,
  peer: <T>(deviceId: string) => peer<T>({ rpc, presence }, deviceId),
  describePeer: (deviceId: string) => describePeer({ rpc, presence }, deviceId),
  whenReady: idb.whenLoaded,
};
```

A content doc that only needs Y.Doc sync:

```ts
const ydoc = new Y.Doc({ guid: contentDocId, gc: false });
const idb = attachIndexedDb(ydoc);

const sync = attachSync(ydoc, {
  url,
  waitFor: idb.whenLoaded,
  getToken,
});

return { ydoc, idb, sync };
```

A read-only viewer that wants to see peers but cannot call actions:

```ts
const sync = attachSync(ydoc, { url, waitFor: idb.whenLoaded });
const presence = sync.attachPresence({ device });

return { ydoc, sync, presence };
```

Normal app code should not manually compose `{ rpc, presence }` on every call. The bundle exposes helpers:

```ts
const remote = fuji.peer<typeof fuji>('macbook-pro');
await remote.entries.create({ title: 'Hello' });

const manifest = await fuji.describePeer('macbook-pro');
```

The lower-level helper remains useful in tests and unusual compositions:

```ts
const remote = peer<TabActions>({ rpc, presence }, 'macbook-pro');
```

## Validation surfaces

| primitive | inbound | outbound |
|---|---|---|
| `attachSync` | close reasons, frame type byte, Y.Doc sync frames delegated to y-protocols | raw frames from sibling attachments |
| `sync.attachPresence` | awareness states against `DeviceDescriptor` | local state shape enforced by `standardAwarenessDefs` |
| `sync.attachRpc` | action inputs, `RpcError` response shape | response payloads when an output schema exists |

Validation lives next to the wire surface that emits the bad data. Sync validates sync-level frames. Presence validates presence states. RPC validates RPC messages.

## What we explicitly do not do

- **No `attachTransport` rename.** The primitive synchronizes the Y.Doc, so `attachSync` remains the right public name.
- **No `createRpc`.** RPC attachment registers message handlers and pending cleanup at call time, so it is side-effectful.
- **No package split.** All three pieces remain in `packages/workspace`. The wire is shared; splitting packages would add indirection without isolating a real deployment boundary.
- **No general output-schema migration.** RPC validates outputs when schemas exist. Adding output schemas to every action is a separate decision.
- **No replacement for general awareness.** `sync.attachPresence()` is the standard device-presence bridge. Custom schemas keep using `attachAwareness` / `createAwareness`.
- **No backwards-compatible presence/RPC fields on `sync`.** Clean break. Callers that need presence or RPC must attach them explicitly.

## Files touched

| file | change |
|---|---|
| `packages/workspace/src/document/attach-sync.ts` | keep file and public name; remove presence and RPC fields from the base return; add `attachPresence`, `attachRpc`, and internal `raw.send` / `raw.onMessage`. |
| `packages/workspace/src/document/attach-presence.ts` | new implementation backing `sync.attachPresence`; reuse `createAwareness` and `standardAwarenessDefs`. |
| `packages/workspace/src/document/attach-rpc.ts` | new implementation backing `sync.attachRpc`; owns pending requests, dispatch, system injection, and validation. |
| `packages/workspace/src/document/index.ts` | export the updated types. |
| `packages/workspace/src/rpc/peer.ts` | `peer()` and `describePeer()` take `{ rpc, presence }` instead of `SyncAttachment`. |
| `packages/sync/src/rpc-errors.ts` | add `InvalidInput` and `InvalidResponse`. |
| `apps/fuji/src/lib/fuji/browser.ts` | attach sync, presence, and RPC; expose ergonomic bundle helpers. |
| `apps/honeycrisp/src/lib/honeycrisp/browser.ts` | same. |
| `apps/opensidian/src/lib/opensidian/browser.ts` | same for workspace docs; content docs attach only sync. |
| `apps/tab-manager/src/lib/tab-manager/extension.ts` | attach sync, presence, and RPC; expose ergonomic bundle helpers. |
| `packages/cli/src/daemon/app.ts` | attach sync, presence, and RPC where peer targeting is supported. |
| `packages/workspace/src/rpc/peer.test.ts` | mocks shift from one `SyncAttachment` blob to a `{ rpc, presence }` pair. |
| `packages/workspace/SYNC_ARCHITECTURE.md` | rewrite the architecture diagram around sync plus optional sibling attachments. |

## Phased plan

### Phase 1: slim `attachSync`

1. Keep `attach-sync.ts` and the `attachSync` export.
2. Remove awareness handling, RPC handling, and `system.*` injection from the base return.
3. Keep the supervisor, backoff, auth, liveness, and Y.Doc sync protocol.
4. Add internal `raw.send(frame)` and `raw.onMessage(typeByte, handler)` for sibling attachments.
5. Keep lifecycle fields: `status`, `whenConnected`, `whenDisposed`, `goOffline`, `reconnect`, `onStatusChange`.

### Phase 2: add `sync.attachPresence`

1. Create `attach-presence.ts`.
2. Reuse `createAwareness` with `standardAwarenessDefs`.
3. Register an awareness-frame handler through `sync.raw.onMessage(MESSAGE_TYPE.AWARENESS, ...)`.
4. Send local awareness updates through `sync.raw.send`.
5. Add inbound validation. Malformed states are dropped and logged.
6. Move presence tests from `attach-sync.test.ts` to `attach-presence.test.ts`.

### Phase 3: add `sync.attachRpc`

1. Create `attach-rpc.ts`.
2. Move `pendingRequests`, `nextRequestId`, request/response correlation, `clearPendingRequests`, `handleRpcRequest`, and `system.*` injection.
3. Register an RPC-frame handler through `sync.raw.onMessage(MESSAGE_TYPE.RPC, ...)`.
4. Validate inbound inputs against handler input schemas.
5. Validate outbound responses when output schemas exist.
6. Add `RpcError.InvalidInput` and `RpcError.InvalidResponse`.

### Phase 4: update callers

1. Update workspace factories to call `sync.attachPresence()` and `sync.attachRpc()` where needed.
2. Leave content docs as sync-only.
3. Add bundle helpers like `fuji.peer(deviceId)` and `fuji.describePeer(deviceId)`.
4. Update UI components to keep reading `workspace.sync.status`, `workspace.sync.reconnect()`, and `workspace.sync.goOffline()`.
5. Run typecheck across the monorepo.

### Phase 5: opt-in output schemas

Out of scope for this spec, tracked separately: decide which actions get output schemas first. Suggested first targets: `system.describe` and actions that cross package or version boundaries.

## Risks and unresolved questions

**`raw` naming.** `raw.send` and `raw.onMessage` are intentionally not the ergonomic app API. They are the sub-protocol registration surface. If `raw` feels too exposed, use an internal symbol or a non-exported type while keeping methods available to `attach-presence.ts` and `attach-rpc.ts`.

**Handler registration ordering.** Presence and RPC register handlers after `attachSync` returns. If frames arrive before registration, they are dropped. In practice, callers attach siblings synchronously before the socket has completed its first exchange. Document this. If it bites, add a tiny inbound queue per message type.

**Multiple attachments of the same sub-protocol.** Calling `sync.attachPresence()` twice should throw. Same for `sync.attachRpc()`. Two handlers for the same message type would make behavior ambiguous.

**RPC without presence.** This is allowed. RPC targets clientId. Presence is only required for `peer()` because `peer()` resolves a stable device id to the current clientId.

**Test mock complexity.** `peer.test.ts` will mock `{ rpc, presence }` instead of one `SyncAttachment`. The mock surface is smaller and more honest.

## One-sentence test

`attachSync` synchronizes a Y.Doc over a supervised WebSocket and lets optional sibling attachments register presence and RPC sub-protocols on that same connection.

Every surface in this spec serves that sentence:

- `attachSync` synchronizes the Y.Doc and owns the supervised WebSocket.
- `sync.attachPresence` registers the presence sub-protocol.
- `sync.attachRpc` registers the RPC sub-protocol.
- `peer()` composes RPC with presence only when callers want device-id addressing.
