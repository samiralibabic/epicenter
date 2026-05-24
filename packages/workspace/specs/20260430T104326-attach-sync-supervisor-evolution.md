# `attachSync` Supervisor Evolution: State Machine, Cross-Tab Sync, Goodbye Frame, Internal Events

**Date**: 2026-04-30
**Status**: Draft
**Author**: AI-assisted
**Branch**: supervisor-abortsignal (current) -> supervisor-v2 (proposed)

## Overview

`attachSync` should own sync topology: callers ask it to sync a document to a URL, and it attaches the socket, cross-tab transport, leader election, presence wiring, lifecycle supervision, and teardown semantics needed to make that true. Three product changes and one internal testing primitive support that thesis: replace the implicit supervisor with an explicit reducer plus effects model (A1), make browser cross-tab sync automatic through Web Locks plus BroadcastChannel (A2), introduce a tiny `MESSAGE_TYPE.GOODBYE` wire frame for graceful disconnects (A4), and keep the async event bus internal until a real public consumer appears (A3). The recommended landing order is A4 -> A1 -> A2, with A3 implemented only as private test/debug infrastructure during A1.

## Grand Vision

The public contract should be boring:

```typescript
const sync = attachSync(doc, {
  url,
  waitFor: idb,
  loadToken,
});
```

That line means: keep this document synced to that room. It should not mean "the app remembered to attach BroadcastChannel first," "the app knows whether this tab owns the WebSocket," or "the caller understands the difference between local document fanout and remote transport."

`attachSync` owns the topology below that line:

```
caller intent
  │
  ▼
attachSync(doc, { url, waitFor, loadToken })
  │
  ├── waits for local persistence before first remote handshake
  ├── supervises direct WebSocket transport when direct is the right topology
  ├── elects one browser leader per document when cross-tab sharing is available
  ├── fans document updates across tabs without caller wiring
  ├── carries presence and RPC over the one active remote transport
  └── exposes one lifecycle/status surface to the app
```

This is the source-of-truth rule: app code owns product intent; `attachSync` owns sync mechanics. If a proposed change makes app code pass another topology flag, wire another transport, or switch on internal wire events, it is probably moving in the wrong direction.

## Worth-It Gates

A1 and A2 are worth doing only if they pass these gates:

| Gate | A1 State Machine | A2 Cross-Tab Sync |
|---|---|---|
| Deletes caller decisions | No, not directly | Yes, removes explicit browser `attachBroadcastChannel` for synced docs |
| Creates a source of truth | Yes, lifecycle state moves into one reducer | Yes, one tab owns the remote transport for a doc |
| Makes failure handling clearer | Yes, auth failure, reconnect, stop, and destroy become explicit transitions | Yes, followers mirror leader status instead of each tab inventing status |
| Adds public surface area | No, if `SyncAttachment` stays stable | One escape hatch only: `crossTab: 'direct'` |
| Reduces code overall | Maybe not immediately | Should reduce app wiring and duplicate sockets; internal code grows |
| Worth doing alone | Maybe | Yes |
| Worth doing before the other | Yes, if A2 follows | No, A2 without A1 risks adding lifecycle branches to the current closure |

The hard standard: after A2, browser workspace setup should lose code. If the migration leaves callers with both `attachBroadcastChannel(doc.ydoc)` and `attachSync(..., { leaderElection: true })`, the design failed.

Stop conditions:

1. Stop A1 if the extracted reducer makes `attach-sync.ts` longer and does not remove the reconnect-tail race, permanent failure flag, or scattered lifecycle mutation.
2. Stop A2 if browser callers still need to wire `attachBroadcastChannel` for synced docs.
3. Stop A2 if followers expose a meaningfully different `SyncAttachment` contract than leaders.
4. Stop A4 if it becomes an acknowledged shutdown protocol. GOODBYE is a small hint, not a correctness dependency.
5. Stop A3 as a public API until a real app or CLI needs event streaming.

## What To Hunt Down

Before implementing A1 or A2, verify these spots:

1. Browser workspace factories that call both `attachBroadcastChannel(doc.ydoc)` and `attachSync(...)`. These are the call sites A2 must simplify.
2. Content-doc factories that call `attachSync(...)` without `attachBroadcastChannel(...)`. Decide whether automatic cross-tab sync applies there too.
3. Node daemon factories that pass `webSocketImpl`. They should stay direct by default because Web Locks and BroadcastChannel are browser topology.
4. Tests that stub `globalThis.WebSocket`. A1 should preserve that test strategy unless a transport injection point already exists.
5. Presence and RPC methods. Followers must keep `peers()`, `find()`, `observe()`, and `rpc()` behavior compatible enough that callers cannot tell which tab owns the socket.
6. Existing sync status UI. `connected`, `failed`, and `hasLocalChanges` should mean the same thing before and after cross-tab sharing.

## Motivation

### Current State

After the `AbortController` refactor, `attachSync` is structurally clean but still composed of mutable state scattered across the closure:

```typescript
let permanentFailure: SyncFailedReason | null = null;
const masterController = new AbortController();
let cycleController: AbortController = childOf(masterController.signal);
let websocket: WebSocket | null = null;
let loopPromise: Promise<void> | null = null;
let localVersion = 0;
let ackedVersion = 0;
let syncStatusTimer: ReturnType<typeof setTimeout> | null = null;
const pendingRequests = new Map<...>();
let nextRequestId = 0;
const status = createStatusEmitter<SyncStatus>({ phase: 'offline' });
```

(`packages/workspace/src/document/attach-sync.ts:468-551`)

The supervisor (`runLoop`) drives transitions through these by mutating in line, then nudging `status.set(...)` to broadcast the externally-visible phase. There are at least three implicit invariants the reader must hold in their head:

- `websocket !== null` iff the loop is in `attemptConnection` past the `ws.onopen` line and before `ws.onclose`.
- `loopPromise !== null` iff the supervisor is running a cycle.
- `permanentFailure !== null` blocks `runLoop`'s `while`, but `reconnect()` clears it back to `null` to allow recovery.

This creates problems:

1. **Implicit state machine, hard to reason about.** Six observable states (offline, connecting, handshaking, connected, backing_off, failed) and ~10 events (start, stop, token result, ws open/close/error, handshake complete, backoff done, status tick) are tangled into a single async loop. The "reconnect-during-supervisor-tail" race at `attach-sync.ts:944-955` is a comment-heavy patch over a structural gap. New contributors cannot easily answer "what happens if X arrives in state Y."
2. **No internal event stream.** Tests and debug tooling that need ordered transitions, wire bytes, peer joins/leaves, or RPC observations get one callback per concern (`onStatusChange`, `observe`). An integration test that asserts a sequence ("connecting -> connected -> hasLocalChanges:true -> hasLocalChanges:false") needs a custom queue. That is a real internal smell, but it does not yet justify a public `sync.events()` API.
3. **Server cannot tell graceful from network drop.** Both `pause()` and `doc.destroy()` call `ws.close()` which the server sees as code 1006 (abnormal close), indistinguishable from a TCP drop. The DO has to wait out the awareness 30s TTL and reply `RpcError.PeerOffline` to in-flight RPCs that could have been answered with "we know they intentionally left."
4. **N tabs = N WebSockets to the same DO.** A user with 12 workspace tabs opens 12 sockets, runs 12 ping loops, and shows up in awareness 12 times under the same `deviceId`. Same is true on devices with multiple PWA windows. CRDTs make this *correct*, just wasteful.

### Code Smell Test

The smell test is whether the caller has to know about sync topology. If a caller has to wire persistence, cross-tab broadcast, the socket, and a future leader-election flag in the right order, the abstraction is leaking.

Current browser workspace setup:

```typescript
const idb = attachIndexedDb(doc.ydoc);
attachBroadcastChannel(doc.ydoc);

const sync = attachSync(doc, {
  url: websocketUrl(`${APP_URLS.API}/workspaces/${doc.ydoc.guid}`),
  waitFor: idb,
  device,
  loadToken: async () => auth.loadToken(),
});
```

Bad redesigned API:

```typescript
const idb = attachIndexedDb(doc.ydoc);
attachBroadcastChannel(doc.ydoc);

const sync = attachSync(doc, {
  url,
  waitFor: idb,
  device,
  loadToken,
  leaderElection: true,
});
```

This is worse than today. The caller now knows two implementation details: same-tab docs need BroadcastChannel and browser tabs need leader election. The fact that those two mechanisms must cooperate is exactly what `attachSync` should hide.

Target browser call site:

```typescript
const idb = attachIndexedDb(doc.ydoc);

const sync = attachSync(doc, {
  url,
  waitFor: idb,
  device,
  loadToken,
});
```

Direct transport remains available only for unusual cases:

```typescript
const sync = attachSync(doc, {
  url,
  waitFor: idb,
  crossTab: 'direct',
});
```

Internal smell before A1:

```typescript
let permanentFailure: SyncFailedReason | null = null;
let websocket: WebSocket | null = null;
let loopPromise: Promise<void> | null = null;

async function runLoop(signal: AbortSignal) {
  while (!signal.aborted && !permanentFailure) {
    status.set({ phase: 'connecting', retries: backoff.retries });
    const result = await attemptConnection(token, signal);
    if (result === 'connected') backoff.reset();
    await backoff.sleep(signal);
  }
}
```

Better shape after A1:

```typescript
const { state, effects } = step(current, event);
current = state;
for (const effect of effects) runEffect(effect);
```

A1 earns its keep because A2 adds another mode. Without an explicit state machine, the leader/follower split will pile more lifecycle branches onto the existing supervisor closure.

Public API smell for A3:

```typescript
for await (const event of sync.events({ types: ['wire-in', 'rpc-request'] })) {
  debug(event);
}
```

That looks useful, but it exposes wire vocabulary as public API. Once shipped, `wire-in`, `rpc-request`, and payload shapes become compatibility promises. Keep this private first:

```typescript
const events = createSyncEventBus();
runtime.onEvent((event) => events.emit(event));
```

### Desired State

```typescript
// A1: explicit FSM, no hidden mutation
const machine = createSupervisorMachine({ url, loadToken, ... });
machine.send({ type: 'START' });

// A3: internal event stream for tests and debug tooling
const events = createSyncEventBus();
events.emit({ type: 'status', status: sync.status });

// A4: graceful disconnect
sync.pause();   // sends GOODBYE(reason: 'user_request') before ws.close()

// A2: browser cross-tab sharing is automatic
attachSync(doc, { url, waitFor: idb });
// First browser tab acquires Web Lock + WebSocket; others piggyback via BC.
// Node, workers, and unsupported browsers fall back to a direct WebSocket.
```

## Research Findings

### Comparison: y-websocket reference vs current `attachSync`

Grounded against `yjs/y-websocket` and `yjs/y-protocols` via deepwiki.

| Concern | `y-websocket` (upstream) | Current `attachSync` | Post-spec target |
|---|---|---|---|
| Reconnect | `setTimeout` recursion + `shouldConnect` flag | `AbortController` hierarchy | FSM with explicit `START`/`STOP` events |
| Backoff | 100ms x 2^n, cap 2.5s, no jitter | 500ms x 2^n, cap 30s, jitter 0.5-1.0x | unchanged (already strong) |
| Liveness | 30s no-message threshold, no active ping | 90s threshold + 60s `'ping'` text (CF auto-pongs) | unchanged |
| Status API | events: `status`, `sync`, `connection-close` | typed `SyncStatus` discriminated union | unchanged publicly; internal event bus for tests/debug |
| `whenSynced` | none | `whenConnected` Promise (resolves on STEP2/UPDATE, rejects on dispose/4401) | unchanged |
| Persistence gate | none | `waitFor: idb.whenLoaded` | unchanged |
| Permanent failure | none, retries forever | close 4401 -> terminal `failed` phase | becomes a state, not a flag (A1) |
| Auth | URL params or in-protocol AUTH frame | `Sec-WebSocket-Protocol: bearer.<token>` | unchanged |
| Graceful disconnect | none | none | new `MESSAGE_TYPE.GOODBYE` (A4) |
| Cross-tab BC | built into provider | separate `attachBroadcastChannel` | automatic browser cross-tab sharing inside `attachSync` (A2) |

**Key finding**: `attachSync` is already significantly more sophisticated than `y-websocket` on every axis. The pieces missing are not on the upstream roadmap (XState-style machines, leader election, goodbye frames are all custom-territory). No upstream pattern to inherit; we are designing.

### State machine libraries vs hand-rolled

| Option | Pros | Cons |
|---|---|---|
| XState | Visualizable, well-known mental model, dev tools | New runtime dep (~25KB min+gz), team has no XState elsewhere, bundle cost for browser apps |
| Zag.js | Smaller than XState, framework-agnostic | Same "new dep" issue |
| Hand-rolled reducer | Zero deps, matches codebase style | We write all the test scaffolding ourselves |

**Recommendation**: Hand-rolled. The state space is small (6 states, ~10 events) and the codebase has no precedent for state-chart libraries. We can borrow the *vocabulary* (states, events, effects) without adopting any library.

### Web Locks API support

`navigator.locks` is supported in all modern browsers (Chrome 69+, Firefox 96+, Safari 15.4+). It's NOT available in:

- Service Workers (we don't run there)
- Cloudflare Workers / Node (we run via `attachSync` only in browsers and Node servers; in Node, leader election is meaningless because each process has its own ydoc)
- Old WebView shells (Tauri's WebKit is recent enough)

Lock semantics (per [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API)):
- `navigator.locks.request(name, callback)` blocks the callback until the lock is available, runs it, releases on resolve/reject.
- Locks are scoped to origin + lock name; they survive tab navigation but die with the tab.
- The `steal: true` option forcibly takes a lock from another holder (useful for crash recovery, but we don't need it).

**Implication**: leader election is a clean fit. The lock holder runs the WebSocket; others wait inside `request()`'s callback queue. When the leader tab dies (or navigates away), the lock auto-releases, the next waiting tab's callback runs.

### Async iterator patterns

Three common patterns in the wild:

| Pattern | Used by | Trade-off |
|---|---|---|
| Single shared queue, fanout to listeners | `events.on` | Easy; can't filter per-listener |
| Per-iterator queue, demand-driven | RxJS Subjects, Node streams | More code; per-iterator filtering & backpressure |
| Generator with `yield` from inside the loop | Some Yjs internals | Tightly couples producer to consumer count |

**Recommendation**: per-iterator queue. Trivial to filter, multiple iterators get independent buffers, `iterator.return()` cleans up subscription on `break` / early exit.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| State machine implementation | Hand-rolled reducer + effects queue | No suitable lib in repo; state space small; matches codebase style |
| State machine: where effects run | Separate `effectRunner` module | Keeps reducer pure; effects are testable in isolation; matches Elm/MVU pattern |
| FSM: replace `permanentFailure` flag | `state.phase === 'failed'` | One source of truth; impossible-state by construction |
| Event API: public shape | Deferred | No current consumer justifies freezing wire/debug vocabulary as API |
| Event API: internal shape | `createSyncEventBus()` | Gives tests ordered observations without exposing internals |
| Event API: backpressure | Buffered queue per iterator, no producer slowdown | Wire is real-time; we cannot pause ws.onmessage |
| Goodbye frame: message type | `102` in the Epicenter range (100+) | 102 is next free after RPC=101 |
| Goodbye frame: payload | `[varuint: 102] [varuint: reason_code]` | Symmetric with SYNC_STATUS; tiny on wire |
| Goodbye reasons | `0=unknown, 1=user_request, 2=doc_destroyed` | Minimal vocabulary; extensible via reserved range |
| Goodbye: where to send | Both `pause()` and dispose path, before `ws.close()` | Server uses the reason for telemetry + RPC PeerOffline routing |
| Cross-tab mode | `crossTab?: 'auto' | 'direct'`, default `'auto'` | Browser callers get one socket per doc by default; escape hatch remains explicit |
| Leader election: lock name | `epicenter:sync:${ydoc.guid}` | Per-doc; avoids cross-doc contention |
| Leader election: follower writes | Routed to leader via internal BroadcastChannel | Reuses existing document update channel semantics without caller wiring |
| Leader election: follower RPC | Routed to leader via new BC message type | Required because RPC needs request/response correlation |
| Leader election: awareness | Leader owns; followers publish state via BC, leader merges | Single source of truth on the wire |
| Backwards compatibility | A1 and A4 are internal or additive; A2 changes browser defaults | Migration removes explicit browser `attachBroadcastChannel` calls where `attachSync` is present |
| Bundle impact | Hand-rolled, no new deps | Net code addition: ~600 lines; no new bundle deps |

## Architecture

### A1: Explicit Supervisor State Machine

Replace the implicit state machine in `runLoop` with an explicit reducer.

```
                                STATES
                                ──────
   ┌─────────┐  START                       STOP    ┌─────────┐
   │ offline │ ──────► connecting ──────────────► │ offline │
   └─────────┘                  │                   └─────────┘
        ▲                       │ TOKEN_OBTAINED
        │                       ▼
        │                 ┌──────────────┐
        │                 │ handshaking  │
        │                 └──────┬───────┘
        │                        │ HANDSHAKE_COMPLETE
        │                        ▼
        │                  ┌─────────────┐
        │                  │  connected  │ (hasLocalChanges varies)
        │                  └──────┬──────┘
        │                         │ WS_CLOSE
        │                         ▼
        │                ┌──────────────┐
        │                │ backing_off  │ ◄────┐
        │                └──────┬───────┘      │
        │                       │ BACKOFF_DONE │
        │                       └──────────────┘
        │                                       (re-enters connecting)
        │
        │ WS_CLOSE(permanent=4401)
        │       ▼
        │ ┌─────────┐
        └─│ failed  │   (terminal; only START exits via clearing reason)
          └─────────┘
```

**File: `packages/workspace/src/document/sync-machine.ts` (new)**

```typescript
// State (discriminated union; impossible states impossible)
export type MachineState =
  | { phase: 'offline' }
  | { phase: 'connecting'; retries: number; lastError?: SyncError }
  | { phase: 'handshaking'; ws: WebSocket; retries: number }
  | { phase: 'connected'; ws: WebSocket; hasLocalChanges: boolean }
  | { phase: 'backing_off'; retries: number; lastError?: SyncError }
  | { phase: 'failed'; reason: SyncFailedReason };

// Events (everything that can move the machine)
export type MachineEvent =
  | { type: 'START' }
  | { type: 'STOP'; reason: 'pause' | 'reconnect' | 'destroy' }
  | { type: 'CONNECT_ATTEMPT' }
  | { type: 'TOKEN_OBTAINED'; token: string | null }
  | { type: 'TOKEN_REJECTED'; error: unknown }
  | { type: 'WS_OPEN'; ws: WebSocket }
  | { type: 'HANDSHAKE_COMPLETE' }
  | { type: 'WS_CLOSE'; code: number; reason: string }
  | { type: 'BACKOFF_DONE' }
  | { type: 'LOCAL_CHANGES'; hasLocalChanges: boolean };

// Effects (commands the runtime executes)
export type MachineEffect =
  | { type: 'OPEN_WS'; url: string; subprotocols: string[] }
  | { type: 'CLOSE_WS'; ws: WebSocket; goodbyeReason?: GoodbyeReason }
  | { type: 'GET_TOKEN' }
  | { type: 'START_BACKOFF'; retries: number }
  | { type: 'CANCEL_BACKOFF' }
  | { type: 'EMIT'; event: SyncEvent };  // for A3 iterator

// Reducer (pure)
export function step(
  state: MachineState,
  event: MachineEvent,
): { state: MachineState; effects: MachineEffect[] };
```

**File: `packages/workspace/src/document/sync-runtime.ts` (new)**

Owns the side-effect runner: WebSocket lifecycle, backoff timers, token fetching, abort signal threading. Calls `step()` on each event, processes returned effects.

**File: `packages/workspace/src/document/attach-sync.ts` (modified)**

Becomes a thin wrapper: builds the dispatch tree, constructs awareness, instantiates the machine + runtime, exposes the `SyncAttachment` surface. Body shrinks from ~1290 lines to ~600.

### A3: Internal Async Iterator Event Bus

```
┌──────────────────────────────────────────────────────────┐
│  attachSync internals                                    │
│                                                          │
│   reducer.emit(event)                                    │
│   ws.onmessage → emit({type:'wire-in', bytes})           │
│   handleRpcRequest → emit({type:'rpc-request', rpc})     │
│   awareness.on('change') → emit({type:'peer-joined',...})│
│                              │                           │
│                              ▼                           │
│                     ┌──────────────┐                     │
│                     │ Subscribers  │                     │
│                     │ Set<sub>     │                     │
│                     └──────┬───────┘                     │
└────────────────────────────┼─────────────────────────────┘
                             │
       ┌─────────────────────┼─────────────────────┐
       ▼                     ▼                     ▼
   iterator A           iterator B           iterator C
   filter:status        filter:rpc-*         filter:all
   queue: []            queue: [r1, r2]      queue: [...]
   pendingNext: ◄┐      pendingNext: null    pendingNext: ◄┐
                │                                          │
   for await { ─┘      const r = await       for await { ──┘
     console.log         it.next()             debugPanel.push(ev)
   }                                         }
```

This is not a public `SyncAttachment` method in the first implementation. It is private infrastructure used by reducer/runtime tests, debug panels inside this repo, and future diagnostics. Public exposure is deferred until a concrete app needs it.

**Internal SyncEvent variants:**

```typescript
export type SyncEvent =
  | { type: 'status'; status: SyncStatus }
  | { type: 'wire-in'; bytes: Uint8Array; messageType: number }
  | { type: 'wire-out'; bytes: Uint8Array; messageType: number }
  | { type: 'rpc-request'; rpc: DecodedRpcRequest }
  | { type: 'rpc-response'; rpc: DecodedRpcResponse }
  | { type: 'peer-joined'; clientId: number; state: PeerAwarenessState }
  | { type: 'peer-left'; clientId: number }
  | { type: 'doc-update'; size: number; origin: 'local' | 'wire' | 'bc' };
```

**Internal helper:**

```typescript
function createSyncEventBus(): {
  emit(event: SyncEvent): void;
  events(filter?: {
  types?: SyncEvent['type'][];
  bufferSize?: number;  // default 256; on overflow, drop oldest
  }): AsyncIterableIterator<SyncEvent>;
};
```

**Wire-in/out events are emitted only when at least one iterator subscribes to them** (cheap to compute; avoids allocating Uint8Array slices when nobody's watching). Other event types are always synthesized because they're already computed for the existing callbacks.

### A4: GOODBYE Wire Frame

**Protocol addition (`packages/sync/src/protocol.ts`):**

```typescript
export const MESSAGE_TYPE = {
  // ... existing 0, 1, 2, 3, 100, 101 ...
  GOODBYE: 102,
} as const;

export const GOODBYE_REASON = {
  UNKNOWN: 0,
  USER_REQUEST: 1,        // pause()
  DOC_DESTROYED: 2,       // ydoc.destroy()
  TOKEN_REFRESH: 3,       // reserved for future use
} as const;

export type GoodbyeReason = (typeof GOODBYE_REASON)[keyof typeof GOODBYE_REASON];

export function encodeGoodbye(reason: GoodbyeReason): Uint8Array {
  return encoding.encode((encoder) => {
    encoding.writeVarUint(encoder, MESSAGE_TYPE.GOODBYE);
    encoding.writeVarUint(encoder, reason);
  });
}

export function decodeGoodbye(decoder: decoding.Decoder): GoodbyeReason;
```

**Client wire flow:**

```
pause() called
   │
   ├── send(encodeGoodbye(USER_REQUEST))
   ├── ws.close(1000)
   ├── cycleController.abort()
   └── status -> 'offline'

doc.destroy() fired
   │
   ├── send(encodeGoodbye(DOC_DESTROYED))
   ├── masterController.abort()
   └── (existing teardown path)
```

**Server reaction (`apps/api/src/sync-handlers.ts`):**

```typescript
case MESSAGE_TYPE.GOODBYE: {
  const reason = decodeGoodbye(decoder);
  return { action: 'goodbye', reason };  // new action type
}
```

`BaseSyncRoom.webSocketMessage` handles `'goodbye'` by:
1. Logging the reason for telemetry.
2. Marking the connection as `gracefulClose=true`.
3. Replying `RpcError.PeerGone({ deviceId })` to any in-flight RPCs from this peer (instead of letting them time out OR returning `PeerOffline`).
4. Broadcasting peer departure to other peers' awareness immediately (via `removeAwarenessStates` on this peer's `controlledClientIds`).

`RpcError.PeerGone` is a new variant in `packages/sync/src/rpc-errors.ts`. Distinguishes "intentional disconnect" from "we don't know where they went."

### A2: Automatic Browser Cross-Tab Sync

```
┌────────────────────────────────────────────────────────────────┐
│   USER OPENS 3 TABS OF THE SAME WORKSPACE                      │
│                                                                │
│  Tab A (Leader)         Tab B (Follower)     Tab C (Follower)  │
│  ────────────           ───────────────       ───────────────   │
│  navigator.locks.       navigator.locks.      navigator.locks.  │
│   request('eds:DOC',     request('eds:DOC',    request('eds:DOC',│
│   () => runLeader())     () => runLeader())    () => runLeader())│
│                                                                │
│  ✓ acquired             ⏸ queued              ⏸ queued         │
│  opens WebSocket        listens BC            listens BC       │
│       │                                                        │
│       ▼                                                        │
│   ┌─────┐                                                      │
│   │ WS  │ ◄────── server                                       │
│   └─────┘                                                      │
│       │                                                        │
│       │ inbound bytes                                          │
│       ▼                                                        │
│   apply to local ydoc with SYNC_ORIGIN                         │
│       │                                                        │
│       ▼ (existing attachBroadcastChannel)                      │
│   broadcasts to followers                                      │
│       │                                                        │
│       └─► Followers apply with BC_ORIGIN                       │
│                                                                │
│  Tab A dies (close, navigate, crash):                          │
│   lock auto-released                                           │
│   Tab B's queued callback runs: now leader                     │
│   Tab B opens WebSocket, others stay followers                 │
└────────────────────────────────────────────────────────────────┘
```

**Three message types over BC for leader/follower coordination:**

```typescript
// Existing channel: 'yjs:${ydoc.guid}'  (carries doc updates)
// New channel:     'epicenter:sync:${ydoc.guid}'  (carries control messages)

type LeaderMessage =
  | { type: 'leader-status'; status: SyncStatus }       // leader -> all followers
  | { type: 'follower-rpc-request'; rpc: RpcRequest }   // follower -> leader
  | { type: 'follower-rpc-response'; rpc: RpcResponse } // leader -> requesting follower
  | { type: 'follower-awareness'; state: unknown };     // follower -> leader
```

**Public config addition:**

```typescript
export type SyncAttachmentConfig = {
  // Existing config...
  crossTab?: 'auto' | 'direct';
};
```

`crossTab: 'auto'` is the default. In browsers with `navigator.locks` and `BroadcastChannel`, `attachSync` elects one leader tab per document and routes follower work through that leader. In Node, workers, tests without browser globals, and unsupported browser shells, `'auto'` falls back to a direct WebSocket. `crossTab: 'direct'` forces today's one-attachment-one-socket behavior.

**Implementation file: `packages/workspace/src/document/leader.ts` (new)**

```typescript
export function runWithLeaderElection(
  ydoc: Y.Doc,
  config: SyncAttachmentConfig,
  runLeader: (ctx: LeaderContext) => Promise<void>,
): SyncAttachment;
```

`runLeader` is the existing supervisor-machine setup. `runWithLeaderElection` decides at construction whether to launch the supervisor (won the lock), attach BC listeners only (queued), or fall back to a direct socket because cross-tab primitives are unavailable.

**Follower's `SyncAttachment.rpc()`** sends the request as a `follower-rpc-request` BC message; leader picks it up, dispatches as if it came from the wire, sends the response back as `follower-rpc-response`. The follower's pending request map keys by the same `requestId`. Leader rotation does NOT survive in-flight RPCs (followers see `RpcError.LeaderRotated` and re-issue).

**Follower's `peers()` and `find()`** read from a follower-local awareness mirror that the leader keeps populated via the existing BC update stream. They lag the leader by one BC tick.

## Implementation Plan

### Phase 1: A4 - GOODBYE wire frame (smallest, lowest risk, lands first)

- [ ] **1.1** Add `MESSAGE_TYPE.GOODBYE = 102`, `GOODBYE_REASON`, `encodeGoodbye`, `decodeGoodbye` to `packages/sync/src/protocol.ts`.
- [ ] **1.2** Add `RpcError.PeerGone({ deviceId })` to `packages/sync/src/rpc-errors.ts`.
- [ ] **1.3** Wire client send: `send(encodeGoodbye(USER_REQUEST))` in `pause()` before `cycleController.abort()` (`attach-sync.ts:958`); `send(encodeGoodbye(DOC_DESTROYED))` in destroy handler before `masterController.abort()` (`attach-sync.ts:990`).
- [ ] **1.4** Server: handle `MESSAGE_TYPE.GOODBYE` in `applyMessage` (`apps/api/src/sync-handlers.ts:243`), return new `{ action: 'goodbye', reason }`. `BaseSyncRoom.webSocketMessage` handles `'goodbye'` by reverse-iterating any in-flight forwarded RPCs whose `requesterClientId` is in this WS's `controlledClientIds`, replying `PeerGone`.
- [ ] **1.5** Tests: client-side, assert `ws.sent` contains a GOODBYE frame before `ws.close` in pause/destroy paths. Server-side, drive a fake WS through GOODBYE then assert in-flight RPC replies switched from `PeerOffline` to `PeerGone`.

### Phase 2: A1 - State machine extraction

- [ ] **2.1** Create `packages/workspace/src/document/sync-machine.ts` with `MachineState`, `MachineEvent`, `MachineEffect`, and `step(state, event): { state, effects }`. Pure module; no `Y.Doc`, no `WebSocket` imports.
- [ ] **2.2** Exhaustive reducer test file `sync-machine.test.ts`: every `(state, event)` pair, asserting both next state and effects list. Target: 100% branch coverage.
- [ ] **2.3** Create `packages/workspace/src/document/sync-runtime.ts`. Owns `AbortController` hierarchy, `setTimeout`/`setInterval`, WebSocket factory (or `globalThis.WebSocket` for testability), `loadToken` invocation, `backoff` helper. Translates events from the wire/timers into `step()` calls; executes returned effects.
- [ ] **2.4** Refactor `attach-sync.ts`: replace `runLoop`, `attemptConnection`, `ensureSupervisor`, `pause`, `reconnect` with calls into the runtime. Keep the public `SyncAttachment` surface byte-identical (`whenConnected`, `status`, `onStatusChange`, `pause`, `reconnect`, `whenDisposed`, `rpc`, `peers`, `find`, `observe`, `raw` unchanged).
- [ ] **2.5** Verify all existing `attach-sync.test.ts` tests pass without modification. If a test needed a code change to pass, the public API regressed.
- [ ] **2.6** Delete `permanentFailure` flag (now `state.phase === 'failed'`); delete `currentSupervisorPromise` (now owned by runtime); delete the "reconnect-during-tail" race comment block (impossible by construction now).

### Phase 3: A2 - Automatic browser cross-tab sync

- [ ] **3.1** Add `crossTab?: 'auto' | 'direct'` to `SyncAttachmentConfig`, defaulting to `'auto'`.
- [ ] **3.2** Detect `navigator.locks` and `BroadcastChannel` availability. If either is absent, `'auto'` falls back to direct connection without warning. Missing primitives are normal in Node and test environments.
- [ ] **3.3** Create `packages/workspace/src/document/leader.ts` with `runWithLeaderElection(ydoc, config, runLeader)`. Acquires `epicenter:sync:${ydoc.guid}`. Inside callback, calls `runLeader(ctx)` which builds the supervisor machine + runtime as a leader.
- [ ] **3.4** Define `LeaderMessage` BC channel `epicenter:sync:${ydoc.guid}`. New `attachLeaderChannel` helper that wraps a `BroadcastChannel` and exposes `send(msg)` / `subscribe(handler)`.
- [ ] **3.5** Leader-side: on connected status change, broadcast `leader-status`. On follower-rpc-request receipt, dispatch via the wire as if it were local; on response, broadcast `follower-rpc-response` keyed by request id.
- [ ] **3.6** Follower-side: build a stub `SyncAttachment` whose `status` mirrors `leader-status` BC messages, whose `rpc()` round-trips through BC to leader, whose `peers()`/`find()`/`observe()` mirror leader's broadcast peer set. Leader rotation rejects in-flight follower RPCs with `RpcError.LeaderRotated`.
- [ ] **3.7** Browser app migration: remove explicit `attachBroadcastChannel(doc.ydoc)` calls from workspace modules that also call `attachSync` for the same doc. Keep standalone BroadcastChannel attachments for local-only docs with no `attachSync`.
- [ ] **3.8** Tests: simulate two `attachSync` calls in the same process with shared mock `BroadcastChannel` and shared mock `navigator.locks`; assert exactly one opens a WebSocket; assert follower's `rpc()` reaches the wire via leader; assert leader death promotes follower.

### Deferred: A3 - Public async iterator events API

- [ ] Define `SyncEvent` discriminated union in `packages/workspace/src/document/sync-event.ts`.
- [ ] Add private `createSyncEventBus()` helper: subscribers `Set`, per-subscriber queue, `iterator.next()` resolves from queue or pending Promise, `iterator.return()` drops subscriber.
- [ ] Use the bus in runtime tests where ordered event assertions replace ad hoc queues.
- [ ] Do not add `events(filter)` to `SyncAttachment` until a real app or CLI needs it.

## Edge Cases

### A1: state machine

**Reconnect during handshake.** The current code handles this via the `cycleController` swap + the post-finally `ensureSupervisor` chain (`attach-sync.ts:944-955`). In the FSM model: `STOP{reason:reconnect}` event in `handshaking` state transitions to `connecting`, with effects `[CLOSE_WS, OPEN_WS]`. The `WS_CLOSE` event from the old socket arrives in `connecting` state and is dropped (no-op transition). No race; one event at a time.

**`loadToken()` resolves after `STOP`.** The runtime's `GET_TOKEN` effect captures the cycle generation. When the Promise resolves, runtime checks if the generation matches; if not, the result is dropped before being fed back into `step()`.

### A3: internal event bus

**Slow consumer.** Default `bufferSize` is 256. On overflow, drop oldest. Document this clearly. Don't try to do "pause the wire on overflow" - the wire is real-time, not flow-controllable.

**Iterator created but never consumed.** Subscriber registered eagerly; queue grows. After `bufferSize` events, oldest dropped. No memory leak. (Could add a "GC after 60s of no `next()` calls" but that's premature.)

**`for await` with synchronous `break`.** Iterator's `return()` is called automatically; subscriber removed. Verified by private event-bus tests.

### A4: GOODBYE frame

**Server already sent close 4401 before client sends GOODBYE.** GOODBYE arrives at a CLOSING socket; `send()` no-ops (current behaviour at `attach-sync.ts:599-602`). No harm.

**Client sends GOODBYE then network drops mid-flight.** Server may or may not receive it. Server defaults to "PeerOffline" on missed RPC if no GOODBYE was seen. Idempotent - if GOODBYE arrived, optimization fires; if not, fallback path.

### A2: leader election

**Lock acquired but WS auth fails (4401).** Leader transitions to `failed` state. Followers see `leader-status` carrying `failed`. Followers do NOT re-attempt to acquire the lock (the auth failure is a property of the user's session, not the tab; same token, same result). Lock is RELEASED so a future `reconnect()` from any tab can re-acquire and try again.

**Two tabs race for the lock at startup.** Web Locks API guarantees serial acquisition; one wins, others queue. No race.

**Leader navigates away while connected.** Lock auto-released on `pagehide`. Next-in-queue tab's callback fires, opens its own WebSocket. Brief gap (one new STEP1+STEP2 round trip, ~100ms typically). Document this is by-design - leader handoff cost = one handshake.

**Follower issues an RPC; leader rotates mid-flight.** Follower sees `LeaderRotated` and re-issues automatically? Or returns the error to caller? Open question; default to surfacing the error (caller decides whether to retry).

**Same `deviceId` across tabs (current bug).** With leader election, only the leader's awareness state is on the wire. The deviceId appears once, not N times. Fixes a symptom of the current architecture.

**`crossTab: 'auto'` in Node.** No `navigator.locks` and usually no `BroadcastChannel`. Falls back to direct connection per 3.2. CLI tools and servers always go direct; this matches the SYNC_ARCHITECTURE.md "server-to-server" pattern.

**Caller already attached BroadcastChannel.** During migration, a caller may still call `attachBroadcastChannel(doc.ydoc)` before `attachSync`. This is CRDT-safe but wasteful. Phase 3.7 removes those calls where the same doc also has `attachSync`.

## Open Questions

1. **Should A1 use a tagged-union state library like `ts-pattern` for `step()`?**
   - Options: (a) plain `switch(state.phase)` + `switch(event.type)`, (b) `ts-pattern` for exhaustive matching with compile-time check, (c) a tiny inline matcher.
   - **Recommendation**: (a) plain `switch`. The reducer is the single place that needs exhaustiveness; TypeScript's `never` check catches missed cases. A library would be the only `ts-pattern` usage in the repo.

2. **Should A3 become public now?**
   - Options: (a) keep event bus private, (b) expose `sync.events()` with status-only events, (c) expose full wire/debug events.
   - **Recommendation**: (a). Status-only duplicates `onStatusChange`; full wire/debug events freeze internals. Build the bus privately first and expose only after a real consumer proves the shape.

3. **A4: should GOODBYE be ack'd by the server before `ws.close()`?**
   - Currently the design sends GOODBYE and immediately closes; server may or may not get it before the FIN.
   - Options: (a) fire-and-forget (proposed), (b) await a server `'goodbye-ack'` text frame before closing, with a 200ms timeout.
   - **Recommendation**: (a). The GOODBYE is an optimization, not a correctness primitive. A 200ms delay on `pause()` is bad UX. If the server misses it, fallback (PeerOffline + 30s awareness TTL) is fine.

4. **A2: should browser cross-tab sharing be the default?**
   - Options: (a) default `'auto'` in browsers with fallback to direct, (b) opt-in `leaderElection: true`, (c) direct sockets forever.
   - **Recommendation**: (a). The caller should not know that sync needs leader election plus BroadcastChannel. `crossTab: 'direct'` is enough escape hatch for tests and unusual transports.

5. **A2: what happens to `attachBroadcastChannel`?**
   - It remains available for local-only docs that do not call `attachSync`.
   - For docs that do call `attachSync`, browser BroadcastChannel wiring moves inside sync.
   - **Recommendation**: migrate browser workspace docs away from explicit `attachBroadcastChannel(doc.ydoc)` when the same doc also has `attachSync`.

6. **Should the runtime in A1 expose a `dryRun` mode for testing?**
   - Options: (a) tests stub `globalThis.WebSocket` (current pattern from `attach-sync.test.ts`), (b) runtime accepts a `transport` injection point, (c) both.
   - **Recommendation**: (a). The existing `FakeWebSocket` pattern works; adding a transport seam is pure overhead until we have a non-WebSocket transport.

## Success Criteria

- [ ] Three product phases land as separate PRs (A4 first, then A1, then A2). A3 stays private unless a consumer appears.
- [ ] Existing `attach-sync.test.ts` passes byte-identical after Phase 2 (no API regressions).
- [ ] New per-phase tests cover the new surfaces:
  - [ ] Phase 1: GOODBYE frame round-trip + PeerGone on in-flight RPCs.
  - [ ] Phase 2: 100% branch coverage of `step()`; runtime integration test exercises full connect/disconnect/reconnect cycle.
  - [ ] Phase 3: shared mocked `navigator.locks` + `BroadcastChannel` test proves N tabs = 1 WebSocket; leader rotation works.
  - [ ] Deferred A3: private event iterator yields expected sequence; `return()` cleanup; multiple iterators are independent.
- [ ] `bun run check` and `bun run typecheck` pass at every phase boundary.
- [ ] Bundle size delta measured per phase. Goal: net under +12KB min+gz across all four (A1 might be slightly negative, A2 is the bulk).
- [ ] `SYNC_ARCHITECTURE.md` updated to describe the FSM, GOODBYE semantics, automatic browser cross-tab sync, and private event-bus testing hooks.
- [ ] No new runtime dependencies added to any package.

## References

### Files modified

- `packages/workspace/src/document/attach-sync.ts` - thinned to wrapper; ~600 lines after Phase 2.
- `packages/workspace/src/document/attach-broadcast-channel.ts` - remains public for local-only docs; browser sync docs stop wiring it directly (Phase 3).
- `packages/sync/src/protocol.ts` - new GOODBYE codec (Phase 1).
- `packages/sync/src/rpc-errors.ts` - new `PeerGone`, `LeaderRotated` variants (Phase 1, Phase 3).
- `packages/sync/src/index.ts` - re-exports.
- `apps/api/src/sync-handlers.ts` - GOODBYE handling (Phase 1).
- `apps/api/src/base-sync-room.ts` - PeerGone routing (Phase 1).

### Files created

- `packages/workspace/src/document/sync-machine.ts` - the reducer (Phase 2).
- `packages/workspace/src/document/sync-machine.test.ts` - exhaustive reducer tests (Phase 2).
- `packages/workspace/src/document/sync-runtime.ts` - effects runner (Phase 2).
- `packages/workspace/src/document/sync-event.ts` - private `SyncEvent` union + `createEventBus` (deferred A3, or created during Phase 2 tests if useful).
- `packages/workspace/src/document/sync-event.test.ts` - private iterator tests (deferred A3, or created during Phase 2 tests if useful).
- `packages/workspace/src/document/leader.ts` - automatic browser cross-tab sync (Phase 3).
- `packages/workspace/src/document/leader.test.ts` - cross-tab sync tests (Phase 3).

### Patterns to follow

- `packages/workspace/src/document/attach-sync.test.ts` - `FakeWebSocket` pattern; reuse for runtime tests.
- `packages/workspace/src/document/attach-awareness.ts` - typed wrapper pattern; A3's iterator helper can mirror its lifecycle discipline.
- `packages/sync/src/protocol.ts:427-451` - SYNC_STATUS codec; GOODBYE follows the same shape.
- `apps/api/src/base-sync-room.ts:340-380` - existing message-action router; GOODBYE adds one new branch.

### Reference implementations consulted

- `yjs/y-websocket` (`WebsocketProvider`): reconnect + ping pattern, no FSM, no leader election. Considered upstream baseline.
- `yjs/y-protocols` (`PROTOCOL.md`): standard SYNC + AWARENESS framing; confirmed our extension IDs (100+) are conflict-free.
- `lib0/broadcastchannel`: y-websocket's cross-tab implementation; reviewed for leader-election patterns (it's flat fanout, no leader).
- `y-sweet`: SYNC_STATUS echo pattern (server is dumb); already in our codebase, validates A4's "server doesn't ack GOODBYE" choice.

### Out of scope (deferred)

- B1 from the original analysis: snapshot+delta replication. Touches server-side persistence; separate spec.
- B2: WebTransport over HTTP/3. Cloudflare DO support is incomplete.
- B3: multi-provider RPC racing. Doc-level concern, not supervisor-level.
- B4: Lamport-based "saved" tracker. Violates "server is a dumb echoer" invariant.
