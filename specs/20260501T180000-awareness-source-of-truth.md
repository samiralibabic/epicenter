# Awareness Source Of Truth

**Date**: 2026-05-01
**Status**: Implemented
**Author**: AI-assisted
**Related**: `specs/20260430T114949-peer-presence-rename-and-sync-split.md`, `specs/20260430T103959-split-attach-sync-into-transport-presence-rpc.md`
**Superseded in part by**: `specs/20260501T150015-peer-addressed-remote-client-api.md`, which removes the transitional `PeerDirectory` target and makes `createRemoteClient({ awareness, rpc })` own peer-addressed RPC.

## Overview

Peer presence, cursors, selections, typing indicators, and similar ephemeral state should share one Yjs awareness instance per synced `Y.Doc`. The new shape makes `attachAwareness(ydoc, { schema, initial })` the single source of truth for awareness state, makes `attachSync` transport that awareness instance, and turns peer lookup into a domain helper over the shared awareness.

One sentence:

```txt
Awareness publishes one validated ephemeral state object per Yjs client, sync transports it, and small helpers read named fields from that object.
```

## Motivation

### Current State

The current code has two awareness concepts that overlap.

First, `attachAwareness` creates a typed wrapper around a raw `YAwareness`:

```ts
const awareness = attachAwareness(
	ydoc,
	{
		cursor: Cursor,
		name: type('string'),
	},
	{
		cursor: null,
		name: 'Braden',
	},
);
```

Second, `sync.attachPresence({ peer })` creates its own raw `YAwareness` internally:

```ts
const sync = attachSync(ydoc, {
	url,
	getToken,
});

const presence = sync.attachPresence({
	peer,
});
```

That means a document can accidentally grow multiple raw awareness instances:

```txt
Y.Doc
  |
  +-- attachAwareness()       -> new YAwareness(ydoc)
  |
  +-- sync.attachPresence()   -> new YAwareness(ydoc)
```

This creates problems:

1. **Yjs expects one state object per client**: `y-protocols/awareness` stores state as `Map<clientID, state>`. Each raw awareness instance has its own clock for the same `doc.clientID`. Multiple instances can publish competing states for the same client.
2. **The peer helper owns too much**: `peer-presence.ts` owns raw awareness construction, awareness wire encoding, schema validation, and peer lookup. Only peer lookup is peer-specific.
3. **Composition happens in the wrong place**: apps compose documents in `openFuji`, `openTabManager`, and daemon factories, but awareness composition is hidden inside `sync.attachPresence`.
4. **The current API encourages incremental field attachment**: a future `attachFields` or `attachPresence` split would make one field magic and the rest generic. That preserves the smell instead of fixing it.
5. **The `attachAwareness` signature is hard to read**: schema and initial data are separate positional arguments after `ydoc`, even though both are one awareness contract.

### Desired State

The app declares the full awareness state once:

```ts
const awareness = attachAwareness(ydoc, {
	schema: {
		peer: PeerIdentity,
		cursor: Cursor.or('null'),
	},
	initial: {
		peer,
		cursor: null,
	},
});

const sync = attachSync(ydoc, {
	url,
	getToken,
	awareness,
});

const peerDirectory = createPeerDirectory({
	awareness,
	sync,
});
const rpc = sync.attachRpc(actions);
const remote = createRemoteClient({ peerDirectory, rpc });
```

There is one raw awareness instance:

```txt
Y.Doc
  |
  v
attachAwareness(ydoc, { schema, initial })
  |
  +-- raw YAwareness
  +-- typed state reads and writes
  |
  +-- attachSync(..., { awareness }) transports updates
  |
  +-- createPeerDirectory({ awareness, sync }) reads state.peer
  |
  +-- future helpers read state.cursor, state.selection, state.typing
```

## Research Findings

### Yjs Awareness Model

Yjs documents do not store awareness data. The awareness protocol lives in `y-protocols` and manages ephemeral JSON state for online clients.

The Yjs docs describe awareness as a CRDT where each client has one awareness state. Remote states are stored in a `Map` keyed by client id. Each state has an increasing clock. Clients broadcast updates regularly so peers do not time them out.

The local installed source matches that model:

```txt
Awareness
  doc: Y.Doc
  clientID: doc.clientID
  states: Map<number, Object<string, any>>
  meta: Map<number, { clock, lastUpdated }>
```

Important API points from `y-protocols/awareness`:

```ts
awareness.setLocalState(state);
awareness.setLocalStateField(field, value);
awareness.getStates(); // Map<clientID, state>
encodeAwarenessUpdate(awareness, clients);
applyAwarenessUpdate(awareness, update, origin);
```

Key finding: Yjs expects fields such as `user`, `cursor`, and `peer` to compose on one schemaless state object for the client. Multiple raw awareness instances for one `Y.Doc` are constructible, but they create separate clocks and separate local state maps for the same `doc.clientID`.

Implication: Epicenter should expose one awareness attachment per synced document and build typed field helpers over that attachment.

### Existing Epicenter Shape

Current production usage only uses the standard peer state. Generic awareness is tested but not used in app code.

```txt
production:
  sync.attachPresence({ peer })

tests:
  attachAwareness(ydoc, { cursorX, cursorY, name }, initial)
```

Key finding: the generic typed awareness wrapper is still useful, but it should be the owner of the raw awareness instance. Peer presence should stop constructing awareness.

Implication: keep typed awareness, but move sync transport and peer lookup to separate layers.

### Attach Primitive Conventions

Workspace attach primitives follow this shape:

```ts
attachX(subject, options)
```

The subject is normally a `Y.Doc`. Options are a single object.

Key finding: `attachAwareness(ydoc, definitions, initial)` does not match the preferred shape. It should become `attachAwareness(ydoc, { schema, initial })`.

Implication: schema and data stay separate, but they should live inside one options object.

## Design Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Raw awareness ownership | `attachAwareness` owns the raw `YAwareness` | Awareness state is its own attachment. Sync transports it, but sync should not define its schema. |
| API shape | `attachAwareness(ydoc, { schema, initial })` | Matches attach primitive conventions and keeps schema and data separate without positional ambiguity. |
| Schema extension | No incremental field attachment after construction | Yjs local state is one object. Declaring the full schema up front avoids partial-state windows and ordering surprises. |
| Sync relationship | `attachSync(ydoc, { awareness })` consumes an awareness attachment | Sync is the provider transport. It should encode and apply awareness updates for the provided attachment. |
| Peer lookup | `createPeerDirectory({ awareness, sync })` | Peer lookup is a helper over `state.peer`, not an attachment that owns awareness. |
| Presence naming | Rename peer-specific presence to peer directory | The helper maps stable peer ids to live Yjs client ids. `presence` is too broad once awareness can also carry cursors and typing. |
| Generic typed wrapper | Keep as internal machinery behind `attachAwareness` | The typed validation logic earns its keep, but public callers should not need `createAwareness`. |
| Public raw access | Keep `awareness.raw` | Editor bindings and low-level tests may need the underlying `YAwareness`. |
| Compatibility aliases | No aliases in the clean break | Aliases keep the old ownership model alive. This is a breaking cleanup. |

## Proposed API

### Awareness Attachment

```ts
export type AwarenessSchema = Record<string, CombinedStandardSchema>;

export type AwarenessState<TSchema extends AwarenessSchema> = {
	[K in keyof TSchema]: InferAwarenessValue<TSchema[K]>;
};

export type AwarenessAttachment<TSchema extends AwarenessSchema> = {
	setLocal(state: Partial<AwarenessState<TSchema>>): void;
	setLocalField<K extends keyof TSchema & string>(
		key: K,
		value: AwarenessState<TSchema>[K],
	): void;
	getLocal(): AwarenessState<TSchema> | null;
	getLocalField<K extends keyof TSchema & string>(
		key: K,
	): AwarenessState<TSchema>[K] | undefined;
	getAll(): Map<number, AwarenessState<TSchema>>;
	peers(): Map<number, AwarenessState<TSchema>>;
	observe(
		callback: (changes: Map<number, 'added' | 'updated' | 'removed'>) => void,
	): () => void;
	raw: YAwareness;
};

export function attachAwareness<TSchema extends AwarenessSchema>(
	ydoc: Y.Doc,
	options: {
		schema: TSchema;
		initial: AwarenessState<TSchema>;
	},
): AwarenessAttachment<TSchema>;
```

The schema and initial state are deliberately separate:

```ts
const awareness = attachAwareness(ydoc, {
	schema: {
		peer: PeerIdentity,
		cursor: Cursor.or('null'),
	},
	initial: {
		peer,
		cursor: null,
	},
});
```

Do not use a per-field wrapper:

```ts
// Rejected. This hides the actual wire object.
attachAwareness(ydoc, {
	fields: {
		peer: { schema: PeerIdentity, initial: peer },
		cursor: { schema: Cursor.or('null'), initial: null },
	},
});
```

The wire object is `{ peer, cursor }`, so `initial` should show `{ peer, cursor }`.

### Sync Attachment

```ts
const awareness = attachAwareness(ydoc, {
	schema,
	initial,
});

const sync = attachSync(ydoc, {
	url,
	getToken,
	awareness,
});
```

`attachSync` should own the awareness wire transport for the provided attachment:

```txt
awareness.raw.on('update')
  -> encodeAwarenessUpdate()
  -> sync send awareness frame

sync receives awareness frame
  -> applyAwarenessUpdate(awareness.raw, update, SYNC_ORIGIN)

sync connects
  -> send local awareness state
  -> send known awareness states when queried

sync disconnects
  -> remove remote awareness states
```

If no `awareness` option is passed, `attachSync` does not transport awareness frames.

### Peer Directory

```ts
export type PeerDirectory = {
	peers(): Map<number, PeerPresenceState>;
	find(peerId: string): ResolvedPeer | undefined;
	waitForPeer(
		peerId: string,
		options: { timeoutMs: number },
	): Promise<Result<ResolvedPeer, PeerMiss>>;
	observe(callback: () => void): () => void;
};

export function createPeerDirectory<TSchema extends AwarenessSchema>(
	deps: {
		awareness: AwarenessAttachment<TSchema & { peer: typeof PeerIdentity }>;
		sync: Pick<SyncAttachment, 'status'>;
	},
): PeerDirectory;
```

The exact type constraint may need adjustment because `CombinedStandardSchema` inference can be picky. The intent is more important than the exact spelling:

```txt
createPeerDirectory requires an awareness attachment whose schema includes peer: PeerIdentity.
```

The helper should not expose `raw.awareness`; raw access belongs to the awareness attachment.

### Remote Client

Current:

```ts
const remote = createRemoteClient({ presence, rpc });
```

Target:

```ts
const remote = createRemoteClient({ peerDirectory, rpc });
```

The remote client resolves stable peer ids through `peerDirectory.find()` and sends RPC calls through `rpc.rpc()`.

## Rename Map

| Current | Target | Notes |
| --- | --- | --- |
| `AwarenessDefinitions` | `AwarenessSchema` | Schema is the user-facing word in this codebase. |
| `Awareness<TDefs>` | `AwarenessAttachment<TSchema>` | Return type of `attachAwareness`; avoids shadowing `YAwareness`. |
| `attachAwareness(ydoc, defs, initial)` | `attachAwareness(ydoc, { schema, initial })` | Breaking signature cleanup. |
| `createAwareness` | internal `createAwarenessAttachment` or `createAwarenessView` | Keep private unless an external raw-awareness wrapper is proven necessary. |
| `sync.attachPresence({ peer })` | delete | Presence no longer creates or owns awareness. |
| `createPeerPresence` | `createPeerDirectory` | The helper maps peer ids to client ids. |
| `PeerPresenceAttachment` | `PeerDirectory` | More precise role. |
| `AttachPresenceConfig` | delete | The peer field is declared in awareness initial state. |
| `presence` app fields | `peerDirectory` | Breaking rename. Avoid generic `presence` once awareness carries more fields. |
| `createRemoteClient({ presence, rpc })` | `createRemoteClient({ peerDirectory, rpc })` | Makes the dependency explicit. |

## Architecture

### Current Ownership

```txt
openFuji()
  |
  +-- attachSync(ydoc)
        |
        +-- attachPresence({ peer })
              |
              +-- new YAwareness(ydoc)
              +-- validate state.peer
              +-- send awareness frames
              +-- find peer id
```

The peer layer owns four jobs:

```txt
raw awareness construction
wire transport
schema validation
peer lookup
```

### Target Ownership

```txt
openFuji()
  |
  +-- attachAwareness(ydoc, { schema, initial })
  |     |
  |     +-- new YAwareness(ydoc)
  |     +-- validate full awareness state
  |
  +-- attachSync(ydoc, { awareness, url })
  |     |
  |     +-- send awareness updates
  |     +-- apply remote awareness updates
  |
  +-- createPeerDirectory({ awareness, sync })
        |
        +-- read state.peer
        +-- find peer id
        +-- wait for peer id
```

Each layer has one job:

```txt
attachAwareness     state and validation
attachSync          transport
createPeerDirectory peer lookup
attachRpc           action dispatch
```

### App Composition

```ts
export function openFuji({ auth, peer }: OpenFujiOptions) {
	const doc = openFujiDoc();
	const idb = attachIndexedDb(doc.ydoc);
	attachBroadcastChannel(doc.ydoc);

	const awareness = attachAwareness(doc.ydoc, {
		schema: {
			peer: PeerIdentity,
		},
		initial: {
			peer,
		},
	});

		const sync = attachSync(doc, {
			url: websocketUrl(`${APP_URLS.API}/workspaces/${doc.ydoc.guid}`),
			waitFor: idb,
			getToken: async () => {
				await auth.whenSessionLoaded;

				const snapshot = auth.snapshot;
				return snapshot.status === 'signedIn' ? snapshot.session.token : null;
			},
			awareness,
		});

	const peerDirectory = createPeerDirectory({ awareness, sync });
	const rpc = sync.attachRpc(doc.actions);

	return {
		...doc,
		idb,
		awareness,
		sync,
		peerDirectory,
		rpc,
		whenReady: idb.whenLoaded,
	};
}
```

A future editor can extend the schema at the same construction boundary:

```ts
const awareness = attachAwareness(doc.ydoc, {
	schema: {
		peer: PeerIdentity,
		cursor: Cursor.or('null'),
		selection: Selection.or('null'),
		typing: 'boolean',
	},
	initial: {
		peer,
		cursor: null,
		selection: null,
		typing: false,
	},
});
```

## Implementation Plan

### Phase 1: Change `attachAwareness`

- [x] **1.1** Rename `AwarenessDefinitions` to `AwarenessSchema`.
- [x] **1.2** Rename `Awareness<TDefs>` to `AwarenessAttachment<TSchema>`.
- [x] **1.3** Change `attachAwareness(ydoc, defs, initial)` to `attachAwareness(ydoc, { schema, initial })`.
- [x] **1.4** Keep schema and initial state as separate object properties.
- [x] **1.5** Update `attach-awareness.test.ts` to cover the new signature.
- [x] **1.6** Decide whether `createAwareness` remains exported. Recommendation: make it private and name it `createAwarenessAttachment` internally.

### Phase 2: Move Awareness Transport Into `attachSync`

- [x] **2.1** Add `awareness?: AwarenessAttachment<AwarenessSchema>` to `AttachSyncConfig`.
- [x] **2.2** Move `encodeAwarenessUpdate`, `applyAwarenessUpdate`, `encodeAwarenessStates`, and `removeAwarenessStates` wiring out of `peer-presence.ts` and into `attach-sync.ts`.
- [x] **2.3** Register one `awareness.raw.on('update')` handler inside `attachSync` when awareness is provided.
- [x] **2.4** Send local awareness state after sync attaches or connects, matching current behavior.
- [x] **2.5** Send known states on query awareness frames.
- [x] **2.6** Remove remote awareness states when the sync connection closes or goes offline.
- [x] **2.7** Make no-awareness sync explicit: sync still works, but awareness frames are ignored or dropped.

### Phase 3: Replace Peer Presence Attachment With Peer Directory

- [x] **3.1** Rename `createPeerPresence` to `createPeerDirectory`.
- [x] **3.2** Rename `PeerPresenceAttachment` to `PeerDirectory`.
- [x] **3.3** Delete `AttachPresenceConfig`.
- [x] **3.4** Delete `PeerPresenceController`.
- [x] **3.5** Remove all raw `YAwareness` construction from `peer-presence.ts`.
- [x] **3.6** Make `createPeerDirectory` accept `{ awareness, sync }` or `{ awareness, status }`.
- [x] **3.7** Keep `peers()`, `find()`, `waitForPeer()`, and `observe()` behavior.
- [x] **3.8** Keep malformed peer states invisible to peer lookup.

### Phase 4: Update Remote Client And Daemon Types

- [x] **4.1** Change `createRemoteClient({ presence, rpc })` to `createRemoteClient({ peerDirectory, rpc })`.
- [x] **4.2** Update daemon runtime types from `presence` to `peerDirectory`.
- [x] **4.3** Update `/peers` route consumers to read `entry.runtime.peerDirectory.peers()`.
- [x] **4.4** Update CLI peer wait and remote run handling to use `peerDirectory`.
- [x] **4.5** Remove public aliases for old `presence` names unless a rollout constraint appears.

### Phase 5: Update Apps And Examples

- [x] **5.1** Update Fuji browser and daemon factories.
- [x] **5.2** Update Honeycrisp browser and daemon factories.
- [x] **5.3** Update Opensidian browser and daemon factories.
- [x] **5.4** Update Tab Manager extension factory.
- [x] **5.5** Update Zhongwen daemon factory.
- [x] **5.6** Update `examples/notes-cross-peer`.
- [x] **5.7** Return `awareness` and `peerDirectory` from app bundles where callers need them.

### Phase 6: Documentation And Verification

- [x] **6.1** Update `packages/workspace/src/document/README.md` awareness examples.
- [x] **6.2** Update sync architecture docs and specs that still show `sync.attachPresence`.
- [x] **6.3** Run focused workspace tests.
- [x] **6.4** Run CLI tests that cover peers, run, and daemon routes.
- [x] **6.5** Run app typechecks for touched apps.
- [x] **6.6** Run root typecheck and record any unrelated failures.

## Edge Cases

### Optional Awareness Fields

Yjs awareness state is a JSON object. If a field may be absent in behavior, prefer an explicit `null` value in the schema:

```ts
schema: {
	cursor: Cursor.or('null'),
},
initial: {
	cursor: null,
},
```

Do not rely on fields being omitted after schema declaration. The typed wrapper currently treats missing defined fields as invalid.

### Peer Identity Changes

A peer may update its name or platform while online:

```ts
awareness.setLocalField('peer', {
	...peer,
	name: nextName,
});
```

Expected behavior:

1. The local awareness clock increments.
2. Sync broadcasts the update.
3. Remote `peerDirectory.peers()` returns the updated peer state.

### No Awareness Attached To Sync

Some documents may only need durable Y.Doc sync:

```ts
const sync = attachSync(ydoc, { url });
```

Expected behavior:

1. Y.Doc sync works.
2. No awareness frames are sent.
3. Peer directory cannot be constructed unless the caller has an awareness attachment with `peer`.

### Malformed Remote Peer State

A remote client can publish invalid awareness JSON:

```json
{ "peer": null }
```

Expected behavior:

1. `awareness.getAll()` excludes states that fail schema validation.
2. `peerDirectory.peers()` excludes malformed peer states.
3. `peerDirectory.find(peerId)` ignores malformed states.

### External Provider Awareness

Yjs docs commonly expose awareness as `provider.awareness`. This spec does not require external provider support in the first implementation because Epicenter's `attachSync` is the active provider. If external raw awareness wrapping is needed later, add one explicit API:

```ts
const awareness = attachAwareness(ydoc, {
	raw: provider.awareness,
	schema,
	initial,
});
```

Recommendation: defer this until a real caller appears. Do not keep public `createAwareness` only for theoretical provider wrapping.

### Multiple Calls To `attachAwareness`

Multiple raw awareness instances for one synced `Y.Doc` should be treated as a misuse.

Expected behavior:

1. The implementation may not be able to prevent every duplicate call.
2. Docs should state one awareness attachment per synced `Y.Doc`.
3. Tests should assert that app factories compose one awareness attachment and pass it to sync.

## Review

**Completed**: 2026-05-01
**Branch**: current workspace branch

### Summary

Implemented the awareness ownership change so `attachAwareness(ydoc, { schema, initial })` creates the single raw Yjs awareness instance, and `attachSync(..., { awareness })` transports it. Peer lookup now lives in `createPeerDirectory({ awareness, sync })`, and RPC, daemon, CLI, app, example, and documentation surfaces use `peerDirectory` instead of the deleted `sync.attachPresence({ peer })` path.

### Deviations from Spec

- `PeerPresenceState` remains as the state type name for `{ peer: PeerIdentity }`. The spec did not require renaming that derived shape, and keeping it limits churn while removing the old ownership API.
- App typechecks still hit pre-existing Svelte/UI and app errors outside this change. The workspace package typecheck and focused tests pass.

### Follow-up Work

- Clean up the existing Svelte/UI typecheck failures so app-level verification can distinguish awareness regressions from unrelated project errors.

## Open Questions

1. **Should `createPeerDirectory` depend on the whole `sync` attachment or only a status reader?**
   - Options: pass `sync`, pass `{ status }`, or make `waitForPeer` unaware of sync status.
   - Recommendation: pass a small status dependency if practical. The helper needs sync status only to produce better `PeerMiss` messages.

2. **Should app bundle fields be renamed from `presence` to `peerDirectory` immediately?**
   - Options: hard rename, temporary alias, or keep `presence`.
   - Recommendation: hard rename. This is a breaking cleanup, and `presence` will be too broad after generic awareness is real.

3. **Should `createRemoteClient` take `{ peerDirectory, rpc }` or `{ peers, rpc }`?**
   - Options: `peerDirectory`, `peers`, `directory`.
   - Recommendation: `peerDirectory`. It is explicit and avoids colliding with the `peers()` method.

4. **Should `attachAwareness` accept `raw` in the first implementation?**
   - Options: support `raw` now, keep an internal wrapper only, or defer.
   - Recommendation: defer public raw wrapping. Keep `raw` exposed on the return value for editor bindings and low-level integration.

5. **Should `PeerPresenceState` be renamed?**
   - Options: keep `PeerPresenceState`, rename to `PeerState`, or derive it from `AwarenessState`.
   - Recommendation: keep `PeerPresenceState`. It names the subset returned by the peer directory, not the full awareness state.

## Success Criteria

- [x] `attachAwareness` uses `attachAwareness(ydoc, { schema, initial })`.
- [x] Schema and initial data stay separate inside the options object.
- [x] Production app factories create one awareness attachment per synced document.
- [x] `attachSync` transports awareness updates for a provided awareness attachment.
- [x] `peer-presence.ts` no longer constructs `new YAwareness`.
- [x] `peer-presence.ts` no longer owns awareness wire encoding or update application.
- [x] `sync.attachPresence` is removed.
- [x] Peer lookup is exposed through `createPeerDirectory` and `PeerDirectory`.
- [x] Remote client construction uses `createRemoteClient({ peerDirectory, rpc })`.
- [x] No public `PeerIdentityInput` or dead peer id generics return.
- [x] `rg "new YAwareness|sync\\.attachPresence|createPeerPresence|PeerPresenceAttachment|AwarenessDefinitions|createAwareness\\(" packages apps examples` has no stale production matches except intentional tests or internals.
- [x] `bun test packages/workspace/src/document` passes.
- [x] `bun test packages/workspace/src/rpc` passes.
- [x] `bun test packages/cli` passes.
- [x] Relevant app typechecks pass or unrelated pre-existing failures are recorded.

## References

- `packages/workspace/src/document/attach-awareness.ts`: current typed awareness wrapper and target owner of raw awareness.
- `packages/workspace/src/document/attach-sync.ts`: target owner of awareness wire transport.
- `packages/workspace/src/document/peer-presence.ts`: current peer-specific helper to shrink into peer directory.
- `packages/workspace/src/document/peer-presence-defs.ts`: `PeerIdentity` schema and peer state types.
- `packages/workspace/src/rpc/remote-actions.ts`: remote client constructor that should depend on peer directory.
- `packages/workspace/src/daemon/types.ts`: daemon runtime surface that currently names presence.
- `packages/workspace/src/daemon/app.ts`: `/peers` route consumer.
- `packages/cli/src/commands/run.ts`: peer-targeted remote run path.
- `packages/cli/src/commands/peers.ts`: peer list command.
- `apps/fuji/src/lib/fuji/browser.ts`: browser app composition example.
- `apps/fuji/src/lib/fuji/daemon.ts`: daemon app composition example.
- `apps/tab-manager/src/lib/tab-manager/extension.ts`: branded peer id call site.
- `node_modules/.bun/y-protocols@1.0.7+34f3bd3cf9e54176/node_modules/y-protocols/awareness.js`: local source for awareness clock and state model.
- `https://docs.yjs.dev/api/about-awareness`: Yjs awareness API.
- `https://docs.yjs.dev/getting-started/adding-awareness`: Yjs awareness composition examples.
