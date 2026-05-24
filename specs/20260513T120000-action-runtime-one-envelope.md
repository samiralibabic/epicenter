# Action Runtime: openCollaboration Hosts Actions

**Date**: 2026-05-13
**Status**: Superseded by `specs/20260513T235000-rpc-on-yjs-state.md`
**Reason**: The `peer.ts`, `peer.invoke`, `peer.describe()`, `attachAwareness`, runtime-request envelope, and `SelfInvocationError` / `PeerLeftError` surfaces referenced throughout this document no longer exist. The shipped model is `collab.dispatch(action, input, { to: connId, signal })` against the `PresenceSurface` in `packages/workspace/src/document/presence.ts` and the LWW-row dispatch in `packages/workspace/src/document/rpc.ts`. Actions are flat snake_case (see `specs/20260513T231157-actions-snake-case-only-no-dots.md`), not dot-path. Keep this file for the audit trail; do not implement.
**Author**: AI-assisted
**Original status**: Draft (rev 3; superseded rev 2 of this file)

## Why This Rewrite

Rev 1 described a separate Bun host, JSON-RPC envelope, `ctx.host` capability layer, loopback HTTP transport, and new `@epicenter/action-client` package.

Rev 2 corrected the instinct: the repo already had typed actions, local invocation, peer routing, and sync transport machinery. But it named the old primitive, `attachRpc`, and preserved the old idea that `system.describe` was just another action.

The current tree has moved again. `openCollaboration` is now the public primitive. It opens sync on a workspace document, publishes `{ identity, actionPaths }` in awareness, hosts local actions, exposes `collaboration.actions` for local calls, and exposes `collaboration.peers` for cross-peer calls. Runtime introspection uses a separate runtime wire plane, not the user action namespace.

## One Sentence

```txt
Actions are typed functions defined with defineQuery / defineMutation;
openCollaboration publishes the local action paths and hosts the handlers;
local callers use collaboration.actions or invokeAction; remote callers use
peer.invoke(path, input) over the same WebSocket that syncs the workspace doc.
```

## Current Model

The current runtime has three layers:

```txt
document
  Y.Doc, tables, kv, batch, persistence

collaboration
  openCollaboration(ydoc, { url, identity, actions, ... })
    -> sync supervisor
    -> awareness: { identity, actionPaths }
    -> inbound action dispatch
    -> runtime requests such as peer.describe()
    -> peers surface

app binding
  app-specific handle that returns document pieces, persistence, collaboration,
  wipe, and disposal
```

The important shape is small:

```ts
const collaboration = openCollaboration(ydoc, {
	url: websocketUrl(RELAY_URL),
	waitFor: idb.whenLoaded,
	openWebSocket: auth.openWebSocket,
	identity: peer,
	actions,
});
```

That one call replaces the old attach chain:

```txt
attachSync + attachAwareness + attachRpc + createRemoteClient
```

## What Already Exists

| Primitive | Location | What it does |
| --- | --- | --- |
| `openCollaboration(ydoc, config)` | `packages/workspace/src/document/open-collaboration.ts` | Opens sync, publishes identity and action paths, hosts local actions, exposes peers. |
| `attachYjsSync(ydoc, config)` | `packages/workspace/src/document/attach-yjs-sync.ts` | Sync-only sibling for content docs. No presence, actions, or peers. |
| `Peer.invoke(path, input)` | `packages/workspace/src/document/peer.ts` | Cross-peer action call by typed dot path. |
| `Peer.describe()` | `packages/workspace/src/document/peer.ts` | Runtime-plane request that returns an `ActionManifest`. |
| `defineQuery` / `defineMutation` | `packages/workspace/src/shared/actions.ts` | Defines action contracts and handlers. |
| `invokeAction(action, input, label)` | `packages/workspace/src/shared/actions.ts` | In-process action invocation with validation and Result wrapping. |
| `describeActions(actions)` | `packages/workspace/src/shared/actions.ts` | Turns an action tree into the manifest returned by `peer.describe()`. |
| `SelfInvocationError` / `PeerLeftError` | `packages/workspace/src/document/peer.ts` | Workspace-layer remote call errors that are not sync protocol errors. |

The transport is still the workspace sync WebSocket. There is no second action HTTP server, no action-client package, and no separate peer registry.

## Action Definition

Handlers use the app's existing services and document binding. There is no `ctx.host`.

```ts
import { defineMutation } from '@epicenter/workspace';
import { type } from 'arktype';
import { services } from '$lib/services';
import { whispering } from '$lib/workspace';

const StartRecordingInput = type({ deviceId: 'string' });
const StopAndAppendInput = type({
	sessionId: 'string',
	documentId: 'string',
});

export const actions = {
	whispering: {
		startRecording: defineMutation({
			input: StartRecordingInput,
			handler: async (input) => {
				const session = await services.recorder.start({
					deviceId: input.deviceId,
				});
				return { sessionId: session.id };
			},
		}),

		stopAndAppend: defineMutation({
			input: StopAndAppendInput,
			handler: async (input) => {
				const recording = await services.recorder.stop({
					sessionId: input.sessionId,
				});
				const transcript = await services.transcriptions.run({
					audioAssetId: recording.assetId,
				});
				await whispering.documents.append({
					documentId: input.documentId,
					text: transcript.text,
				});
				return {
					appended: true,
					charCount: transcript.text.length,
				};
			},
		}),
	},
} as const;

export type WhisperingActions = typeof actions;
```

Rules:

```txt
- Handlers import services and the app binding the same way SPA code does.
- Different platforms wire different service implementations.
- Handler output must be JSON-serializable when remote callers may invoke it.
- Return raw values for success; invokeAction wraps them as Ok.
- Return Err(...) when the handler has a typed domain error to preserve.
- Thrown errors are converted to ActionFailed at the action boundary.
- User actions may use the `system` key. Runtime verbs are on a separate plane.
```

## Local Calls

Known local callers can call the typed action tree directly when that reads best:

```ts
const result = await collaboration.actions.whispering.startRecording({
	deviceId,
});
```

Unknown or boundary-style callers should use `invokeAction`:

```ts
import { invokeAction } from '@epicenter/workspace';

const { data, error } = await invokeAction(
	collaboration.actions.whispering.startRecording,
	{ deviceId },
	'whispering.startRecording',
);

if (error) {
	services.toast.error(error.message);
	return;
}

sessionId = data.sessionId;
```

`invokeAction` validates input, runs the handler, and normalizes the result. No fetch, port, envelope, or RPC path is involved for local work.

## Remote Calls

Cross-peer callers route through the peers surface:

```ts
const target = collaboration.peers
	.list()
	.find((peer) => peer.actionPaths.includes('whispering.startRecording'));

if (!target) return;

const { data, error } = await target.invoke(
	'whispering.startRecording',
	{ deviceId: 'default' },
);
```

When the target type is known, `peers.find<TActions>(id)` narrows the path and payload types:

```ts
const peer = collaboration.peers.find<WhisperingActions>(peerId);
const result = await peer?.invoke('whispering.startRecording', {
	deviceId: 'default',
});
```

Self is not reachable through `peers.list()` or `peers.find()`. A stale client id that reaches the wire fallback returns `SelfInvocationError`, with guidance to call `collaboration.actions.<path>` locally.

## Discovery

Awareness tells you which peers are online and which action paths they host:

```ts
const candidates = collaboration.peers
	.list()
	.filter((peer) => peer.actionPaths.includes('whispering.stopAndAppend'));
```

Full schemas and descriptions come from `peer.describe()`:

```ts
const manifest = await peer.describe();
```

That distinction matters:

```txt
awareness
  small, live, frequently updated
  identity + actionPaths only

peer.describe()
  explicit runtime request
  full ActionManifest with schemas and descriptions
```

## Whispering Phase 1 Direction

Whispering currently has its own query and service layers plus raw Tauri calls. The first action-runtime phase should stay boring:

```txt
1. Create an app action registry around existing recorder, transcription,
   and document-append paths.

2. Mount that registry with openCollaboration once Whispering has a
   collaboration-backed app binding.

3. Keep platform effects in services. The desktop implementation can use
   Tauri/CPAL; the web implementation can use browser APIs.

4. Convert only the call sites that benefit from a typed action boundary.
   Do not force every local service call through actions.
```

This is not a source-install runtime yet. It is the shared action surface that future source-installed apps can call once the shell and permission model exist.

## CLI Direction

The CLI should remain a peer-facing tool, not a separate protocol.

```txt
epicenter list
  local daemon route -> collaboration.actions / peer.describe

epicenter run <path> <input>
  local target -> invokeAction
  remote target -> peer.invoke(path, input)

epicenter peers
  collaboration.peers.list()
```

The daemon already owns the long-lived collaboration runtime. The CLI should keep using the daemon socket for local process management and use the collaboration surface behind it for action discovery and invocation.

## What This Spec Refuses

```txt
- A second action wire format beside the sync protocol.
- A new @epicenter/action-client package.
- ctx.host as a handler argument or capability surface.
- A Bun sidecar in phase 1.
- Loopback HTTP between the webview and bundled JavaScript.
- A peer registry separate from awareness.
- Full action schemas in awareness.
- Treating runtime verbs as user actions.
```

## Deferred

```txt
- Headless Bun daemon as an always-on peer.
- Source-installed apps with capability-gated services.
- Manifest review UX, signing, and marketplace trust.
- Per-action permission grants surfaced to the user.
- Typed Tauri command generation for native bridge calls.
- WASM extension lane.
```

## Related

- `packages/workspace/src/document/open-collaboration.ts`
- `packages/workspace/src/document/peer.ts`
- `packages/workspace/src/document/peer-identity.ts`
- `packages/workspace/src/shared/actions.ts`
- `packages/workspace/SYNC_ARCHITECTURE.md`
- `specs/20260512T234944-source-installed-app-runtime-vision.md`
- `specs/20260513T105808-tauri-specta-bindings.md`
