# Live-device dispatch over the relay

Date: 2026-05-18
Status: planned
Owner: Braden

## 1. Context

Today's cross-device RPC, `collab.dispatch`, writes call rows into a `YKeyValueLww<Call>` keyspace in the workspace Y.Doc. The relay (Cloudflare Durable Object in `apps/api/src/room.ts`) syncs the keyspace to every connected peer. Each peer's observer filters by `to === selfConnectionId` and drops the rest.

This works, but it's wrong on three axes:

1. **Fan-out.** A call addressed to one device is replicated to every connected device. At realistic scale (5 devices, 10 calls per minute) every peer sees ~5.76 MB of dispatch traffic per day it does not care about. On a laptop, invisible. On a Chrome extension service worker or a phone background task, every replicated message wakes the runtime. Wake-up amplification is the real cost.

2. **CRDT history bloat.** Every call is two writes (request, response) plus a tombstone on sweep, all entering the relay's SQLite update log until compaction. Long-lived hot rooms accumulate dispatch churn linearly.

3. **Fake durability.** The CRDT promises eventual delivery. RPC wants "right now, or fail." The orphan sweep in `open-collaboration.ts:162-176` is the confession: rows must expire because they were never durable workspace state in the first place.

The fix has two parts that turn out to be independent:

- **Liveness moves to standard y-protocols awareness.** Server-validated on inbound, force-cleared on socket close. The relay is the source of truth for "who is online"; awareness is the broadcast mechanism. No custom snapshot message, no custom registry frame.
- **Dispatch moves to HTTP POST.** Caller fires `POST /room/v1/:wid/dispatch`; the relay correlates internally with a WebSocket push to the recipient and a WebSocket response back; the HTTP response completes when the recipient answers. The caller has no id correlation, no pending map, no wire-level expiry. Each fetch is its own request-response lifecycle.

The relay's custom protocol surface shrinks to two WebSocket text frames (`dispatch_inbound`, `dispatch_response`) plus one HTTP endpoint, riding on top of standard y-protocols sync + awareness.

## 2. Target state

```
Workspace W on the relay (one Durable Object):

  ┌──────────────────────────────────────────────────────────────────┐
  │ Durable Object: workspace/W                                      │
  │                                                                  │
  │   live WebSocket connections, tagged by installationId in        │
  │   the WS attachment:                                             │
  │     { R_laptop -> ws1, R_phone -> ws2, R_daemon -> ws3 }         │
  │                                                                  │
  │   live Y.Doc (existing, unchanged)                               │
  │   awareness:                                                     │
  │     each peer's state carries a `liveness.installationId` field, │
  │     server-validated via modifyAwarenessUpdate,                  │
  │     server force-cleared on socket close                         │
  │                                                                  │
  │   WebSocket carries standard y-protocols binary frames           │
  │     SYNC = 0       Yjs document sync (unchanged)                 │
  │     AWARENESS = 1  liveness + future ephemeral state             │
  │     AUTH = 2       reserved sentinel (unchanged)                 │
  │                                                                  │
  │   WebSocket also carries two custom text frames                  │
  │     dispatch_inbound  (server -> recipient)                      │
  │     dispatch_response (recipient -> server)                      │
  │                                                                  │
  │   HTTP endpoint                                                  │
  │     POST /room/v1/:wid/dispatch  (caller fires; relay correlates │
  │     internally with the WS push/response loop; returns the       │
  │     result in the HTTP response body)                            │
  └──────────────────────────────────────────────────────────────────┘
```

The Y.Doc keeps durable workspace state. Liveness lives in awareness. Dispatch lives on a separate HTTP endpoint plus a thin WS push channel. None of the three touch each other.

A device is visible to dispatch if and only if it has an open socket on the relay right now and its awareness state carries a valid `liveness.installationId`. There is no durable dispatch-device registry; offline devices do not exist for the purpose of dispatch.

## 3. Explicit decisions

### 3.1 Live-only discovery and dispatch

A device is visible to dispatch if and only if it has an open socket on the relay right now. There is no durable protocol-level `devices` table, no last-seen tracking, no retirement workflow, no stale-device sweep, and no offline row in `collab.devices`.

Apps may still keep their own durable product-level device profiles, such as Tab Manager's local devices table for display names, browser kind, action capabilities, and last-seen timestamps. Those rows are not dispatch liveness, routing, or authorization state. Awareness's `liveness` field is the only source of truth for what can receive a dispatch right now.

A UI may join product profiles with awareness states to show online and offline sections, or to filter by capability ("only devices that can open URLs"). The relay carries none of that; it only knows whether a socket is open and which `installationId` claimed it.

Refused: offline-deferred dispatch, "send this to my phone when it next wakes." If a real use case appears, it gets a separate primitive with its own claim, lease, retry, and dedup invariants. Not this one.

Refused: anycast / capability-based addressing (`{ to: { capability: 'X' } }`). Every dispatch carries a concrete `to: installationId`. Selection by capability is a client-side helper at most.

### 3.2 One call shape: HTTP `POST /dispatch`

No `fire` / `send` / `job` taxonomy. One verb, one transport. The caller does `fetch POST /room/v1/:wid/dispatch` with `{ to, action, input }`. If the recipient is online, the relay forwards, awaits the recipient's response, and returns it as the HTTP response body. If the recipient is offline, the relay returns `{ error: { name: 'RecipientOffline', to } }` immediately.

The HTTP response body is always a wellcrafted `Result<unknown, DispatchError>` (always HTTP 200 unless the request is malformed). This keeps the client code uniform: one branch on `result.error`, no parallel branch on HTTP status.

Once the relay has pushed `dispatch_inbound` to the recipient, the protocol cannot tell whether a later disconnect means "the handler never ran," "the handler is still running," or "the handler ran its side effect and failed before responding." Retry safety belongs to the action contract, not the dispatch protocol.

Dispatch ids exist only inside the relay (a server-minted correlation token between the open HTTP request and the WS push/response). Retries are new HTTP requests with new internal ids; the protocol does no dedup. If an action needs idempotency it carries its own dedup key in `input`.

### 3.3 Identity: one stable `installationId`, claimed at upgrade and validated in awareness

- `installationId` is the stable install identity. It is the address used in `dispatch({ to: installationId, ... })`.
- The client claims its `installationId` once, as a query parameter on the WebSocket upgrade URL: `/room/v1/:wid?installationId=X`. The relay records it in the socket's hibernation attachment.
- The relay also requires `installationId` on every inbound HTTP dispatch, as a `from` field in the request body. The relay validates `from` against the request's auth context (the subject), then stamps it as `from` on the forwarded `dispatch_inbound`.
- The client publishes its `installationId` to awareness via `awareness.setLocalStateField('liveness', { installationId })`. The relay validates inbound awareness updates against the URL-stamped `installationId` (see §3.7). A peer that tries to claim a different installationId in awareness has its update rejected.

There is no `connectionId`, no `device_hello` message, and no `registered` client-side gate. The act of opening the socket with `?installationId=X` is the device-hello.

### 3.4 No `platform`, no `displayName`, no `actions` in the protocol

The relay carries only `installationId`. Three reasons:

- **`displayName`** is user-editable, so it must live in app-owned durable state to avoid the "live name vs durable name" divergence that develops on first rename. Apps that want human-readable picker labels join awareness states against their own durable device profile table.
- **`actions`** would be a code-defined per-build capability list. For static apps (browser, Tauri) it never changes at runtime, so the URL or upgrade payload could carry it. For dynamic apps (daemons with user-added actions) it would change at runtime, so the protocol would need an update mechanism. Carrying it at all forces the relay into being a registry; apps that need pre-dispatch capability filtering can maintain their own durable capability table or query peers via a meta-action. Apps that don't filter just dispatch and handle `ActionNotFound`.
- **`platform`** existed in early drafts as a capability hint. It's strictly less useful than the action list and the action list is gone too, so platform follows.

The wire shape of "an online device" is `{ installationId: string }` and only that.

### 3.5 Server stamps `from` on every forwarded dispatch; `from` is a routing label, not an auth principal

The relay is authoritative for the `from` field on `dispatch_inbound`. The caller's HTTP request body includes its own `installationId` as the `from` field; the relay validates it against the request's auth context (subject scope) and stamps it as `from` on the forwarded `dispatch_inbound` verbatim.

For v1, `installationId` is a trusted routing label inside the authenticated subject scope, not a cryptographic device identity. A subject can register multiple installs and claim any of their own `installationId`s in any request, so action handlers must not treat `from` as an authorization principal. Cross-subject impersonation is prevented by the subject-scoped DO (see `apps/api/src/app.ts:482-492`); within a subject, all installs are trusted equally.

Room authorization is checked when `apps/api/src/app.ts` handles the WebSocket upgrade and when it handles each HTTP dispatch request, forwarding both to the Durable Object. The Durable Object does not revalidate OAuth tokens or Better Auth sessions per WebSocket message; the HTTP layer is the auth boundary for dispatch, the WS upgrade is the auth boundary for sync and awareness. Token or session revocation takes effect when the next HTTP dispatch is rejected at the Worker, or when the socket reconnects.

### 3.6 Multi-socket per installationId: most-recently-connected wins for inbound; HTTP caller-side has no problem

Multi-tab same-install is a real case (browser tabs sharing localStorage, so they share `installationId`). Two flows to consider:

**Inbound dispatch_inbound delivery:** if two sockets register the same `installationId`, the relay forwards `dispatch_inbound` to the most-recently-connected socket only. On that socket closing, the relay falls back to the next-most-recent socket. No `activeForDispatch` flag is stored in attachments; the rule is positional ("newest in the connections map for this installationId"), evaluated at delivery time. No attachment rewrites on new-connection or close, just a Map lookup.

**Caller side has no problem.** HTTP requests are request-response. Each fetch carries its own response over its own HTTP connection. The "non-active tab's Promise hangs" race that WS-based dispatch had does not exist here.

Refused: same-install dispatch fan-out for `dispatch_inbound`. A caller that wants to run an action in every tab needs a separate client-side loop over concrete socket identities; it is not the default `installationId` dispatch contract.

### 3.7 Awareness is the liveness primitive

Yjs awareness is exactly the right primitive for ephemeral per-peer state that all peers care about, which is what device liveness is. The spec uses it deliberately:

- **Namespaced state.** Each peer's awareness state is a single JSON object, but `setLocalStateField('liveness', { installationId })` lives alongside other future fields (`cursor`, `typing`, etc.) without collision. The relay only validates the `liveness` sub-field.
- **Server-validated inbound.** The relay implements `modifyAwarenessUpdate` (y-protocols hook) to inspect every inbound awareness message. If `state.liveness.installationId` is present and differs from the socket's URL-stamped `installationId`, the relay drops the update silently. This is the established y-redis pattern.
- **Server force-clear on disconnect.** On `webSocketClose`, the relay calls `removeAwarenessStates(awareness, [clientID], 'close')`, which broadcasts a null state to all peers immediately. Peers see the device drop within one RTT, not after the 30s heartbeat timeout.
- **Client renewal cadence.** The standard y-protocols awareness heartbeat is ~15s per peer (renews local state to fight the 30s timeout). For typical N (5-20 devices) this is negligible traffic (~80 B/s at N=5). For very large shared workspaces (N >> 50) this is worth revisiting, but it is not a v1 concern.

Reading liveness from the client side:

```ts
function getOnlineInstallationIds(awareness: Awareness): string[] {
  const ids: string[] = []
  for (const [, state] of awareness.getStates()) {
    if (state.liveness?.installationId) ids.push(state.liveness.installationId)
  }
  return [...new Set(ids)]  // dedupe in case multi-tab same-install
}
```

Future awareness uses (cursors, typing indicators, true presence) ride the same channel under different `setLocalStateField` namespaces. The dispatch layer never sees them; the liveness validation in `modifyAwarenessUpdate` only inspects the `liveness` sub-field and leaves the rest alone.

**Tracking `clientID` for force-clear on close.** `removeAwarenessStates` needs the Yjs `clientID`, not the `installationId`, to clear a specific peer's state. The relay learns the `clientID` from the first inbound awareness update on a socket (the awareness message header carries it). On that first valid update, the relay updates the WS attachment from `{ installationId }` to `{ installationId, clientID }`. `webSocketClose` reads the attachment, and if `clientID` is present, calls `removeAwarenessStates(awareness, [clientID], 'close')`. Sockets that close before sending any awareness update have no `clientID` to clear, which is correct (they never published liveness). The added `clientID` field is a few bytes inside the same 2 KB attachment budget.

### 3.8 Protocol portability

The dispatch protocol is intentionally implementable on any WebSocket server that speaks y-protocols, plus a thin HTTP endpoint. The Cloudflare Durable Object is an optimization (free hibernation, tagged sockets), not a requirement.

A self-host reference implementation would need:

1. A stock y-protocols sync + awareness server (any existing y-websocket server)
2. A `modifyAwarenessUpdate` hook that validates `state.liveness.installationId` against the connection's claimed installationId
3. A socket-close handler that calls `removeAwarenessStates` for that peer
4. Two custom WS text-frame handlers (`dispatch_inbound` push, `dispatch_response` receive) with an internal id-to-pending-HTTP-request correlation map
5. A `POST /room/v1/:wid/dispatch` HTTP endpoint that drives the correlation

That is a small shim on top of a standard y-websocket server. This spec does not ship a `bun.serve()` reference implementation; self-hosters who want the relay today should run their own Cloudflare Workers + Durable Objects with the existing `apps/api` code. A non-Cloudflare reference impl is a candidate follow-up spec.

### 3.9 Three transports, three roles

The relay listens on three logically distinct surfaces that share auth context but are independent at the wire level:

```
binary WS frames   -> standard y-protocols
                      SYNC = 0       (Yjs sync, unchanged)
                      AWARENESS = 1  (liveness, server-validated)
                      AUTH = 2       (reserved sentinel, unchanged)
text WS frames     -> dispatch push/response
                      server -> recipient: dispatch_inbound
                      recipient -> server: dispatch_response
HTTP               -> POST /room/v1/:wid/dispatch
                      caller's request-response transport
```

The receiver routes inbound WS frames on the WebSocket frame type:

```ts
ws.addEventListener('message', (event) => {
  if (typeof event.data === 'string') handleDispatchTextFrame(JSON.parse(event.data))
  else                                  handleStandardYProtocol(new Uint8Array(event.data))
})
```

Why this shape:

1. Yjs sync and awareness must be binary; they're standard y-protocols.
2. Dispatch push/response payloads have no binary fields. JSON is debuggable and `defineErrors` serializes natively.
3. The WebSocket frame-type distinction is a free discriminator between binary and text; no registry byte.
4. HTTP for caller-initiated dispatch is the natural request-response transport; it eliminates id correlation, pending Promise maps, expiresAt, and multi-tab caller routing from the wire.
5. The recipient's `dispatch_response` rides WS because the recipient is already there for sync and awareness; opening an HTTP back-channel would be a second transport for no reason.

Refused: doing dispatch entirely over WS text frames. The wire surface and the multi-tab response routing get more complex without buying anything; HTTP gives request-response semantics for free.

Refused: doing dispatch entirely over HTTP (including recipient delivery via SSE). SSE would mean two transports for the recipient (WS for sync + SSE for inbound dispatch) and would multiply reconnects, wake-ups, and auth round trips. Reuse the existing recipient WS.

Refused: a second WebSocket per workspace. Sync, awareness, and dispatch_inbound share lifecycle (workspace membership, installationId, auth session). Splitting them doubles every one of those for no real win and adds wake-up amplification on mobile and extension service workers.

Refused: dropping y-protocols compat on the binary side (sync over HTTP). It is the cleanest available break but deletes the y-protocols-compatible binary wire and slows worst-case sync latency. Reconsider only when y-protocols compat stops being a value.

## 4. Wire protocol

The wire has three surfaces. This section specifies each.

### 4.1 WebSocket binary frames: standard y-protocols

Unchanged from today, with one server-side addition.

```
binary frames -> Yjs sync + awareness, standard y-protocols.
                 See packages/sync/src/protocol.ts.
                 MESSAGE_TYPE.SYNC = 0       (y-protocols canonical)
                 MESSAGE_TYPE.AWARENESS = 1  (y-protocols canonical)
                 MESSAGE_TYPE.AUTH = 2       (Epicenter convention; reserved)
```

Server addition: the relay registers `modifyAwarenessUpdate` to validate the `liveness` sub-field on every inbound awareness update (see §4.4) and calls `removeAwarenessStates` for each closed socket so peers see immediate disconnect.

The only top-level message numbers that y-protocols itself reserves are `SYNC = 0` and `AWARENESS = 1`. `AUTH = 2` is an Epicenter convention living in a slot y-protocols recommends for custom protocols (≥2); it is not canonical upstream. y-protocols compat in this spec means "we do not collide with 0 or 1," which we don't.

### 4.2 WebSocket text frames: dispatch push/response

Two message types, both JSON.

```ts
// server -> recipient
type DispatchInbound = {
  type: 'dispatch_inbound'
  id: string         // server-minted correlation token (opaque to clients)
  from: string       // caller's installationId, server-stamped
  action: string     // snake_case key
  input: unknown
}

// recipient -> server
type DispatchResponse = {
  type: 'dispatch_response'
  id: string         // matches DispatchInbound.id
  result: Result<unknown, ActionResponseError>
}

type ActionResponseError =
  | { name: 'ActionNotFound'; action: string; message: string }
  | { name: 'ActionFailed';   action: string; cause: string; message: string }
```

Encoding:

```ts
const encodeDispatchFrame = (m: DispatchInbound | DispatchResponse): string => JSON.stringify(m)
const decodeDispatchFrame = (s: string): DispatchInbound | DispatchResponse => JSON.parse(s)
```

There is no `expiresAt` on the wire. The HTTP request's lifetime is the dispatch deadline; the caller's `AbortSignal` (or fetch timeout) decides when to give up. The relay holds the open HTTP request and the pending `id` until either the recipient responds (`dispatch_response` matches `id`) or the HTTP request is aborted (relay drops the pending entry; any late `dispatch_response` is dropped on arrival).

There is no caller-visible `id`. Callers see a Promise resolving to `Result`; correlation is the relay's bookkeeping.

### 4.3 HTTP endpoint: `POST /room/v1/:workspaceId/dispatch`

Request:

```
POST /room/v1/:workspaceId/dispatch
Authorization: Bearer <oauth-token>             (or cookie session)
Content-Type: application/json

{
  "from":   "R_laptop",     // caller's installationId
  "to":     "R_phone",      // recipient installationId
  "action": "open_note",
  "input":  { "noteId": "abc" }
}
```

`from`, `to`, `action`, and `input` are all required fields in one JSON object that fully describes the dispatch. `from` is caller-claimed and validated by the relay against the request's auth subject; it is not signed or otherwise cryptographically bound to the caller in v1.

Response (always HTTP 200, body is `Result`):

```
HTTP/1.1 200 OK
Content-Type: application/json

{ "data": { "ok": true } }
```

or:

```
HTTP/1.1 200 OK
Content-Type: application/json

{ "error": { "name": "RecipientOffline", "to": "R_phone",
             "message": "Recipient \"R_phone\" is offline" } }
```

HTTP status codes:

- `200` for every dispatch that the relay was able to evaluate, including handler-level errors and `RecipientOffline`. The Result body is the only error channel for the caller.
- `400` for a malformed body or missing `from`, `to`, `action`, or `input` field.
- `401` / `403` for unauthenticated or forbidden requests (existing OAuth boundary), or for a `from` that does not belong to the request's authenticated subject.
- `5xx` for relay-internal failures only; never used for dispatch-level outcomes.

### 4.4 Validation

The relay validates every surface independently.

**HTTP dispatch validation:**

- Body must be valid JSON with `from`, `to`, `action`, `input` fields. All four are required; missing any returns HTTP 400.
- `from` and `to` are non-empty strings, length at most 128 (installation id constraints).
- `action` is a non-empty string matching `ACTION_KEY_PATTERN`.
- `input` is any JSON value.
- `from` is treated as the caller's `installationId`; subject-scope auth at the Worker boundary prevents cross-subject impersonation, and within-subject any `from` claimed by an authenticated request is trusted (matches the WS model where any of a subject's tabs can register any of their `installationId`s).
- Request body size is below `MAX_PAYLOAD_BYTES`.

**Awareness validation (via `modifyAwarenessUpdate`):**

- Every inbound awareness update is decoded. For each client's new state, if the state contains a `liveness` field, `state.liveness` must be an object containing `installationId: string` and nothing else (forward-compat: ignore other liveness sub-keys, do not reject for them).
- `state.liveness.installationId` must equal the socket's URL-stamped `installationId`. Mismatches: the relay drops that client's awareness update silently (does not propagate to peers; does not close the socket).
- The relay never modifies non-`liveness` sub-fields of awareness state. Cursors, typing, and other future ephemeral state pass through unchanged.

**WebSocket text-frame validation (recipient -> server):**

- Frame must be valid JSON with `type: 'dispatch_response'`, `id: string` (matching a pending dispatch), `result: { data? } | { error? }` (Result-shaped).
- `id` must match a relay-tracked pending dispatch; unknown ids are dropped silently (most often, the HTTP request already timed out and the relay forgot the id).
- An unknown `type` on an inbound text frame closes the sender's socket with `4400 protocol-error`.

Validation failures are protocol violations: malformed inbound text frames close the socket, malformed inbound HTTP requests return `400`, malformed awareness updates are dropped. None of these surface as `DispatchError` to callers.

When emitting `ActionFailed`, the recipient must serialize a safe `cause` (e.g., via `extractErrorMessage` from wellcrafted) rather than forwarding arbitrary thrown objects. JSON cannot round-trip Error instances, circular references, or DOMException chains; the wire form of `cause` is a string.

### 4.5 Wire form of `Result`

`result` follows wellcrafted's runtime `Result<T, E>` shape exactly. Each value is one of two shapes, never both keys:

```ts
type Ok<T>  = { data: T }       // no `error` key
type Err<E> = { error: E }      // no `data` key
type Result<T, E> = Ok<T> | Err<E>
```

This is the body shape of every HTTP `/dispatch` response and the `result` field of every `dispatch_response` WS frame. Validators check `"data" in result` xor `"error" in result`. Receivers branch with `if (result.error)` without translation.

### 4.6 End-to-end flow

```
caller R_laptop                 relay (DO)                       recipient R_phone
─────────────                   ──────────                       ─────────────────

(fetch is sent over caller's
 existing HTTP/2 connection to
 the Worker; reuses TCP/TLS)

POST /room/v1/wid/dispatch ──►
{ from: 'R_laptop',
  to:   'R_phone',
  action: 'open_note',
  input:  {...} }
                                 │
                                 ├─ validate body, auth (subject scope)
                                 │
                                 ├─ look up active socket
                                 │    for installationId 'R_phone'
                                 │
                                 ├─ none found: return immediately
                                 │  HTTP 200
                                 │  { error: { name: 'RecipientOffline', ... } }
                                 │
                                 ├─ found: mint internal id 'i7';
                                 │  hold the HTTP request open;
                                 │  store mapping i7 -> this HTTP request;
                                 │  push WS text frame:
                                 │    { type: 'dispatch_inbound',
                                 │      id: 'i7',
                                 │      from: 'R_laptop',
                                 │      action, input } ──────────────►  handler runs
                                 │                                              │
                                 │                                              ▼
                                 │ ◄── { type: 'dispatch_response',  ◄─── responds
                                 │      id: 'i7',
                                 │      result: { data: {...} } }
                                 │
                                 ├─ look up i7, find the pending HTTP request
                                 │
                                 ├─ complete HTTP response:
                                 │  HTTP 200
                                 │  { data: {...} }
                                 │
◄── HTTP 200 ─────────────────  ◄┘
    { data: {...} }

caller's fetch Promise resolves with Result.
```

Key points:

1. The relay reads its own connection map to answer "is the recipient online?" synchronously. No CRDT round trip, no awareness lookup.
2. The relay stamps `from` from the validated `from` body field. Recipient handlers do not trust caller self-report.
3. There is no caller-visible `id`, no client-side pending map, no `expiresAt` on the wire. The HTTP request lifetime is the deadline; the relay's internal map is bookkeeping the caller never touches.
4. `RecipientOffline` is the only no-delivery outcome. Once `dispatch_inbound` is pushed, the protocol cannot tell whether a later disconnect means the handler ran, is still running, or failed mid-side-effect.
5. Multi-tab caller is invisible to this flow: each fetch is its own request-response, with its own HTTP connection.
6. Multi-tab recipient (same `installationId` on two sockets) is handled by "most-recently-connected wins" at the relay's connection lookup. The non-active recipient socket never sees `dispatch_inbound`.

## 5. Public API

`openCollaboration` absorbs liveness reading (via awareness) and dispatch (via HTTP). It already requires the WebSocket, the identity, and the Yjs sync wiring; dispatch reuses identity and wraps the HTTP endpoint.

```ts
// packages/workspace/src/document/open-collaboration.ts

export function openCollaboration<TActions extends ActionRegistry>(
  ydoc: Y.Doc,
  opts: {
    url:            string
    installationId: string
    actions:        TActions
  },
): {
  installationId: string
  status:         'connecting' | 'live' | 'offline'

  /**
   * Online installs in this workspace, derived from awareness liveness states.
   * Deduplicated by installationId (multi-tab same-install collapses to one entry).
   * Self is excluded.
   */
  devices: {
    list():                                LiveDevice[]
    subscribe(fn: (d: LiveDevice[]) => void): () => void
  }

  /**
   * Fire a dispatch via HTTP POST. The request is sent over the Worker's HTTP
   * endpoint, not the WebSocket. The relay pushes `dispatch_inbound` to the
   * recipient's socket and awaits `dispatch_response` before completing this
   * HTTP request. The caller's `AbortSignal` (or fetch timeout) is the deadline.
   */
  dispatch<TOutput = unknown>(req: DispatchRequest): Promise<Result<TOutput, DispatchError>>

  [Symbol.dispose](): void
}

type LiveDevice = { installationId: string }

type DispatchRequest = {
  to:      string                       // installationId
  action:  string
  input:   unknown
  signal?: AbortSignal                  // dispatch deadline; passed to fetch
}

type DispatchFor<TTargetActions extends ActionRegistry> = <
  TAction extends keyof TTargetActions & string,
>(req: {
    to:      string
    action:  TAction
    input:   InferInput<TTargetActions[TAction]>
    signal?: AbortSignal
  }) => Promise<Result<InferOutput<TTargetActions[TAction]>, DispatchError>>

export const DispatchError = defineErrors({
  RecipientOffline: ({ to }: { to: string }) => ({
    message: `Recipient "${to}" is offline`,
    to,
  }),
  ActionNotFound: ({ action }: { action: string }) => ({
    message: `Target has no handler for "${action}"`,
    action,
  }),
  ActionFailed: ({ action, cause }: { action: string; cause: string }) => ({
    message: `Action "${action}" failed`,
    action,
    cause,
  }),
  Cancelled: ({ reason }: { reason: unknown }) => ({
    message: 'Dispatch was cancelled',
    reason,
  }),
  NetworkFailed: ({ cause }: { cause: unknown }) => ({
    message: 'Dispatch HTTP request failed before reaching the relay',
    cause,
  }),
})
export type DispatchError = InferErrors<typeof DispatchError>
```

`TActions` types this device's inbound action handlers only. It does not type outbound dispatch; the recipient's registry is application-determined and runtime-discovered. Apps that want a typed view of a known target import that registry and use `DispatchFor<TTargetActions>` (caller-asserted, not enforced by the relay).

`DispatchError` is one `wellcrafted/error` union. `RecipientOffline`, `ActionNotFound`, `ActionFailed` arrive in the HTTP response body. `Cancelled` is local (the caller's `AbortSignal` aborted). `NetworkFailed` is local (the HTTP request failed before reaching the relay). All five share the `name` discriminator for exhaustive `switch (error.name)`.

`ActionResponseError` (used in §4.2's `dispatch_response.result`) is the subset of `DispatchError` that crosses the WS push channel: only `ActionNotFound` and `ActionFailed`, because the recipient is the only party that can produce them. `RecipientOffline` is added by the relay before the response leaves the dispatch endpoint; `Cancelled` and `NetworkFailed` are produced locally by the caller's `dispatch()` wrapper. The two type names exist because two different surfaces carry them; the caller-facing union is always `DispatchError`.

There is no `expiresAt` parameter. Callers that want a deadline pass `signal: AbortSignal.timeout(ms)` (or compose with user-cancel via `AbortSignal.any`).

There is no caller-visible pending map, no id correlation. The Promise resolves when the relay's HTTP response arrives or when the caller's signal aborts.

Callers that know the target contract:

```ts
import type { DispatchFor } from '@epicenter/workspace'
import type { TabManagerActions } from '@epicenter/tab-manager/actions'

const dispatchTabManager: DispatchFor<TabManagerActions> = collab.dispatch

await dispatchTabManager({
  to:     tabManagerInstallationId,
  action: 'tabs_close',
  input:  { tabIds: [1, 2] },
  signal: AbortSignal.timeout(30_000),
})
```

The typed view is caller-asserted. The relay does not prove that a given `installationId` implements `TTargetActions`; it routes by `installationId` only.

## 6. Failure modes

| Scenario                                       | Caller observes                                                       |
|------------------------------------------------|-----------------------------------------------------------------------|
| Recipient not online at send time              | HTTP 200 `{ error: { name: 'RecipientOffline' } }`                    |
| Recipient handler throws                       | HTTP 200 `{ error: { name: 'ActionFailed' } }`                        |
| Recipient lacks the action                     | HTTP 200 `{ error: { name: 'ActionNotFound' } }`                      |
| Recipient disconnects mid-handler              | HTTP 200 `{ error: { name: 'RecipientOffline' } }` after relay timeout |
| Caller aborts `signal` before response         | `{ error: { name: 'Cancelled', reason } }` (no HTTP response)         |
| Caller HTTP request fails (network)            | `{ error: { name: 'NetworkFailed', cause } }`                         |
| Caller WS drops mid-dispatch                   | dispatch is independent of WS; HTTP request continues to completion   |
| Same install reopens recipient socket          | next dispatch routes to the newer socket (most-recent-wins)           |

The relay enforces no wire-level deadline. The caller's `signal` (or default fetch timeout) is the only deadline; the relay holds the open HTTP request until the recipient responds or the request is aborted by the caller.

The relay's pending-id map is per-HTTP-request. There is no need to survive reconnects: if the caller's HTTP request is still open, the relay still has the id; if it isn't, the relay forgot the id and any late `dispatch_response` is dropped on arrival.

"Mid-handler disconnect" surfaces as `RecipientOffline` because the relay observes the recipient's socket close and drops the pending id. This is an unknown-outcome result: the handler may have completed its side effect before failing to respond. It is safe to report to the user as no confirmed response. It is not safe to treat as "nothing happened" unless the action itself is idempotent or carries its own dedup key.

## 7. Files affected

Remove:

```
packages/workspace/src/document/rpc.ts                            (entire file)
packages/workspace/src/document/open-collaboration.ts:162-176     (orphan sweep)
packages/workspace/src/document/presence.ts                       (replaced by awareness reads)
```

Update:

```
packages/workspace/src/document/open-collaboration.ts
  • drop attachActionRunner
  • drop YKeyValueLww<Call> usage
  • new signature: { installationId, actions } (no device.displayName)
  • set awareness liveness field on connect: awareness.setLocalStateField('liveness', { installationId })
  • return: installationId, status, devices, dispatch, [Symbol.dispose]
  • devices.list() reads from awareness.getStates(), dedupes by installationId, excludes self
  • dispatch() fires HTTP POST to `${url}/dispatch` with X-Installation-Id header and signal
  • inbound dispatch_inbound text frames invoke the local action runner; response goes back as dispatch_response text frame

packages/workspace/src/daemon/run-handler.ts
  • peerTarget path now calls the new HTTP-backed dispatch; error mapping updated.

packages/workspace/src/daemon/run-errors.ts
  • RemoteCallFailed mapping reflects the new DispatchError variants.

apps/api/src/room.ts
  • install modifyAwarenessUpdate hook for liveness validation
  • on socket close: call removeAwarenessStates for that client's awareness state
  • on socket accept: store installationId in attachment (already done today; keep)
  • inbound text frames: only dispatch_response is accepted; route to internal id map
  • new internal pending-id map: Map<id, { httpRespond: (Result) => void }>
  • deprecate the presence YKeyValueLww keyspace and SERVER_ORIGIN presence writes

apps/api/src/sync-handlers.ts
  • route inbound text frames through the new dispatch_response handler
  • no changes to binary handling

apps/api/src/app.ts
  • new route: POST /rooms/:room/dispatch
    - validate body { from, to, action, input } in one parse pass
    - call into the DO stub: stub.dispatch(body)
    - DO returns Result<unknown, DispatchError>; respond HTTP 200 with body Result
  • subject-scope auth (requireOAuthUser) already covers /rooms/*

packages/sync/...
  • drop the LiveDeviceMessage union from earlier draft revisions; only DispatchInbound and DispatchResponse remain
  • no changes to binary MESSAGE_TYPE; SYNC = 0 and AUTH = 2 stay; AWARENESS = 1 is now actively used by the relay's modifyAwarenessUpdate hook
  • path-based versioning: relay mounts at /room/v1/:workspaceId
```

Add:

```
packages/workspace/src/document/dispatch.ts
  • HTTP-backed dispatch() implementation
  • inbound dispatch_inbound text-frame handler that runs the local action registry
  • internal helper: deriveDispatchUrl(wsUrl) returns the HTTP dispatch URL
```

## 8. Migration

Single coordinated wire-format change. Client and relay deploy together. The new dispatch path is not backward-compatible with the existing CRDT-based dispatch.

Steps:

1. **Land server-side**: awareness validation hook, socket-close awareness clear, new dispatch HTTP endpoint, new dispatch_inbound/response WS handlers, internal pending-id map. New surfaces are inert until clients use them.
2. **Land client-side**: replace `rpc.ts` with `dispatch.ts`; replace `presence.ts` reads with awareness reads; `openCollaboration` returns the new shape.
3. **Cut over** in one release. In-flight CRDT call rows at deploy time are abandoned; they are ephemeral by design.
4. **Delete deprecated paths** (`rpc.ts`, orphan sweep, `presence.ts`, presence keyspace, SERVER_ORIGIN writes) after the cutover release is stable.

The daemon `/run` endpoint signature does not change. Its internal call to `collab.dispatch` swaps from CRDT-row write to HTTP POST. CLI consumers see no difference.

## 9. Risks and mitigations

### Awareness validation pass-through

Risk: A buggy `modifyAwarenessUpdate` either over-rejects (drops valid liveness updates) or under-rejects (lets an installationId mismatch through).

Mitigation: Validation logic is small and isolated: inspect `state.liveness.installationId`, compare to the socket's URL-stamped value, drop the update if it differs. Pin with a test that registers a socket with `installationId=A`, sends awareness with `liveness.installationId=B`, and asserts no peer observes the bad state.

### Awareness heartbeat fan-out at scale

Risk: Awareness renews local state every ~15s per peer. For N=50+ devices in one workspace, broadcast traffic grows as O(N²) per 15s.

Mitigation: For v1 N is small (typically 3-10). Revisit if any deployment crosses ~30 devices in one workspace. Mitigations are known (disable heartbeat for the liveness namespace since the server actively clears on close; or server-managed heartbeat). None are in scope for v1.

### Force-clear race on hibernation wake

Risk: A DO wakes from hibernation with sockets restored. Awareness state in memory is empty until clients re-publish, leaving a window where the picker UI shows no devices.

Mitigation: On hibernation wake, the constructor scans `ctx.getWebSockets()`, reads each attachment's `installationId`, and reconstructs awareness state programmatically (publish `liveness.installationId` for each restored socket). This restores liveness within the same `blockConcurrencyWhile` window before any callback runs. Verify by a hibernate-wake test that asserts `awareness.getStates()` is non-empty for restored sockets immediately after wake.

### Auth revocation while sockets are open

Risk: An OAuth token or Better Auth session is revoked after a WebSocket upgrade, but the already-open socket can still send awareness updates and receive dispatches.

Mitigation: This is v1's auth boundary. The Worker authenticates the upgrade for sync/awareness and each HTTP dispatch request individually. HTTP dispatch from a revoked token is rejected at the Worker. Already-open sockets continue to sync until reconnect or close; immediate WebSocket invalidation on token revocation is a follow-up primitive, not part of dispatch routing.

### Multi-tab same-install recipient selection

Risk: Two tabs of one install both connect; the relay picks the wrong one to deliver `dispatch_inbound` to.

Mitigation: "Most-recently-connected wins." On socket accept, the relay records this socket as the active recipient for its installationId; older sockets remain in the connection map but are not the active recipient. On close of the active socket, the relay falls back to the next-most-recent. Pin with a test: open two tabs same install, dispatch lands on the newer tab only.

### Pending-id map growth under high in-flight dispatch load

Risk: The relay's internal `Map<id, pendingHttpRequest>` grows with every concurrent in-flight dispatch. A misbehaving or adversarial caller could open many slow HTTP requests, each holding a pending entry until the recipient responds or the request times out.

Mitigation: The natural ceiling is Cloudflare's per-DO concurrent-request limit; the map cannot exceed that. Each entry is small (an `id` string plus a Promise resolver closure). Entries clean up on three triggers: recipient sends matching `dispatch_response`, caller aborts and the HTTP request closes, or the platform request timeout fires. Add an upper-bound counter on the map size and log when it crosses a threshold (e.g., 1,000 entries) so adversarial growth is observable. Hard cap is not required for v1 but is a candidate v2 hardening.

### Dispatch deadline runs longer than the platform request timeout

Risk: A caller passes a long timeout (or none) and the recipient's handler runs for longer than the platform's HTTP request timeout (Cloudflare Workers: ~100s for HTTP request lifetime).

Mitigation: Document the practical upper bound. Long-running actions are out of scope for dispatch; they should be modeled as jobs (out-of-scope follow-up). Recommend callers pass an explicit `signal: AbortSignal.timeout(...)` under the platform limit.

### Wire format version

Risk: Mixed-version clients connect to a relay that handles only the new format (or vice versa).

Mitigation: Path-based versioning. The relay mounts at `/room/v1/:workspaceId`; the dispatch endpoint at `/rooms/:wid/dispatch` (under the existing `/rooms` route family). A future v2 protocol gets a separate path. No WebSocket subprotocol negotiation; the URL is the version.

### Self-host story regresses

Risk: Self-hosters cannot drop in a generic y-websocket server anymore.

Mitigation: The custom surface is now smaller than the previous draft (two text frame types + one HTTP endpoint + an awareness-validation hook). A self-host reference implementation is a small shim on top of a stock y-websocket server. Not delivered in this spec; a candidate follow-up.

## 10. Source-of-truth map (after this spec lands)

```
Concern                          Single source of truth
───────────────────────────────  ─────────────────────────────────────────────────
Is a device online?              Awareness state's `liveness.installationId`
                                 sub-field. Server-validated on inbound;
                                 server force-cleared on socket close.
Which installationId sent this?  Server-stamped `from` on `dispatch_inbound`,
                                 copied verbatim from the caller's `from`
                                 body field after subject-scope validation
                                 at the HTTP dispatch endpoint.
                                 `from` is a routing label, not an auth principal.
Dispatch routing                 Most-recently-connected socket for the target
                                 installationId in the DO's connections map.
                                 Synchronous lookup. No CRDT involvement.
Action registry                  Per-device, declared at openCollaboration time.
                                 Not in the protocol.
Dispatch error taxonomy          DispatchError variants in
                                 packages/workspace/src/document/dispatch.ts:
                                 RecipientOffline + ActionNotFound + ActionFailed
                                 (remote) + Cancelled + NetworkFailed (local).
Identity                         installationId, stable per install,
                                 claimed at WS upgrade URL,
                                 validated in awareness via modifyAwarenessUpdate,
                                 echoed on HTTP dispatch as the body `from` field.
```

## 11. Out of scope

Deliberately not in this spec. Each is a candidate for a follow-up.

- Offline-deferred dispatch (queueing for not-yet-connected devices).
- Durable jobs (claim/lease/retry/dedup primitives) for long-running actions.
- Anycast or capability-based addressing.
- User-level addressing (`{ to: { user: U } }`); a helper if/when needed.
- A non-Cloudflare reference relay implementation.
- Cross-workspace dispatch.
- Per-action ACL hooks beyond `ActionNotFound`.
- Cryptographic per-install identity proof for `installationId`.
- Immediate socket invalidation on OAuth token or session revocation.
- Disabling the awareness heartbeat for the liveness namespace at scale.
- Schema introspection on actions (meta-action like `describe_actions`).

## 12. Verification at completion

- `packages/workspace/src/document/rpc.ts` is gone.
- `packages/workspace/src/document/presence.ts` is gone.
- Orphan sweep block in `open-collaboration.ts` is gone.
- A dispatch in a workspace with N=5 devices produces exactly one outbound socket write at the relay (not N-1 fan-out).
- The relay's SQLite update log no longer grows from dispatch traffic.
- Chrome extension service worker is not woken by dispatches addressed to other devices.
- A fresh deploy passes the existing daemon `/run` end-to-end tests with the new dispatch underneath.
- `collab.devices.list()` reflects connect/disconnect events within one RTT of socket open/close (server force-clears awareness on close; no 30s window).
- Multi-tab same-install: exactly one tab receives `dispatch_inbound` (newest wins).
- Multi-tab same-install: a `dispatch()` originated by any tab resolves with the recipient's response; the caller side has no multi-tab routing problem because HTTP is request-response.
- Durable Object hibernation and wake preserves liveness: `awareness.getStates()` is non-empty for every restored socket immediately after wake.
- Awareness `modifyAwarenessUpdate` rejects a `liveness.installationId` that differs from the socket's URL-stamped value: peers never observe the bad state.
- An HTTP `POST /dispatch` with a missing or empty `from`, `to`, `action`, or `input` body field returns HTTP 400.
- HTTP dispatch to an offline recipient returns HTTP 200 with `{ error: { name: 'RecipientOffline', to } }`.
- HTTP dispatch where the recipient disconnects mid-handler returns HTTP 200 with `RecipientOffline` after the relay observes the close.
- Caller aborting the `signal` rejects the dispatch Promise with `Cancelled` and the relay drops its pending id (verified by no late `dispatch_response` being matched).
