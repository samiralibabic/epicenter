# Collapse HTTP Dispatch onto the Sync Socket

**Date**: 2026-05-22
**Status**: Implemented
**Author**: AI-assisted
**Branch**: revert/cloud-workspace-sync-layer (spec + implementation)

> **Implementation note.** The caller side (`open-collaboration.ts`,
> `dispatch.ts`) was already in place when this spec was executed, so the
> work that landed was the wire types, the relay frame handlers, the HTTP
> route/RPC deletion, and the test coverage. One divergence from the plan
> below: the locally-produced error variant kept its existing name
> `NetworkFailed` (its JSDoc was repurposed to the socket meaning) rather
> than being renamed to `Disconnected`; renaming a live variant across its
> `run-handler.ts` / `run.ts` consumers was not worth the churn. The code
> is the source of truth where this spec and it disagree.

## Overview

Live-device dispatch (`collab.dispatch(...)`) is the only one of a room's wire
surfaces that does not ride the WebSocket. Binary sync frames and text presence
frames ride the authenticated socket opened by `auth.openWebSocket`. Dispatch
instead does an HTTP `POST` to `/rooms/:room/dispatch` using the global `fetch`,
with no `Authorization` header. The route is behind `requireOAuthUser`, so on a
browser or extension client every dispatch returns 401.

This spec deletes the HTTP dispatch transport. The caller side of dispatch
becomes two text frames on the socket the caller already owns: `dispatch_request`
up and `dispatch_result` down. The recipient side (`dispatch_inbound` /
`dispatch_response`) is unchanged. After this change a `Collaboration` owns
exactly one wire (the authenticated WebSocket) and one transport capability in
its config (`openWebSocket`).

**One sentence**: `dispatch` is a method on `Collaboration`, every
`Collaboration` already owns one authenticated WebSocket to its room, so dispatch
rides that socket as a text-frame request/response correlated by a caller-minted
id, and the HTTP route, the `Room.dispatch` RPC, and `dispatchOverHttp` are
deleted.

## Motivation

### The bug

```
binary WS frames  -- auth.openWebSocket --> /rooms/:room            authed
text WS frames    -- auth.openWebSocket --> /rooms/:room            authed
HTTP dispatch     -- global fetch()     --> /rooms/:room/dispatch    401
```

`packages/workspace/src/document/dispatch.ts` calls bare `fetch`. `app.ts` mounts
`/rooms/*` under `requireOAuthUser`. `OpenCollaborationConfig` accepts an
auth-bound `openWebSocket` but has no slot for an auth-bound `fetch`. The HTTP
transport was never wired to auth.

### Why delete the transport instead of authenticating it

The patch (add `fetch?: AuthFetch`, thread `auth.fetch` to the HTTP call, update
call sites) works but keeps two transports, two auth bindings, two error
surfaces, and leaves the auth-bug class alive: a new app can still forget
`auth.fetch`.

The deeper fact: `dispatch` is a method on `Collaboration`. The standalone
`dispatch` function and `deriveDispatchUrl` are imported only by
`open-collaboration.ts` and are not re-exported from the package index. Every
caller of dispatch is a `Collaboration`, and every `Collaboration` already holds
an open, authenticated WebSocket to that exact room. The HTTP call is redundant
with a socket the caller already has.

## Honest complexity accounting

This is not primarily a line-count win. Raw tally:

```
DELETED                                              ~lines
  dispatchOverHttp() HTTP half (fetch, ok, parse)        40
  /rooms/:room/dispatch route + JSDoc + sValidator       45
  Room.dispatch() RPC method + JSDoc                     58
  DispatchRpcRequest type + JSDoc                        12
  deriveDispatchUrl()                                     5
                                                     ───────
                                                       ~160

RELOCATED, not deleted                               ~lines
  dispatchOverHttp() result interpretation               45  -> interpretDispatchResult
  Room.dispatch() routing body (pickRecipient, push)     25  -> handleDispatchRequest

ADDED                                                ~lines
  DispatchRequestFrame + DispatchResultFrame types        14
  relay: dispatch_request handler + dual-role close        30
  client: pending map + ceiling + sweeps + result case    55
                                                     ───────
                                                        ~99
```

Net is roughly **-60 lines**. The real win is structural:

```
                       TODAY          AFTER
transports               2              1
auth bindings            1 (+1 bug)     1
error surfaces           2              1
dispatch mental models   2              1
config capabilities      openWebSocket  openWebSocket (+ fetch slot never added)
auth-bug class           present        impossible
```

The two new frame types are the cheapest kind of addition: the text-frame
mechanism (a `type` discriminant, `handleTextFrame` switching on it,
`onTextFrame` routing) already exists for `dispatch_inbound`,
`dispatch_response`, and `presence`. The relay already runs the pending-by-id
correlation pattern; this change makes the caller side use the same pattern
instead of HTTP.

## Hibernation: the one real hazard, and the fix

The Room DO uses Cloudflare's WebSocket Hibernation API. A hibernatable DO with
open sockets but no running JS and no pending IO can be **evicted from memory**.
On eviction the in-memory `pendingDispatches` map and every in-flight
`setTimeout` are lost; the constructor re-runs on the next event and rebuilds
`connections` from `getWebSockets()`, but `pendingDispatches` has no source to
rebuild from.

Today's HTTP dispatch is hibernation-immune by accident: the Worker holds an
in-flight HTTP request, so the DO has pending IO and stays resident until the
RPC promise resolves. Frame dispatch has no such anchor. Between
`dispatch_inbound` being delivered and `dispatch_response` arriving the DO can
be fully idle. If it hibernates there, the `dispatch_response` wakes a fresh DO
with an empty `pendingDispatches`, the lookup misses, and the result is silently
dropped.

**Fix**: the client side carries a mandatory deadline. `dispatch()` always arms
a `DISPATCH_RESPONSE_CEILING_MS` timer; if no `dispatch_result` arrives, the
promise settles `Disconnected`. Every dispatch is therefore guaranteed to settle
even when the relay loses the pending entry to eviction. The relay's own timeout
and the client disconnect sweep become fast-path optimizations, not correctness
requirements. The ceiling sits above the relay's internal timeout so the relay's
accurate `RecipientOffline` wins the race in the normal (non-hibernation) case.

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Dispatch transport | 2 coherence | The sync WebSocket; delete HTTP | Caller always owns an authed socket; HTTP was redundant |
| Caller -> relay frame | 2 coherence | New `dispatch_request` text frame | Mirrors the existing `dispatch_inbound` shape |
| Relay -> caller frame | 2 coherence | New `dispatch_result` text frame | Structurally identical to today's HTTP body |
| Correlation id | 2 coherence | Caller-minted (`crypto.randomUUID()`) | Caller keys its pending map before sending; no id round-trip |
| Client deadline | 2 coherence | Mandatory ceiling timer, settles `Disconnected` | Guarantees settlement across DO hibernation |
| Disconnect / dispose sweep | 3 taste | Fast-path: settle in-flight dispatches `Disconnected` | UX parity with HTTP fail-fast; ceiling is the real backstop |
| Malformed `dispatch_request` | 2 coherence | Drop the frame silently; do NOT close the socket | One bad dispatch frame must not tear down sync + presence |
| `Room.dispatch` RPC + `DispatchRpcRequest` | 2 coherence | Delete | No HTTP route forwards to it |
| `/rooms/:room/dispatch` route | 2 coherence | Delete | Dispatch never touches the Worker now |
| `NetworkFailed` variant | 2 coherence | Rename to `Disconnected({ detail })` | "HTTP request failed" is gone; the honest meaning is "the call did not complete over the sync connection" |
| Relay `DISPATCH_INTERNAL_TIMEOUT_MS` | keep | Keep; rewrite JSDoc | Still bounds the relay's pending map for long-lived sockets |
| DO-instance telemetry on dispatch | 1 evidence | Dropped | The WebSocket upgrade already upserts; dispatch needs a live socket, so the upgrade ran first |
| Wire migration | 1 evidence | Clean break, no compat | No production clients on the old protocol |

## Architecture

### The four-frame protocol

All four frames are text frames on the one authenticated WebSocket. `id` is
minted by the caller and echoed unchanged by the relay.

```
  CALLER                       RELAY (Room DO)                 RECIPIENT
    |                              |                               |
    |  dispatch_request            |                               |
    |  { id, to, action, input }   |                               |
    | ---------------------------> |  pickRecipient(to)            |
    |                              |  miss -> dispatch_result back  |
    |                              |  hit  -> store pending[id]     |
    |                              |  dispatch_inbound              |
    |                              |  { id, action, input }         |
    |                              | ----------------------------> | runs action
    |                              |  dispatch_response             |
    |                              |  { id, result }                |
    |                              | <---------------------------- |
    |  dispatch_result             |  look up pending[id]           |
    |  { id, result }              |                               |
    | <--------------------------- |                               |
```

`dispatch_inbound` and `dispatch_response` are unchanged. `dispatch_request`
replaces the HTTP `POST`; `dispatch_result` replaces the HTTP response body.
`DispatchResultFrame.result` has the exact shape of today's HTTP body.

### Wire protocol types (`dispatch-protocol.ts`)

```ts
/** Caller -> relay: route this call to installation `to`, correlated by `id`. */
export type DispatchRequestFrame = {
	type: 'dispatch_request';
	id: string;
	to: string;
	action: string;
	input: unknown;
};

/**
 * Relay -> caller: the dispatch outcome, correlated by `id`. `result` is typed
 * `Result<unknown, unknown>`: the relay forwards the recipient's reply opaquely
 * and never inspects the error side. The caller validates it.
 */
export type DispatchResultFrame = {
	type: 'dispatch_result';
	id: string;
	result: Result<unknown, unknown>;
};
```

### Relay (`room.ts`)

`pendingDispatches` becomes a plain routing table (no captured Promise):

```ts
private pendingDispatches = new Map<string, {
	callerWs: WebSocket;
	recipientWs: WebSocket;
	timeout: ReturnType<typeof setTimeout>;
}>();
```

`handleTextFrame` switches on `type`: `dispatch_request` and `dispatch_response`
are both valid; unparseable JSON or an unknown `type` still closes `4400`. A
recognized `dispatch_request` with malformed fields is dropped silently (the
caller's ceiling settles it). `handleDispatchRequest`:

```ts
const { id, to, action, input } = frame;
if (typeof id !== 'string' || typeof to !== 'string'
	|| typeof action !== 'string') return;       // drop; do not close the socket
const recipientWs = this.pickRecipient(to);
if (!recipientWs) {
	this.sendDispatchResult(callerWs, id, recipientOffline(to));
	return;
}
const timeout = setTimeout(() => {
	const pending = this.pendingDispatches.get(id);
	if (!pending) return;
	this.pendingDispatches.delete(id);
	this.sendDispatchResult(pending.callerWs, id, recipientOffline(to));
}, DISPATCH_INTERNAL_TIMEOUT_MS);
this.pendingDispatches.set(id, { callerWs, recipientWs, timeout });
try {
	recipientWs.send(JSON.stringify(
		{ type: 'dispatch_inbound', id, action, input } satisfies DispatchInboundFrame));
} catch {
	clearTimeout(timeout);
	this.pendingDispatches.delete(id);
	this.sendDispatchResult(callerWs, id, recipientOffline(to));
}
```

The `dispatch_response` branch keeps its parse and `isDispatchResult` checks;
its tail forwards a `dispatch_result` frame to the stored `callerWs` instead of
resolving an RPC promise. `webSocketClose` handles the closed socket in either
role: `recipientWs === ws` -> send `RecipientOffline` to `callerWs`;
`callerWs === ws` -> drop the entry (nobody to notify). Both clear the timeout.

`Room.dispatch()` and `DispatchRpcRequest` are deleted.

Invariant worth stating in the code: `dispatch_result` is always routed to the
captured `callerWs` reference, never re-resolved by `installationId`. A stale
result can only hit a dead socket, never a reconnected sibling.

### Client (`dispatch.ts` + `open-collaboration.ts`)

`dispatch.ts` keeps `DispatchError`, `DispatchRequest`, `asDispatchWireError`,
`ActionInput` / `ActionOutput` / `TypedDispatch` / `typedDispatch`,
`runInboundDispatch`, `LiveDevice`. It deletes `dispatch()` (HTTP) and
`deriveDispatchUrl()`. It gains `interpretDispatchResult(body): Result<unknown,
DispatchError>` (the `{ data, error }` guard + `asDispatchWireError` + the
variant switch, relocated from the old HTTP function). `NetworkFailed` becomes:

```ts
Disconnected: ({ detail }: { detail: string }) => ({
	message: `Dispatch failed: ${detail}`,
	detail,
}),
```

`open-collaboration.ts` owns a caller-side pending map and the new `dispatch()`:

```ts
const pendingDispatches =
	new Map<string, (result: Result<unknown, DispatchError>) => void>();

dispatch(req: DispatchRequest): Promise<Result<unknown, DispatchError>> {
	if (req.signal?.aborted) {
		return Promise.resolve(
			DispatchError.Cancelled({ reason: req.signal.reason }));
	}
	if (supervisor.status.phase !== 'connected') {
		return Promise.resolve(
			DispatchError.Disconnected({ detail: 'not connected' }));
	}
	const id = crypto.randomUUID();
	return new Promise((resolve) => {
		let settle: (r: Result<unknown, DispatchError>) => void;
		const onAbort = () =>
			settle(DispatchError.Cancelled({ reason: req.signal!.reason }));
		const ceiling = setTimeout(
			() => settle(DispatchError.Disconnected({ detail: 'no response from the relay' })),
			DISPATCH_RESPONSE_CEILING_MS);
		settle = (result) => {
			if (!pendingDispatches.delete(id)) return;   // idempotent
			clearTimeout(ceiling);
			req.signal?.removeEventListener('abort', onAbort);
			resolve(result);
		};
		pendingDispatches.set(id, settle);
		req.signal?.addEventListener('abort', onAbort, { once: true });
		supervisor.send(JSON.stringify({
			type: 'dispatch_request', id,
			to: req.to, action: req.action, input: req.input,
		} satisfies DispatchRequestFrame));
	});
}
```

Two more wirings in `open-collaboration.ts`:

1. `onTextFrame` gains a `dispatch_result` case. Order: presence, then
   `dispatch_result`, then fall through to `runInboundDispatch`. The handler
   parses the frame, looks up the pending settle by `id`, and settles with
   `interpretDispatchResult(frame.result)`.

2. Sweeps. On any supervisor status change away from `connected`, and on
   `supervisor.whenDisposed`, settle every in-flight dispatch `Disconnected`
   (`detail: 'connection lost'`). The dispose sweep is needed because the
   supervisor clears its status listeners during teardown, so the
   status-change sweep would not fire for dispatches in flight at dispose.
   Iterate a snapshot (`[...pendingDispatches.values()]`) since `settle`
   mutates the map.

## Edge Cases

- **DO hibernates mid-dispatch.** `dispatch_result` is lost; the client ceiling
  settles `Disconnected` after `DISPATCH_RESPONSE_CEILING_MS`. See above.
- **Caller dispatches while offline.** `dispatch()` returns `Disconnected`
  immediately. Matches today's HTTP fail-fast.
- **Caller socket drops after sending.** The status-change sweep settles the
  client entry `Disconnected`; the relay's `webSocketClose` drops the entry.
- **Recipient never replies, both sockets stay open.** The relay's
  `DISPATCH_INTERNAL_TIMEOUT_MS` fires `RecipientOffline`; if the relay
  hibernated, the client ceiling fires instead.
- **Recipient socket drops mid-handler.** `webSocketClose` sends
  `RecipientOffline` to the caller.
- **Late `dispatch_response`.** The relay's map no longer has the id; lookup
  misses, returns. The client `settle` is idempotent.
- **Malformed `dispatch_request`.** Dropped silently by the relay; the caller's
  ceiling settles it. The socket is not closed.

## Implementation Plan

Three commits. Build and tests stay green after each.

### Commit 1: add the frame protocol (additive)

- [ ] Add `DispatchRequestFrame`, `DispatchResultFrame` to `dispatch-protocol.ts`.
- [ ] `room.ts`: rewrite `pendingDispatches` to the routing-table shape; split
  `handleTextFrame` into `handleDispatchRequest` + `handleDispatchResponse`; add
  `sendDispatchResult`; make `webSocketClose` cover both socket roles. Keep
  `Room.dispatch` and `DispatchRpcRequest` so the build stays green.
- [ ] Typecheck `@epicenter/api` and `@epicenter/workspace`.

### Commit 2: switch the client to frames

- [ ] `dispatch.ts`: delete `dispatch()` (HTTP) and `deriveDispatchUrl()`; add
  `interpretDispatchResult`; rename `NetworkFailed` -> `Disconnected({ detail })`.
- [ ] `open-collaboration.ts`: add `DISPATCH_RESPONSE_CEILING_MS`, the pending
  map, the new `dispatch()`, the `dispatch_result` case in `onTextFrame`, and
  the status-change + dispose sweeps. Remove the `dispatchUrl` / HTTP wiring.
- [ ] Update the two `DispatchError` switch consumers: `daemon/run-handler.ts`
  and `cli/commands/run.ts` (`case 'NetworkFailed'` -> `case 'Disconnected'`;
  the `cli` body no longer reads a `cause` field). The `satisfies never`
  defaults make the rename self-checking.
- [ ] Update doc comments: `open-collaboration.ts` header, `dispatch.ts` header
  and `DispatchError` JSDoc, `dispatch-protocol.ts` frame-flow comment,
  `index.ts` ("HTTP-backed dispatch" line).
- [ ] Rewrite `dispatch.test.ts`: drop the `deriveDispatchUrl` and HTTP-`fetch`
  tests; test the frame-based `dispatch` against a stub socket (asserts
  `dispatch_request` is sent, a fed `dispatch_result` settles the promise);
  cover `Disconnected` (offline), `Cancelled` (abort), the ceiling, and the
  disconnect sweep. Keep the `runInboundDispatch` and `typedDispatch` tests.
- [ ] Typecheck the monorepo; run `@epicenter/workspace` and CLI suites.

### Commit 3: delete the HTTP dispatch route and RPC

- [ ] `app.ts`: delete the `/rooms/:room/dispatch` route block and the
  `DispatchRpcRequest` import.
- [ ] `room.ts`: delete `Room.dispatch()` and `DispatchRpcRequest`; update the
  `room.ts` header and `DISPATCH_INTERNAL_TIMEOUT_MS` JSDoc (no HTTP request,
  no ~100s ceiling; it bounds the pending map only).
- [ ] Add dispatch integration coverage to `app.rooms.test.ts` (it has none
  today): drive the four-frame round trip over test sockets, including
  `RecipientOffline` with no live recipient.
- [ ] Typecheck `@epicenter/api`; run its suite.

## Open Questions

1. **`DISPATCH_RESPONSE_CEILING_MS` value.** Must exceed the relay's
   `DISPATCH_INTERNAL_TIMEOUT_MS` (60s) so the relay's accurate `RecipientOffline`
   wins the normal-case race. Recommendation: 90_000.

2. **Should the relay reject a duplicate in-flight `id`?** Not required for
   correctness (single-subject room, UUID source). Recommendation: skip.

3. **Keep `DISPATCH_INTERNAL_TIMEOUT_MS`?** Yes: it bounds the relay's pending
   map for long-lived sockets. It is no longer a correctness backstop (the
   client ceiling is); rewrite its JSDoc to say so.

## Success Criteria

- [ ] A browser/extension client dispatches with no HTTP request and no 401.
- [ ] `OpenCollaborationConfig` has exactly one transport capability,
  `openWebSocket`; no `fetch` field was added.
- [ ] `/rooms/:room/dispatch`, `Room.dispatch`, `DispatchRpcRequest`, the
  `dispatch()` HTTP function, and `deriveDispatchUrl` are deleted.
- [ ] `DispatchError` has `Disconnected` and no `NetworkFailed`; both switch
  consumers compile.
- [ ] Every dispatch settles: on result, on `Cancelled`, on a disconnect/dispose
  sweep, or on the ceiling. No path hangs, including DO hibernation.
- [ ] `@epicenter/workspace` and `@epicenter/api` typecheck and their dispatch
  and room test suites pass; CLI peer-dispatch tests pass.

## References

- `packages/workspace/src/document/dispatch.ts` - delete `dispatch()` HTTP fn + `deriveDispatchUrl`; add `interpretDispatchResult`; rename `NetworkFailed`
- `packages/workspace/src/document/dispatch-protocol.ts` - add the two frame types
- `packages/workspace/src/document/open-collaboration.ts` - new `dispatch()`, pending map, ceiling, `onTextFrame` case, sweeps
- `packages/workspace/src/document/internal/sync-supervisor.ts` - `send`, `status`, `onStatusChange`, `whenDisposed` are the surfaces the client dispatch uses
- `apps/api/src/room.ts` - `handleTextFrame` split, `pendingDispatches`, `webSocketClose`, delete `Room.dispatch`
- `apps/api/src/app.ts` - delete the `/rooms/:room/dispatch` route (~line 605) and the `DispatchRpcRequest` import (~line 44)
- `packages/workspace/src/daemon/run-handler.ts`, `packages/cli/src/commands/run.ts` - `NetworkFailed` -> `Disconnected` switch updates
- `packages/workspace/src/document/dispatch.test.ts`, `apps/api/src/app.rooms.test.ts` - tests to rewrite / add
- `specs/20260522T160000-revert-cloud-workspace-sync-layer.md` - the predecessor revert; established the subject-owned model and the no-production-users clean-break basis
