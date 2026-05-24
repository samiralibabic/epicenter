# Subject Principal Surface

**Date**: 2026-05-19
**Status**: Superseded

Superseded by the current sync-room decision: no org-scoped rooms now, the host owns Room Durable Object name construction, and workspace-scoped rooms wait until real workspace access checks exist. This draft is useful background for the typed subject string, but its `Subject.toRoomName()` API would move a host-owned routing decision into the auth package.

## One Sentence

Epicenter should make `subject` a typed workspace-data owner principal, formatted as `user:{user.id}` today, centralized behind a `Subject` namespace module, and deliberately keep orgs out of the subject model until the product chooses team-owned data. This remains a possible subject-shape direction, not an active room-name implementation plan.

## Overview

This spec updates the subject architecture now that there are no users to migrate. The right clean-break value is no longer raw Better Auth `user.id`; it is a typed subject string with a kind prefix. The only supported kind today is `user`. The surface should reserve room for `service` without adding it before a real service-account flow exists.

## Motivation

### Current State

`/api/session` returns the local identity used to open encrypted local-first data:

```ts
localIdentity: {
	subject: user.id,
	keyring: await deriveSubjectKeyring(user.id),
}
```

Room Durable Objects are also keyed from the same raw user id:

```ts
const doName = `subject:${c.var.user.id}:rooms:${room}`;
```

Subject-key derivation uses the same string as an HKDF label:

```ts
info: textEncoder.encode(`subject:${subject}`);
```

That makes `subject` conceptually correct but structurally ambiguous. A persisted value like `cm8...` does not say whether it is a human user, service account, org, imported principal, tenant, or workspace id. Since no user data exists yet, this is the moment to choose the better wire string.

### Desired State

Use a kind-prefixed subject from the first real sign-in:

```txt
user:{user.id}
```

Callers do not format this directly. They go through a namespace module:

```ts
import * as Subject from '@epicenter/auth/subject';

const subject = Subject.fromUser(user);
const doName = Subject.toRoomName(subject, room);
const info = Subject.toHkdfInfo(subject);
```

The same subject value then flows through `/api/session`, persisted auth cells, HKDF info labels, Durable Object names, IndexedDB owner scopes, and BroadcastChannel names.

## Core Model

```txt
subject = workspace-data owner principal

It answers one question:
  Whose local-first data is this?

It does not answer:
  Who is logged in?          Better Auth user
  Which device is this?      installationId
  Which document is this?    ydoc.guid
  Which tenant is this?      Worker routing or deployment boundary
  Which org owns billing?    organization model
```

Today the only data owner is a human account:

```txt
Better Auth user.id
  -> Subject.fromUser(user)
  -> user:{user.id}
```

## Why `service:` Exists As A Reserved Kind

`service:` names a machine principal that owns its own workspace data. It is not a device, install, CLI process, or daemon running on behalf of a human.

This distinction matters:

```txt
Human-owned daemon
  subject: user:{user.id}
  installationId: cli-daemon-on-mbp
  meaning: the daemon acts for the human account

Service-owned worker
  subject: service:{serviceId}
  installationId: hosted-ingest-worker-01
  meaning: the service owns data directly
```

Why reserve the prefix:

1. A future ingest worker, import bot, or scheduled automation may need data that is not owned by one human account.
2. `service:` keeps that identity out of the `user:` namespace without needing a rename later.
3. It avoids overloading `installationId`. Installs are runtime addresses. They can restart, move, and multiply. They do not own encrypted data.
4. It avoids overloading orgs. An org can grant access, group people, and pay bills without becoming a cryptographic owner.

Do not implement `Subject.fromService()` until the first service-owned data flow exists. Reserve the format in docs and tests only where parser forward-compatibility needs it.

## Should We Support Users And Orgs Only?

No. The better split is not users versus orgs. The better split is owner principals versus product relationships.

```txt
Owner principals:
  user:{userId}
  service:{serviceId}        reserved

Product relationships:
  org membership
  workspace ACL grant
  public share token
  billing tenant
  imported account issuer
```

Under the current Google Docs model, orgs are not subjects. They are groups that drive grants.

```txt
Bob owns a workspace:
  subject = user:bob
  room    = subject:user:bob:rooms:R
  key     = derived from user:bob

Bob shares with Alice:
  owner subject stays user:bob
  ACL grants Alice access
  workspace key is wrapped for Alice

Bob shares with Team Blue:
  owner subject still user:bob
  org membership expands into grants
  org itself does not derive the workspace key
```

If Epicenter later chooses Vercel-style team-owned workspaces, then `org:{orgId}` becomes a subject kind. That is a product pivot, not a small extension. It changes ownership, ACLs, key wrapping, revocation, billing language, and the app.ts Google Docs model comment.

## Namespace Import Rule

Use namespace imports for this module:

```ts
import * as Subject from '@epicenter/auth/subject';
```

This keeps call sites readable:

```ts
const subject = Subject.fromUser(user);
const roomName = Subject.toRoomName(subject, room);
const keyInfo = Subject.toHkdfInfo(subject);
```

Avoid scattering named helpers like `subjectFromUser`, `subjectToRoomName`, and `subjectToHkdfInfo`. The module has one strong noun, so the namespace carries the domain name once and the functions can use small verbs.

Do not apply this rule to grab-bag modules. `Subject.*` works because every export is about one concept.

## Before And After

Assume `user.id = abc` and `ydoc.guid = R`.

| Surface | Current | Clean break |
| --- | --- | --- |
| API subject | `abc` | `user:abc` |
| HKDF info | `subject:abc` | `subject:user:abc` |
| Room DO name | `subject:abc:rooms:R` | `subject:user:abc:rooms:R` |
| Peer DO name | `subject:abc:peers` | `subject:user:abc:peers` |
| Browser local owner | `abc` | `user:abc` |
| IndexedDB name | `epicenter.owner.abc.yjs.R` | `epicenter.owner.user:abc.yjs.R` |
| Workspace HKDF info | `workspace:R` | `workspace:R` |
| installationId | `browser-profile-1` | `browser-profile-1` |

The changes are intentional only where the subject value appears. `workspace:{workspaceId}`, `ydoc.guid`, and `installationId` stay separate.

## API Story

This is the simplest end-to-end story.

```txt
1. User signs in
   Better Auth proves the human account.

2. API builds the subject
   Subject.fromUser(user) -> user:{user.id}

3. API derives local identity
   Subject.toHkdfInfo(subject) -> subject:user:{user.id}
   deriveSubjectKeyring(rootKeys, hkdfInfo) -> SubjectKeyring

4. API returns session
   GET /api/session
     user
     localIdentity.subject = user:{user.id}
     localIdentity.keyring

5. Client persists the session cell
   grant + localIdentity

6. Session opens a local owner
   ownerId = localIdentity.subject

7. Workspace opens local storage
   epicenter.owner.user:{user.id}.yjs.{ydoc.guid}

8. Workspace connects to sync
   /rooms/{ydoc.guid}?installationId={installationId}

9. API routes to the room DO
   Subject.toRoomName(subject, ydoc.guid)
   -> subject:user:{user.id}:rooms:{ydoc.guid}
```

## API Surface Tree

```txt
packages/auth
  src/subject.ts
    type Subject
    type SubjectKind = 'user'
    fromUser(user) -> Subject
    kindOf(subject) -> SubjectKind
    toHkdfInfo(subject) -> string
    toRoomName(subject, room) -> string
    fromRoomName(name) -> { subject, room }
    toPeerName(subject) -> string
    fromPeerName(name) -> { subject }

apps/api
  src/app.ts
    GET /api/session
      user -> Subject.fromUser(user)
      subject -> deriveSubjectKeyring(subject)

    getRoomStub(c)
      user -> Subject.fromUser(user)
      room -> Subject.toRoomName(subject, room)
      env.ROOM.idFromName(roomName)

  src/auth/encryption.ts
    deriveSubjectKeyring(subject)
      Subject.toHkdfInfo(subject)
      @epicenter/encryption derives bytes

  src/room.ts
    constructor(ctx)
      Subject.fromRoomName(ctx.id.name)
      room subject is context, not per-message input

packages/workspace
  src/document/local-owner.ts
    ownerId = localIdentity.subject
    ownerId names local storage scope

  src/document/local-yjs-key.ts
    createOwnedYjsKey(ownerId, ydoc.guid)

  src/document/installation-id.ts
    installationId names one install, never a data owner
```

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Subject definition | 2 coherence | Workspace-data owner principal | It matches auth, encryption, DO routing, and local storage ownership without collapsing device or document identity. |
| Current subject format | 2 coherence | `user:{user.id}` | No users exist, so the self-describing format should ship before persistence starts. |
| Org subject | Deferred | No `org:{orgId}` now | Current product model is Google Docs style. Orgs drive grants; users own data. |
| Service subject | Deferred | Reserve `service:{serviceId}` but do not implement | Service-owned data is plausible, but no concrete flow exists. The prefix prevents future namespace collision. |
| Helper location | 2 coherence | `packages/auth/src/subject.ts` | Auth owns the session identity contract. API and clients both need the same vocabulary. |
| Imports | 3 taste | `import * as Subject` | One strong domain noun with cohesive functions reads better as a namespace. |
| Encryption package ownership | 2 coherence | Encryption accepts formatted HKDF info or stays generic | Subject string format belongs to auth/session architecture, not low-level crypto. |
| Parser shape | 1 evidence | Parse until `:rooms:` or `:peers` | Subjects contain internal colons by design. Regexes like `^subject:([^:]+):` are now incorrect. |

## Implementation Plan

### Phase 1: Subject Module

- [ ] Add `packages/auth/src/subject.ts`.
- [ ] Export `Subject` namespace from `packages/auth/src/index.ts`.
- [ ] Add exact-string tests for `user:abc`, `subject:user:abc`, `subject:user:abc:rooms:R`, and `subject:user:abc:peers`.
- [ ] Add parser tests proving `service:ingest` round-trips through DO names even before `fromService()` exists.

### Phase 2: API Wiring

- [ ] Update `/api/session` to use `Subject.fromUser(user)`.
- [ ] Update resource-boundary session projection to use `Subject.fromUser(user)`.
- [ ] Update `getRoomStub()` to use `Subject.toRoomName(subject, room)`.
- [ ] Replace `room.ts` local parser with `Subject.fromRoomName(ctx.id.name)`.
- [ ] Update comments near `/api/session`, `getRoomStub()`, and room construction to point at the subject module.

### Phase 3: Key Derivation Boundary

- [ ] Decide whether `apps/api/src/auth/encryption.ts` calls `Subject.toHkdfInfo(subject)` or whether `@epicenter/encryption` accepts an already formatted info string.
- [ ] Make tests assert that `user:abc` derives with HKDF info `subject:user:abc`.
- [ ] Keep workspace derivation as `workspace:{workspaceId}`.

### Phase 4: Test And Fixture Flip

- [ ] Update API tests that expect `localIdentity.subject === user.id`.
- [ ] Update auth persisted-cell tests from `user-1` to `user:user-1`.
- [ ] Update encryption fixture tests from raw user ids to typed subject values.
- [ ] Update workspace local-owner tests to use `ownerId = user:user-1` where the value represents a session subject.

## Files That Should Change

```txt
packages/auth/src/subject.ts
packages/auth/src/subject.test.ts
packages/auth/src/index.ts
apps/api/src/app.ts
apps/api/src/auth/encryption.ts
apps/api/src/auth/resource-boundary.ts
apps/api/src/room.ts
apps/api/src/api-session.test.ts
apps/api/src/auth/resource-boundary.test.ts
apps/api/src/sync-handlers.test.ts
packages/auth/src/contract.test.ts
packages/auth/src/node/machine-auth.test.ts
packages/auth/src/node/machine-tokens-store.test.ts
packages/encryption/src/crypto.test.ts
packages/encryption/src/derivation.ts
packages/workspace/src/document/local-owner.test.ts
```

## Files That Should Not Change Conceptually

```txt
packages/workspace/src/document/installation-id.ts
  Remains install/device/browser-profile identity.

packages/workspace/src/document/local-owner.ts
  Keeps ownerId vocabulary for local storage scope.

packages/workspace/src/document/local-yjs-key.ts
  Keeps epicenter.owner.{ownerId}.yjs.{ydoc.guid}.

packages/workspace/src/document/derive-workspace-keyring.ts
  Keeps workspace key derivation based on workspace id.

apps/api/src/db/schema.ts
  durableObjectInstance.userId remains Better Auth user.id.
  durableObjectInstance.doName carries the full subject-formatted DO name.
```

## Invariants To Document

Place this near `Subject.fromUser`, `/api/session`, `getRoomStub()`, and the API subject-key derivation wrapper:

```ts
/**
 * Subject is the workspace-data owner principal.
 *
 * The exact string is persisted, used in HKDF info labels, embedded in
 * Durable Object names, and passed to browser-local storage as ownerId.
 * Build it only through the Subject module. Do not inline `user.id`,
 * DO name templates, or HKDF `subject:` labels at call sites.
 *
 * Subject is not installationId, ydoc.guid, workspaceId, tenantId, or orgId.
 * Changing the emitted string is a storage, routing, and encryption contract
 * change. Tests assert exact strings by design.
 */
```

## Open Product Questions

1. Do service accounts need to own data, or do all automations act on behalf of a human subject?
2. Does Epicenter want Google Docs ownership long term, or team-owned workspaces like Vercel and Supabase?
3. Should federation introduce `user:{issuer}:{userId}` before self-host import exists?
4. Should `SubjectIdentity.subject` validate a regex like `^user:[^:]+$` at the API boundary now?
5. Should peer dispatch ever cross subject boundaries through an ACL grant, or is dispatch always same-subject only?

## Recommendation

Ship `user:{user.id}` now. Put all subject construction, formatting, and parsing in `packages/auth/src/subject.ts`. Use `import * as Subject` at call sites. Reserve `service:{serviceId}` in the design, but do not implement a constructor until a real service-owned data flow lands. Keep orgs out of the subject model unless the product explicitly chooses team-owned data.
