# Epicenter Sync Engine Host Composition

> **Status:** SUPERSEDED by `20260520T190000-cloud-workspace-app-instance-clean-break.md`
>
> This spec describes a direction that did not ship. The Cloud sync route shape that landed is `/workspaces/:workspaceId/apps/:appId/docs/:docId` with the App Namespace model (no `app_instance` table). The body below is preserved as historical context only and should not be used as a current-state reference.
>
> The host-composition boundary that this spec introduces (host owns auth and `roomName` construction; the engine receives an opaque `roomName`) is the part that T190000 builds on. What is now stale: the examples that show Epicenter Cloud building `subject:{user.id}:rooms:{room}` for `/rooms/:room`, and the claim that workspace-scoped room names are still a future migration target. They have shipped as `v1:workspace:{workspaceId}:app:{appId}:doc:{docId}` behind `/workspaces/:workspaceId/apps/:appId/docs/:docId`.

**Date**: 2026-05-20
**Status**: Superseded (host-composition boundary retained by T190000; concrete Cloud examples below are stale)
**Author**: AI-assisted

## Overview

Epicenter sync should move down one abstraction layer: the core package should expose a sync engine that host applications compose into their own routes, not a full relay server that owns auth hooks, billing hooks, or product policy.

Epicenter Cloud, a solo self-host server, and an enterprise host should all call the same HTTP sync helper and room backend contract. They differ in route ownership, authentication, billing, policy, and room-name construction. The room backend owns live Yjs room mechanics; the sync engine owns HTTP sync and snapshot response framing.

## One Sentence

Epicenter Sync is host composition around an authorized room name: the host owns policy and naming, the room backend owns live Yjs mechanics, and the sync engine owns HTTP sync responses.

Shorter versions:

```txt
Host routes decide who may enter. Room backends decide how rooms run. SyncEngine formats HTTP sync responses.

The room backend owns Yjs mechanics. The host owns policy.

Move the boundary down one layer: compose routes around an engine, not hooks into a relay.
```

## Current State

> [SUPERSEDED] This "Current State" snapshot pre-dates T190000. Today, `apps/api/src/app.ts` resolves `/workspaces/:workspaceId/apps/:appId/docs/:docId`, checks Better Auth membership, and builds `v1:workspace:{workspaceId}:app:{appId}:doc:{docId}` before calling the sync engine. The subject-scoped `/rooms/:room` handler still exists, but only for non-Cloud personal-room and daemon compatibility, not as the main Cloud sync surface.

The current Cloudflare API already has the rough shape, but the boundary is not named as a reusable engine yet.

```txt
apps/api/src/app.ts
  authenticates /rooms/*
  resolves c.var.user
  builds a subject-scoped Durable Object room name
  forwards HTTP sync, WebSocket upgrade, and dispatch to Room

apps/api/src/room.ts
  trusts the Worker boundary
  owns Yjs document state
  owns WebSockets
  owns awareness
  owns dispatch correlation
  owns Durable Object persistence
```

That is close to the desired ownership split:

```txt
Host route:
  auth
  policy
  billing
  route errors

Room runtime:
  Yjs sync
  persistence
  awareness
  dispatch
```

The missing abstraction is the reusable layer between them.

## Why Not Hooks

Hooks feel attractive when a generic relay wants to stay policy-free while still reporting stateful effects back to the host.

```ts
createSyncRelay({
  resolveAccess,
  onRoomAccess,
  onStorageBytesChanged,
  onDisconnect,
});
```

That shape is a smell here. It means the relay owns the effect while the host owns the decision.

```txt
host owns billing
relay observes bytes

host owns revocation
relay owns open sockets

host owns deletion policy
relay owns stored updates
```

The cleaner model is composition:

```ts
const access = await requireRoomAccess(c);
const result = await sync.handleHttpSync(c.req.raw, {
  roomName: access.roomName,
});

await recordUsage({
  subject: access.subject,
  room: access.room,
  storageBytes: result.storageBytes,
});

return result.response;
```

The hook disappears because the host route is the composer.

## Architecture

```txt
Browser SPA
  IndexedDB
  live Yjs docs
  encryption keys
  offline edits
      |
      v
Host route
  auth
  policy
  billing
  route errors
      |
      v
SyncEngine
  HTTP sync response framing
  snapshot response framing
      |
      v
Room backend
  Cloudflare Durable Object
  local process
  test in-memory runtime
  WebSocket sync
  awareness
  dispatch
  room persistence
```

The engine has no idea whether the host used Better Auth, a reverse proxy, a shared secret, or enterprise IAM. It receives an already-authorized room name.

## Proposed Surface

```ts
export function createSyncEngine(
  rooms: SyncHttpRooms,
  options?: {
    maxPayloadBytes?: number;
  },
) {
  return {
    async handleHttpSync(
      request: Request,
      input: {
        roomName: string;
      },
    ) {
      // Decode sync request, route to room, and return response + metering.
      return {
        response,
        storageBytes,
      };
    },

    async getSnapshot(roomName: string) {
      // Return encoded Yjs state for bootstrap.
    },
  };
}
```

The engine depends on room infrastructure, not auth infrastructure.

```ts
type SyncHttpRooms = {
  sync(roomName: string, update: Uint8Array): Promise<{ diff: Uint8Array | null; storageBytes: number }>;
  getDoc(roomName: string): Promise<{ data: Uint8Array; storageBytes: number }>;
};

type SyncRooms = SyncHttpRooms & {
  handleWebSocket(roomName: string, request: Request): Promise<Response>;
  dispatch(roomName: string, request: DispatchRpcRequest): Promise<DispatchResult>;
};
```

This is the small surface area:

```txt
roomName =
  opaque sync address
  built by the host after access has already been checked

rooms.sync(roomName, update) =
  apply one HTTP sync request body to that room
  return the room's reply bytes, if the caller is missing anything
  return storageBytes as a mechanical observation for the host

rooms.getDoc(roomName) =
  read the current encoded Yjs document state for that room
  return storageBytes with the read so the host can record durable footprint

sync.handleHttpSync(request, { roomName }) =
  enforce HTTP-level limits such as max payload size
  read request bytes
  call rooms.sync(roomName, bytes)
  turn the result into an HTTP Response
  return storageBytes beside the Response

sync.getSnapshot(roomName) =
  call rooms.getDoc(roomName)
  wrap the encoded document bytes in an HTTP Response
  return storageBytes beside the Response
```

`handleHttpSync` is the one-shot POST path. A client sends a compact Yjs sync
request that says, "here is what I know, give me what I am missing, and accept
my update if I have one." The engine does not interpret ownership. It only
checks the request size, forwards bytes to the selected room, and maps the
room's answer to either `200 application/octet-stream` or `204 No Content`.

`getSnapshot` is the bootstrap read path. A client or tool asks for the current
encoded room state without opening a live WebSocket. The room backend still owns
how that state is stored and encoded; the engine only makes it an HTTP
response.

The exact method names can change during implementation. Phase 1 keeps the Cloudflare WebSocket upgrade as a raw `Request`, so `Room.upgrade()` still reads `installationId` from the URL. The important constraint is that the engine receives a resolved `roomName`, not a user session or auth client.

Phase 1 follow-up decision: the internal `SyncRooms` contract takes `roomName`
on each backend method instead of returning a per-room object. That keeps the
runtime path honest: the backend resolves the named room and performs one
operation. There is no room object lifecycle, cache, or reusable instance owned
by the engine today.

Second follow-up decision: pass-through WebSocket and dispatch methods do not
belong on `createSyncEngine`. Host routes call the room backend directly for
those capabilities. `createSyncEngine` depends only on `SyncHttpRooms` and stays
focused on HTTP sync response construction and snapshot response construction.

## Host Composition

### Epicenter Cloud

> [SUPERSEDED] The Epicenter Cloud example below shows the pre-T190000 subject-scoped composition. The current Cloud composition mounts `/workspaces/:workspaceId/apps/:appId/docs/:docId`, runs the Better Auth organization membership check in the resolver, and builds `v1:workspace:{workspaceId}:app:{appId}:doc:{docId}`. The host-composition boundary (host builds `roomName`, engine receives it opaquely) is the part that carries forward; the route path and room-name format below are stale.

```ts
const rooms = cloudflareDurableObjectRooms(c.env.ROOM);
const sync = createSyncEngine(rooms);

app.use('/rooms/*', requireOAuthUser);

app.post('/rooms/:room', async (c) => {
  await requireBillingAllowsSync(c);

  const roomName = `subject:${c.var.user.id}:rooms:${c.req.param('room')}`;
  const result = await sync.handleHttpSync(c.req.raw, { roomName });

  c.var.afterResponse.push(
    recordSyncUsage({
      userId: c.var.user.id,
      room: c.req.param('room'),
      storageBytes: result.storageBytes,
    }),
  );

  return result.response;
});
```

Epicenter Cloud owns Better Auth, billing, Postgres metadata, room-name construction, and route errors. The room backend owns the live Yjs mechanics. The sync engine owns the HTTP response shape for sync and snapshots.

### Solo Self-Host

```ts
const rooms = localRooms({ dir: './.epicenter/sync' });

app.all('/rooms/:room/*', async (c) => {
  if (!hasSharedSecret(c.req.raw)) {
    return new Response('Unauthorized', { status: 401 });
  }

  return rooms.handleWebSocket(
    `subject:solo:rooms:${c.req.param('room')}`,
    c.req.raw,
  );
});
```

This mode can be intentionally small. It is for one person or a tiny trusted group. It should not pretend to support enterprise revocation.

### Enterprise Host

```ts
app.get('/rooms/:room', async (c) => {
  const user = await enterpriseIam.requireUser(c.req.raw);
  const allowed = await enterpriseAcl.canSyncRoom({
    user,
    room: c.req.param('room'),
  });

  if (!allowed) return new Response('Forbidden', { status: 403 });

  return rooms.handleWebSocket(
    `subject:${user.tenantScopedId}:rooms:${c.req.param('room')}`,
    c.req.raw,
  );
});
```

The enterprise app keeps its IAM, database, audit policy, and SSO model. Epicenter sync does not import those concepts.

## Room Name Scope

> [SUPERSEDED] The "Current Epicenter Cloud should keep personal owner-scoped rooms" recommendation below was overtaken by T190000. The current Cloud room name is `v1:workspace:{workspaceId}:app:{appId}:doc:{docId}`, and the workspace-scoped room name (`workspace:{workspaceId}:docs:{docId}`) shown as a future migration target later in this section has shipped, in App Namespace form. Treat the section below as historical justification for the host-builds-`roomName` boundary, not as current naming guidance.

`roomName` is the sync address after the host has already made the access decision. The sync engine treats it as opaque.

Current Epicenter Cloud should keep personal owner-scoped rooms:

```txt
subject:{subject}:rooms:{room}
```

That name says only this:

```txt
the current host has authorized this subject to open this room
```

It does not say the product has organizations, team workspaces, grants, workspace transfer, or enterprise custody. Those are larger product invariants and should not be smuggled into the sync engine.

Solo self-host can use the same shape with a local subject:

```txt
subject:solo:rooms:{room}
```

It can also choose a simpler local-only name if the host truly has one owner:

```txt
rooms:{room}
```

Enterprise self-hosting does not require org-scoped rooms in the engine. The first enterprise isolation boundary can be the deployment itself:

```txt
Acme deployment
  auth issuer
  database
  room backend
  asset storage
```

If one deployment hosts several enterprise customers, the host can choose a customer-scoped room name outside the engine:

```txt
customer:{customerId}:subject:{subject}:rooms:{room}
```

If Epicenter later ships real team workspaces, room names can move to workspace scope only after workspace rows, workspace access checks, and migration rules exist:

```txt
workspace:{workspaceId}:docs:{docId}
```

Until then, workspace-scoped room names are a future migration target, not the current Cloud contract.

## Terms

```txt
token =
  network credential used by a host route
  short-lived when possible
  does not decrypt workspace data

RelayAccess =
  optional host-level result saying this request may open a subject + room
  not required by SyncEngine if the host builds roomName directly

keyring =
  versioned encryption material used to open encrypted local workspace data
  cached for offline use
  never sent as WebSocket auth

workspace encryption key =
  derived from keyring + workspaceId
  encrypts CRDT values
  not a token and not a room credential

passphrase =
  human input used to unlock or prove possession
  may mint access in solo self-host mode
  should not be passed through the sync protocol as raw auth

roomName =
  internal sync namespace
  opaque to SyncEngine
  should already include whatever owner, subject, customer, or workspace scoping the host has proven
```

## Design Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Core abstraction | Host composition plus `createSyncEngine` for HTTP sync responses | It removes policy hooks by making the host route the composer. |
| Auth ownership | Host route | Better Auth, enterprise IAM, and self-host secrets are host concerns. |
| Room access | Resolved before engine call | The engine receives `roomName`, not sessions or users. |
| Room-name scope | Host-owned | Personal Cloud can use subject scope, self-host can use local scope, enterprise can use deployment or customer scope, and future workspace scope needs real workspace access checks first. |
| Metering | Return values, not hooks | The host can record usage after engine calls. |
| Deletion | Deferred room backend method | Keep deletion out of Phase 1 until an admin route needs it. |
| Token verifier | Not in v1 engine | Token verification belongs to the host route unless we build a separate relay process. |
| Room boundary | One Yjs doc room | A Durable Object per Yjs doc is the clean Cloudflare boundary. |
| WebSocket room method | `rooms.handleWebSocket(roomName, request)` | The room backend names the capability it needs; the Cloudflare adapter owns the `fetch(request)` bridge. |
| Read-only mode | Deferred | Write access is the only v1 sync capability. |

## What This Refuses

```txt
No Better Auth imports in SyncEngine.
No org, team, customer, workspace, or grant model in SyncEngine.
No grant tables in SyncEngine.
No callback hooks for billing or policy.
No signed relay token issuer in v1.
No read-only collaboration in v1.
No user profile, email, or display name in room runtime.
```

These can be built in host applications or in a later packaged relay. They should not enter the engine.

## Implementation Plan

### Phase 1: Extract Engine Shape From `apps/api`

- [x] **1.1** Create a sync engine module near the existing room route code.
- [x] **1.2** Move HTTP sync request handling behind `sync.handleHttpSync(...)`.
- [x] **1.3** Keep WebSocket upgrade forwarding behind the room backend capability.
- [x] **1.4** Keep `requireOAuthUser` and billing checks in `apps/api/src/app.ts`.
- [x] **1.5** Return metering data from engine calls instead of adding callbacks.
- [x] **1.6** Add tests proving auth stays outside the engine.
- [x] **1.7** Rename the internal WebSocket room capability away from Durable Object `fetch(request)`.

Phase 1 note: the first implementation keeps the boundary inside `apps/api`.
`app.ts` still resolves the subject-scoped room name and records Postgres usage.
`sync-engine.ts` only receives `roomName` for HTTP sync and snapshot response
construction. WebSocket upgrades and dispatch now call the room backend directly.

Write-through metering is deferred. Phase 1 returns `storageBytes`, the durable
measurement the host can record today. If write-throughput billing becomes
necessary, it should be measured at the persistence boundary rather than naming
incoming update bytes as written bytes.

Billing stance: bill durable footprint before sync churn. Epicenter Cloud can
periodically aggregate room `storageBytes`, asset or blob storage, and other
host-owned storage facts outside the engine. Incoming sync traffic and persisted
update bytes may still be useful for diagnostics, abuse detection, or cost
analysis, but they should not become billing fields until the product model
needs them and the persistence layer can measure them honestly.

Adapter stance: crossws stays a future runtime adapter candidate. It should not
become the core sync engine contract unless a second runtime proves that shape.
For now, `apps/api` keeps one Cloudflare adapter around the Durable Object room.

### Phase 2: Prove Package Pressure Before Extraction

- [ ] **2.1** Identify a second real host or runtime that would share the engine code.
- [ ] **2.2** Prove that host shares behavior beyond HTTP response framing.
- [ ] **2.3** Decide whether raw `Request` WebSocket forwarding survives outside Cloudflare.
- [ ] **2.4** Extract only after the second runtime proves the package contract.

### Phase 3: Self-Host Host Routes

- [ ] **3.1** Add a minimal solo self-host example with a shared-secret route guard.
- [ ] **3.2** Keep passphrase or shared-secret handling outside the engine.
- [ ] **3.3** Show how a host maps `{ subject, room }` into `roomName`.
- [ ] **3.4** Keep enterprise examples deployment-scoped or host-scoped until an actual multi-tenant control plane exists.

### Phase 4: Optional Packaged Relay

- [ ] **4.1** Build a convenience relay server only after the engine boundary is proven.
- [ ] **4.2** Add signed capability tokens only for separate-process relay deployment.
- [ ] **4.3** Keep same-process host composition as the preferred integration.

## Open Questions

1. What exact workspace access model, migration plan, and product route justify moving from subject-scoped personal rooms to workspace-scoped room names?
2. Should `handleWebSocket` read `installationId` from the URL, headers, or a parsed input supplied by the host route?
3. Should dispatch stay on the room backend, or should live-device RPC become a separate backend capability beside sync?
4. What second runtime would prove package extraction is safer than staying inside `apps/api`?
5. Should WebSocket sync eventually report storage observations, or should
   storage metering stay tied to HTTP sync and periodic host-side measurement?

## Working Rule

When a hook appears, ask whether the host route should own the surrounding control flow instead.

```txt
If host owns the decision:
  host route should call the engine

If room backend owns the live mechanism:
  engine method should return the data the host needs

If both seem true:
  the boundary is probably one layer too high
```
