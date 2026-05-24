# Workspace Capsule Clean Break

> **Status:** SUPERSEDED by `20260520T190000-cloud-workspace-app-instance-clean-break.md`
>
> This spec describes a direction that did not ship. The Cloud sync route shape that landed is `/me/apps/:appId/docs/:docId` with the App Namespace model (no `app_instance` table); the server resolves the default workspace from the auth token, so the client never names a workspaceId. The body below is preserved as historical context only and should not be used as a current-state reference.
>
> Specifically: the canonical model uses App Namespace (`workspaceId + appId`) as the workspace-local sync namespace, not App Instance. `workspaceId` is Better Auth `organization.id` in phase 1, no `cloud_workspace` row is added, and `/rooms/:room` is no longer the current Cloud sync path (it remains only for non-Cloud personal-room and daemon compatibility). The capsule pressure test below still illustrates why a smaller-than-Workspace app data boundary must exist, but read it as historical motivation, not current implementation guidance.

**Date**: 2026-05-20
**Status**: Superseded (historical)

Revision note, 2026-05-20: `specs/20260520T190000-cloud-workspace-app-instance-clean-break.md` supersedes this spec for Cloud product naming. The capsule pressure test still applies, but the Cloud data capsule is now App Namespace (`workspaceId + appId`), not an `app_instance` row and not the top-level Cloud Workspace. Read this spec as the local and portability argument for why there must be a smaller app data boundary below the Cloud Workspace.

> [SUPERSEDED] The "keep subject-scoped `/rooms/:room` for now" stance below was overtaken by T190000. The current Cloud sync route is `/workspaces/:workspaceId/apps/:appId/docs/:docId`; `/rooms/:room` survives only as non-Cloud personal-room and daemon compatibility, not as the active Cloud product route.

Current sync-room decision (historical, no longer accurate): keep subject-scoped `/rooms/:room` for now. Do not add org-scoped rooms. Do not move to workspace-scoped Room names until the host has real workspace access checks. When that future route exists, the host builds the Room Durable Object name after authorization.

## One Sentence

Epicenter Workspaces are portable app-data capsules: a Workspace gives apps a shared storage, sync, key, asset, sharing, and export boundary, while each app owns its own Yjs document graph.

## Overview

This spec replaces the Realm-centered boundary with a Workspace-centered capsule. It removes Realm and Tenant from the product model, keeps Deployment as the runtime host, and treats Epicenter as the decoupled data layer for many apps.

The small product model is:

```txt
Workspace
  -> Apps
      -> App data
```

The small data model is:

```txt
Workspace
  -> app entry docs
      -> app-owned Yjs docs
  -> assets
```

The runtime model is:

```txt
Yjs doc id
  -> Room
      -> Durable Object, cloud
      -> local room process, self-host
```

Do not explain the product with `AppInstallation`, `SyncUnit`, `SyncStream`, `Replica`, `RoomActor`, or `app_doc`. Those names make the implementation feel larger than the product. If a future registry exists, describe it as an index or inventory, not as the thing that makes app data real.

## Current Evidence

> [SUPERSEDED] This section described pre-T190000 state. Current hosted Cloud sync is no longer subject-scoped: the active route is `/workspaces/:workspaceId/apps/:appId/docs/:docId` with internal room name `v1:workspace:{workspaceId}:app:{appId}:doc:{docId}`. The subject-scoped DO name shown below remains only in the `/rooms/:room` compatibility handler.

Current hosted sync is subject-scoped. `/api/session` returns the Better Auth user id as the local identity subject:

```ts
localIdentity: {
  subject: user.id,
  keyring: await deriveSubjectKeyring(user.id),
}
```

`apps/api/src/app.ts` builds Room Durable Object names from that subject:

```ts
const doName = `subject:${c.var.user.id}:rooms:${room}`;
```

`apps/api/src/room.ts` is already the right runtime atom. One Room owns one Y.Doc, WebSocket lifecycle, awareness liveness, dispatch correlation, HTTP sync, SQLite update-log persistence, bootstrap, cleanup, and compaction.

Hosted assets are user-owned today:

```txt
asset.user_id -> user.id
R2 key        -> {userId}/{assetId}
public URL    -> /api/assets/{userId}/{assetId}
```

Local project layout already points toward data capsules, but the current helper uses `workspaceId` to mean `ydoc.guid`:

```txt
.epicenter/yjs/<workspaceId>.db
.epicenter/sqlite/<workspaceId>.db
.epicenter/md/<workspaceId>/
```

Current encryption also treats `ydoc.guid` as the workspace id. `attachEncryption()` derives the keyring from `ydoc.guid`, and encrypted IndexedDB uses that guid in AAD.

Whispering currently has one app entry Y.Doc:

```ts
const ydoc = new Y.Doc({ guid: 'whispering', gc: true });
const tables = attachTables(ydoc, whisperingTables);
const kv = attachKv(ydoc, whisperingKv);
```

That Y.Doc contains five normalized tables and about forty synced KV settings. Tauri persistence adds IndexedDB, BroadcastChannel, and a markdown materializer for recording files. The materialized files are not the portable source of truth.

External grounding:

```txt
Cloudflare Durable Objects:
  good fit for one active document each
  isolated storage per object
  WebSocket hibernation is compatible with this shape
  no production API should be treated as an app-level export inventory

Yjs:
  portable document state can be encoded as an update and applied to a fresh Y.Doc
  V2 updates are smaller but require V2-aware importers
  awareness is live presence, not durable document state
  doc.guid is metadata, not the CRDT synchronization identity

Better Auth organizations:
  useful for auth, membership, invitations, teams, and policy
  should not become the owner of Epicenter app data
```

## Problems

1. **Subject ownership does not match portability**: `subject:{userId}:rooms:{room}` says data belongs to a user account. A portable capsule needs `workspace:{workspaceId}:docs:{docId}`.
2. **`ydoc.guid` is doing too many jobs**: it names local storage, sync rooms, encryption domains, and sometimes "workspace". Shared workspaces and multi-doc apps need separate Workspace identity and document identity.
3. **Hosted assets are outside the Workspace**: user-owned asset rows and R2 keys cannot express team ownership, Workspace export, or host-independent import.
4. **Complete export is not currently knowable**: Durable Objects are not a production inventory. Yjs app graphs may include child docs the platform has not seen unless the app exports them or an observed index exists.
5. **A mandatory per-doc registry would overcorrect**: requiring every child Y.Doc to be registered before it exists would make offline creation a control-plane problem.
6. **Encryption is not yet a sharing model**: subject-derived keys work for personal data, but they do not explain password unlock, device grants, member grants, import, or key rotation.

## Desired State

Use this explanation stack:

```txt
Product model
  Workspace
    Apps
      App data

App data model
  app entry docs
    app-owned child docs
    app-owned references between docs

Runtime model
  doc id
    Room
      Durable Object, cloud
      local room process, self-host
```

Short rules:

```txt
Workspace owns the capsule.
Apps own their data graph.
Assets are workspace-scoped.
Room owns live sync for one doc id.
Deployment owns runtime access, policy checks, and storage adapters.
Archive is the runtime-independent portable representation.
```

## Chosen Model

Choose **Workspace capsule plus app-owned graph plus app export adapter plus optional observed inventory**.

```txt
Workspace
  id
  name
  key envelope metadata
  app entry points
  assets
  optional observed inventory

App
  stable app id
  entry doc strategy
  export adapter, when needed for complete export

Document
  doc id scoped by workspace at runtime
  Yjs state payload
  optional app-owned references to other docs

Deployment
  auth issuer
  sessions
  memberships and policy checks
  Room runtime
  object storage adapter
  control database
```

This keeps the product small without lying about export. A full Workspace export is only complete when enumeration is complete. Enumeration can come from app export adapters, an observed inventory, or a later mandatory registry. Phase 1 should not pretend otherwise.

## Rejected Models

### Mandatory Registry

```txt
workspace
  -> workspace_app
      -> registered_doc
      -> registered_asset
```

This model gives the best server-side export, quota, delete, and admin story. It is too much for phase 1 because offline child-doc creation must now register with the platform before app state can be complete.

Keep this as an enterprise or admin-control option, not the first invariant.

### Archive As Live Source

```txt
archive manifest
  -> docs
  -> assets
  -> key envelope
```

This makes backup and restore clean, but it is a poor live runtime model. Cloudflare Rooms and local sync need hot append logs and WebSockets, not a zip-like source of truth.

Keep the archive format strong. Do not make it the live control database.

### Deployment-Owned Workspace

```txt
deployment workspace row
  -> deployment docs
  -> deployment assets
```

This is easiest to implement from today's subject-scoped code, but it weakens the main promise. Moving a Workspace between hosts becomes a migration between deployments instead of importing the same portable capsule.

Reject this as the product model. Deployment owns runtime control, not portable identity.

### App-Pack Capsules As The Core

```txt
workspace shell
  -> app capsule
      -> app manifest
      -> app docs
      -> app assets
```

This works well for one-app exports, including Whispering, but it fragments the whole-Workspace guarantee. It is useful as an app export adapter shape, not as the top-level product model.

## Pressure Tests

| Scenario | Result |
| --- | --- |
| Personal power user | One owner, one default Workspace, derived app roots, and workspace-scoped assets are enough. No team policy required. |
| Team workspace | Workspace remains the data boundary. Deployment stores membership and wraps the workspace key for each member or device. Organization policy may sit above it later. |
| Whispering-only workspace | One app entry Y.Doc is enough for tables and KV. Audio blobs and materialized markdown must be represented as assets or derived files, not hidden inside the doc. |
| Cloudflare-hosted | `/workspaces/:workspaceId/docs/:docId` can route to one Room Durable Object per active doc. The Worker checks workspace access before calling the Room. |
| Local self-hosted | A local control database can store users, sessions, workspaces, and memberships. Workspace data can live in a portable folder with docs and assets. |
| Archive import/export | Archive is runtime-independent. Complete export requires complete enumeration. Incomplete enumeration must be called best-known export, not full export. |

## Non-Goals

These are deliberately out of scope for the first implementation wave:

- Do not introduce Realm or Tenant as product nouns.
- Do not add a platform root Y.Doc.
- Do not require every Y.Doc to have a control-plane row before it can sync.
- Do not make a Durable Object equal a Workspace.
- Do not make one Y.Doc equal a Workspace.
- Do not use Cloudflare Durable Object storage as the archive format.
- Do not use local SQLite database files as the portable archive format.
- Do not treat observed inventory as authorization.
- Do not promise complete export unless app adapters or inventory coverage prove it.
- Do not put live auth policy only inside app Yjs state.
- Do not make Better Auth organizations the owner of Epicenter app data.
- Do not implement full quota, orphan cleanup, admin export, or revocation as phase 1 requirements.

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Portable boundary | 2 coherence | Workspace | Workspace is the data capsule. It can own identity, keys, assets, export, app entries, and future sharing without becoming one Y.Doc. |
| Runtime boundary | 2 coherence | Deployment | Deployment is where code runs, sessions are minted, storage adapters live, and policy checks happen. It is replaceable. |
| App data graph | 2 coherence | App-owned Yjs graph | Apps already know their own child docs through app state. The platform should not duplicate that graph in phase 1. |
| App entry strategy | 2 coherence | Derived entry first | A stable app entry doc can be derived from `{ workspaceId, appId }`. Store app entries later if installed-app listing or app settings need it. |
| Per-doc registry | Deferred | Optional observed inventory first | A registry helps export, cleanup, quota, and admin tooling, but makes offline creation harder. |
| Archive root metadata name | Deferred | `workspace.json` is the working example | The name is not architecturally important yet. Use examples with `workspace.json`, but mark it as tentative until archive tooling exists. |
| Archive doc payload | 1 evidence | Yjs V2 state update by default | Current Room and local log compaction already use V2. Keep a `format` field so V1 can be supported for compatibility if needed. |
| Awareness export | 1 evidence | Do not export | Awareness is live presence and liveness, not durable Workspace data. |
| Asset ownership | 2 coherence | Workspace-scoped assets | Assets must move, unlock, share, and export with the Workspace. |
| Encryption boundary | Deferred | Workspace key envelope | The spec chooses the boundary, not the full cryptographic UX. Product decisions remain for password recovery, member removal, and organization custody. |
| Sharing boundary | 2 coherence | Workspace | Sharing one app doc at a time is a later feature. The base model shares a Workspace. |
| Better Auth organizations | Deferred | Policy layer only | Organizations can supply membership and RBAC context later. They should not own Workspace data. |
| WorkspaceCoordinator Durable Object | Deferred | Not phase 1 | It may help export jobs, key rotation, quota, or bulk delete. It should not proxy hot sync frames. |

## Identity

Workspace identity is portable. Deployment identity is local to a host.

```txt
workspaceId:
  stable logical identity inside the capsule
  stored in archive metadata
  preserved on trusted restore when the host has no collision
  regenerated on fork, duplicate import, or collision

workspace name:
  user-facing label
  can change without changing identity

archive filename:
  transport convenience
  never trusted as identity

docId:
  app-chosen document identity inside a Workspace
  scoped by workspace at runtime
  may repeat in different workspaces
```

Import rules:

```txt
restore:
  preserve workspaceId when importing back into the same trust context

fork:
  create a new workspaceId and keep old id as importedFromWorkspaceId metadata

collision:
  ask or fork by default

team to personal:
  import data only if the user can unwrap the workspace key and has export rights
  drop live membership policy unless the target host can represent it

personal to team:
  preserve data identity only if the team import is an ownership transfer
  otherwise fork
```

## App Entry Strategy

Phase 1 should derive app entries by convention:

```txt
entryDocId(workspaceId, appId) = app:{appId}:root
```

The doc id is scoped by the Workspace route, so it does not need to embed `workspaceId`.

```txt
/workspaces/ws_personal/docs/app:whispering:root
/workspaces/ws_personal/docs/app:tab-manager:root
```

This is not a universal claim that every app has one primary doc forever. It is just an entry strategy.

Apps can choose:

```txt
one doc:
  Whispering today
  Tab Manager may fit here

entry plus children:
  root doc stores stable ids
  rows reference child doc ids

many peer docs:
  app shards by project, account, month, or natural content boundary

local-only docs:
  app uses Yjs locally without opening a remote Room
```

Store `workspace_app` later only when a product surface needs installed-app listing, app display names, app settings, app removal, or admin controls.

## Enumeration

The platform needs to distinguish app truth from export planning.

```txt
App graph:
  authoritative references inside app state

Observed inventory:
  derived facts from sync and storage events

Registry:
  mandatory control-plane declarations
```

Choose this first-wave model:

```txt
complete export:
  app export adapter enumerates app docs and assets
  plus observed inventory fills in docs the app has opened remotely
  plus asset table lists workspace assets

best-known export:
  platform exports entry docs, observed docs, and known assets
  output metadata says enumeration was incomplete
```

An observed inventory may contain:

```txt
observed_doc
  workspace_id
  doc_id
  app_id, optional
  first_seen_at
  last_seen_at
  storage_bytes, optional
  deleted_at, optional
  source = sync | import | app-export
```

Rules:

```txt
Observation is not registration.
Observation is not authorization.
Missing from observed_doc does not mean nonexistent.
Present in observed_doc does not mean still referenced by app state.
```

Move to a mandatory registry only if a concrete feature needs server-side completeness more than offline child-doc creation:

```txt
admin export
quota by app
bulk delete by app
orphan cleanup
per-doc revocation
legal hold
```

## Archive Shape

The archive is a portable representation of logical Workspace data. It is not a dump of Cloudflare storage or local SQLite files.

Working example:

```txt
workspace-capsule.zip
  workspace.json
  keys.json
  docs/
    app:whispering:root.yjsv2
    doc_transcript_123.yjsv2
  assets/
    asset_abc.meta.json
    asset_abc.blob
  apps/
    whispering/
      export.json
  inventory.json
```

`workspace.json` example:

```json
{
  "format": "epicenter.workspace-capsule",
  "version": 1,
  "workspaceId": "ws_personal_01",
  "name": "Personal",
  "createdAt": "2026-05-20T20:00:00.000Z",
  "exportedAt": "2026-05-20T21:30:00.000Z",
  "apps": [
    {
      "appId": "whispering",
      "entryDocId": "app:whispering:root",
      "enumeration": "complete"
    }
  ],
  "docs": [
    {
      "docId": "app:whispering:root",
      "path": "docs/app%3Awhispering%3Aroot.yjsv2",
      "format": "yjs-update-v2",
      "sha256": "..."
    }
  ],
  "assets": [
    {
      "assetId": "asset_abc",
      "metadataPath": "assets/asset_abc.meta.json",
      "blobPath": "assets/asset_abc.blob",
      "sha256": "..."
    }
  ]
}
```

`keys.json` example:

```json
{
  "format": "epicenter.workspace-keys",
  "version": 1,
  "workspaceId": "ws_personal_01",
  "encrypted": true,
  "workspaceKey": {
    "algorithm": "xchacha20-poly1305",
    "wrappings": [
      {
        "type": "password",
        "kdf": "argon2id",
        "salt": "...",
        "wrappedKey": "..."
      },
      {
        "type": "member",
        "subject": "user_123",
        "wrappedKey": "..."
      }
    ]
  }
}
```

Asset metadata example:

```json
{
  "assetId": "asset_abc",
  "contentType": "audio/mpeg",
  "sizeBytes": 1234567,
  "originalName": "meeting.mp3",
  "createdAt": "2026-05-20T20:05:00.000Z",
  "sha256": "...",
  "encrypted": true
}
```

Deferred archive decisions:

```txt
root metadata filename:
  use workspace.json in examples, decide when tooling lands

doc file extension:
  use .yjsv2 in examples, keep format field authoritative

checksums:
  inline in workspace.json for now
  content-addressed blobs remain an option

inventory naming:
  inventory.json is the working name
  catalog or manifest are still acceptable if implementation makes that clearer
```

## Export And Import

Export flow:

```txt
1. Read workspace metadata.
2. Ask each app export adapter for docs, assets, and completeness.
3. Add observed docs when adapter output is missing or partial.
4. Encode each Y.Doc as a portable state update.
5. Write workspace asset metadata and blobs.
6. Write key envelope metadata.
7. Write inventory and completeness markers.
```

Import flow:

```txt
1. Read workspace.json and keys.json.
2. Resolve preserve, fork, or collision behavior for workspaceId.
3. Unlock workspace key.
4. Verify checksums before applying payloads.
5. Create local or hosted control rows.
6. Hydrate Yjs docs by applying updates into fresh docs.
7. Store assets under the target deployment adapter.
8. Mark app enumeration status from archive metadata.
```

Completeness vocabulary:

```txt
complete:
  every app in the archive says it enumerated all docs and assets it owns

best-known:
  archive includes entry docs, observed docs, and known assets
  at least one app or source could not prove completeness

partial:
  user explicitly exported a subset
```

Do not call `best-known` export `complete`.

## Assets

Assets are first-class Workspace data. App rows should reference assets by stable asset id, not by deployment URL.

```txt
recording row
  audioAssetId: asset_abc

asset table
  id: asset_abc
  workspaceId: ws_personal_01
  contentType: audio/mpeg
  sizeBytes: 1234567
  originalName: meeting.mp3
  sha256: ...
```

Cloudflare mapping:

```txt
workspace asset
  -> Postgres asset.workspace_id
  -> R2 key workspaces/{workspaceId}/assets/{assetId}
```

Local mapping:

```txt
workspace asset
  -> control.sqlite asset row or asset metadata file
  -> .epicenter/workspaces/{workspaceId}/assets/{assetId}.blob
```

Rules:

```txt
assetId is stable across restore
fork may preserve assetId inside the new workspace unless it collides
URLs are deployment-generated views, not portable references
content type, size, original name, checksum, and encryption status travel with the asset
missing or corrupted blobs are import errors unless the user explicitly imports metadata only
```

## Encryption And Unlock

The chosen boundary is a Workspace key envelope. The exact product UX is deferred.

```txt
password, passkey, account key, member key, or device key
  -> wrapping key
    -> unwraps workspace key
      -> decrypts docs and assets directly or through derived doc and asset keys
```

Rules:

```txt
Never store the raw password.
Never store raw workspace key material unless export is explicitly unencrypted.
Doc ids are not key material.
doc.guid is not the Workspace identity.
Password change rewraps the workspace key. It does not re-encrypt every doc by default.
Adding a device adds a wrapping entry.
Adding a member adds a wrapping entry if sharing is enabled.
Removing a member requires a product decision: revoke future access only, or rotate data keys and re-encrypt.
```

Archive contents:

```txt
keys.json:
  encrypted workspace key wrappings
  KDF parameters
  algorithm ids
  key version
  no raw password
  no raw workspace key
```

Server visibility:

```txt
zero-knowledge deployment:
  server stores encrypted docs, encrypted assets, and wrapped keys it cannot unwrap

host-custodied deployment:
  server may unwrap keys for policy, recovery, search, or automation
  this is a product and trust decision, not a storage accident
```

Paused product decisions:

```txt
Can an organization recover a member's encrypted Workspace?
Does member removal require historical re-encryption?
Can server-side search index decrypted data?
Can a password-only export be recovered if the password is lost?
```

## Sharing

Workspace is the default sharing boundary.

```txt
Personal workspace:
  one owner
  multiple devices
  private apps and assets

Team workspace:
  multiple members
  shared apps and assets
  deployment-enforced roles
  workspace key wrapped for members or devices
```

Split the responsibilities:

```txt
Workspace:
  portable data
  app entries
  docs
  assets
  key envelope metadata

Deployment:
  sessions
  workspace membership
  role checks
  active organization context, if any
  audit logs
  billing and quotas

Organization:
  optional policy and billing parent
  not the data owner
```

Do not store live member policy as the only copy inside app docs. A self-hosted import may carry archived membership metadata for reference, but the target deployment must decide whether to recreate members and roles.

## Deployment Control Data

Portable Workspace data and deployment control data are separate.

Portable:

```txt
workspace id and name
app entry metadata
Yjs document payloads
asset metadata and blobs
key envelope metadata
export inventory and completeness status
app-provided export metadata
```

Deployment control:

```txt
users
sessions
OAuth clients and tokens
workspace membership rows
organization policy
billing state
Room Durable Object names
R2 object keys
local filesystem paths
observed telemetry
audit logs
```

Cloudflare example:

```txt
workspace row
  id
  name
  created_by_user_id
  created_at
  updated_at

workspace_member
  workspace_id
  user_id
  role

asset
  id
  workspace_id
  content_type
  size_bytes
  original_name
  sha256
  uploaded_at

Future Room DO name, after workspace access checks exist
  workspace:{workspaceId}:docs:{docId}
```

Local self-host example:

```txt
control.sqlite
  users
  sessions
  workspaces
  workspace_members
  assets

.epicenter/workspaces/{workspaceId}/
  docs/
  assets/
  projections/
```

## Route Shape

> [SUPERSEDED] T190000 replaced the proposed `/workspaces/:workspaceId/docs/:docId` shape with `/workspaces/:workspaceId/apps/:appId/docs/:docId`. The App Namespace segment (`:appId`) is part of the route, and the internal room name is `v1:workspace:{workspaceId}:app:{appId}:doc:{docId}`. The "future" route described below has shipped, but in the App Namespace form, not the bare workspace+doc form.

Future clean hosted route:

```txt
/workspaces/:workspaceId/docs/:docId
```

This is not a phase-zero route. Current subject-scoped rooms stay in place until the host can prove workspace access before opening a Room.

Request flow:

```txt
request
  -> resolve principal
  -> load workspace
  -> check workspace access
  -> host builds Room DO name
  -> dispatch to Room
  -> optionally record observed_doc after Room opens
```

Future Room DO name:

```txt
workspace:{workspaceId}:docs:{docId}
```

> [SUPERSEDED] The room name that actually shipped is `v1:workspace:{workspaceId}:app:{appId}:doc:{docId}`. The `v1:` version prefix and the `:app:{appId}` segment are part of the live contract per T190000.

This route proves the caller may sync docs inside the Workspace. It does not prove the server knows where `docId` sits in the app graph. The host owns this name construction because authorization and deployment routing are host responsibilities, not app, auth-package, or client responsibilities.

## Concrete Examples

### Personal

```txt
Workspace
  id: ws_personal_01
  name: Personal
  owner: user_braden

Apps
  whispering -> app:whispering:root
  tab-manager -> app:tab-manager:root

Assets
  asset_voice_001

Keys
  workspace key wrapped for Braden's account key
  workspace key wrapped for Braden's laptop device key
```

Export can be complete if Whispering and Tab Manager adapters enumerate their docs and assets. If Tab Manager has no adapter, export is best-known unless observed inventory covers it.

### Team

```txt
Workspace
  id: ws_acme_research
  name: Acme Research

Members
  Braden owner
  Alice editor
  Sam viewer

Apps
  whispering -> app:whispering:root
  tab-manager -> app:tab-manager:root

Keys
  workspace key wrapped for each member or approved device
```

The archive may include membership metadata, but import into a new deployment does not automatically recreate Better Auth users, OAuth sessions, billing state, or organization policy.

### Whispering

Current Whispering can map directly:

```txt
Workspace: Voice Notes
  app: whispering
    entryDocId: app:whispering:root
    tables:
      recordings
      transformations
      transformationSteps
      transformationRuns
      transformationStepRuns
    kv:
      sound.*
      output.*
      ui.*
      retention.*
      recording.*
      transcription.*
      transformation.*
      analytics.enabled
      shortcut.*
    assets:
      audio blobs, when recordings keep original audio
    derived files:
      markdown materializer output
```

Whispering does not need more than one Y.Doc today. If transcripts later become large collaborative text documents, Whispering can add child docs referenced from recording rows:

```txt
recordings[id].transcriptDocId = doc_transcript_123
```

That would be an app-owned graph change, not a platform migration.

## Implementation Plan

### Phase 1: Workspace Boundary And App Roots

- [ ] Add a `workspace` control row.
- [ ] Create a default Workspace for a user at signup or first session bootstrap.
- [ ] Derive the first migrated app's root doc id from `{ workspaceId, appId }`.
- [ ] Keep current subject-scoped rooms available during migration.
- [ ] Do not add `workspace_app` unless the migrated app needs server-side app listing.
- [ ] Do not add a mandatory per-doc registry.
- [ ] Do not implement full export, quota, cleanup, or workspace key grants in this phase.

### Phase 2: Workspace-Scoped Sync Route

- [ ] Add `/workspaces/:workspaceId/docs/:docId` only after real workspace access checks exist.
- [ ] Authorize through workspace access before opening any Room.
- [ ] Let the host build Room names from `{ workspaceId, docId }` after authorization.
- [ ] Track DO usage by `workspace_id` and `doc_id` where available.
- [ ] Optionally record opened docs in `observed_doc`.
- [ ] Move one app to the workspace route.

### Phase 3: Asset Ownership

- [ ] Move asset rows from `user_id` ownership to `workspace_id` ownership.
- [ ] Store blob keys under `workspaces/{workspaceId}/assets/{assetId}`.
- [ ] Return deployment URLs that resolve through workspace access.
- [ ] Preserve old asset URLs through migration or compatibility redirects if needed.

### Phase 4: Export Reality Check

- [ ] Define app export adapter shape.
- [ ] Define `complete`, `best-known`, and `partial` archive metadata.
- [ ] Export a Whispering Workspace to a runtime-independent archive.
- [ ] Import that archive into a local self-host fixture.
- [ ] Prove whether observed inventory is enough for non-adapter apps.

### Phase 5: Workspace Key Material

- [ ] Stop deriving encryption identity from `ydoc.guid`.
- [ ] Introduce explicit Workspace key material.
- [ ] Decide whether data keys are per workspace, per app, per doc, per asset, or derived by path.
- [ ] Support multiple devices decrypting the same Workspace.
- [ ] Defer multi-member rotation semantics until sharing ships.

### Phase 6: Optional WorkspaceCoordinator

- [ ] Add a WorkspaceCoordinator only if export, key rotation, quota, or bulk delete needs cross-Room orchestration.
- [ ] Do not route hot sync WebSockets through the coordinator.

## Open Decisions

These need product or implementation pressure before they should be finalized:

1. **Export completeness**: Is best-known export acceptable for personal backups, or must all export buttons run app adapters and fail closed?
2. **Organization custody**: Can a team or enterprise admin recover a Workspace key, or is Epicenter strictly user-held?
3. **Member removal**: Does removal revoke future access only, or must it rotate keys and re-encrypt historical docs and assets?
4. **Server-side decrypted features**: Are hosted search, automation, AI, or previews allowed to see decrypted Workspace data?
5. **Archive identity on import**: Which import UI choices map to restore, fork, or ownership transfer?
6. **Asset URL compatibility**: How long should user-scoped asset URLs continue to resolve after moving assets under Workspaces?
7. **`workspace_app` timing**: Which product surface first requires stored app entries rather than derived entry docs?
8. **Registry threshold**: Which enterprise feature justifies mandatory per-doc registration?

Pause implementation if any of these decisions are required to make a code path correct.

## Success Criteria

- [ ] No new first-wave table uses `realm_id`.
- [ ] No production route needs a raw `user.id` to construct a Room name.
- [ ] Workspace identity is separate from `ydoc.guid`.
- [ ] The first migrated app can create child Yjs docs offline without registering each one with the server first.
- [ ] The server can route sync by `{ workspaceId, docId }`.
- [ ] A Workspace can contain multiple app entry docs.
- [ ] A simple Workspace with one app and one doc remains easy to understand.
- [ ] Cloudflare uses one Durable Object per active synced doc id.
- [ ] Self-host can map a Workspace to a portable folder or database capsule.
- [ ] Assets are workspace-scoped in the design.
- [ ] The spec is honest that full export needs app adapters, observed inventory coverage, or a mandatory registry later.
- [ ] The archive examples include docs, assets, key metadata, app metadata, and completeness status.

## References

- `specs/20260520T130000-workspace-portability-design-brief.md` for the broader design brief.
- `specs/20260519T231845-realm-boundary-clean-break.md` for the Realm proposal this replaces.
- `specs/20260519T155705-workspace-noun-clean-break.md` for the earlier Workspace-centered model.
- `apps/api/src/app.ts` for current `/api/session`, subject-scoped `/rooms/:room`, and DO lookup.
- `apps/api/src/room.ts` for current Room Durable Object responsibilities.
- `apps/api/src/db/schema.ts` for current user-owned asset and Durable Object tracking rows.
- `apps/whispering/src/lib/whispering/index.ts` for the current single-doc Whispering entry.
- `apps/whispering/src/lib/whispering/tauri.ts` for current local persistence and markdown materialization.
- `apps/whispering/src/lib/workspace/definition.ts` for current Whispering tables and KV.
- `packages/workspace/src/document/doc-guid.ts` for current child Y.Doc guid convention.
- `packages/workspace/src/document/workspace-paths.ts` for current per-workspace local file layout.
- `packages/workspace/src/document/attach-yjs-log.ts` for SQLite-backed Yjs update logs.
- `packages/workspace/src/document/attach-encryption.ts` for the current `ydoc.guid` as workspace id assumption.
- DeepWiki: `cloudflare/cloudflare-docs` on Durable Objects, isolated storage, hibernation, Durable Object to Durable Object calls, and object listing limits.
- DeepWiki: `better-auth/better-auth` on organization plugin boundaries.
- DeepWiki: `yjs/yjs` on document updates, awareness, and portable update application.
