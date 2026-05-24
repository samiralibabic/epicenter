# Cloud Workspace App Namespace Clean Break

**Date**: 2026-05-20
**Status**: Substantially landed; the route family and client architecture were superseded by server-default-workspace routing (see amendment)
**Author**: Epicenter

> **Superseded, 2026-05-22:** The cloud-workspace product model this spec lands (workspaces as the data boundary, the App Namespace, organization-backed membership) was reverted by `specs/20260522T160000-revert-cloud-workspace-sync-layer.md`. A cloud document is now owned by `subject:${userId}` and synced through the single route `/rooms/:room`; the org concept moves to a future tenancy layer. Read this spec as historical context only.

## Post-implementation amendment (2026-05-21)

The product model in this spec landed, but two of its mechanisms were
superseded before this spec's checklist was closed out. The supersession is
recorded in `specs/20260521T160000-server-default-workspace-route.md`.

```txt
This spec planned:
  public route   /workspaces/:workspaceId/apps/:appId/docs/:docId
  client owns    workspaceId, resolved from /api/workspaces
  client wrapper deferred-collaboration shell (cloud-app-sync.ts)

What shipped instead:
  public route   /me/apps/:appId/docs/:docId
  server owns    default-workspace resolution from the auth token
  client wrapper deleted; apps call openCollaboration directly
```

Unchanged by the supersession, and still the current direction:

```txt
workspaceId is Better Auth organization.id
Better Auth membership is the sync authorization check
roomName is host-built, opaque, v1:-prefixed
SyncEngine and Room stay policy-free
/api/workspaces is read-only and never repairs missing rows
/rooms/:room is daemon and non-Cloud compatibility only, not a Cloud fallback
no app_instance, app_sync_doc, app_asset, scoped sync token, or head Y.Doc
```

Checklist items below that named the `/workspaces/:workspaceId/...` route or
client-side workspaceId resolution are kept checked, because they were
genuinely implemented, and annotated as superseded. See the closing
Implementation Note for the landed/deferred/rejected summary.

## Overview

Epicenter Cloud should make Workspace the product account surface and an app namespace the durable sync boundary. In phase 1, Cloud Workspace identity is Better Auth organization identity: `workspaceId` is `organization.id`. The app namespace is the tuple `workspaceId + appId`; it does not need a required `app_instance` table until Cloud needs an installed-app product surface.

This supersedes the Cloud ownership direction in `specs/20260520T170000-cloud-workspaces-and-organizations-clean-break.md`. That spec kept Workspace as the data boundary and Organization as the team, policy, and billing boundary. This spec collapses that split: the product noun is Workspace, Better Auth organization is the backing row, and `workspaceId + appId` becomes the lower app sync namespace.

## One Sentence

Epicenter Cloud Workspaces are Better Auth organizations presented as Workspaces; app namespaces anchor app-owned root Y.Docs; Rooms coordinate Yjs sync.

## Mental Model

```txt
User =
  a human login identity

Cloud Workspace =
  the product account surface
  same id as Better Auth organization
  owns members, invitations, billing, policy, and app namespaces

App =
  an app definition or package, such as Whispering or Tab Manager

App Namespace =
  the workspace-local namespace for one app
  identified by workspaceId + appId in phase 1
  anchors that app's root Y.Doc namespace inside the Cloud Workspace

App Instance =
  optional future product row for installed apps
  only needed when Cloud must list, disable, bill, delete, or duplicate app installations

Sync Doc =
  one independently synced Y.Doc inside an App Namespace
  usually the app's root Y.Doc in phase 1

Room =
  the live runtime actor that syncs one Sync Doc
```

The friendly version:

```txt
Personal use:
  "Braden" is a one-member Cloud Workspace.

Team use:
  "Epicenter" is a multi-member Cloud Workspace.

Apps:
  each Cloud Workspace can contain app namespaces.

Sync:
  each app namespace opens a root Sync Doc.
  extra Sync Docs are app-owned and optional.
```

The maintenance-cost version:

```txt
Delete:
  workspace.owner_user_id
  workspace.owner_organization_id
  fake personal organization debate
  public Organization product noun
  user-owned room namespace as the Cloud product boundary

Keep:
  Better Auth organization and member tables
  one Cloud Workspace membership surface
  workspaceId = organization.id in phase 1
  zero required Epicenter-owned Cloud app tables in phase 1
  app namespace = workspaceId + appId
  app-owned root Y.Doc as the semantic source of truth
  one opaque roomName builder
  one generic SyncEngine
```

## What This Supersedes

```txt
Supersedes:
  specs/20260520T170000-cloud-workspaces-and-organizations-clean-break.md
    rejects user-owned or organization-owned Workspace rows for Cloud
    replaces public Organization with Cloud Workspace
    moves the Cloud app namespace below Workspace into `workspaceId + appId`

  specs/20260519T155705-workspace-noun-clean-break.md
    keeps Workspace as the daily product noun
    rejects the owner_user_id / owner_organization_id SQL shape for Cloud

  specs/20260520T001032-workspace-capsule-clean-break.md
    keeps the capsule pressure test for local and portable app data
    maps the Cloud app capsule to app namespace plus root Y.Doc

  specs/20260520T130000-workspace-portability-design-brief.md
    keeps portability requirements
    applies them to the app-owned root Y.Doc inside an app namespace

  specs/20260519T231845-realm-boundary-clean-break.md
    keeps the warning that one DO per top-level boundary is wrong
    rejects Realm as a product noun

Builds on:
  specs/20260520T114537-epicenter-sync-engine-host-composition.md
    host-owned authorization and roomName construction

  specs/20260519T085954-api-session-clean-break.md
    authenticated session projection
```

## Current State

The current Cloud API is subject-scoped.

```txt
request
  -> Better Auth user
  -> /rooms/:room
  -> roomName = subject:{user.id}:rooms:{room}
  -> Room Durable Object
```

That is the right sync-engine shape but the wrong Cloud product boundary. The route owns auth, builds an opaque room name, and passes bytes to a generic sync engine. The problem is the route identity:

```txt
subject:{user.id}:rooms:{room}
```

That names personal sync. It does not name a Cloud Workspace, app namespace, or sync doc.

## Desired Shape

```txt
request
  -> authenticate user
  -> resolve Cloud Workspace
  -> check Better Auth organization membership
  -> validate appId and docId
  -> build internal roomName
  -> Room Durable Object
```

The public route should name product resources:

```txt
GET  /workspaces/:workspaceId/apps/:appId/docs/:docId
POST /workspaces/:workspaceId/apps/:appId/docs/:docId
WS   /workspaces/:workspaceId/apps/:appId/docs/:docId
POST /workspaces/:workspaceId/apps/:appId/docs/:docId/dispatch
```

The internal room name should name the authorized sync doc:

```txt
v1:workspace:{workspaceId}:app:{appId}:doc:{docId}
```

`v1:` is worth keeping. It is not user-facing API. It is an internal Durable Object naming protocol. The prefix gives future room-name migrations a clean boundary if we need epochs, sharding, custody-mode splits, or a different sync-doc identity format.

## Phase 1 Boundary

Phase 1 does not need scoped sync tokens. The Hono route is the control-plane boundary.

```txt
Hono route:
  reads the authenticated Better Auth user
  checks Better Auth organization membership
  validates workspaceId, appId, and docId
  builds the internal roomName

Room Gateway:
  maps roomName to the Durable Object id

Room Durable Object:
  syncs Yjs
  persists updates
  manages awareness and dispatch

SyncEngine:
  wraps binary HTTP sync
  knows only roomName
```

This keeps the sync plane policy-free without adding token infrastructure. Scoped sync tokens are a future extraction path for dedicated or self-hosted sync servers. They are not part of this clean break.

The sync-plane primitive is still a room. The product-shaped route exists at the Cloud API edge so the Hono resolver has the authorization inputs without a lookup table.

```txt
Product route:
  /workspaces/:workspaceId/apps/:appId/docs/:docId

Internal room:
  v1:workspace:{workspaceId}:app:{appId}:doc:{docId}
```

## Why AppId Is Enough In Phase 1

Use `App` for the app definition:

```txt
App:
  Whispering
  Tab Manager
  future app package from jsrepo or a local project
```

Use `App Namespace` for the workspace-local sync namespace:

```txt
App Namespace:
  Braden Workspace + whispering
  Epicenter Workspace + whispering
  Epicenter Workspace + tab-manager
```

This distinction matters because each Workspace needs its own app namespace. The same app definition can exist in many workspaces. In phase 1, one app namespace per `workspaceId + appId` is enough.

Cloud should not use an App Instance table as a shadow app database. The app's root Y.Doc remains the semantic source of truth for app records, child doc references, and blob references.

Creation should be idempotent:

```txt
User opens an app in a Cloud Workspace
  -> Cloud validates workspace membership
  -> Cloud validates appId and docId syntax
  -> app opens its root Sync Doc
  -> app records its own data inside that root Y.Doc
  -> additional Sync Docs are opened only if the app needs them
```

That can look explicit in UI:

```txt
Add app
```

or implicit:

```txt
Open Whispering for the first time
```

In phase 1, both flows can be pure navigation into `/workspaces/:workspaceId/apps/:appId/docs/root`. They do not require a Cloud mutation.

The storage invariant is smaller than earlier drafts: Cloud owns access to the Workspace and the room-name namespace; the app owns the Yjs document graph and blob references inside `workspaceId + appId`.

## What The Collapse Buys And Costs

The collapsed phase 1 shape is intentionally sparse:

```txt
Better Auth organization:
  owns Workspace identity and membership

Sync route:
  owns authorization and roomName construction

App root Y.Doc:
  owns app records, child doc references, settings, and blob references

Object storage:
  owns blob bytes under a workspace/app/doc-aware prefix
```

That means Cloud can sync this without creating an installed-app row:

```txt
/workspaces/ws_123/apps/whispering/docs/root
```

and also this:

```txt
/workspaces/ws_123/apps/whispering/docs/recording_rec_456
```

The second route does not prove that `recording_rec_456` exists in Postgres. It means the caller is a member of `ws_123`, `whispering` is an allowed app id, and `recording_rec_456` is a syntactically valid app-owned doc id. The app root Y.Doc decides whether that child doc is referenced by the product state.

This gives up a few Cloud control-plane features in phase 1:

```txt
Cloud cannot list installed apps from SQL.
Cloud cannot distinguish "never opened" from "opened but empty" without reading app data.
Cloud cannot disable one app namespace without app-level policy.
Cloud cannot delete one app namespace with a single relational cascade.
Cloud cannot support two separate Whispering instances in one Workspace.
```

Those are real costs, but they are product costs, not sync correctness costs. If one becomes necessary, add `app_instance` then.

## Whispering Example

Whispering should treat the root Y.Doc as the app's semantic index.

```txt
/workspaces/braden/apps/whispering/docs/root
  recordings table
  transformations table
  settings KV
  blob references
  optional child doc references
```

A recording can stay entirely inside the root doc if its CRDT state is small:

```txt
recording rec_123:
  metadata in root Y.Doc
  transcript text in root Y.Doc
  audio blob path in root Y.Doc
  audio bytes in object storage
```

If a recording grows enough to deserve independent sync, Whispering can create a child doc by convention:

```txt
/workspaces/braden/apps/whispering/docs/recording_rec_123
```

Cloud does not register that child doc. The root Y.Doc references it. The route allows it. The Room Durable Object coordinates it when clients open it.

That avoids turning Cloud into an orchestra that every app-specific record creation must call. The app owns app semantics; Cloud owns authorization and sync transport.

## Better Auth Grounding

Better Auth organization plugin is the right backing layer for Cloud Workspace. In phase 1, it should also be the Workspace identity row. `workspaceId` is the public product name for `organization.id`.

DeepWiki confirmed the plugin provides:

```txt
organization:
  id
  name
  slug
  logo
  metadata

member:
  userId
  organizationId
  role

invitation:
  email
  inviterId
  organizationId
  role
  status
  expiresAt

session:
  activeOrganizationId

optional teams:
  team
  teamMember
  activeTeamId
```

Epicenter should map that like this:

```txt
Better Auth organization =
  Cloud Workspace row

Better Auth organization.id =
  Cloud Workspace workspaceId

Better Auth member =
  Cloud Workspace member

Better Auth invitation =
  Cloud Workspace invitation

Better Auth activeOrganizationId =
  active Cloud Workspace context in auth/session plumbing
```

Do not expose Organization as a separate product noun in Cloud. Users see Workspaces. Better Auth can keep its internal organization vocabulary.

Do not map App Namespace to Better Auth team. Better Auth teams are people groupings inside an organization. App namespaces are data namespaces inside a Workspace.

Do not create a separate `cloud_workspace` table in phase 1. Better Auth already owns the top-level account shape. Add a 1:1 `workspace_profile` table only when Workspace owns product fields that do not belong in Better Auth organization metadata.

Examples that would justify `workspace_profile` later:

```txt
workspace custody mode
workspace deletion lifecycle
workspace export/import lineage
workspace default app policy
workspace billing cache
```

## Notion And Comparable Products

The product shape is closer to Notion and Linear than to the old owner-union model.

| Product | Top-level surface | Inner surface | Lesson |
| --- | --- | --- | --- |
| Notion | Workspace | teamspaces, pages, databases | Workspace is the daily product container. Smaller content surfaces live inside it. |
| Linear | Workspace | teams, projects, issues | A company should usually live in one workspace. Teams and projects organize work inside it. |
| Supabase | Organization | projects | Billing and members live at the org; deployable units live below it. |
| Vercel | personal or team scope | projects | The selected scope owns billing and members; projects sit inside. |

Epicenter should use the Workspace word like Notion and Linear:

```txt
Workspace =
  the place people enter, invite members to, and pay for
```

Epicenter should not copy Supabase and Vercel project tables unless the product need is real:

```txt
Supabase or Vercel Project =
  deployable product surface with settings, status, env vars, domains, and lifecycle

Epicenter app namespace in phase 1 =
  workspaceId + appId
  sync namespace only
  no settings row, no installed-app lifecycle row
```

## Why A Smaller Data Unit Still Exists

Cloud Workspace should not be the Yjs document boundary.

One giant Workspace-level Y.Doc would create these problems:

```txt
all apps load together
one app edit touches the whole workspace document stream
export and delete boundaries get muddy
key rotation gets too coarse
offline caches collide more easily
one Durable Object can bottleneck an entire Workspace
```

The smaller Cloud unit is the app namespace. Inside it, the app should usually start with one root Y.Doc.

```txt
App Namespace:
  workspaceId = braden
  appId = whispering

Root Sync Doc:
  docId = root
  contains recordings, transformations, settings, blob references
```

Yjs and y-indexeddb both make identity collisions expensive. A `Y.Doc.guid` is document identity metadata, not authorization. `y-indexeddb` persists by the `docName` string passed to `IndexeddbPersistence`, not by `Y.Doc.guid`. Two logical docs that share persistence names or receive the same updates will converge.

So the sync identity must include the full hierarchy:

```txt
syncDocIdentity =
  workspaceId + "/" + appId + "/" + docId

Y.Doc.guid =
  syncDocIdentity, or a documented legacy guid mapped to it

IndexedDB docName =
  owner-scoped syncDocIdentity

BroadcastChannel name =
  owner-scoped syncDocIdentity

roomName =
  v1:workspace:{encodedWorkspaceId}:app:{encodedAppId}:doc:{encodedDocId}
```

The sync protocol does not know any of these ids. The host authorizes the request, builds the room name, and passes bytes to the sync engine.

Cloud does not need a relational row for every Sync Doc by default. The app root Y.Doc owns the app's semantic document graph. Extra Sync Docs are app-owned choices, not Cloud control-plane records.

The route accepts any valid app-owned `docId`. `root` is only the convention for the entry point, not a different resource type.

```txt
docs/root =
  conventional app entry document

docs/{anything-else} =
  optional app-owned child document
```

Cloud treats `root` and every other valid `docId` the same after authorization. Apps give `root` meaning. For Whispering, `root` should contain recordings, settings, transformations, blob references, and optional child doc references.

## Architecture

```txt
┌─────────────────────────────────────────────┐
│ Better Auth user                             │
│ human login identity                         │
└─────────────────────────────────────────────┘
                    │ member rows
                    ▼
┌─────────────────────────────────────────────┐
│ Better Auth organization                     │
│ Epicenter Cloud Workspace identity row       │
│ members, invitations, roles, billing context │
└─────────────────────────────────────────────┘
                    │ contains
                    ▼
┌─────────────────────────────────────────────┐
│ App Namespace                                │
│ workspace-local namespace for one app id      │
│ Cloud namespace for the app root Y.Doc       │
└─────────────────────────────────────────────┘
                    │ contains
                    ▼
┌─────────────────────────────────────────────┐
│ Sync Doc                                     │
│ root Y.Doc by default; app-owned extras later │
└─────────────────────────────────────────────┘
                    │ coordinated by
                    ▼
┌─────────────────────────────────────────────┐
│ Room Durable Object                          │
│ live peers, Yjs update log, awareness        │
└─────────────────────────────────────────────┘
```

## Schema Sketch

Better Auth owns the top-level Workspace tables. Cloud Workspace is not a separate table in phase 1.

```txt
organization
  id
  name
  slug
  metadata
  used publicly as workspaceId

member
  user_id
  organization_id
  role

invitation
  organization_id
  email
  role
  status
```

Epicenter owns no required Cloud app tables in phase 1. The app namespace is derived from the route:

```txt
app namespace =
  workspaceId + appId

root document =
  workspaceId + appId + root
```

Do not add these tables in phase 1:

```txt
cloud_workspace
workspace_member
workspace_invitation
workspace_role
workspace_owner
workspace_billing
workspace_policy
app_sync_doc
app_asset
app_instance_member
app_key_grant
billing_cache
```

Keep these as future escape hatches, not phase 1 plan items:

```txt
app_instance:
  installed-app inventory if Cloud must list, disable, delete, duplicate, bill, migrate, or configure apps independently of app-owned Yjs data

app_sync_doc:
  Cloud inventory for Sync Docs if app-owned root docs are not enough for deletion, migration, support, or metering

workspace_profile:
  1:1 product fields for a Workspace when Better Auth metadata is not enough

app_asset:
  Cloud inventory for blobs if object-store prefix accounting and app-owned references are not enough

app_instance_member:
  private apps or app-level roles

app_key_grant:
  user-held or customer-managed key grants

billing_cache:
  cached billing state if Autumn lookup cost or dashboard needs justify it
```

Access and custody stay deliberately simple in phase 1.

```txt
Workspace membership =
  can user enter this Cloud Workspace?

App namespace access in phase 1 =
  any Workspace member can open any valid appId namespace

Custody in phase 1 =
  server-managed encryption, not zero-knowledge
```

Future private apps and user-held keys should not be compressed into route parsing or app metadata.

```txt
Private app access:
  app_instance plus app_instance_member may earn themselves

User-held or customer-managed keys:
  app_key_grant may earn itself
```

## Route Flow

```txt
GET /workspaces/:workspaceId/apps/:appId/docs/:docId
  -> authenticate user
  -> require Better Auth member in organization workspaceId
  -> validate appId and docId syntax
  -> optionally check appId against a static first-party app catalog
  -> build roomName
  -> if WebSocket upgrade, hand to Room
  -> else return snapshot

POST /workspaces/:workspaceId/apps/:appId/docs/:docId
  -> same resolver
  -> sync.handleHttpSync(request, { roomName })

POST /workspaces/:workspaceId/apps/:appId/docs/:docId/dispatch
  -> same resolver
  -> rooms.dispatch(roomName, body)
```

The resolver returns the authorized sync target:

```ts
type AuthorizedSyncDoc = {
  workspaceId: string;
  appId: string;
  docId: string;
};
```

The conventional entry doc id is `root`.

```txt
/workspaces/:workspaceId/apps/:appId/docs/root
```

Additional doc ids are app-owned. Cloud authorizes the Workspace boundary, validates route identity, and constructs a room name; it does not need to know what a child doc means. A child doc does not need a Postgres row before it can sync.

The sync engine still sees only:

```ts
sync.handleHttpSync(request, { roomName });
```

## Naming Rules

Use these names consistently:

```txt
Cloud Workspace:
  product/account surface
  Better Auth organization backing row

App:
  app definition or package

App Namespace:
  Cloud sync namespace for one workspace-local app id

App Instance:
  optional future installed-app product row

Sync Doc:
  independently synced Y.Doc
  usually the root Y.Doc for an App Namespace

Room:
  live runtime actor for one Sync Doc
```

Avoid:

```txt
Organization as public Cloud product noun
Workspace owner
workspace_member as a custom duplicate of Better Auth member
App Installation for the data boundary
Project unless the app-specific UI needs that word
Realm
Tenant
```

`App Installation` sounds like package management. `App Instance` is acceptable only when Cloud has an installed-app lifecycle to manage. In phase 1, `workspaceId + appId` is enough; the namespace can be entered explicitly by Add App or lazily by first use.

## Billing

Billing attaches to Cloud Workspace.

```txt
Autumn customerId =
  workspace:{workspaceId}

workspaceId =
  Better Auth organization.id

Usage event properties =
  workspaceId
  appId
  docId when useful
```

Personal and team billing use the same model:

```txt
Personal:
  one-member Cloud Workspace pays for its app usage

Team:
  multi-member Cloud Workspace pays for its app usage
```

If a company needs hard-separated billing, policy, or custody, it creates another Cloud Workspace. If it needs nested departments, SCIM group mirroring, cross-workspace enterprise policy, or custom IAM, that belongs in a later enterprise or self-host shape.

## Encryption And Custody

Do not call current Cloud encryption E2E or zero-knowledge.

Phase 1 has one custody mode:

```txt
server_managed:
  Cloud derives or unwraps the key material it gives the client
  easier recovery and sharing
  not end-to-end encryption
  not zero-knowledge
```

Do not add a `key_policy` or `custody_mode` column while there is only one mode. Add custody storage only when a second real mode exists.

Future custody modes:

```txt
user_held:
  Cloud stores wrapped grants only
  server cannot derive plaintext keys

customer_managed:
  a customer-owned root key or KMS wraps app keys
```

Recommended phase 1 key hierarchy:

```txt
Cloud Workspace
  membership and billing

App Namespace
  app root Y.Doc namespace

Sync Doc
  encrypted values under server-managed key material
```

Access and custody stay separate.

```txt
Removing a member:
  stops new Cloud Workspace access immediately

Changing custody:
  explicit migration, not an access-control toggle

True user-held sharing:
  requires app_key_grant or an equivalent grant store
```

## Self-Hosting

Self-hosting does not have to copy Better Auth organization policy.

The portable model is:

```txt
Workspace-like container
  -> app namespaces
      -> app-owned root docs
```

The host can map local auth or IAM into that shape:

```txt
Epicenter Cloud:
  Better Auth organization is the Cloud Workspace row

Solo self-host:
  local owner maps to one Workspace

Enterprise self-host:
  IAM group or deployment policy maps to Workspace membership
```

Packages should remain inversion-of-control friendly. `packages/workspace` should not import Better Auth organization, Autumn billing, or Cloud Workspace schema. Local apps open local app data; Cloud maps that data into app namespaces.

Apps own their document graph in every deployment mode. Cloud does not need to understand Whispering recordings, transcript docs, or blob relationships to sync them.

## Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Public product noun | 2 coherence | Workspace | Matches Notion and Linear. Users enter workspaces, invite members, and pay for them. |
| Auth backing row | 1 evidence | Better Auth organization.id is workspaceId | Better Auth already provides organization, member, invitation, activeOrganizationId, and optional teams. A duplicate Cloud Workspace table does not earn itself in phase 1. |
| Required Epicenter Cloud app table | 1 evidence | None in phase 1 | Better Auth owns Workspace membership. The app root Y.Doc owns app records, doc graph, and blob references. |
| App versus App Namespace | 2 coherence | Use App for the definition, App Namespace for `workspaceId + appId` | App names the package. App Namespace names the workspace-local sync namespace. |
| App Instance table | Deferred | Add only when installed-app lifecycle earns it | Listing, disabling, duplicating, deleting, app billing, app settings, or multiple same-app instances would earn a row. |
| App Namespace creation | 3 taste | Idempotent first sync, explicit Add App can navigate to the same path | Supports Notion-like sidebar use without making installation a package-management ceremony. |
| Room-name version | 2 coherence | Prefix internal names with `v1:` | It gives migration room for epochs, sharding, custody modes, or identity format changes without public route churn. |
| Root document | 2 coherence | One root Y.Doc per App Namespace | The root Y.Doc is the app-owned entry point and semantic index. |
| Sync grain | 1 evidence | One Room per opened Sync Doc | Yjs sync and Cloudflare DO coordination fit per-doc boundaries. Cloud does not need a Postgres row for each doc. |
| Read-only live sync | Deferred | Snapshot-only until frame filtering exists | Yjs protocol does not enforce read-only peers by itself. |
| Better Auth teams | Deferred | Do not map to App Namespace | Teams are people groupings, not app data boundaries. |
| Workspace profile table | Deferred | Add only when product fields earn it | Start with Better Auth organization metadata and add a 1:1 profile table only for real Workspace fields. |
| App-level privacy | Deferred | Every Workspace member can open every phase 1 app namespace | Add app_instance_member only when one app namespace must be visible to some Workspace members and forbidden to others. |
| Sync Doc inventory | Deferred | App root Y.Doc owns child doc references | Add app_sync_doc only when Cloud needs deletion, migration, support inspection, metering, retention, legal hold, or cross-doc search over docs without reading app-owned root data. |
| App asset table | Deferred | Avoid by default | Apps own blob references in Yjs. Cloud object storage can stay opaque and prefix-addressed. |
| Key grants | Deferred | Server-managed only in phase 1 | True user-held or customer-managed keys need an earned grant store later. |
| App registry | Deferred | Static first-party app catalog is enough | Add an app registry table only for third-party publishing, app version policy, central disablement, marketplace metadata, or app-bound billing and policy. |
| Greenfield compatibility | 2 coherence | Refuse `/rooms/:room` as a Cloud client fallback | A signed-in Cloud app has one sync identity: Workspace, App, Doc. Local-only offline boot is a real mode; legacy room sync is a second product path. |
| Workspace repair | 2 coherence | Signup owns personal Workspace provisioning | `/api/workspaces` lists memberships. It does not repair missing rows because repair-by-read hides a broken account invariant. |
| Subject switch | 2 coherence | Auth must publish a signed-out gap before mounting another subject | A mounted local workspace payload belongs to one subject. Downstream session code should not defend against account switching. |
| Workspace route helper ownership | 2 coherence | App or Cloud owns product route construction | `packages/workspace` owns Yjs collaboration primitives. Cloud product route vocabulary should not become a published workspace-library helper unless external consumers need it. |
| Session prepare values | 3 taste | Prefer `prepare` return values over mutable sidecars | Prepared values should flow into `build`; a mutable resolver object hides ordering between two callbacks. |

## Implementation Plan

### Phase 1: Spec And Vocabulary

- [x] **1.1** Mark older Cloud ownership specs as superseded by this model. (All five superseded specs carry a superseded/revision note referencing this spec.)
- [x] **1.2** Rename Cloud product language from Organization to Workspace. (`organization` survives only as the Better Auth backing table, below the product boundary.)
- [x] **1.3** Use App Namespace for `workspaceId + appId`; reserve App Instance for a future installed-app row.
- [x] **1.4** Keep App for app definitions and packages.

### Phase 2: Better Auth Organization As Workspace

- [x] **2.1** Enable Better Auth organization plugin for Cloud Workspaces.
- [x] **2.2** Create a personal Cloud Workspace as a one-member organization during signup.
- [x] **2.3** Expose Workspace APIs that wrap Better Auth organization APIs.
- [x] **2.4** Keep Better Auth organization naming below the product API boundary.
- [x] **2.5** Do not create `cloud_workspace`, `workspace_member`, `workspace_invitation`, or `workspace_role` tables.
- [x] **2.6** Defer `workspace_profile` until Workspace owns product fields that Better Auth organization metadata should not carry.

### Phase 3: App Namespace Sync

- [x] **3.1** Do not add `app_instance` in phase 1.
- [x] **3.2** Add `appId` and `docId` validators.
- [x] **3.3** Do not add `app_sync_doc`, `app_asset`, `app_instance_member`, `app_key_grant`, or `billing_cache` in phase 1.
- [x] **3.4** Keep app display metadata, child doc references, and blob references in the app root Y.Doc unless a Cloud operation earns a table. (Refusal decision; satisfied by inaction, no Cloud app table exists.)
- [x] **3.5** Treat Add App as navigation or app-owned root-doc initialization unless Cloud product state earns an installed-app row. (Refusal decision; satisfied by inaction, no installed-app row exists.)
- [x] **3.6** Treat `docId = root` as the conventional app entry document, not as a special platform resource type.
- [x] **3.7** Do not add a Workspace head Y.Doc in phase 1.

### Phase 4: Workspace App Sync Routes

- [x] **4.1** Add `/workspaces/:workspaceId/apps/:appId/docs/:docId`. (Superseded: the clientless explicit-workspace routes were later deleted; `/me/apps/:appId/docs/:docId` replaced them.)
- [x] **4.2** Add `/workspaces/:workspaceId/apps/:appId/docs/:docId/dispatch`. (Superseded: replaced by `/me/apps/:appId/docs/:docId/dispatch`.)
- [x] **4.3** Build `roomName` with `v1:` and encoded route parts.
- [x] **4.4** Keep SyncEngine policy-free.
- [x] **4.5** Use `docs/root` as the default App Namespace entry point.
- [x] **4.6** Keep Better Auth membership checks in the Hono route or resolver, not in the Room Durable Object or SyncEngine.
- [x] **4.7** Do not add scoped sync tokens in phase 1.

### Phase 5: Cleanup

- [x] **5.1** Remove `/rooms/:room` from the Cloud sync route. The server handler remains only as explicit non-Cloud personal-room and daemon compatibility until remaining `roomWsUrl()` callers migrate.
- [x] **5.2** Remove subject-scoped room names from Cloud product routes.
- [x] **5.3** Remove owner-user versus owner-organization workspace schema proposals from active Cloud plans.
- [x] **5.4** Remove `/rooms/:room` fallback from Tab Manager Cloud sync. Offline or unavailable Workspace lookup produces local-only boot, not legacy Cloud sync.
- [x] **5.5** Rehome Tab Manager Workspace app doc URL construction out of `@epicenter/workspace`. Public package export removal is deferred because it is a published API break.

### Phase 6: Client Adoption

- [x] **6.1** Resolve a default Cloud Workspace from `/api/workspaces` for at least one real client path. (Superseded: clients no longer resolve workspaceId; the server resolves the default workspace from the auth token.)
- [x] **6.2** Open the client root Sync Doc at `/workspaces/:workspaceId/apps/:appId/docs/root` by default. (Superseded: clients open `/me/apps/:appId/docs/root`.)
- [x] **6.3** Replace `/rooms/:room` compatibility with explicit local-only behavior when the default Workspace is not available.
- [x] **6.4** Add tests for the client Workspace app doc URL construction.
- [x] **6.5** Make the signed-in app payload receive prepared Workspace defaults directly, without a mutable resolver object. (Superseded: the prepare/build sidecar and the deferred-collaboration wrapper were deleted; apps call `openCollaboration` directly with a static `/me/...` URL.)

### Phase 7: Auth And Account Invariants

- [x] **7.1** Add an account-provisioning invariant test: a newly created user has a deterministic personal Cloud Workspace and owner membership before `/api/workspaces` is useful.
- [x] **7.2** Keep `/api/workspaces` read-only. It may assert missing personal Workspace membership as a provisioning bug, but it must not create rows.
- [x] **7.3** Add an explicit account-switch boundary that publishes signed-out before installing another subject.
- [x] **7.4** Add a session lifecycle test proving a different subject disposes the old local workspace payload before a new payload is built.
- [x] **7.5** Keep `PersistedAuth`, `ApiSessionResponse`, and local storage schema changes out of this pass unless the spec is updated with a migration rule.

## Test And Migration Invariants

Even in a clean break, these should become tests or migration gates.

```txt
Every Cloud Workspace has at least one owner/admin member.
Cloud Workspace identity is Better Auth organization.id in phase 1.
No duplicate Cloud Workspace membership, invitation, role, owner, billing, or policy tables are added in phase 1.
No required Epicenter-owned Cloud app tables are added in phase 1.
Every app namespace is addressed by workspaceId + appId.
Every app namespace has a conventional root Sync Doc address.
Cloud does not require a persisted Sync Doc inventory row in phase 1.
Cloud does not require an app asset table in phase 1.
The sync route rejects users who are not members of the backing Better Auth organization.
The sync route validates appId and docId before building roomName.
The sync route accepts any valid app-owned docId, not only root.
roomName is built by one host-owned function.
roomName includes a version prefix.
roomName is never parsed for auth.
The Room Durable Object does not import Better Auth or billing code.
The Hono resolver is the phase 1 control-plane boundary.
Scoped sync tokens are not required in phase 1.
No Workspace head Y.Doc is required in phase 1.
docId root is tested as a normal valid docId with conventional app meaning.
docId, Y.Doc.guid, IndexedDB docName, BroadcastChannel name, and roomName collision cases are tested.
SyncEngine imports no Better Auth, Autumn, Workspace membership, or billing code.
Viewer live sync is not enabled until update frames are filtered.
Cloud v1 encryption is server-managed and must not be described as zero-knowledge.
Cloud clients do not fall back from Workspace App Doc sync to public `/rooms/:room`.
`/api/workspaces` is read-only and does not create missing personal Workspaces.
Auth subject changes unmount local workspace state before another subject mounts.
Product Cloud route helpers are not exported from `@epicenter/workspace` unless that package explicitly owns them.
```

## Execution Readiness

This spec is ready to execute as a narrow clean break if the implementation stays inside these limits:

```txt
Do:
  add Workspace/App/Doc sync routes
  use Better Auth organization membership as Workspace authorization
  build roomName from workspaceId + appId + docId
  keep Room and SyncEngine policy-free
  treat missing Workspace lookup as local-only or unavailable, not legacy sync

Do not:
  add app_instance
  add app_sync_doc
  add app_asset
  add scoped sync tokens
  add a Workspace head Y.Doc
  add app-level billing, disablement, migration, or dashboard state
  preserve `/rooms/:room` as a greenfield Cloud client fallback
```

The first implementation should change the route boundary and identity construction. It should not solve future Cloud app management.

## Implementation Notes

### 2026-05-20 Phase 1 Sync Route

Implemented the product-shaped sync route boundary in `apps/api`:

```txt
GET  /workspaces/:workspaceId/apps/:appId/docs/:docId
POST /workspaces/:workspaceId/apps/:appId/docs/:docId
POST /workspaces/:workspaceId/apps/:appId/docs/:docId/dispatch
```

The resolver validates `workspaceId`, `appId`, and `docId`, checks the Better Auth `member` table with `workspaceId = organization.id`, and builds opaque room names with:

```txt
v1:workspace:{workspaceId}:app:{appId}:doc:{docId}
```

Route compatibility remains for `/rooms/:room` because existing clients still depend on it. No `app_instance`, `app_sync_doc`, `app_asset`, scoped sync token, Workspace head Y.Doc, or app management table was added.

### 2026-05-21 Phase 2 Workspace API

Implemented the minimal Cloud Workspace product surface in `apps/api`:

```txt
GET /api/workspaces
```

Cloud Workspace remains backed by Better Auth `organization` and `member` rows. `workspaceId` is `organization.id`; the API does not expose Organization as a product noun. A deterministic personal Workspace is created during signup. `/api/workspaces` lists existing Workspace memberships and does not create missing personal Workspaces.

`/api/workspaces` returns `defaultWorkspaceId` for clients that need to open:

```txt
/workspaces/:workspaceId/apps/:appId/docs/root
```

No `cloud_workspace`, `workspace_member`, `app_instance`, `app_sync_doc`, `app_asset`, scoped sync token, or Workspace head Y.Doc was added.

### 2026-05-21 Phase 3 Client Adoption

Tab Manager now resolves the default Cloud Workspace through `/api/workspaces` and opens its root sync document at:

```txt
/workspaces/:workspaceId/apps/tab-manager/docs/root
```

`@epicenter/workspace` exposed a `workspaceAppDocWsUrl()` helper for the product-shaped WebSocket route while keeping `roomWsUrl()` for compatibility. Tab Manager used the Workspace app doc URL when the default Workspace was known and fell back to `/rooms/:room` when the user was offline, signed out, or reauth was required before the default Workspace could be refreshed.

Tab Manager resolves `defaultWorkspaceId` when the signed-in app payload is built. Auth does not keep product Workspace selection in memory, and offline local workspace boot still depends only on `localIdentity`.

No `app_instance`, `app_sync_doc`, `app_asset`, scoped sync token, Workspace head Y.Doc, or Better Auth Organization product surface was added.

### 2026-05-21 Greenfield Cleanup Pass

The compatibility path was useful while proving the route, but it should not survive the greenfield clean break.

```txt
Product sentence:
  A signed-in Cloud app syncs one Workspace App Doc address.

Refuse:
  public `/rooms/:room` as a Cloud client fallback
  read-time personal Workspace repair
  silent subject replacement while a local workspace payload is mounted
  Cloud product route helpers as default `@epicenter/workspace` exports
  mutable prepare/build sidecars for app payload construction
```

### 2026-05-21 Phase 5, 6, And 7 Cleanup

Checkpoint 1 refused Tab Manager's `/rooms/:room` Cloud fallback.

```txt
Product sentence:
  Tab Manager syncs Cloud data through one Workspace App Doc URL when a
  default Workspace is known.

Current drift:
  Missing defaultWorkspaceId opened /rooms/:room, and buildSession passed the
  Workspace id through a mutable resolver object.

Owner:
  resolveDefaultWorkspaceId owns Workspace lookup. createSession owns
  prepare/build sequencing. Tab Manager owns its product route string.

Refusal option:
  Refuse legacy room fallback and sidecar state.

User loss:
  If /api/workspaces is offline or unavailable, Tab Manager opens local data
  without Cloud sync.

Decision:
  Refused. tabManagerSyncUrl now returns undefined without a Workspace id, and
  openTabManagerBrowser installs a local-only collaboration object instead of
  opening /rooms/:room.
```

Checkpoint 2 kept `/api/workspaces` read-only and proved signup provisioning.

```txt
Product sentence:
  Signup creates the personal Cloud Workspace before Workspace listing matters.

Current drift:
  The creation and read-only listing tests existed separately, but no single
  test proved the creation path made /api/workspaces useful.

Owner:
  createPersonalCloudWorkspace owns organization and owner membership creation.
  listCloudWorkspaces owns read-only membership listing.

Refusal option:
  Refuse repair-by-read.

User loss:
  Broken accounts get an error instead of hidden repair.

Decision:
  Refused. The new provisioning test creates the personal Workspace, lists
  workspaces, and asserts the default owner membership is already present.
```

Checkpoint 3 refused silent subject replacement.

```txt
Product sentence:
  A mounted local workspace payload belongs to one auth subject.

Current drift:
  applySignIn could replace a persisted subject directly if another sign-in
  grant completed while a payload was mounted.

Owner:
  Auth owns account switching. Session owns disposal when auth publishes
  signed-out.

Refusal option:
  Refuse silent subject replacement by publishing a signed-out gap before
  installing a different subject.

User loss:
  Account switching has an observable sign-out boundary. Same-subject reauth
  still works.

Decision:
  Refused. startSignIn publishes signed-out before installing a different
  subject, and createSession has a lifecycle test for dispose-before-remount
  across that gap.
```

Checkpoint 4 rehomed the Cloud route helper for Tab Manager and deferred the
published package API removal.

```txt
Product sentence:
  packages/workspace owns collaboration primitives; Cloud apps own product
  route construction.

Current drift:
  @epicenter/workspace exports workspaceAppDocWsUrl(), but the only in-repo
  production caller was Tab Manager.

Owner:
  Tab Manager owns its app route. @epicenter/workspace owns websocketUrl(),
  roomWsUrl(), openCollaboration(), and Yjs primitives.

Refusal option:
  Refuse new app callers for workspaceAppDocWsUrl() and rehome Tab Manager's
  route construction locally.

User loss:
  None for in-repo callers. Removing the root export itself can break external
  package consumers.

Decision:
  Rehomed the in-repo caller. Deferred deleting the public export because
  @epicenter/workspace is a published package API.

Trigger to revisit:
  The next intentional @epicenter/workspace breaking API pass may remove
  workspaceAppDocWsUrl() after release notes or a migration note name the
  replacement.
```

`/rooms/:room` remains in the API only as explicit non-Cloud personal-room and
daemon compatibility. In-repo callers still include Fuji, Honeycrisp,
Opensidian, Zhongwen daemon paths, and workspace daemon infrastructure. Deleting
the handler is deferred until those callers move to Workspace App Doc routes or
a separate personal-room compatibility decision removes them.

Files changed in this cleanup checkpoint:

```txt
apps/api/src/cloud-workspaces.test.ts
apps/tab-manager/src/lib/session.svelte.ts
apps/tab-manager/src/lib/tab-manager/default-workspace.ts
apps/tab-manager/src/lib/tab-manager/default-workspace.test.ts
apps/tab-manager/src/lib/tab-manager/extension.ts
apps/tab-manager/src/lib/tab-manager/sync-url.ts
apps/tab-manager/src/lib/tab-manager/sync-url.test.ts
packages/auth/src/contract.test.ts
packages/auth/src/create-oauth-app-auth.ts
packages/svelte-utils/src/session.svelte.ts
packages/svelte-utils/src/session.svelte.test.ts
specs/20260520T190000-cloud-workspace-app-instance-clean-break.md
```

The target flow is smaller:

```txt
sign up
  -> create user
  -> create deterministic personal Workspace organization
  -> create owner membership

sign in
  -> fetch /api/session
  -> fetch /api/workspaces
  -> build app payload for localIdentity.subject
  -> open /workspaces/:workspaceId/apps/:appId/docs/root

Workspace lookup unavailable
  -> open local data without Cloud sync, or stay unavailable
  -> do not sync to /rooms/:room

account switch
  -> publish signed-out
  -> dispose mounted local workspace payload
  -> install new subject
  -> build a new payload
```

The implementation should run as build, prove, remove:

```txt
1. Build explicit local-only or unavailable behavior for missing Workspace lookup.
2. Prove Tab Manager opens only Workspace App Doc sync when Cloud sync is available.
3. Remove `/rooms/:room` fallback from Tab Manager and its tests.
4. Remove or rehome `workspaceAppDocWsUrl()` from the public workspace package surface if no external package owns that helper.
5. Prove account provisioning owns personal Workspace membership.
6. Prove auth subject changes dispose before remount.
```

### 2026-05-21 Spec Reconciliation Checkpoint

A later spec, `20260521T160000-server-default-workspace-route.md`, landed on
this branch and superseded the route family and client architecture this spec
planned. This checkpoint reconciles the checklist with the code that is
actually on `redesign/server-owned-presence`. No tables, schemas, or public
APIs were changed in this checkpoint.

```txt
Landed and still standing:
  Better Auth organization backs Cloud Workspace (Phase 2)
  appId/docId validators; no app_instance, app_sync_doc, app_asset (Phase 3)
  host-built v1: roomName; policy-free SyncEngine and Room (Phase 4.3-4.7)
  /rooms/:room narrowed to daemon and non-Cloud compatibility (Phase 5)
  read-only /api/workspaces; signup-owned provisioning; account-switch
    boundary; dispose-before-remount lifecycle test (Phase 7)

Superseded by server-default-workspace routing:
  /workspaces/:workspaceId/apps/:appId/docs/:docId route family (Phase 4.1-4.2)
    deleted; /me/apps/:appId/docs/:docId replaced it
  client-side workspaceId resolution from /api/workspaces (Phase 6.1)
  client opening /workspaces/:workspaceId/... URLs (Phase 6.2)
  prepare/build Workspace-default sidecar and the deferred-collaboration
    wrapper: cloud-app-sync.ts, openCloudAppSync, and the client
    workspaceAppDocWsUrl builder (Phase 6.5); apps now call openCollaboration
    directly

Rejected as stale, not implemented:
  re-adding the explicit /workspaces/:workspaceId/... route family
    (zero clients; re-add only if a workspace-switching UI needs to name a
    workspaceId)
  migrating the daemon off /rooms/:room (the daemon is a config-known
    service principal; /rooms/:room stays as its compatibility path and
    cannot be narrowed further while the daemon and examples/ call it)
  app_instance, app_sync_doc, app_asset, app_key_grant, app registry,
    workspace_profile (all still deferred behind their earned-table triggers
    in the Greenfield Ambiguity Ledger; no product operation has earned one)

Decisions affirmed:
  the server resolves the default workspace; clients do not own workspaceId
  /api/workspaces stays read-only and off the sync critical path
  /rooms/:room is not a Cloud client fallback
```

The `/api/workspaces` listing currently has no client consumer. It is kept
deliberately, per the server-default-workspace spec, for a future
workspace-switching UI; it is no longer on the sync critical path. The only
code edit in this checkpoint was dropping a stale `/api/workspaces`
default-resolution reference from the daemon-infrastructure JSDoc.

## Greenfield Review Protocol

Use this review loop any time a cleanup pass finds a fallback, optional shape, helper, or exported type that only exists because the invariant is checked too late.

```txt
1. Write the product sentence.
2. Name each important value and its owner.
3. Mark the late invariant.
4. List the code family the late invariant creates.
5. Ask what disappears if the invariant moves to its owner.
6. Apply only changes that remove a second path, shrink public surface, or move the invariant earlier.
7. Re-read every touched file and update this spec with what was refused, kept, or deferred.
```

Use this finding format before editing:

```txt
Product sentence:
  ...

Current drift:
  ...

Owner:
  ...

Refusal option:
  ...

User loss:
  ...

Decision:
  Refuse it / keep it / defer it because ...
```

If the decision keeps or defers a table, name the earned-table trigger in the same finding.

```txt
Earned-table trigger:
  ...
```

Do not leave a cleanup ambiguity with only an unspecified future revisit. It must resolve to one of these outcomes:

```txt
Refusal:
  the behavior is not part of the greenfield product

Owner:
  an existing layer owns the invariant without a new table

Earned-table trigger:
  the first concrete product operation that makes a new table worth adding
```

## Greenfield Ambiguity Ledger

Every Cloud Workspace and app sync ambiguity must fit this ledger shape before implementation starts.

### Subject-Scoped Cloud Fallback

```txt
Product sentence:
  A signed-in Cloud app syncs one Workspace App Doc address.

Current drift:
  Tab Manager still treats missing defaultWorkspaceId as permission to open
  /rooms/:room. The API also still exposes /rooms/:room for compatibility.

Owner:
  The client session owns local-only or unavailable behavior. The Cloud sync
  route owns Workspace, App, Doc authorization and roomName construction.

Refusal option:
  Refuse /rooms/:room as a Cloud app fallback. Keep it only as an explicit
  personal-room compatibility route until the cleanup phase removes it.

User loss:
  When /api/workspaces is unavailable, a signed-in Cloud app will not silently
  sync through the old personal route. It must open local data without Cloud
  sync or show an unavailable state.

Decision:
  Refuse the fallback. Greenfield Cloud sync has one identity:
  workspaceId + appId + docId.
```

### Read-Time Workspace Repair

```txt
Product sentence:
  Signup creates the personal Cloud Workspace before Workspace listing matters.

Current drift:
  /api/workspaces could be tempted to create missing organization/member rows
  because it knows the deterministic personal Workspace id.

Owner:
  Better Auth user.create hook owns personal Workspace provisioning.
  /api/workspaces owns read-only membership listing.

Refusal option:
  Refuse repair-by-read. A missing personal Workspace membership is an account
  provisioning bug.

User loss:
  A broken account gets an error instead of a hidden repair.

Decision:
  Refuse read-time repair. Add invariant tests around signup provisioning and
  keep /api/workspaces read-only.
```

### Silent Subject Replacement

```txt
Product sentence:
  A mounted local workspace payload belongs to exactly one auth subject.

Current drift:
  createOAuthAppAuth can apply a new sign-in grant over an existing signed-in
  state. createSession assumes two identity-bearing states are the same subject
  and keeps the payload mounted.

Owner:
  Auth owns account switching. Session owns disposing the payload when auth
  publishes signed-out.

Refusal option:
  Refuse silent account replacement. startSignIn must be invalid while signed
  in, or account switching must publish signed-out before installing a new
  subject.

User loss:
  Switching accounts needs an explicit sign-out or account-switch flow.

Decision:
  Refuse silent replacement. Do not make downstream workspace code defend
  against two subjects in one mounted payload.
```

### Public Cloud Route Helper In Workspace Package

```txt
Product sentence:
  packages/workspace owns collaboration primitives; Cloud apps own product
  route construction.

Current drift:
  @epicenter/workspace exports workspaceAppDocWsUrl(), which bakes Cloud
  route vocabulary into a published workspace-library surface.

Owner:
  App packages or the Cloud API client own product routes. packages/workspace
  owns websocketUrl(), roomWsUrl(), openCollaboration(), and Yjs primitives.

Refusal option:
  Refuse a public Cloud product helper in @epicenter/workspace unless external
  workspace consumers need it.

User loss:
  App packages write the short Workspace App Doc URL builder themselves or
  import it from a Cloud-owned helper later.

Decision:
  Refuse the public export by default. Pause before removing the published API;
  the spec authorizes the investigation but not an unreviewed package API break.
```

### Mutable Prepare Sidecar

```txt
Product sentence:
  Session preparation returns the data needed to build the identity-bound app
  payload.

Current drift:
  Tab Manager stores defaultWorkspaceId in a resolver object between prepare()
  and build(), so the ordering contract is implicit.

Owner:
  createSession owns prepare/build sequencing. The app build callback owns how
  prepared Workspace defaults enter app construction.

Refusal option:
  Refuse mutable sidecars for prepared values. prepare() should return the
  value build() receives.

User loss:
  None visible. The implementation shape changes.

Decision:
  Refuse sidecars when changing this surface. This can require a shared
  createSession API change, so pause if the published auth/session contract
  would need a migration rule.
```

### Active Workspace In Auth Session

```txt
Product sentence:
  Auth says who is signed in; routes and UI state say which Workspace is open.

Current drift:
  Better Auth exposes activeOrganizationId, which could be projected as
  activeWorkspaceId in ApiSessionResponse.

Owner:
  Auth owns user identity and localIdentity. Workspace route parameters,
  app navigation, or user preferences own selected Workspace.

Refusal option:
  Refuse activeWorkspaceId in auth/session.

User loss:
  The UI cannot get selected Workspace from /api/session. It must use route
  state, local UI state, or a future preference.

Decision:
  Refuse. Do not change PersistedAuth, ApiSessionResponse, or session schema
  for Workspace selection in this pass.
```

### Default App Rows

```txt
Product sentence:
  Apps are available by catalog; app data exists when the app opens its root doc.

Current drift:
  New Workspace provisioning could create default app, installation, or
  app_instance rows so the UI can list first-party apps.

Owner:
  The app catalog owns available app definitions. The app root Y.Doc owns
  app data. Cloud Workspace provisioning owns only organization and membership.

Refusal option:
  Refuse default app rows.

User loss:
  Cloud cannot infer "installed apps" from SQL in phase 1. The UI lists
  catalog apps and opens root docs directly.

Decision:
  Refuse. Default app rows would create a second lifecycle before any product
  operation needs one.
```

### Multiple Instances Of One App

```txt
Product sentence:
  One Workspace has one app namespace per appId.

Current drift:
  Product language around App Instance could invite multiple copies of the same
  app in one Workspace.

Owner:
  App Namespace owns workspaceId + appId. App root Y.Doc owns app semantics
  inside that namespace.

Refusal option:
  Refuse multiple same-app instances in phase 1.

User loss:
  A Workspace cannot create "Tab Manager A" and "Tab Manager B" as separate
  Cloud-managed instances.

Decision:
  Refuse until a product lifecycle operation earns app_instance.

Earned-table trigger:
  Add app_instance only when Cloud must rename, delete, duplicate, disable,
  bill, configure, permission, or list installed app instances independently
  of app-owned Yjs data.
```

### App-Level Privacy

```txt
Product sentence:
  Workspace membership grants access to phase 1 app namespaces.

Current drift:
  Private apps or app-level roles could be modeled with app_instance_member,
  Better Auth teams, app metadata, or route conditionals.

Owner:
  Cloud Workspace membership owns phase 1 access. App root Y.Doc may own
  app-level product visibility that does not protect sync access.

Refusal option:
  Refuse app-level privacy in phase 1.

User loss:
  Every Workspace member can open every valid first-party app namespace.

Decision:
  Defer behind an earned table. Do not compress app privacy into route parsing,
  Better Auth teams, or app metadata.

Earned-table trigger:
  Add app_instance_member, or an equivalent policy table, only when Cloud must
  make one app namespace visible to some Workspace members and forbidden to
  others.
```

### Workspace Profile Table

```txt
Product sentence:
  Better Auth organization is the phase 1 Cloud Workspace row.

Current drift:
  Workspace-specific product fields could be added to Better Auth metadata or
  a duplicate cloud_workspace table without a clear owner.

Owner:
  Better Auth organization owns identity, name, slug, and membership.
  workspace_profile owns only product fields that do not belong to Better Auth.

Refusal option:
  Refuse workspace_profile in phase 1.

User loss:
  Workspace product fields are limited to Better Auth organization fields and
  metadata.

Decision:
  Defer behind an earned table. Do not add cloud_workspace as a duplicate
  identity row.

Earned-table trigger:
  Add workspace_profile only when Cloud needs custody mode, deletion lifecycle,
  export/import lineage, default app policy, or billing cache fields that should
  not live in Better Auth organization metadata.
```

### Sync Doc Inventory

```txt
Product sentence:
  The app root Y.Doc owns the app's document graph.

Current drift:
  Cloud could add app_sync_doc so every docId has a relational row before sync.

Owner:
  App root Y.Doc owns child doc references. The sync route owns syntax,
  membership authorization, and roomName construction.

Refusal option:
  Refuse required app_sync_doc rows in phase 1.

User loss:
  Cloud cannot list, delete, migrate, support, or meter every Sync Doc from SQL
  without reading app data or room telemetry.

Decision:
  Defer behind an earned table. A valid docId can sync without a Postgres row.

Earned-table trigger:
  Add app_sync_doc only when Cloud must run a product operation over Sync Docs
  without app-owned root data: deletion, migration, support inspection, metering,
  retention, legal hold, or cross-doc search.
```

### App Asset Inventory

```txt
Product sentence:
  Apps own blob references; object storage owns bytes.

Current drift:
  Existing asset and reconciliation code is user-scoped, while this spec says
  Cloud billing and app namespaces are Workspace-shaped. A new app_asset table
  could be added before the product operation is real.

Owner:
  App root Y.Doc owns blob references. Object storage owns bytes under a
  workspace/app/doc-aware prefix. Billing reconciliation owns aggregate totals.

Refusal option:
  Refuse app_asset in phase 1.

User loss:
  Cloud cannot list app files, cascade-delete one app namespace's blobs, or
  produce per-app asset inventory from SQL.

Decision:
  Defer behind an earned table. Do not use app_asset to repair a prefix or
  billing ambiguity that can be solved by owner-aware object keys and aggregate
  reconciliation.

Earned-table trigger:
  Add app_asset only when Cloud must list, delete, retain, meter, export, or
  support blobs independently of app-owned Yjs references.
```

### Customer-Managed Or User-Held Keys

```txt
Product sentence:
  Phase 1 Cloud custody is server-managed.

Current drift:
  User-held keys, customer-managed keys, or app_key_grant could be introduced
  while there is still only one custody mode.

Owner:
  Server-managed Cloud owns key derivation and recovery in phase 1. A future
  custody subsystem owns grants only after a second mode exists.

Refusal option:
  Refuse app_key_grant and custody_mode storage in phase 1.

User loss:
  Cloud cannot claim zero-knowledge, user-held, or customer-managed custody.

Decision:
  Defer behind an earned table. Do not represent a second custody mode before
  the product can execute it.

Earned-table trigger:
  Add app_key_grant, or require self-host/customer-managed deployment, only when
  a Workspace can actually grant, revoke, rotate, recover, and audit user-held
  or customer-managed keys.
```

### App Registry Requirement

```txt
Product sentence:
  Cloud validates the namespace, not app semantics.

Current drift:
  The route flow says appId may optionally require a known Cloud app registry.
  Without a decision, that optional check becomes another source of truth.

Owner:
  A static app catalog owns first-party app definitions in phase 1. The sync
  route owns appId syntax and Workspace membership.

Refusal option:
  Refuse a required app registry table in phase 1.

User loss:
  Cloud cannot dynamically enable, disable, or discover app definitions from SQL.

Decision:
  Use a static catalog if the UI needs display metadata. Do not add a registry
  table or require per-Workspace app rows before lifecycle operations earn them.

Earned-table trigger:
  Add an app registry table only when Cloud must publish third-party apps,
  manage versions, disable apps centrally, review marketplace metadata, or
  bind app definitions to billing/policy.
```

Candidate greenfield smells:

```txt
compatibility fallback beside the canonical path
read endpoint that repairs missing write-side state
optional argument that keeps an old mental model alive
helper exported only so one app can hide product route construction
state object that passes data between lifecycle callbacks
type alias that duplicates a factory return shape
test fixture that preserves old behavior as a requirement
```

## Execution Prompts

### Implementation Prompt

```txt
Implement the greenfield cleanup pass in `specs/20260520T190000-cloud-workspace-app-instance-clean-break.md`.

First read `AGENTS.md`, the spec, and the `cohesive-clean-breaks`, `one-sentence-test`, `refactoring`, `approachability-audit`, and `post-implementation-review` skills. Treat the spec as greenfield: there are no existing users and no `/rooms/:room` migration burden.

Review these surfaces first:

- `apps/tab-manager/src/lib/tab-manager/sync-url.ts`
- `apps/tab-manager/src/lib/tab-manager/default-workspace.ts`
- `apps/tab-manager/src/lib/session.svelte.ts`
- `packages/svelte-utils/src/session.svelte.ts`
- `packages/auth/src/create-oauth-app-auth.ts`
- `packages/auth/src/auth-contract.ts`
- `packages/workspace/src/document/transport.ts`
- `packages/workspace/src/index.ts`
- `apps/api/src/cloud-workspaces.ts`
- `apps/api/src/auth/create-auth.ts`
- `apps/api/src/app.ts`

Before editing each surface, report findings in this shape: Product sentence, Current drift, Owner, Refusal option, User loss, Decision. Include Earned-table trigger when the decision defers a table.

Apply only changes that remove a duplicate path, shrink public surface, or move an invariant to its owner. Do not add `app_instance`, `app_sync_doc`, `app_asset`, scoped sync tokens, a Workspace head Y.Doc, or read-time Workspace repair.

Expected outcomes:

- Tab Manager no longer falls back to public `/rooms/:room` for Cloud sync.
- Missing Workspace lookup becomes explicit local-only or unavailable behavior.
- `/api/workspaces` remains read-only.
- Account provisioning owns personal Workspace creation.
- Auth subject switching disposes the old local workspace payload before a new subject mounts.
- Product Cloud route helpers are not public `@epicenter/workspace` exports unless the spec records that package ownership decision.

Validate with targeted `bun test` for changed files and package `typecheck` for changed packages. Update the spec checklist and Implementation Notes after each checkpoint. Pause before changing durable storage schemas, `PersistedAuth`, `ApiSessionResponse`, Better Auth generated schema, or published package APIs not already called out by the spec.
```

### Continuous Greenfield Goal

```txt
/goal Continue the greenfield clean-break pass for `specs/20260520T190000-cloud-workspace-app-instance-clean-break.md` until every checklist item in Phases 5, 6, and 7 is either complete or explicitly deferred in the spec. First read `AGENTS.md`, the spec, and the `cohesive-clean-breaks`, `collapse-pass`, `one-sentence-test`, `refactoring`, `approachability-audit`, and `post-implementation-review` skills. Work in checkpoints. For each checkpoint, inspect one changed feature surface from the last relevant commits, write Product sentence, Current drift, Owner, Refusal option, User loss, Decision, and Earned-table trigger when a table is deferred, then apply only changes that remove a duplicate path, shrink public surface, or move an invariant to its owner. After each edit, run targeted `bun test` plus package `typecheck`, re-read touched files, update the spec checklist and Implementation Notes, and surface the validation result. Stop when Phases 5, 6, and 7 are complete or after three consecutive reviewed surfaces produce no findings. Pause before durable storage schema changes, Better Auth generated schema edits, `PersistedAuth` or `ApiSessionResponse` changes, published package API removals not already authorized by the spec, or any migration policy that contradicts greenfield assumptions.
```

## Greenfield Review Rules

Use this section for future cleanup passes. The product sentence is:

```txt
Cloud Workspace is the product account boundary; app namespaces are entered by workspaceId + appId; sync docs are addressed explicitly.
```

Anything that makes that sentence need an exception is a clean-break candidate.

### Active Workspace

Do not expose Better Auth `activeOrganizationId` as `activeWorkspaceId`.

```txt
Auth session:
  who is signed in?

Workspace route:
  which workspace is this request for?
```

Workspace selection is route or UI state. Cloud resource URLs already carry the workspace:

```txt
/workspaces/:workspaceId/apps/:appId/docs/:docId
```

If the UI later needs "last opened workspace", store that as a user preference or local UI state. Do not put product navigation state into the auth/session contract.

### Default Apps

Do not create default app rows for every new Workspace.

```txt
Apps are available by definition.
App data exists when opened.
```

The UI may show first-party apps from a static app catalog, but Cloud should not insert `workspace_app`, `app_instance`, or `app_installation` rows for each new Workspace. Opening an app is enough:

```txt
/workspaces/ws_123/apps/tab-manager/docs/root
```

The app-owned root Y.Doc is the source of truth for that app namespace until a Cloud operation earns a table.

### Multiple Instances

Do not support multiple instances of the same app in one Workspace.

```txt
One Workspace has one namespace per appId.
```

Supported:

```txt
/workspaces/ws_123/apps/tab-manager/docs/root
```

Refused for now:

```txt
/workspaces/ws_123/apps/tab-manager-1/docs/root
/workspaces/ws_123/apps/tab-manager-2/docs/root
```

An `app_instance` table is earned only by product lifecycle operations:

```txt
rename instance
delete instance
duplicate instance
disable instance
bill instance
set instance-specific permissions
list installed app instances
```

Until one of those operations exists, `workspaceId + appId` is the boundary.

### Greenfield Cleanup Loop

Run this loop after any Cloud Workspace or app sync change:

```txt
1. Write the product sentence for the changed surface.
2. List every owner: auth, Workspace API, app catalog, app root Y.Doc, sync route, Room.
3. Search for repair paths: ensure*, fallback, optional response fields, compatibility aliases, default rows, duplicate helpers.
4. Ask whether the product sentence survives if that behavior is refused.
5. If it survives, delete the behavior and record the refusal.
6. Validate with targeted tests and typecheck.
```

Refusal defaults:

```txt
No activeWorkspaceId in auth.
No default app rows.
No multiple app instances.
No app_sync_doc table.
No app_asset table.
No app registry table.
No app_instance_member table.
No app_key_grant table.
No Workspace head Y.Doc.
No scoped sync token.
No public Organization product surface.
No subject-scoped Cloud sync route in greenfield mode.
```

## Resolved And Deferred Questions

Resolved for greenfield:

1. `activeWorkspaceId` in auth is refused. Workspace selection is route or UI state.
2. Default app rows are refused. Show apps from a catalog; create app data on open.
3. Multiple app instances are refused. Add `app_instance` only when lifecycle operations earn it.
4. App-level privacy is deferred. Every Workspace member can open every phase 1 app namespace. Add `app_instance_member` only when Cloud must make one app namespace visible to some Workspace members and forbidden to others.
5. `workspace_profile` is deferred. Add it only for custody mode, deletion lifecycle, export/import lineage, default app policy, or billing cache fields that should not live in Better Auth organization metadata.
6. `app_sync_doc` is deferred. Add it only when Cloud must delete, migrate, inspect, meter, retain, legally hold, or search Sync Docs without reading app-owned root data.
7. `app_asset` is deferred. Add it only when Cloud must list, delete, retain, meter, export, or support blobs independently of app-owned Yjs references.
8. `app_key_grant` is deferred. Add it, or require self-host/customer-managed deployment, only when a Workspace can actually grant, revoke, rotate, recover, and audit user-held or customer-managed keys.
9. An app registry table is deferred. Use a static first-party app catalog until third-party publishing, app version policy, central disablement, marketplace metadata, or app-bound billing and policy earns a table.

## References

- Better Auth organization plugin grounding: https://deepwiki.com/search/for-the-organization-plugin-ca_4c544468-a46e-4704-8f77-7d3d09a08075
- Yjs document boundary grounding: https://deepwiki.com/search/for-an-app-with-a-hierarchy-wo_6e15f867-ab97-4d2e-8b3e-a7602ccda9ea
- y-indexeddb naming grounding: https://deepwiki.com/search/for-a-hierarchy-workspace-app_c29d43b0-e146-428b-af9f-6e2cafb92c8b
- Cloudflare Durable Object sync-doc grounding: https://deepwiki.com/search/for-cloudflare-durable-objects_f4afa7fa-3c24-4a3e-b47b-b108ea8d9417
- Yjs protocol host boundary grounding: https://deepwiki.com/search/for-a-workspace-app-instance-s_0ccef3e3-e831-411f-803f-73b7d9813832
- Linear Workspaces: https://linear.app/docs/workspaces
- Linear Teams: https://linear.app/docs/teams
- Supabase Platform: https://supabase.com/docs/guides/platform
- Supabase billing: https://supabase.com/docs/guides/platform/billing-on-supabase
