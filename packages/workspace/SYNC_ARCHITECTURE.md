# Multi-Device Sync Architecture

Epicenter replicates a `Y.Doc` across many devices over a WebSocket relay. Yjs's CRDT semantics keep every replica eventually consistent regardless of message order or how many devices are connected.

This document describes the runtime: the one public primitive (`openCollaboration`), the handle it returns, and how the wire is organized.

## One primitive: `openCollaboration`

Every document that participates in sync, the workspace doc and every nested content doc, goes through `openCollaboration`. There is no second primitive. The workspace doc passes a real action registry; content docs pass `actions: {}`.

```ts
import {
    defineActions,
    defineMutation,
    openCollaboration,
    roomWsUrl,
} from '@epicenter/workspace';

const collaboration = openCollaboration(ydoc, {
    url: roomWsUrl('https://api.epicenter.so', ydoc.guid),
    waitFor: idb.whenLoaded,
    openWebSocket: auth.openWebSocket,
    installationId: 'macbook',
    actions: defineActions({ tabs_close: defineMutation({ /* ... */ }) }),
});

// Local invocation: direct function call against the registry.
await collaboration.actions.tabs_close({ tabIds: [1, 2] });

// Remote invocation: pick an online install, dispatch to it over HTTP.
const phone = collaboration.devices
    .list()
    .find((device) => device.installationId === 'phone');
if (phone) {
    const { data, error } = await collaboration.dispatch({
        to: phone.installationId,
        action: 'tabs_close',
        input: { tabIds: [1, 2] },
        signal: AbortSignal.timeout(5_000),
    });
}
```

Content docs (rich-text bodies, attachments, anything nested that syncs independently) use the same call with `actions: {}`. Inbound dispatch frames reply `ActionNotFound`; sync and presence are unchanged.

## The `Collaboration` handle

`openCollaboration` returns synchronously:

| Field             | What it is                                                         |
| ----------------- | ------------------------------------------------------------------ |
| `installationId`  | Install-stable routing label, echoed from config                  |
| `actions`         | Live local action registry; call directly                         |
| `status`          | Current `SyncStatus` (`offline`/`connecting`/`connected`/`failed`) |
| `whenConnected`   | Resolves on first successful handshake; rejects on permanent fail  |
| `whenDisposed`    | Resolves once the supervisor exits and the socket closes           |
| `onStatusChange`  | Subscribe to status changes; returns unsubscribe                   |
| `reconnect`       | Manually wake the supervisor (resets backoff)                      |
| `devices`         | `list()` / `subscribe()` over the server-owned presence channel    |
| `dispatch`        | Fire a cross-device call over HTTP                                 |
| `[Symbol.dispose]`| Sugar for `ydoc.destroy()`; cascades through every attachment      |

There is no `peers` surface, no `identity`, no `actionKeys`. Presence is server-owned and surfaced as `devices`; cross-device calls are HTTP and surfaced as `dispatch`.

## The wire: one socket, two frame kinds, plus HTTP

`openCollaboration` opens exactly one WebSocket per `(Y.Doc, relay)` pair, and uses one HTTP endpoint alongside it.

```
WebSocket
│
├─ binary frames   Yjs CRDT sync (STEP1 / STEP2 / UPDATE)
│
└─ text frames     server -> client:  presence (full install list)
                   server -> client:  dispatch_inbound
                   client -> server:  dispatch_response

HTTP
│
└─ POST .../dispatch   caller-side dispatch (fire and await)
```

Three concerns, three transports inside one connection:

- **Durable doc state** rides binary Yjs frames. Multi-writer, conflict-free.
- **Presence** rides text frames pushed by the relay. The relay owns it.
- **Dispatch** is a request/response over HTTP; the relay forwards `dispatch_inbound` / `dispatch_response` text frames in the middle.

None of the three touch the others. There is no awareness protocol, and no reserved Y.Doc array for presence or RPC.

### Sync plane (binary)

Standard Yjs sync: STEP1 (state vector), STEP2 (missing updates), UPDATE (incremental changes). The supervisor encodes and decodes through `@epicenter/sync`'s `handleSyncPayload`. The first STEP2 or UPDATE after connect completes the handshake and flips status to `connected`.

### Presence plane (server-owned)

The relay tracks live WebSocket connections in a `connections` Map. That map is the source of truth for "who is online." On every connection change it broadcasts one server-to-client text frame carrying the whole list:

```ts
type PresenceFrame = { type: 'presence'; installs: string[] };
```

- The frame is sent to a freshly-upgraded socket, and rebroadcast to every other socket whenever an install joins or leaves.
- `installs` is computed per recipient with the receiver's own install excluded, so the client stores it verbatim.
- The first socket for an install triggers a rebroadcast; a second tab for an install already present does not (the list is unchanged).
- A last-socket close arms a short debounced rebroadcast. A reconnecting socket inside that window supersedes the pending rebroadcast, so a graceful tab handoff produces no wire-visible transition.

There is no delta protocol. The relay owns the whole truth and ships the whole truth on every change; the client never reassembles `added` / `removed` events. Clients never SEND presence frames either: connecting is the publish, and the URL-stamped `installationId` is the address.

`openCollaboration` parses the frame inline and stores `installs` as the `LiveDevice[]` behind `devices`:

```ts
collaboration.devices.list();        // LiveDevice[], the latest relay-pushed list
collaboration.devices.subscribe(fn); // fires on every `presence` frame
```

`LiveDevice` is exactly `{ installationId: string }`. Display names, cursors, and capability lists are app concerns and live in app-owned tables, not on the presence wire.

`devices` is a display mirror, not a decision input. The client never reads it to decide whether a call will reach a peer; "is this install reachable" is answered authoritatively by the relay on every dispatch (see below). The daemon's run-handler used to keep a local pre-check against this list; it now just maps the relay's `RecipientOffline` to `PeerNotFound`.

#### Why server-owned, not awareness

Presence used to ride y-protocols Awareness. Awareness is built for ephemeral peer-to-peer state with concurrent per-peer writers (cursors, selections, typing indicators), not for a server-authoritative fact the relay already holds in its `connections` Map. Moving presence onto a plain server-pushed channel deleted the awareness round-trip, the Durable Object hibernation restore loop, and the clock-fabrication seed. See `specs/20260521T121500-server-owned-presence.md` for the full argument.

Cursor and selection sync, when they arrive, bring Awareness back, used for what it is designed for and kept separate from this presence channel.

### Dispatch (HTTP)

A cross-device call is an HTTP `POST` to the relay's `/dispatch` endpoint, derived from the sync URL by `deriveDispatchUrl` (swap `ws`/`wss` to `http`/`https`, append `/dispatch`).

```ts
const { data, error } = await collaboration.dispatch({
    to: 'phone',                       // target installationId
    action: 'tabs_close',              // snake_case action key
    input: { tabIds: [1, 2] },         // omit for no-argument actions
    signal: AbortSignal.timeout(5_000),
});
```

End to end:

```
caller                      relay                        recipient
──────                      ─────                        ─────────
POST /dispatch ───────────▶  look up `to` in
{ to, action, input }        the connections Map
                             │
                             ├─ no live socket ─▶ 200 { error: RecipientOffline }
                             │
                             └─ push dispatch_inbound ──▶ runInboundDispatch:
                                  (text frame)              actions[action](input)
                                                            │
                             ◀── dispatch_response ─────────┘
                                  (text frame)
       200 { data } ◀──────  relay completes the held
       or { error }          HTTP request
```

The caller's `signal` (or the platform fetch timeout) is the only deadline; the relay holds the HTTP request open until the recipient responds or the caller aborts.

`dispatch` always resolves to `Result<unknown, DispatchError>`:

| Variant            | Produced by | When                                                       |
| ------------------ | ----------- | ---------------------------------------------------------- |
| `RecipientOffline` | relay       | No live socket for `to`, or its socket closed mid-handler  |
| `ActionNotFound`   | recipient   | Recipient has no handler for `action`                      |
| `ActionFailed`     | recipient   | Recipient handler threw or returned `Err`; `cause` is a string |
| `Cancelled`        | local       | Caller's `AbortSignal` aborted before the response arrived |
| `NetworkFailed`    | local       | The HTTP request failed before reaching the relay          |

`RecipientOffline`, `ActionNotFound`, and `ActionFailed` arrive inside the HTTP 200 body; `Cancelled` and `NetworkFailed` are produced locally.

Because the relay answers reachability inline (its `connections` Map decides, on the same request that routes the call), callers that need to tell "addressed an offline install" apart from "the call reached the peer and failed" branch on `RecipientOffline` directly. There is no separate liveness pre-check, and no window where a client cache disagrees with the relay.

For a type-narrowed success payload against a known target registry, lift through `typedDispatch`:

```ts
import { typedDispatch } from '@epicenter/workspace';
import type { TabManagerActions } from '@epicenter/tab-manager/actions';

const tabManager = typedDispatch<TabManagerActions>(collaboration.dispatch);
const { data } = await tabManager({
    to: phone.installationId,
    action: 'tabs_close',
    input: { tabIds: [1, 2] },
});
```

The runtime call is unchanged; `typedDispatch` only constrains the action key and the input/output types. The relay routes by `installationId` only; it does not prove the target install implements `TActions`.

The recipient side is `runInboundDispatch`: the supervisor routes inbound text frames to it, it looks up the action in the local registry, runs it, and emits the `dispatch_response`. A content doc with `actions: {}` always replies `ActionNotFound`.

## URLs and routing

A cloud document is owned by the authenticated subject (the user's identity) and addressed by its own `ydoc.guid`. The client builds the URL from `(apiUrl, ydoc.guid)`:

```ts
roomWsUrl('https://api.epicenter.so', ydoc.guid);
// -> wss://api.epicenter.so/rooms/<ydoc.guid>
```

The relay takes the subject from the auth token and builds the internal Durable Object name `subject:${userId}:rooms:${room}`. There is no workspace lookup and no membership check: the route's auth middleware is the whole authorization story, because you cannot fail to be yourself.

This is the consumer Google Docs model and the first of three account layers, introduced over time:

- **Layer 1 (this)**: personal content. `subject:${userId}` owns the doc.
- **Layer 1.5 (future)**: sharing. A per-document ACL grants other subjects access; the owner's DO name does not change.
- **Layer 2 (future)**: shared-drive content. An org owns a namespace so content survives a departing employee.
- **Layer 3 (future)**: tenancy and billing. An organization groups user accounts for one invoice and admin policy; it never owns a document.

`installationId` is appended as a query parameter (`?installationId=`) on every connect, including reconnects. It is a routing label stamped on the socket at upgrade, not an auth principal: the relay authorizes the room from the token, and within that room `installationId` only decides which socket dispatch is delivered to.

`/rooms/:room` is the single cloud sync route. Browser apps and the workspace daemon both build their URL with `roomWsUrl`, exported from the `@epicenter/workspace` package root.

## Supervisor lifecycle

`openCollaboration` wraps an internal `createSyncSupervisor` that owns the WebSocket. Three timers participate:

| Timer                 | Default | Job                                                         |
| --------------------- | ------- | ----------------------------------------------------------- |
| `CONNECT_TIMEOUT_MS`  | 15 s    | Abort a socket stuck in CONNECTING                          |
| `PING_INTERVAL_MS`    | 60 s    | Send a `'ping'` text frame to keep the socket alive         |
| `LIVENESS_TIMEOUT_MS` | 90 s    | Close the socket if no traffic arrives for this long (checked every 10 s) |

### Connect, reconnect, backoff

```
   ┌─────────────┐
   │   offline   │ ◄── ydoc.destroy()
   └──────┬──────┘
          │ waitFor resolves
          ▼
   ┌─────────────┐
   │ connecting  │ ──► attemptConnection(signal)
   │ retries=N   │ ◄── reconnect() wakes the loop
   └──────┬──────┘
          │ STEP2/UPDATE handshake
          ▼
   ┌─────────────┐
   │  connected  │ ──► whenConnected.resolve()
   └──────┬──────┘
          │ ws.onclose
          ▼
   backoff sleep (jittered, capped at 30 s)
          │
          └─► retry
```

Backoff is `min(BASE_DELAY_MS * 2 ** retries, MAX_DELAY_MS)` scaled by `0.5 + Math.random() * 0.5`. Window `online`, `offline`, and `visibilitychange` events wake the backoff or close the socket as appropriate.

### Permanent failure

A server-side auth rejection closes the WebSocket with code `4401` and a JSON reason `{ "code": "<reason>" }`. Codes seen today: `invalid_token`, `token_expired`, `deauthorized`, `unknown`. On 4401:

- Status becomes `{ phase: 'failed', reason: { type: 'auth', code } }`.
- `whenConnected` rejects with `SyncFailedError.AuthRejected({ code })`.
- The supervisor parks; only `reconnect()` reopens it. Apps wire `reconnect()` to `auth.onStateChange` so a sign-in retries automatically.

### Cancellation hierarchy

```
masterController   aborts on ydoc.destroy(); kills everything
   ▼
cycleController    aborts on reconnect(); kills the current iteration only
```

`reconnect()` replaces `cycleController` (rather than just re-aborting it) so the next cycle gets a fresh signal unrelated to the old one. The supervisor reads `cycleController.signal` fresh at the top of each iteration; aborting the old one wakes a parked supervisor and the next iteration picks up the replacement.

## Construction to first connect, in time

```
t=0      openCollaboration(ydoc, { url, installationId, actions, ... })
         ├─ validate action keys against ACTION_KEY_PATTERN
         ├─ createSyncSupervisor(ydoc, { url, waitFor, openWebSocket, onTextFrame })
         │   ├─ ydoc.on('updateV2', handleDocUpdate)
         │   ├─ ydoc.once('destroy', dispose-cascade)
         │   └─ supervisor loop starts
         └─ returns Collaboration synchronously

t=1ms    supervisor: await waitFor (e.g. idb.whenLoaded)

t=Nms    waitFor resolves; supervisor enters the connecting loop

t=N+ε    attemptConnection(signal):
           openWebSocket(url + '?installationId=...', [MAIN_SUBPROTOCOL])
           ws.onopen   -> send encodeSyncStep1
           ws.onmessage SYNC STEP2/UPDATE -> handshake complete
                        -> status 'connected', whenConnected resolves
           ws.onmessage text `presence` -> devices.list() reflects the relay
```

## Mental model in one paragraph

`openCollaboration(ydoc, config)` is the one collaboration primitive: it opens a single WebSocket to the relay, runs the Yjs binary sync protocol, mirrors the relay's server-owned presence channel into `devices`, and runs inbound dispatch frames against the local `actions` registry. Cross-device calls go out through `dispatch(...)`, a plain HTTP POST the relay routes to the recipient's socket and answers with a typed `Result<unknown, DispatchError>`. Presence is the relay's `connections` Map, not Yjs Awareness; dispatch is HTTP, not a Y.Doc array. Lifecycle is supervisor-driven: exponential backoff with jitter, 60 s pings, 90 s liveness, permanent park on close code 4401, and `whenDisposed` resolves once the cascade from `ydoc.destroy()` finishes. Content docs use the same primitive with `actions: {}`.
