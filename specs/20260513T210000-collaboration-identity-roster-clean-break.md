# Collaboration Identity: Server-Owned Roster (Clean Break)

**Date**: 2026-05-13
**Status**: Superseded by `specs/20260513T235000-rpc-on-yjs-state.md`
**Reason**: Identity, presence, and remote calls moved into Y.Doc state (see `packages/workspace/src/document/presence.ts`, `packages/workspace/src/document/rpc.ts`, `packages/sync/src/index.ts:7-13`). The HELLO / ROSTER / ROSTER_DIFF wire envelopes proposed here were never implemented; the wire now carries only Yjs sync frames. `packages/workspace/src/document/peer.ts` no longer exists, so the `Peer` type, `peer.invoke`, `peer.describe()`, `PeerLeftError`, and the runtime-request plane referenced throughout this document are gone. Keep this file for the audit trail; do not implement.
**Author**: Braden + Claude
**Original supersedes**: the awareness-as-identity model carried by `20260213T102800-workspace-awareness.md`, `20260403T161046-unify-awareness-with-sync-transport.md`, `20260425T000000-device-actions-via-awareness.md`, `20260426T130000-fold-awareness-into-sync.md`, and `20260426T230000-drop-manifest-from-awareness.md`. Those specs incrementally trimmed awareness toward "identity only." This spec finishes the move by removing identity from awareness entirely.

## Why This Exists

Two findings forced the rewrite.

**Finding 1: nothing reads `replica.platform`.** A grep across `packages/` and `apps/` returns zero call sites that branch on `replica.platform`. Every site only writes it. The field is decoration. Today's `Replica { id, platform }` is a one-field object with a decorative second field.

**Finding 2: Yjs awareness is the wrong protocol for our topology.** Awareness is a peer-gossip CRDT designed for symmetric multi-peer state replication with TTL heartbeats. Our wire is hub-and-spoke through a Cloudflare Durable Object: every awareness frame goes client -> DO -> client. We then added a second envelope (`AWARENESS_ATTESTED`) specifically to override awareness's "trust the publisher" default and stamp a server-authoritative `subject`. Two protocols cooperating to undo each other's defaults is a smell.

The killer sentence the model must survive:

```
When I see an online thing, I can explain who owns it, what exact thing it is,
whether it is live, what it can do, and what the UI should call it.
```

The roster model below answers each clause with one field and one source.

## One Sentence

```
Identity is server-owned and lives in a ROSTER pushed over the same WebSocket
that syncs the workspace doc: server-stamped subject, client-claimed install
id, and a static per-connection action key list.
```

## The Model

```
        subject (server-stamped, trust boundary, always present)
           │
           └─ owns ─┐
                    ▼
              replicaId (client-claimed, install-stable, flat string)
                    │
                    └─ advertises ─┐
                                    ▼
                              actionKeys (static per connection)
                                    │
                                    └─ described by ─┐
                                                      ▼
                                                ActionManifest
                                                (fetched on demand via
                                                 the describe-actions
                                                 runtime verb)

Liveness:    in the ROSTER  <=>  socket open
Trust:       subject        <=>  server says so
Address:     replicaId      <=>  client claimed, stable across reconnects
Capability:  actionKeys     <=>  declared at HELLO, frozen for connection
Permission:  PermissionDenied at invoke() time, separate axis from capability
```

### Invariants (locked)

1. **`actionKeys` are immutable for the lifetime of a connection.** To change them, close the WebSocket and reconnect. Captures the fact that `actionKeys` is already computed once at `openCollaboration` startup and frozen.
2. **`subject` is always populated** for any peer in the roster. The server adds a peer only after auth validation. If auth dies mid-connection, server closes the socket; the peer leaves the roster cleanly.
3. **`replicaId` is required, flat, and client-claimed.** The server does not vouch for it. Vouching for who you are is `subject`'s job.
4. **No `platform` field anywhere on the wire or in the public API.** If a future feature needs platform-shaped branching, that is a capability question and belongs in `actionKeys`.
5. **No `profile` / `display` / avatar in the core protocol.** Human-facing labels live in app-side Yjs tables keyed by `replicaId`.
6. **`clientID` is internal.** Address peers by `replicaId`. The Yjs awareness `clientID` (and the new server-minted `connId`) are not in the public `Peer` type.
7. **Capability and permission are separate channels.** `actionKeys` declares what code is loaded. `invoke()` failure declares what the caller is allowed to run.

## Wire Protocol

```
WIRE, BEFORE                            WIRE, AFTER
────────────────────────────            ────────────────────────────
ACTION_REQUEST  / RESPONSE              ACTION_REQUEST  / RESPONSE
RUNTIME_REQUEST / RESPONSE              HELLO        client -> server
AWARENESS                               ROSTER       server -> client
AWARENESS_ATTESTED                      ROSTER_DIFF  server -> client
SYNC_STEP1 / STEP2 / UPDATE             SYNC_STEP1 / STEP2 / UPDATE
```

Two envelope planes deleted: the awareness pair AND the runtime-request pair. The runtime plane had exactly one consumer (`describe-actions`); inlining the manifest in HELLO leaves it with zero consumers, so it goes too.

### HELLO (client -> server, exactly once after socket open)

```
{
  replicaId:      string,
  actionManifest: ActionManifest   // full JSON-Schema-bearing manifest
}
```

`actionKeys` is not on the wire. Clients derive it as `Object.keys(actionManifest).sort()` on receive for fast filtering.

### ROSTER (server -> client, once on connect)

```
{
  self:  ConnId,                 // the receiving client's own connId, so it can self-filter
  peers: RosterEntry[]           // includes self; client filters
}

RosterEntry = {
  connId:         string,           // server-minted, per-connection
  subject:        Subject,          // server-known from auth session
  replicaId:      string,           // from HELLO
  actionManifest: ActionManifest    // from HELLO
}
```

### ROSTER_DIFF (server -> client, on every roster mutation)

```
{
  joined?: RosterEntry[],
  left?:   ConnId[]
}
```

There is no `updated` shape. Action manifests are immutable per connection by invariant 1.

### Bandwidth analysis

Under the static invariant, each peer's manifest is sent **at most once per recipient per peer-existence window**. There is no awareness-style cadence or TTL refresh.

```
Typical manifest:          ~5-20 actions x ~500 bytes/schema = 2.5-10 KB
Worst realistic case:      10 peers, 10 KB manifests, one fresh join
  - joining peer:          downloads ~100 KB once
  - existing peers:        receive ~10 KB each, once
  - lifetime total / pair: bounded; cannot re-broadcast
```

A single Y.Doc snapshot dwarfs this. The wire cost is structurally negligible.

### Why inline (not on-demand)

```
SCENARIO                              INLINE         ON-DEMAND
─────────────────────────────────     ────────       ─────────
Consumer never reads manifest         pays ~10KB     pays 0
Consumer reads manifest once          pays ~10KB     pays ~10KB + RTT
Consumer needs synchronous routing    free           blocked on RTT
Wire plane count                      4              5
peer.describe() exists                no             yes (RTT-bound)
```

Inline pays a fixed, bounded bandwidth cost in exchange for deleting a whole wire plane (`RUNTIME_REQUEST` / `RUNTIME_RESPONSE`) and making capability discovery synchronous. The static invariant guarantees the cost cannot grow with time.

## Public API

```ts
// packages/workspace/src/document/peer.ts (after migration)

export type Subject = string;

export type Peer<TActions = unknown> = {
  readonly subject: Subject;                  // ALWAYS populated, never empty string
  readonly replicaId: string;
  readonly actionManifest: ActionManifest;    // full schema, available immediately
  readonly actionKeys: readonly string[];     // derived view of manifest keys, sorted

  invoke<TMap, TPath>(
    path: TPath,
    input: TMap[TPath]['input'],
    options?: RemoteCallOptions,
  ): Promise<Result<TMap[TPath]['output'], RemoteCallError>>;

  // peer.describe() is GONE. peer.actionManifest is the answer.
};

export type PeersSurface = {
  list(): Peer[];
  find<TActions>(replicaId: string): Peer<TActions> | undefined;
  observe(callback: () => void): () => void;
};
```

```ts
// packages/workspace/src/document/open-collaboration.ts (after migration)

openCollaboration(ydoc, {
  url,
  waitFor: idb.whenLoaded,
  openWebSocket,
  replicaId: createReplicaId({ storage: localStorage }),  // FLAT, was config.replica
  actions,
});
```

## What Disappears

```
packages/workspace/src/document/
  attach-awareness.ts          DELETE from openCollaboration usage
                               (file kept available for per-doc cursor UX later)
  attach-awareness.test.ts     UPDATE to test the standalone primitive only
  peer-identity.ts             COLLAPSE: Replica schema, Platform type, nested
                               peerAwarenessSchema.replica all gone
  internal/sync-supervisor.ts  DELETE peerMetadata + currentEnvelopeSubject
                               + handleRemoteAwarenessAttested + the
                               AWARENESS_ATTESTED switch branch
                               DELETE sendRuntimeRequest implementation
                               DELETE onRuntimeRequest config + dispatch
  peer.ts                      DELETE PeerLeftError + the dispatch() watchdog;
                               server returns PeerNotFound synchronously
                               DELETE peer.describe() method
                               DELETE PeerWireHooks.sendRuntimeRequest
  replica-id.ts                DELETE createReplicaIdAsync (sync variant suffices)

packages/sync/
  AWARENESS envelope kind + codec       DELETE
  AWARENESS_ATTESTED envelope kind      DELETE
  decodeAwarenessAttestedPayload        DELETE
  RUNTIME_REQUEST envelope kind         DELETE
  RUNTIME_RESPONSE envelope kind        DELETE
  RuntimeVerb type                      DELETE
  encodeRuntimeRequest/decodeRuntimeRequest  DELETE

packages/workspace/src/document/open-collaboration.ts:
  onRuntimeRequest config field         DELETE
  the entire onRuntimeRequest switch    DELETE (its one branch went into HELLO)
```

## What Appears

```
packages/sync/src/wire/
  HELLO        envelope kind + codec    NEW (~30 lines)
  ROSTER       envelope kind + codec    NEW
  ROSTER_DIFF  envelope kind + codec    NEW

packages/workspace/src/document/
  roster.ts                              NEW (~80 lines)
    createRosterMirror(supervisor)
      subscribes to ROSTER + ROSTER_DIFF
      exposes a Map<ConnId, RosterEntry>
      drives the existing peers surface signature
  internal/sync-supervisor.ts            REPLACE awareness wiring with HELLO
                                          send-on-connect and roster ingest

apps/api/src/sync-handlers.ts            NEW server-side roster:
                                            - per-DO Map<ConnId, RosterEntry>
                                            - HELLO ingest -> validate -> insert
                                              -> send ROSTER to new conn
                                              -> broadcast ROSTER_DIFF to others
                                            - onclose -> remove + broadcast LEFT
```

Net code: roughly flat in lines. Net conceptual weight: substantial reduction (one protocol instead of two, server-authoritative state, no join-at-read-time pattern).

## Public Surface Changes (caller migration)

```
// AWARENESS PAYLOAD
{ replica: { id, platform }, actionKeys }   ->   { replicaId, actionKeys }

// CONFIG
openCollaboration(ydoc, { ..., replica: { id, platform } })
  ->   openCollaboration(ydoc, { ..., replicaId })

// PEER FIELDS
peer.replica.id            ->   peer.replicaId
peer.replica.platform      ->   REMOVED
peer.clientID              ->   REMOVED from public type
peer.subject               ->   STILL THERE, now non-nullable Subject
peer.actionKeys            ->   STILL THERE, derived view of manifest keys
peer.actionManifest        ->   NEW: full manifest available synchronously
peer.describe()            ->   REMOVED (use peer.actionManifest)

// ERROR TYPES
PeerLeftError              ->   REMOVED (use RpcError.PeerNotFound)

// EXPORTS FROM packages/workspace
export { Replica, Platform }           ->   REMOVED
export type { PeerAwarenessState }     ->   REMOVED (no public schema anymore)
```

## Call Sites Affected

```
apps/fuji/blocks/daemon-route.ts       replica: { id, platform } -> replicaId
apps/fuji/src/lib/session.ts           same
apps/honeycrisp/blocks/script.ts       same
apps/honeycrisp/blocks/daemon-route.ts same
apps/honeycrisp/src/lib/session.ts     same
apps/opensidian/blocks/script.ts       same
apps/opensidian/blocks/daemon-route.ts same
apps/opensidian/src/lib/session.ts     same
apps/zhongwen/blocks/script.ts         same
apps/zhongwen/blocks/daemon-route.ts   same
apps/tab-manager/src/lib/device.ts     same
apps/api/src/sync-handlers.ts          rewrite for HELLO/ROSTER ingest
apps/api/src/sync-handlers.test.ts     update test fixtures

packages/cli/src/commands/up.ts        peer.replica.id -> peer.replicaId
                                       drop clientID printing
packages/workspace/src/daemon/app.ts   peer.replica -> peer.replicaId
                                       drop subject empty-string handling
packages/workspace/src/daemon/run-handler.ts   no change (already uses replicaId)
```

## Implementation Plan

This is a **single clean break** at the wire. No dual-protocol grace period. Pre-GA tolerates this; post-GA would not.

### Wave 1: Wire shapes and codecs (`@epicenter/sync`)

- [ ] Add `HELLO`, `ROSTER`, `ROSTER_DIFF` envelope kinds with arktype-validated payloads. HELLO and RosterEntry both carry the full `ActionManifest`.
- [ ] Remove `AWARENESS` and `AWARENESS_ATTESTED` envelope kinds and their codecs.
- [ ] Remove `RUNTIME_REQUEST` and `RUNTIME_RESPONSE` envelope kinds, the `RuntimeVerb` type, and their codecs.
- [ ] Update wire docs.

### Wave 2: Server-side roster (`apps/api`)

- [ ] In the workspace DO, maintain `Map<ConnId, RosterEntry>` per workspace.
- [ ] Validate auth at the Hono WS upgrade; attach `subject` to the connection.
- [ ] On HELLO: validate `replicaId` and `actionKeys` against `ACTION_KEY_PATTERN`; insert into roster; send `ROSTER` to the new conn; broadcast `ROSTER_DIFF { joined }`.
- [ ] On socket close: remove from roster; broadcast `ROSTER_DIFF { left }`.
- [ ] On `ACTION_REQUEST` whose target `connId` is not in the roster: return `RpcError.PeerNotFound` synchronously without relaying.
- [ ] Update `apps/api/src/sync-handlers.test.ts` fixtures.

### Wave 3: Client-side roster mirror (`packages/workspace`)

- [ ] Add `roster.ts` exporting `createRosterMirror` that subscribes to `ROSTER`/`ROSTER_DIFF` and exposes a `Map<ConnId, RosterEntry>` plus observer.
- [ ] Rewrite `peer.ts` `createPeersSurface` to read from the roster mirror instead of awareness states + peerMetadata.
- [ ] Drop `dispatch()` watchdog. `invoke()` returns server's `PeerNotFound` directly.
- [ ] Remove `PeerLeftError`.
- [ ] Update `Peer` type: `subject: Subject` (non-nullable), `replicaId: string`, `actionManifest: ActionManifest`, derived `actionKeys: readonly string[]`. Drop `clientID`, drop `replica`, drop `describe()`.
- [ ] Remove `onRuntimeRequest` config from `openCollaboration` and the entire runtime-verb switch.
- [ ] Remove `sendRuntimeRequest` from supervisor and `PeerWireHooks`.

### Wave 4: Collapse `Replica` to `replicaId`

- [ ] In `open-collaboration.ts`, change `config.replica: Replica` to `config.replicaId: string`.
- [ ] Delete the `Replica` arktype, `Platform` type, and `peerAwarenessSchema` (or shrink to a one-field HELLO validator scoped inside `roster.ts`).
- [ ] Remove `Replica` and `Platform` from `packages/workspace/src/index.ts` exports.
- [ ] Stop importing `y-protocols/awareness` from `open-collaboration.ts`. (The `attach-awareness.ts` file stays as an opt-in primitive for future per-doc cursor UX; it is no longer used by the collaboration primitive.)
- [ ] Drop `createReplicaIdAsync`; keep `createReplicaId`.

### Wave 5: Sweep call sites

- [ ] Update every `replica: { id, platform }` site listed in "Call Sites Affected."
- [ ] Update CLI/daemon log strings (`peer.replica.id` -> `peer.replicaId`; drop `clientID`).
- [ ] Update example in `packages/workspace/src/index.ts` JSDoc.
- [ ] Update `docs/architecture.md`.

### Wave 6: Tests

- [ ] Rewrite `peer.test.ts` against the roster mirror (no awareness mocks).
- [ ] Update `open-collaboration.test.ts` to assert HELLO is sent and ROSTER is consumed.
- [ ] Update or delete `attach-awareness.test.ts` depending on whether the primitive stays.
- [ ] Add new tests for `apps/api/sync-handlers` covering HELLO validation, ROSTER push, ROSTER_DIFF on join/leave, and PeerNotFound on invoke to absent connId.

### Wave 7: Post-implementation review

- [ ] Run the `post-implementation-review` skill: re-read every touched file, audit for stale comments referencing awareness/AWARENESS_ATTESTED/PeerLeft/`Replica`, confirm exports in `index.ts` match the new surface, confirm the killer sentence holds end-to-end.

## What This Closes (Honest Downsides)

1. **Live capability tuning by reconnect.** "User upgraded to Pro, now expose `pro_export_pdf`" requires the client to close and reopen the WebSocket. Acceptable; reconnects are cheap; subscription-state changes are infrequent. The right alternative for permission-gated UX is a separate `permittedActions` view, not mutating `actionKeys`.
2. **Runtime plugin loading.** Apps that install code at runtime need a reconnect for peers to see the new actions. Most plugin systems already require a restart at the module-resolution layer; reconnect on top is free.
3. **Hiding buttons by permission.** UIs that want to hide rather than show-and-fail can't use `actionKeys` for it. Either accept show-and-fail (recommended), or model permissions as a separate roster-side concern later.

These are bounded. None of them are current product features.

## What This Does Not Touch

```
Y.Doc sync protocol (SYNC_STEP1/2/UPDATE)   unchanged
attachIndexedDb / BroadcastChannel          orthogonal
attachTable / attachKv / attachTimeline     orthogonal
@epicenter/encryption                       orthogonal
ActionRegistry / defineQuery / defineMutation  unchanged
Action dispatch core in sync-supervisor     unchanged
```

The blast radius is scoped to the identity + presence layer. Resist the temptation to bundle adjacent cleanups.

## Open Questions

1. **`attachAwareness` as a public primitive going forward.** Keep it exported for future per-doc live-cursor UX, or delete outright? Recommend keep, drop from collaboration, document the per-doc use case in JSDoc.
2. **Roster on DO eviction.** DO storage vs. memory-only? Memory-only is correct (sockets die on eviction anyway), but confirm the eviction-then-reconnect path doesn't leave a stale roster snapshot for clients that reconnected to a respun DO.
3. **`connId` minting strategy.** Crypto-random 128-bit? Counter? Either works; pick one and document.
4. **Reconnection identity continuity.** Client reconnects with same `replicaId`; server treats it as a fresh peer (new `connId`, ROSTER_DIFF emits `left` for the old + `joined` for the new). Confirm this is the policy and document it.
5. **`subject` exposure cross-workspace.** If one client app opens connections to two workspaces, do both report the same `subject` value? They should (it's the better-auth user id). Verify before relying on it for cross-workspace UX.

## Migration Direction Summary

| Field / Concept     | Action     | Rationale                                                   |
| ------------------- | ---------- | ----------------------------------------------------------- |
| `Replica.platform`  | DELETE     | Zero readers in codebase                                    |
| `Replica` (object)  | FLATTEN    | One-field object; collapses to `replicaId: string`          |
| `Platform` type     | DELETE     | No consumers                                                |
| `Peer.clientID`     | INTERNAL   | Debug-only today; not part of the public model              |
| `Peer.subject`      | KEEP+TIGHTEN | Now non-nullable `Subject`, never empty string             |
| `Peer.actionKeys`   | KEEP       | Static per connection, advertised in HELLO                  |
| `AWARENESS` envelope| DELETE     | Replaced by `ROSTER`                                        |
| `AWARENESS_ATTESTED`| DELETE     | Subject lives in roster entry, server-authored             |
| `peerMetadata` map  | DELETE     | Roster replaces it; no join-at-read-time                   |
| `PeerLeftError`     | DELETE     | Server returns `PeerNotFound` synchronously                 |
| `createReplicaIdAsync` | DELETE  | Sync variant suffices; async init can run before open      |
| `attachAwareness`   | DEMOTE     | Opt-in per-doc primitive; not used by `openCollaboration`   |
| `ActionManifest`    | INLINE     | Rides HELLO/ROSTER; deletes the entire RUNTIME_REQUEST plane |
| `describe-actions`  | DELETE     | Zero consumers once manifest is inline                       |
| `peer.describe()`   | DELETE     | Replaced by `peer.actionManifest` (synchronous accessor)     |
| `RUNTIME_REQUEST/RESPONSE` | DELETE | Had one consumer; manifest inlining left it empty         |
