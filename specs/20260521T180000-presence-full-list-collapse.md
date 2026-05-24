# Presence Full-List Collapse: Delete the Client Presence Tracker

**Date**: 2026-05-21
**Status**: Implemented
**Author**: AI-assisted (with adversarial review)
**Branch**: `redesign/server-owned-presence` (continues the branch that landed server-owned presence)
**Supersedes**: the delta-protocol and `run-handler` sections of `specs/20260521T121500-server-owned-presence.md` (Wire surface, `presence_added` / `presence_removed`, "Run-handler `PeerNotFound` pre-check window" Option A).

## One sentence

The relay broadcasts the full presence list on every change and answers reachability inline on every dispatch, so the client stops reassembling deltas and stops caching presence for decisions; `createPresenceTracker`, `Presence`, `hasSnapshot`, and `reset()` are deleted.

## TL;DR

```
Today                                          After

wire
  presence_snapshot (full list, on upgrade)       presence (full list, on EVERY change)
  presence_added    (delta)                       (deleted)
  presence_removed  (delta, grace-windowed)       (deleted)

client
  createPresenceTracker: 5-method stateful obj    ~8 inline lines in open-collaboration.ts
  Set<string> + delta replay + dedup + self-      remoteDevices = frame.installs
    exclude + hasSnapshot latch + reset()
  presence.ts (~207 lines)                        deleted
  presence.test.ts (~210 lines)                   deleted
  ./document/presence subpath (whole module)      retargeted to a 1-type protocol file
  Collaboration.presence.hasSnapshot accessor     deleted

run-handler
  reads devices.list() (client cache) to split    reads the relay's RecipientOffline
    PeerNotFound vs RemoteCallFailed                error and maps it to PeerNotFound
  hasSnapshot gate papers over stale cache         (deleted: no client cache to gate)
```

Net: roughly **-450 lines**, three frame types collapse to one, and the entire "pre-snapshot window" class of bugs ceases to exist because the client no longer makes presence decisions.

## Overview

`server-owned-presence` (the prior spec) moved presence's source of truth from y-protocols Awareness to the relay's `connections` map. It stopped halfway: it kept a **delta protocol** the client reassembles into a `Set`, and it kept a **client-side decision cache** that `run-handler.ts` consults before dispatching. This spec finishes the move. The relay sends the whole list every time it changes, and dispatch reachability is answered by the relay inline. The client mirrors presence for display only and never decides who is online.

## Motivation

### Current State

**Wire**: three frame types (`packages/workspace/src/document/presence.ts:50-65`).

```ts
type PresenceSnapshotFrame = { type: 'presence_snapshot'; installs: string[] };
type PresenceAddedFrame    = { type: 'presence_added';    install: string };
type PresenceRemovedFrame  = { type: 'presence_removed';  install: string };
```

**Client**: a stateful tracker reassembles those deltas (`presence.ts:118-207`): a `Set<string>`, a `presence_added` branch with size-diff dedup, a `presence_removed` branch, self-exclusion, a `hasSnapshot` latch, and a `reset()` method.

**Decision cache**: `run-handler.ts:100-126` reads that cache to fail-fast a dispatch:

```ts
// run-handler.ts:115  -- the hasSnapshot gate
if (runtime.collaboration.presence.hasSnapshot) {
  const online = runtime.collaboration.devices
    .list()
    .some((d) => d.installationId === peerTarget);
  if (!online) return RunError.PeerNotFound({ peerTarget, waitMs, syncStatus: ... });
}
const result = await runtime.collaboration.dispatch({ to: peerTarget, ... });
```

This creates problems:

1. **The client makes a decision off a cache that is sometimes stale.** Between WebSocket upgrade and the first `presence_snapshot`, `devices.list()` is empty. The `hasSnapshot` gate exists purely to suppress a wrong answer during that window. The gate is a band-aid on a cache that should not be driving decisions.

2. **`reset()` is dead and `hasSnapshot` is a one-way latch.** `reset()` has zero production callers (`rg "reset" packages/workspace/src --glob '!**/*.test.ts'` shows only the definition; `open-collaboration.ts` never calls it, `sync-supervisor.ts`'s `onclose` has no presence hook). Its JSDoc claims "Used on disconnect" -- false. Because `reset()` is never wired, `hasSnapshot` never returns to `false`, so it means "ever had a snapshot," not "has a current snapshot." On a daemon reconnect the gate runs the pre-check against the stale set.

3. **The exit-code split is already racy.** When the pre-check passes (peer online) but the peer goes offline before the HTTP dispatch lands, the relay returns `RecipientOffline`, which `run-handler` maps to `RemoteCallFailed`, not `PeerNotFound`. The split the pre-check exists to preserve is not actually preserved under a race.

4. **Delta reassembly is eventual-consistency-shaped thinking the server-owned move was supposed to retire.** The server already holds the whole truth in `connections`. Shipping it as deltas forces the client to rebuild state the server could have just sent.

### Desired State

One frame. The relay sends the full list whenever it changes:

```ts
type PresenceFrame = { type: 'presence'; installs: string[] }; // receiver's own install excluded
```

The client stores `frame.installs` and notifies subscribers. No `Set`, no delta replay, no dedup, no self-exclusion, no latch, no `reset()`. `run-handler` dispatches and reads the relay's authoritative `RecipientOffline`:

```ts
const result = await runtime.collaboration.dispatch({ to: peerTarget, ... });
if (result.error !== null) {
  return result.error.name === 'RecipientOffline'
    ? RunError.PeerNotFound({ peerTarget, waitMs, syncStatus: ... })
    : RunError.RemoteCallFailed({ cause: result.error, peerTarget, syncStatus: ... });
}
```

## Research Findings

### The relay is already the authority for dispatch reachability

`apps/api/src/room.ts:478-488`, the `dispatch` RPC:

```ts
async dispatch(req: DispatchRpcRequest): Promise<DispatchResult> {
  const recipientWs = this.pickRecipient(req.to);
  if (!recipientWs) {
    return { error: { name: 'RecipientOffline', to: req.to, message: ... } };
  }
  // ...route to the live socket...
}
```

`pickRecipient` (`room.ts:658+`) reads `this.connections` -- the same map presence is derived from. The relay answers "is this install reachable" on every dispatch, before touching a socket.

### The client already lifts that error into a typed variant

`packages/workspace/src/document/dispatch.ts:80-81, 314-316`:

```ts
export const DispatchError = defineErrors({
  RecipientOffline: ({ to }: { to: string }) => ({ ... }),
  // ...
});
// wire decode:
case 'RecipientOffline':
  return DispatchError.RecipientOffline({ to: req.to });
```

**Key finding**: `run-handler`'s local pre-check is a worse, racy duplicate of an answer the relay already returns as a typed `DispatchError.RecipientOffline` on every dispatch. The pre-check can be deleted with no loss of information: `peerTarget`, `waitMs`, and `syncStatus` are all available locally at the mapping site.

**Implication**: once the pre-check is gone, `hasSnapshot` has no consumer, and once `hasSnapshot` is gone, the entire reason the client tracker is stateful (a latch + a reset hook + a snapshot concept) is gone.

### Full-list broadcast is correct at this product's scale

The prior spec's Open Question #6 raised an O(N) per-snapshot, O(N^2)-under-churn trip-wire and set the threshold at ~1000 installs in a room. Two facts make full-list-on-every-change the right call below that threshold:

| Fact | Consequence |
| --- | --- |
| The prior spec already sends a full `presence_snapshot` on every upgrade | The O(N) per-connect cost already exists; deltas only ever saved bandwidth on steady-state `added`/`removed`. |
| A "room" here is one user's own device set (phone, laptop, daemon) | Realistic N is 2-10. At ~26 chars/id, a 10-install broadcast is ~260 bytes. |

**Implication**: deltas do not earn their reassembly complexity at personal-workspace scale. The ~1000-install trip-wire from the prior spec stays as the documented signal to reintroduce deltas.

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Wire shape | 2 coherence | One `presence` frame carrying the full list | The server owns the whole truth; sending deltas forces the client to rebuild it. |
| Self-exclusion | 2 coherence | Server excludes the receiver's own install per-recipient (already done by `snapshotInstalls(exclude)`) | Client stores `frame.installs` verbatim; no client-side filtering. |
| `run-handler` reachability | 1 evidence | Delete the pre-check; map `DispatchError.RecipientOffline` -> `PeerNotFound` | Verified: relay returns `RecipientOffline` (`room.ts:481`), client lifts it (`dispatch.ts:314`). Removes a race; loses no fields. |
| `createPresenceTracker` module | 2 coherence | Delete; inline ~8 lines into `open-collaboration.ts` | With no decision cache and no deltas, the tracker collapses below the bar for a module, a 5-method interface, and a 210-line test file. |
| `reset()` / `hasSnapshot` | 1 evidence | Delete both | `reset()` has zero production callers; `hasSnapshot`'s only consumer is the pre-check being deleted. |
| Grace window | 3 taste | Keep, but as a single shared debounced rebroadcast timer (not a per-install `Map`) | Coalescing tab-handoff flap still has value with full-list frames; one timer suffices because the broadcast reads the live list at fire time. Revisit if connect-time flap appears. |
| `PresenceFrame` type home | 3 taste | A 1-type `presence-protocol.ts`; the `./document/presence` subpath retargets to it | Keeps a single source of truth for the wire type, keeps the subpath key stable so `apps/api` does not churn its import path, and drops `createPresenceTracker` from the subpath's surface. |
| Full list vs deltas | 1 evidence | Full list on every change | Prior spec already pays O(N) on every upgrade; realistic N is 2-10. ~1000-install trip-wire retained. |
| Parallel-emit migration step | 2 coherence | None; clean break, client + server ship in one PR | Matches the prior spec's Appendix A: pre-launch, the PR is the revert atom. |

## Architecture

### Two kinds of presence, now separated

```
presence-for-DISPLAY     "show a list of online devices"
  consumers: CLI up.ts, daemon /peers route, app UI
  a stale list is acceptable: it is just UI
  --> client mirrors via Collaboration.devices.{list,subscribe}

presence-for-DECISION    "should this dispatch fail-fast?"
  consumer: run-handler.ts
  a stale answer is a WRONG answer
  --> the relay decides, inline, via DispatchError.RecipientOffline
      the client never caches this
```

Today `run-handler` makes a DECISION off the DISPLAY mirror. This spec routes the decision to the only component already in the dispatch path: the relay.

### Dispatch reachability flow

```
TODAY
  run-handler --> read devices.list()  [client cache]
                   |- cache stale/empty? hasSnapshot gate suppresses
                   |- peer absent? PeerNotFound          (no round trip)
                   '- peer present? --> dispatch --> relay
                                          '- peer offline NOW? RecipientOffline
                                             --> RemoteCallFailed   (race: wrong split)

AFTER
  run-handler --> dispatch --> relay  [the authority, already in the path]
                                '- pickRecipient miss? RecipientOffline
                                   --> PeerNotFound        (always, no race)
```

### Presence broadcast flow (server)

```
SOCKET UPGRADES
  - send the full list (self excluded) to the new socket
  - if this is the FIRST socket for the install:
      cancel any pending debounced rebroadcast
      broadcast the full list to all other sockets (each self-excluded)
  - subsequent tabs of the same install: no broadcast (the list is unchanged)

SOCKET CLOSES
  - if it was the LAST socket for the install:
      arm the debounced rebroadcast timer (if not already armed)
  - timer fires after the grace window:
      broadcast the then-current full list to all sockets

GRACEFUL TAB HANDOFF  (T1 closes, T2 for the same install connects within grace)
  - T1 close arms the timer
  - T2 connect broadcasts the live list (still contains the install) and cancels the timer
  - peers observe one frame, install never absent
```

## Wire Surface

```ts
/** Full set of currently-connected installs, excluding the receiver's own. */
type PresenceFrame = { type: 'presence'; installs: string[] };
```

Server-to-client only. Clients never send presence frames; their connection is the publish. The text channel still carries `dispatch_inbound`; `open-collaboration`'s `onTextFrame` still tries presence first, then falls through to dispatch.

## Implementation Plan

### Phase 1: Build the full-list path

- [ ] **1.1** Add `presence-protocol.ts` to `packages/workspace/src/document/` exporting `PresenceFrame`. Retarget the `./document/presence` package.json subpath to it.
- [ ] **1.2** `apps/api/src/room.ts`: replace `presence_snapshot` / `presence_added` / `presence_removed` with one `presence` full-list frame. `upgrade()` sends the list to the new socket and broadcasts to others only on the first socket for an install. `presenceBroadcast` computes a per-recipient `installs` (self excluded), reusing `snapshotInstalls(exclude)`.
- [ ] **1.3** `apps/api/src/room.ts`: collapse `pendingRemovals` (a `Map`) to one shared debounced-rebroadcast timer armed on last-socket close, cancelled on any connect. Delete the `cancelPendingRemoval`-gates-`presence_added` coupling. Keep `countInstallSockets`. Keep the 4401-bypasses-grace policy.
- [ ] **1.4** `open-collaboration.ts`: delete `createPresenceTracker` import; inline an ~8-line `handlePresenceFrame` (parse, store `LiveDevice[]`, notify) and back `devices.{list,subscribe}` with it. Delete the `Collaboration.presence` accessor and its type member.
- [ ] **1.5** `run-handler.ts`: delete the pre-check block (`run-handler.ts:100-126`). After `dispatch`, map `result.error.name === 'RecipientOffline'` -> `RunError.PeerNotFound`, else `RemoteCallFailed`.
- [ ] **1.6** `daemon/types.ts`: drop the `presence: { readonly hasSnapshot }` member from the collaboration type.

### Phase 2: Prove

- [ ] **2.1** `bun test` in `packages/workspace` and `apps/api`. Typecheck both.
- [ ] **2.2** Smoke: two clients connect/disconnect, `devices.list()` updates; `epicenter run <offline-peer>` yields `PeerNotFound`; `epicenter run <online-peer>` dispatches.

### Phase 3: Remove (only after Phase 2 is green)

- [ ] **3.1** Delete `packages/workspace/src/document/presence.ts` and `presence.test.ts`.
- [ ] **3.2** Delete `run-handler.test.ts`'s `hasSnapshot` gate tests; add the `RecipientOffline -> PeerNotFound` mapping test.
- [ ] **3.3** Replace `apps/api`'s delta-protocol presence tests with full-list / first-socket / grace-window / handoff tests.
- [ ] **3.4** JSDoc sweep: `open-collaboration.ts` header, `index.ts` packageDoc, `dispatch.ts:17`, `keys.ts` presence comments. Mark the superseded sections of `specs/20260521T121500-server-owned-presence.md`.

## Edge Cases

### Multi-tab, same install
1. Tab 1 (install X) connects -> first socket -> broadcast full list (X present).
2. Tab 2 (install X) connects -> not first socket -> no broadcast (list unchanged).
3. Tab 1 closes -> `countInstallSockets(X) === 1` -> no timer.
4. Tab 2 closes -> last socket -> arm timer -> fires -> broadcast (X absent).

### Graceful tab handoff
1. T1 (install X, only socket) closes -> arm debounced rebroadcast timer.
2. T2 (install X) connects within the grace window -> broadcasts the live list (X still present, T2 is open) and cancels the timer.
3. Peers observe one frame; X never appears absent.

### Burst of departures
1. Install X's last socket closes -> arm timer.
2. Install Y's last socket closes before the timer fires -> timer already armed, do not re-arm.
3. Timer fires -> one broadcast of the live list (both X and Y absent). Y's departure is delayed at most one grace window.

### Caller's own WebSocket is down
1. Daemon's sync socket is disconnected; a dispatch is requested.
2. `dispatch` is HTTP, independent of the sync socket -> relay receives it -> `pickRecipient` for the target.
3. Correct result regardless of caller socket state. (Today's pre-check would read the caller's empty `devices.list()` and wrongly return `PeerNotFound` for an online peer.)

## Open Questions

1. **`PresenceFrame` home.** Options: (a) a dedicated 1-type `presence-protocol.ts`; (b) fold it next to the dispatch wire frames under one shared "relay text frame" module/subpath.
   - **Recommendation**: (a) now -- minimal, keeps the subpath key stable. Revisit (b) if a third relay text-frame family appears.
2. **Debounced rebroadcast: re-arm or not on a second departure?**
   - **Recommendation**: do not re-arm while a timer is pending, so a burst is announced at most one grace window after the first departure rather than drifting later under churn.
3. **Should a redundant connect-time broadcast be skipped when the list is unchanged?** A second tab connecting already skips the broadcast via the first-socket check. A distinct install connecting always changes the list.
   - **Recommendation**: the first-socket check is sufficient; no list-diffing needed.

## Decisions Log

- Keep the grace window: tab-handoff flap is still observable with full-list frames (install drops then reappears across two broadcasts).
  Revisit when: telemetry shows handoffs complete well inside one window, or product decides a brief flap is acceptable.
- Keep full-list over deltas: realistic room size is 2-10 installs; the prior spec already pays O(N) per upgrade.
  Revisit when: `connections.size` in a room approaches ~1000 (the prior spec's trip-wire); then reintroduce `added`/`removed` deltas.

## Success Criteria

- [ ] One `presence` frame type; `presence_added` / `presence_removed` / `presence_snapshot` are gone from `room.ts` and the workspace package.
- [ ] `packages/workspace/src/document/presence.ts` and `presence.test.ts` are deleted; no `createPresenceTracker`, `Presence`, `hasSnapshot`, or `reset()` remain.
- [ ] `./document/presence` subpath resolves to a file exporting only `PresenceFrame`; `apps/api/src/room.ts` imports it with no import-path change.
- [ ] `run-handler.ts` has no presence pre-check; an offline peer yields `PeerNotFound` via the relay's `RecipientOffline`, with no timing race.
- [ ] `Collaboration.devices.{list,subscribe}` behave identically for CLI `up.ts` and the daemon `/peers` route.
- [ ] `bun test` and `tsc --noEmit` pass in `packages/workspace` and `apps/api`.
- [ ] Superseded sections of `specs/20260521T121500-server-owned-presence.md` are marked.

## References

- `packages/workspace/src/document/presence.ts` - the tracker being deleted.
- `packages/workspace/src/document/open-collaboration.ts` - gains the inline presence handler; loses the `presence` accessor.
- `packages/workspace/src/daemon/run-handler.ts:100-126` - the pre-check being deleted.
- `packages/workspace/src/document/dispatch.ts:80-103, 314-316` - `DispatchError.RecipientOffline` definition and wire decode.
- `apps/api/src/room.ts:340-656` - presence broadcast + dispatch RPC; the delta protocol being collapsed.
- `packages/workspace/src/daemon/types.ts:42` - the `hasSnapshot` type member being dropped.
- `specs/20260521T121500-server-owned-presence.md` - the prior spec this one finishes; its Open Question #6 is the scale trip-wire.
