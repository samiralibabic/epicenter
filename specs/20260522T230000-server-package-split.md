# Server package split: @epicenter/server + apps/api

Status: in progress on `braden-w/buffalo`
Started: 2026-05-22
Last updated: 2026-05-23
Owner: braden
Supersedes: specs/20260522T120000-personal-vs-team-deployment-mode.md

## 0. How to read this spec

This spec describes a multi-wave refactor that lives on branch
`braden-w/buffalo`. The intent is one coherent design (sections 1 to 9,
plus 10 for the client-side companion). The execution happens in waves
so the diff stays reviewable. Section A at the end tracks which waves
have landed and which are still ahead.

If you want the design only, read sections 1 to 10 top to bottom and
stop. If you want to know what is actually in the worktree right now,
jump to section A.

The shorthand throughout:

```
Server side       packages/server  (the Hono sub-app factories)
Cloud deployment  apps/api          (composes the library + Autumn extras)
Client side       packages/auth, packages/workspace, packages/svelte-utils,
                  packages/cli, apps/whispering, apps/dashboard, etc.
```

A single shared vocabulary spans all three: `Owner`, `ownerId(owner)`,
`ownerPath(owner)`, `doName(owner, ...)`. The next nine sections define
that vocabulary.

## 1. The punchline

> Personal mode and team mode are the same product. Personal mode
> **partitions data by user**. Team mode does not partition at all.

The partition is one path segment, `users/<userId>`, that appears in every
durable identifier the personal product writes. Team mode does not write
that segment because team mode has nothing to partition. There is no
`team/` literal anywhere except in the `Owner` discriminator.

Everything in this spec follows from that one sentence.

## 2. Goal

Split `apps/api/` into two layers:

```
packages/server/   the shared library; everything a self-hosted team needs.
apps/api/          Epicenter Cloud's deployment; thin composition on top of
                   @epicenter/server plus cloud-only additions (Autumn gates,
                   billing routes, dashboard SPA, admin endpoints).
```

Self-hosted team customers write their own `apps/server-team/` entrypoint
(roughly 15 lines) that imports `@epicenter/server`.

## 3. The Owner concept

`Owner` is the **shared vocabulary** across server, cloud, and every
client. The type definition lives in `@epicenter/auth` (the contract
package) so clients can import it without taking a dependency on
`@epicenter/server`. Server-side derivations (`doName`, `assetKey`,
`keyringLabel`, `assetOwnerFilter`) live in `@epicenter/server` and
consume the type. The string-form helper `ownerId(owner)` lives next to
the type in `@epicenter/auth` because both server and client compute it.

```ts
// packages/auth/src/owner.ts                  (the shared contract)

export type Owner =
  | { kind: 'personal'; userId: string }
  | { kind: 'team' };

export type OwnerKind = Owner['kind'];

/**
 * Stable string identifier for an Owner. Personal owners produce
 * `users/<userId>` (the partition prefix the server writes for DO names,
 * R2 keys, and HKDF labels). Team owners produce the literal `team`.
 *
 * Use this everywhere the client previously read `localIdentity.subject`.
 */
export function ownerId(owner: Owner): string {
  return owner.kind === 'personal' ? `users/${owner.userId}` : 'team';
}
```

```ts
// packages/server/src/owner.ts                (server-only derivations)

import type { Owner } from '@epicenter/auth';

export type OwnerPath = `users/${string}` | '';

export function ownerPath(o: Owner): OwnerPath {
  return o.kind === 'personal' ? `users/${o.userId}` : '';
}

function joinPath(...segments: string[]): string {
  return segments.filter(Boolean).join('/');
}

export function doName(o: Owner, roomId: string): string {
  return joinPath(ownerPath(o), 'rooms', roomId);
}

export function assetKey(o: Owner, assetId: string): string {
  return joinPath(ownerPath(o), 'assets', assetId);
}

export function keyringLabel(o: Owner): string {
  return joinPath(ownerPath(o), 'keyring');
}

export function assetOwnerFilter(o: Owner) {
  return o.kind === 'personal' ? eq(asset.userId, o.userId) : undefined;
}
```

One function (`ownerPath`) produces the partition segment. Every durable
string is built by concatenating it with a resource type and an id.
`joinPath` drops the empty partition segment so team mode strings have no
leading prefix.

**Why the split between auth and server.** Browser apps, the CLI, and the
workspace daemon all need to talk about Owners to render team-aware UI,
key local storage, and decide which signed-in account they are operating
as. None of them should depend on the Hono server library to do that.
`Owner` and `ownerId` are pure types and string functions; they belong
with the auth contract. The derivations that touch DO names, R2 keys,
and HKDF labels are server-only and stay in `@epicenter/server`.

## 4. Every durable string under one rule

```
RULE: `<partition>/<resource type>/<id>`,
      where <partition> is omitted when there is no partition.

                       personal (userId='abc')     team
DO name                users/abc/rooms/xyz         rooms/xyz
R2 object key          users/abc/assets/xyz        assets/xyz
HKDF info label        users/abc/keyring           keyring
SQL filter             WHERE userId = 'abc'        no filter
URL path (under /api)  /api/users/abc/...          /api/...
```

The URL path is the durable identifier with an `/api` prefix. Reading the
URL tells you the partition (or its absence) directly. No magic mapping.

## 5. URL shape

```
                          Personal cloud                       Team
                          --------------------------------     -------------------------
Rooms snapshot/sync       GET  /api/users/:userId/rooms/:r     GET  /api/rooms/:r
                          POST /api/users/:userId/rooms/:r     POST /api/rooms/:r
Rooms WebSocket           WS   /api/users/:userId/rooms/:r     WS   /api/rooms/:r
                            ?clientId=<id>                       ?clientId=<id>

Asset upload              POST /api/users/:userId/assets       POST /api/assets
Asset list                GET  /api/users/:userId/assets       GET  /api/assets
Asset usage               GET  /api/users/:userId/assets/usage GET  /api/assets/usage
Asset delete              DEL  /api/users/:userId/assets/:a    DEL  /api/assets/:a
Asset PUBLIC read         GET  /api/users/:userId/assets/:a    GET  /api/assets/:a

Session                   GET  /api/session                    GET  /api/session

Auth / UI                 /sign-in, /consent, /auth/*, /dashboard  (no /api, no partition)
```

The public asset read carries the userId in the URL in personal mode. The
userId is not a credential; the URL as a whole is. Anyone who can read the
URL already had the userId. This is the same capability-URL model as today,
plus an extra path segment that lets the server skip a DB lookup when
computing the R2 key.

A safety middleware enforces "URL userId matches authenticated user" on
all personal-mode authed routes so Bob cannot reach `/api/users/alice/...`.

## 6. The DO attachment (both modes)

```ts
export type ConnectionId = { userId: string; clientId: string };
```

Each WebSocket connection carries a `(userId, clientId)` pair. The DO is
owner-blind; it tracks pairs and broadcasts presence with the `userId` so
clients can render names. In personal mode every connection to a given DO
shares the same `userId` (the DO name partitions by user). In team mode
connections have different `userId` values. Same code path either way.

`clientId` replaces today's `installationId`. A client is "one running
instance of any app" (browser tab, Tauri app, extension, CLI). The
lifespan is the client's concern.

## 7. /api/session response

```ts
{
  user: AuthUser,                   // who is signed in
  owner: Owner,                     // discriminated union
  ownerPath: OwnerPath,             // `users/<userId>` or ''
  keyring: SubjectKeyring,          // crypto material
}
```

Flat top-level shape. `ownerPath` is included so clients can persist local
state under `${origin}/${ownerPath}/<resource>/<id>` without importing
helpers from `@epicenter/server`. Two self-hosted team deployments do not
collide on the client because the client keys by `${origin}` too.

The old `localIdentity.subject` field retires.

## 8. Why this asymmetry is the right one

```
Personal cloud has many users. They must NOT share data. Therefore every
durable identifier they touch must include their userId so two users
cannot collide. Hence the prefix.

Self-hosted team has one team. There is no second team in the same
deployment to disambiguate from. Therefore no prefix is needed.

The prefix is the partition. No partition, no prefix. End of asymmetry.
```

Cross-deployment isolation (two different team servers, two different
cloud deployments, etc.) is handled at the Cloudflare layer by
`(script_name, class_name)` Durable Object isolation, per-deployment R2
buckets, per-deployment Postgres, per-deployment KV. The server has
nothing to do here; it cannot reach another deployment's resources by
name.

## 9. Client-side companion: local Yjs prefix

The server design above only solves half the problem. Clients persist
Yjs documents in IndexedDB (browser, extension) and on disk (Tauri, CLI
daemon). Those local stores must partition the same way the server does
so that two signed-in accounts on the same machine cannot collide.

### 10.1 The legacy shape

Today's `packages/workspace/src/document/local-yjs-key.ts` builds:

```
epicenter.owner.<subject>.yjs.<ydoc.guid>
```

`<subject>` was the value of `localIdentity.subject` (the user id today).
That string carries two unearned segments and one missing one:

```
"epicenter." app namespace                EARNED (collides with other
                                          IDB consumers on the origin)
"owner."     decorative middle            NOT EARNED (zero partition info;
                                          the next segment IS the owner)
"<subject>." owner identity               EARNED, but stringly typed and
                                          named for the old Better-Auth
                                          vocabulary instead of the Owner
                                          shape
".yjs."      "this is yjs data"           NOT EARNED (y-indexeddb library
                                          prepends its own `yjs.` already;
                                          the live name in IndexedDB is
                                          `yjs.epicenter.owner.X.yjs.Y`,
                                          with TWO `yjs.` segments)

(missing)    server origin                FAILURE: two self-hosted team
                                          servers signed into the same
                                          browser produce the same
                                          `epicenter.owner.team.yjs.*`
                                          prefix and collide
```

### 10.2 The greenfield shape

```
epicenter/<server-origin>/<owner-segment>/<ydoc.guid>
```

`<owner-segment>` is `users/<userId>` for personal owners and is dropped
entirely for team owners (the server origin already disambiguates teams
across deployments).

Examples:

```
Personal Alice on Epicenter Cloud:   epicenter/api.epicenter.so/users/alice/<guid>
Personal Bob   on Epicenter Cloud:   epicenter/api.epicenter.so/users/bob/<guid>
Team on Acme self-host:              epicenter/team.acme.com/<guid>
Team on Beta self-host:              epicenter/team.beta.com/<guid>
```

Y-indexeddb still prepends its own `yjs.` at the IndexedDB layer; the
live database name becomes `yjs.epicenter/api.epicenter.so/users/alice/<guid>`.
Mixed `/` and `.` at the very front is the library's, not ours.

### 10.3 What this earns

```
Cross-server isolation                FIXED (was broken)
Cross-app isolation                   PRESERVED (epicenter/ prefix)
Cross-user isolation                  PRESERVED (users/<id>/)
Cross-doc isolation                   PRESERVED (caller appends ydoc.guid)
Mirrors server's doName(owner, ...)   NEW (same address shape on wire and disk)
Type-safe Owner input                 NEW (Owner replaces stringly-typed subject)
Duplicate `.yjs.` segment             REMOVED
Decorative `.owner.` segment          REMOVED
```

### 10.4 New signatures

```ts
// packages/workspace/src/document/local-yjs-key.ts

import type { Owner } from '@epicenter/auth';

const APP = 'epicenter';

/**
 * Per-owner-per-server prefix for client-side persisted Yjs data on this
 * browser profile. Mirrors the server's `doName(owner, ...)` shape so the
 * same `(server, owner, doc)` tuple lands on the same address on the wire
 * and on disk.
 */
export function getOwnedYjsPrefix(server: string, owner: Owner): string {
  const ownerSeg = owner.kind === 'personal' ? `/users/${owner.userId}` : '';
  return `${APP}/${server}${ownerSeg}/`;
}

export function createOwnedYjsKey(
  server: string,
  owner: Owner,
  ydocGuid: string,
): string {
  return `${getOwnedYjsPrefix(server, owner)}${ydocGuid}`;
}
```

### 10.5 Caller updates

```
Touched files in packages/workspace/:

  document/local-yjs-key.ts          rewritten (signature change)
  document/local-yjs-key.test.ts     literal-shape assertions updated
  document/local-owner.ts            passes (server, owner) instead of ownerId
  document/attach-local-storage.ts   accepts server + owner, threads through
  document/attach-local-storage.test.ts  prefix assertions updated
  document/wipe-local-storage.ts     accepts server + owner

Touched files in packages/svelte-utils/:

  session.svelte.ts                  pass server + state.owner downstream
  session.svelte.test.ts             update test fixtures

Touched files in packages/auth-svelte/:                (none expected;
                                                       imports re-exported types)
```

The server origin comes from the auth session's source URL (the auth
client already knows the API origin it signs into; it is what
`authBaseURL` carries on the server side and what every client uses to
construct its `fetch` and WebSocket URLs).

### 10.6 What this breaks

```
Durable storage format               yes, every existing IndexedDB blob is
                                     orphaned. Greenfield assumption holds
                                     (no users in production with persisted
                                     encrypted Yjs blobs that need to
                                     migrate). Documented refusal.

Workspace-package signatures         getOwnedYjsPrefix(ownerId: string)
                                     -> getOwnedYjsPrefix(server, owner)
                                     Six callers in two packages.

Tests                                Two test files assert the literal
                                     `epicenter.owner.<x>.yjs.<y>` shape;
                                     both rewritten.
```

### 10.7 Trigger to revisit

If a future client needs to multiplex more than one server simultaneously
(e.g., a CLI that holds accounts on Cloud AND a team server), the design
already supports it: each prefix carries its own server origin segment.
No further change needed.

## 10. Library public API

```ts
// packages/server/src/types.ts

export type OwnerKind    = 'personal' | 'team';
export type SignUpPolicy = 'open' | 'disabled';

export type ServerOptions = {
  ownerKind: OwnerKind;
  signUpPolicy?: SignUpPolicy;   // default: 'open'
};

export type Owner =
  | { kind: 'personal'; userId: string }
  | { kind: 'team' };

export type OwnerPath = `users/${string}` | '';

export type ConnectionId = { userId: string; clientId: string };

export type Env = { Bindings: Cloudflare.Env; Variables: { /* ... */ } };
```

```ts
// packages/server/src/create-server.ts

export function createServer(opts: ServerOptions) {
  return {
    base:    createBaseApp(opts),     // CORS, db, auth context, singleCredential
    auth:    createAuthApp(opts),     // /sign-in, /consent, /auth/*, OAuth discovery
    session: createSessionApp(opts),  // /api/session
    rooms:   createRoomsApp(opts),    // owner-shaped URL pattern
    assets:  createAssetsApp(opts),   // owner-shaped URL pattern
    ai:      createAiApp(opts),       // /api/ai/chat
  };
}
```

```ts
// packages/server/src/index.ts

export { createServer } from './create-server';
export { Room } from './room/backends/cloudflare/durable-object';
export type {
  OwnerKind, SignUpPolicy, ServerOptions,
  Owner, OwnerPath, ConnectionId, Env,
} from './types';
```

That is the entire public surface. The `ownerPath`, `doName`, `assetKey`,
`keyringLabel`, and `assetOwnerFilter` functions stay internal because no
consumer needs them.

## 11. Library internals: how ownerKind dispatches

`opts.ownerKind` is the only static config the library reads. It is used
in exactly one place: route registration shape.

```ts
function createAssetsApp(opts: ServerOptions): Hono<Env> {
  const app = new Hono<Env>();

  if (opts.ownerKind === 'personal') {
    // Personal: URL carries userId; safety middleware enforces it
    app.get('/users/:userId/assets/:assetId{[a-z0-9]{15}}', publicReadPersonal);
    app.use('/users/:userId/*', requireAuth, requireUrlUserIdMatchesAuth);
    app.post('/users/:userId/assets', uploadPersonal);
    app.get('/users/:userId/assets', listPersonal);
    app.get('/users/:userId/assets/usage', usagePersonal);
    app.delete('/users/:userId/assets/:assetId{[a-z0-9]{15}}', deletePersonal);
  } else {
    // Team: no partition in URL; auth still required for mutating ops
    app.get('/assets/:assetId{[a-z0-9]{15}}', publicReadTeam);
    app.use('/assets/*', requireAuth);
    app.post('/assets', uploadTeam);
    app.get('/assets', listTeam);
    app.get('/assets/usage', usageTeam);
    app.delete('/assets/:assetId{[a-z0-9]{15}}', deleteTeam);
  }

  return app;
}
```

After route registration, every handler builds its `Owner` value the same
way: personal handlers from `c.req.param('userId')`, team handlers from
the constant `{ kind: 'team' }`. The `Owner` flows into `doName`,
`assetKey`, `keyringLabel`, `assetOwnerFilter` uniformly.

This is the only conditional branch on `ownerKind` in the library.
Everything downstream operates on the resolved `Owner` value.

## 12. Deployment composition

### 11.1 Self-hosted team (`apps/server-team/src/index.ts`)

```ts
import { createServer } from '@epicenter/server';

const s = createServer({
  ownerKind: 'team',
  signUpPolicy: 'disabled',
});

export default s.base
  .route('/api/session', s.session)
  .route('/sign-in',     s.auth)
  .route('/consent',     s.auth)
  .route('/auth',        s.auth)
  .route('/api',         s.rooms)        // mounts /api/rooms/...
  .route('/api',         s.assets)       // mounts /api/assets/...
  .route('/api/ai',      s.ai);

export { Room } from '@epicenter/server';
```

### 11.2 Epicenter Cloud (`apps/api/src/index.ts`)

```ts
import { Hono } from 'hono';
import { createServer } from '@epicenter/server';
import type { Env } from '@epicenter/server';
import { autumnStorageGate, autumnPlanGate } from './autumn-gates';
import { billingRoutes } from './billing-routes';
import { adminRoutes }   from './admin-routes';
import { dashboardSpa }  from './dashboard';

const s = createServer({
  ownerKind: 'personal',
  signUpPolicy: 'open',
});

export default s.base
  .route('/api/session', s.session)
  .route('/sign-in',     s.auth)
  .route('/consent',     s.auth)
  .route('/auth',        s.auth)
  .route('/api',         s.rooms)
  .route(
    '/api',
    new Hono<Env>().use('/users/:userId/assets/*', autumnStorageGate).route('/', s.assets),
  )
  .route('/api/ai',      new Hono<Env>().use('*', autumnPlanGate).route('/', s.ai))
  .route('/api/billing', billingRoutes)
  .route('/admin',       adminRoutes)
  .route('/dashboard',   dashboardSpa);

export { Room } from '@epicenter/server';
```

Any reader sees the entire URL surface of either deployment in one file,
top to bottom.

## 13. Package shape

```
packages/server/
  package.json                name: "@epicenter/server"
  tsconfig.json
  src/
    index.ts                  public re-exports
    create-server.ts          factory; returns named sub-apps
    types.ts                  ServerOptions, OwnerKind, SignUpPolicy, Env
    owner.ts                  Owner, OwnerPath, ownerPath, doName,
                              assetKey, keyringLabel, assetOwnerFilter
    routes/
      auth.ts                 /sign-in, /consent, /auth/*, OAuth discovery
      session.ts              /api/session
      rooms.ts                /api/.../rooms/:roomId (GET, POST, WS upgrade)
      assets.ts               /api/.../assets/[/:id, /usage] (public read + authed CRUD)
      ai.ts                   /api/ai/chat
    middleware/
      single-credential.ts
      require-auth.ts
      require-url-user-id-matches-auth.ts
      cors.ts
      require-origin-for-cookie-mutations.ts
    auth/                     Better Auth setup, encryption, OAuth metadata,
                              resource-boundary, trusted-oauth-clients
    room/                     Room DO class, RoomCore, update-log
    db/                       schema (everything except billing-only columns)
    auth-pages/               sign-in / consent / cli-callback / signed-in HTML

apps/api/                     Epicenter Cloud deployment
  package.json                depends on @epicenter/server
  wrangler.jsonc              cloud secrets and bindings
  src/
    index.ts                  ~30 lines composition
    autumn-gates.ts           autumnStorageGate, autumnPlanGate
    autumn.ts                 createAutumn client wrapper
    billing-routes.ts         /api/billing/*
    admin-routes.ts           /admin/* and /api/assets/reconcile
    dashboard.ts              dashboard SPA static serving
    billing-plans.ts          FEATURE_IDS, plan definitions

(future) apps/server-team/    template self-hosted deployment, or example
                              in @epicenter/server's README until a real
                              customer runs one
```

## 14. Env reads, not opts

The library reads everything from `c.env` at request time. Cloud and team
each declare their own bindings in their own `wrangler.jsonc`; the library
does not see two configurations.

```
Read from c.env (NOT from opts):
  HYPERDRIVE                  postgres connection
  ROOM                        Durable Object namespace
  ASSETS_BUCKET               R2 bucket
  SESSION_KV                  KV for Better Auth secondary storage
  ENCRYPTION_SECRETS          HKDF root keyring
  BETTER_AUTH_SECRET          auth secret
  GOOGLE_CLIENT_ID / SECRET   OAuth provider
  OPENAI_API_KEY etc.         AI provider keys

Cloud-only env (read inside apps/api, NOT inside @epicenter/server):
  AUTUMN_SECRET_KEY
  ADMIN_USER_IDS
```

## 15. Sign-up policy

```ts
type SignUpPolicy = 'open' | 'disabled';
```

`'disabled'` mounts a Better Auth `before` hook on `/sign-up/email` (and
similar paths) that rejects every request. The deployment owner provisions
accounts out of band (via the Better Auth admin API or a CLI tool).

When invitation tokens are designed, `'invite-only'` becomes a third
value. Until that exists, the meaningful gradient is `open` or `disabled`.

## 16. Migration plan (one-shot clean break)

```
1. Create packages/server. Move from apps/api/src/:
     ai-chat*, asset-routes, auth/*, auth-pages, constants, db/schema
     (minus billing-only columns), is-websocket-upgrade, room/*,
     trusted-origins.
   DO NOT move: autumn, autumn.config.ts, billing-routes, billing-plans,
     reconcile handler, dashboard serving, ADMIN_USER_IDS gating.

2. Refactor moved code into sub-app factories:
     createBaseApp, createAuthApp, createSessionApp, createRoomsApp,
     createAssetsApp, createAiApp.
   Each reads opts.ownerKind once to pick URL shapes; downstream handlers
   work in terms of the resolved Owner value.

3. Rewrite URLs to the owner-partition shape (section 5).
   Personal-mode authed routes get the requireUrlUserIdMatchesAuth gate.

4. Replace installationId with clientId everywhere
   (WebSocket query param, DO attachment, presence map).
   DO attachment becomes { userId, clientId }.

5. Recreate apps/api/src/index.ts as the cloud composition (section 11.2).
   Cloud-only files live in apps/api/src/.

6. Update apps/api/wrangler.jsonc to point `main` at the new index.ts.

7. Tests split:
     packages/server/*.test.ts      library tests, no Autumn
     apps/api/*.test.ts             cloud tests, Autumn mocked

8. Delete apps/api/src/app.ts.

9. Update apps/dashboard, apps/whispering, apps/cli, anything that
   imports from apps/api/src/... to import from @epicenter/server.

10. Update client URL builders (workspace daemon, browser apps, CLI,
    extension) to use session.ownerPath when constructing room and
    asset URLs. Replace any installationId usage with clientId.
```

## 17. Tests

```
packages/server/
  owner.test.ts                ownerPath, doName, assetKey, keyringLabel
                               produce expected strings for both kinds
  session.test.ts              /api/session returns owner, ownerPath, keyring
                               personal: omits userId; team: same shape, '' path
  rooms.test.ts                personal: requires URL userId == auth userId
                               team: no userId in URL
                               WS upgrade carries clientId
  assets.test.ts               personal: public read works without auth via
                               URL userId; authed routes require URL match
                               team: public read works without auth
                               provenance (asset.userId) recorded both modes
  signup-policy.test.ts        disabled rejects /sign-up/email
                               open allows
  scope-isolation.test.ts      personal: two userIds resolve to distinct DO
                               names, distinct R2 keys, distinct keyrings
                               team: every request resolves to the same
                               DO name and R2 key

apps/api/
  autumn-gates.test.ts         plan gate denies free tier on premium models
                               storage gate rejects when balance exhausted
  billing-routes.test.ts       portal redirect, plan status
  admin-routes.test.ts         ADMIN_USER_IDS gate; reconcile aggregation
  index.test.ts                composed app shape (mount points exist)
```

## 18. Non-goals

```
- No @epicenter/server-cloud package. apps/api is the only cloud-shaped
  consumer; one consumer = no package needed.
- No per-feature packages. auth/rooms/assets share singleCredential and
  the OAuth resource boundary.
- No runtime OwnerResolver function. ownerKind is the only deployment-
  level choice; per-request owner is derived from URL params.
- No mixed personal+team mode. A third OwnerKind can be added later
  without touching this shape.
- Invitation system (the data model behind invite-only): sibling spec.
- Sign-in page branding per team deployment: out of scope.
- Custom auth providers per team deployment: out of scope.
- Per-asset ACLs in either mode: owner-level visibility is the only knob.
- Versioned HKDF labels: greenfield; add a version when you rotate.
- Server-side teamId field: deployment IS the team. CF script_name is
  the cross-deployment boundary.
- Two factories (createPersonalServer / createTeamServer): one factory
  with ownerKind is the smaller surface.
- mountDefaults helper: each deployment mounts explicitly for visibility.
```

## 19. Open questions

```
1. Should the WebSocket URL place clientId in the query string or in a
   subprotocol entry like `client.<clientId>`? Query string is simpler
   and matches today's pattern; subprotocol is harder to log and slightly
   more secure. Defaulting to query string.

2. The personal-mode safety middleware compares c.req.param('userId') to
   c.var.user.id. Confirm Better Auth's resolved user id matches the
   shape we put in URLs (no encoding mismatch, no case sensitivity).

3. /api/session in team mode includes ownerPath: ''. Do we instead want
   to return a sentinel like `null` to make "no partition" more visible
   to client code? Probably keep '' so concatenation works without
   special-casing.

4. Should apps/server-team/wrangler.jsonc live in this monorepo as a
   template, or as a downstream example repo? Either works.

5. The Room DO attachment shape change from { installationId } to
   { userId, clientId } is a wire change; old clients and old DOs
   would not interoperate. Acceptable because greenfield.
```

## 20. Success criteria

```
1. Anyone can read apps/api/src/index.ts and apps/server-team/src/index.ts
   top-to-bottom and know exactly what URLs the server serves and what
   middleware runs on each.

2. The library's only conditional branch on ownerKind is in route URL
   registration. After routes are mounted, all handlers operate on the
   resolved Owner value uniformly.

3. Adding a hypothetical third OwnerKind requires:
     - 1 new OwnerKind enum value
     - 1 new ownerPath case
     - 1 new branch in route registration
     - 0 changes to handler logic

4. The self-hosted team deployment has zero Autumn code in its dependency
   graph (verifiable via bundle inspection of apps/server-team's compiled
   Worker).

5. Test suite split:
     packages/server tests pass with no @autumn-js dependency installed.
     apps/api tests pass with Autumn mocked.

6. Every durable identifier in the codebase follows the rule:
     <partition>/<resource type>/<id>
   where <partition> is `users/<userId>` in personal mode and absent in
   team mode. No code constructs durable strings inline; everything goes
   through ownerPath() + joinPath().
```

## 21. References

```
- Personal-vs-team deployment-mode spec (superseded):
  specs/20260522T120000-personal-vs-team-deployment-mode.md
- Workspace project layout (sibling spec):
  specs/20260522T220000-workspace-project-layout.md
- Hono sub-app composition idiom:
  honojs/hono deepwiki, route() and .use('*', mw) per-sub-app
- Cloudflare DO isolation by (script_name, class_name):
  cloudflare/cloudflare-docs deepwiki, Wrangler environments
- Better Auth before-hook for sign-up gating:
  better-auth/better-auth deepwiki, plugin hooks section
- libsignal HKDF label conventions:
  signalapp/libsignal source labels
- Current code (pre-split):
  apps/api/src/app.ts, apps/api/src/asset-routes.ts,
  apps/api/src/auth/encryption.ts, apps/api/src/auth/resource-boundary.ts,
  apps/api/src/room/backends/cloudflare/durable-object.ts
```

## A. Implementation status (waves)

This spec landed in three waves on branch `braden-w/buffalo`. Each wave is
intentionally small enough to review on its own but is part of the same
design described above. A reader picking up this branch should read the
status here first, then the sections it points at.

### Wave 1: server package split                        LANDED

What changed in code:

```
NEW   packages/server/                        @epicenter/server library
NEW   apps/api/src/index.ts                   cloud composition (~30 lines)
NEW   apps/api/src/autumn-gates.ts            ensurePlanId, autumnAiGate, autumnStorageGate
NEW   apps/api/src/admin-routes.ts            reconcile (admin-only)
MOVE  apps/api/src/{auth,room,db,...}         -> packages/server/src/
DEL   apps/api/src/app.ts                     replaced by index.ts
DEL   apps/api/src/ai-chat.ts                 replaced by library + autumnAiGate
DEL   apps/api/src/app.rooms.test.ts          will be rebuilt against new shape
```

Spec sections that describe Wave 1: 1, 2, 3 (server-side derivations
only), 4, 5, 6, 8, 10, 11, 12, 13, 14, 15, 16.

### Wave 2: session shape flatten                       LANDED

The deferred Task #5 from Wave 1, executed by a sibling agent on the
same branch. Removed `LocalIdentity` from the wire and from every
consumer; introduced `Owner` in `@epicenter/auth` as the shared
vocabulary.

```
MOVED Owner type:    @epicenter/server/src/owner.ts (Wave 1)
                     -> @epicenter/auth/src/owner.ts (Wave 2)
                     @epicenter/server now imports Owner from auth.

CHANGED wire shape:
  ApiSessionResponse  was: { user, localIdentity: { subject, keyring } }
                      now: { user, owner, keyring }
  PersistedAuth       was: { grant, localIdentity }
                      now: { grant, owner, keyring }

CHANGED AuthState:
  signed-in           was: { localIdentity }
                      now: { owner, keyring }
  reauth-required     same
```

Files touched in Wave 2:

```
packages/auth/src/owner.ts                NEW (Owner + ownerId)
packages/auth/src/auth-types.ts           flattened
packages/auth/src/auth-contract.ts        flattened
packages/auth/src/create-oauth-app-auth.ts cascaded
packages/auth/src/node/machine-auth.ts    cascaded
packages/svelte-utils/src/session.svelte.ts cascaded
packages/svelte-utils/src/account-popover/...svelte cascaded
plus tests
```

Spec sections that describe Wave 2: 3 (the auth/server split), 7
(`/api/session` actually returns the flat shape now).

### Wave 3: client local-Yjs prefix greenfield          AHEAD

What this wave does:

```
EDIT  packages/workspace/src/document/local-yjs-key.ts
      Signature: getOwnedYjsPrefix(ownerId: string)
              -> getOwnedYjsPrefix(server: string, owner: Owner)
      Shape:    epicenter.owner.<id>.yjs.
              -> epicenter/<server>/users/<id>/      (personal)
              -> epicenter/<server>/                  (team)

EDIT  packages/workspace/src/document/local-owner.ts
      Pass (server, owner) instead of ownerId string.

EDIT  packages/workspace/src/document/attach-local-storage.ts
      Accept server in options; pass (server, owner) down.

EDIT  packages/workspace/src/document/wipe-local-storage.ts
      Accept server in options; pass (server, owner) down.

EDIT  packages/workspace/src/document/local-yjs-key.test.ts
      Update literal-shape assertions.

EDIT  packages/workspace/src/document/attach-local-storage.test.ts
      Update prefix assertions.

EDIT  packages/svelte-utils/src/session.svelte.ts
      Thread the auth client's server origin into ownerId callers.
```

Spec section that describes Wave 3 in full: 9.

Trigger to start Wave 3: Wave 2 is fully landed and the whole monorepo
typechecks. Verify with:

```
bun install
bun run --filter '*' typecheck       (or per-package, see Wave 2 list above)
```

### Why three waves on one branch

Each wave is reviewable on its own diff:

```
Wave 1   isolates the cloud product from the library
Wave 2   makes the client speak the same Owner vocabulary as the server
Wave 3   makes local storage partition match server partition
```

All three converge on one sentence: every owner has their own isolated
data, identified by the same `(server, owner)` tuple on the wire and on
disk. The waves split the work along package boundaries so the diffs
stay readable, not because the design has phases.

### Documented refusals

```
Refused:  preserve the old `epicenter.owner.<subject>.yjs.` IndexedDB
          format and `LocalIdentity.subject` wire field
Reason:   greenfield; no users with persisted data we cannot ask to
          re-sync; the shape was muddied by a decorative `owner` segment
          and a duplicate `yjs.` segment that y-indexeddb adds itself
User loss: none under the greenfield assumption
Trigger to revisit: a real customer reports persisted data they cannot
          afford to re-sync
```

```
Refused:  add `LocalIdentity.subject` aliases for backwards compatibility
Reason:   the old field name was a holdover from Better-Auth's
          "subject" vocabulary; the new value carries Owner identity,
          not a Better-Auth subject. An alias would lie about the shape.
User loss: clients with pinned old @epicenter/auth versions stop
          compiling; they update along with the cascade
Trigger to revisit: never (clean break by design)
```


## Wave 4 (proposed): name the bag `session`, add `user`, refuse the facade

Status: drafted, queued. Not yet executed.
Supersedes: an earlier draft of wave 4 that proposed a `LocalWorkspace`
            method-bag facade on `auth.state`. The facade was wrong on
            principle: it is a layer that delegates. See "Refused
            alternatives" below.

### The single sentence

> When you are signed in, you have a Session. Session is a named bundle
> of three values (user, owner, keyring). Apps consume those values
> directly through free primitives. There is no facade between them and
> the workspace.

### Context: why the facade is wrong

The fuji branch (`braden-w/examples-fuji-test-improvements`) deleted the
`LocalOwner` facade for the right reason: apps were calling
`signedIn.owner.attachEncryption(ydoc)` which immediately delegated to
`attachEncryption(ydoc, { keyring })`. The mediator earned nothing. The
fuji refactor moved every browser app to:

```ts
const encryption = attachEncryption(ydoc, { keyring: signedIn.keyring });
const tables = encryption.attachTables(fujiTables);
const idb = attachLocalStorage(ydoc, signedIn);
const collab = openCollaboration(ydoc, { auth: signedIn.auth, ... });
```

Every line at the call site does real work. No facade hiding combinations.

A `LocalWorkspace` facade on `auth.state` would re-create exactly what
fuji deleted, just one layer further up. Wrong direction.

### What actually changes on the client surface

Two changes only. Both are slim renames; the data is the same.

```ts
// @epicenter/auth

type AuthState =
  | { status: 'signed-out' }
  | { status: 'signed-in';       session: Session }   // wraps the bag
  | { status: 'reauth-required'; session: Session };

type Session = {
  user: AuthUser;            // NEW on auth state (apps want it for UI
                             // without re-hitting /api/session)
  owner: Owner;
  keyring: SubjectKeyring;
};

type PersistedAuth = {
  grant: OAuthTokenGrant;
  session: Session;          // wrapped to match the runtime shape
};

type ApiSessionResponse = Session;  // /api/session returns Session directly
```

That is the whole client-side delta.

### What dies, what stays

```
DIES
  auth.state.signed-in.owner               flat field
  auth.state.signed-in.keyring             flat field
  ApiSessionResponse.user / .owner / .keyring as separate top-level keys
    (still present, but wrapped under Session)

STAYS (because fuji's free-primitive direction is correct)
  attachEncryption, attachLocalStorage, wipeLocalStorage as free functions
  openCollaboration(ydoc, { auth, ... }) owning auth and reconnect
  Apps composing primitives inline in open<App>Browser / open<App>Daemon
  No LocalOwner / LocalWorkspace facade anywhere

ADDED
  user on the persisted cell and on auth.state (single source of truth
  for "who is signed in" without a network round-trip)
```

### Wire change

```
ApiSessionResponse before (current buffalo):
  { user, owner, keyring }

ApiSessionResponse after:
  { user, owner, keyring }   /* same fields, now reflected in `Session`
                                schema and matched 1:1 by AuthState */

PersistedAuth before:
  { grant, owner, keyring }

PersistedAuth after:
  { grant, session: { user, owner, keyring } }
```

The wire is essentially the same; the client groups the auth-bound
trio under a `session` name and persists `user` alongside.

### Cycle: not broken in this wave

The earlier draft proposed breaking workspace's dependency on auth so
auth could name `LocalWorkspace`. Since we are not adding a workspace
facade to auth state, the cycle does not need to break. Workspace
keeps depending on auth for `AuthClient` (consumed by openCollaboration);
auth has no need to import anything from workspace.

If a future wave wants to invert this (e.g., move openCollaboration's
auth dependency to a capability function pair), it can. This wave does
not require it.

### Migration scope

```
@epicenter/auth
  auth-types.ts        Session schema (arktype) replacing the three flat
                       fields on ApiSessionResponse and PersistedAuth.
                       user added.
  auth-contract.ts     AuthState carries session instead of (owner, keyring).
  create-oauth-app-auth.ts
                       Use session shape in persistedAuth, AuthState,
                       comparison helpers, refresh paths.

@epicenter/server
  routes/session.ts    Return Session shape directly (already returns
                       { user, owner, keyring }; just satisfy the new
                       arktype).

@epicenter/svelte-utils
  session.svelte.ts    Read state.signed-in.session.{user,owner,keyring}
                       (was state.owner / .keyring).
  account-popover      Same.

apps/*
  open<App>Browser     Receive SignedIn = Session & { auth: AuthClient }.
                       Read signedIn.owner / .keyring / .user.

  open<App>Daemon /    Already passed AuthClient via DaemonWorkspaceContext
  daemon ctx           (fuji branch); add session-shaped fields if any
                       daemon wants user info.

packages/cli, apps/dashboard, apps/whispering
                       Mechanical cascade for any place that reads
                       state.owner / state.keyring directly.
```

### Refused alternatives

```
Refused:  LocalWorkspace facade on auth.state (the earlier wave 4 draft)
Reason:   re-creates exactly the kind of decorative mediator fuji
          deleted. apps composing primitives inline IS the design;
          a facade undoes that.

Refused:  expose signedIn.workspace.keyring() callback
Reason:   not needed. apps call `attachEncryption(ydoc, { keyring })`
          with `signedIn.keyring` directly. No additional indirection.

Refused:  break workspace -> auth dependency
Reason:   only required for the LocalWorkspace facade we are no longer
          adding. Without that, openCollaboration's `auth: AuthClient`
          is honest.

Refused:  flatten Session into auth.state directly (no `.session` bag)
Reason:   the bag has a name and a domain meaning ("the auth-bound bundle
          that is restored on reauth-required"). Naming it earns its
          keep; future fields like `verifiedAt` or `expiresAt` would
          live there.
```

### Success criteria

```
1. ApiSessionResponse, PersistedAuth, AuthState all expose `session` as
   the auth-bound bundle. `user`, `owner`, `keyring` exist exactly under
   `session.*`.

2. Apps' open<App>Browser receive `SignedIn = Session & { auth }` and
   pass `signedIn.keyring` to attachEncryption, `signedIn` to
   attachLocalStorage, `signedIn.auth` to openCollaboration. No facade.

3. `auth.state.signed-in.user` is readable without a network call.
   account-popover, sign-in banners, and any "you are signed in as X"
   surface can render from cache.

4. LocalOwner / LocalWorkspace does NOT exist anywhere. The encryption
   boundary is exactly the free primitives.

5. Adding a hypothetical third OwnerKind requires:
     - 1 new variant on Owner
     - 0 changes to Session
     - 0 changes to apps (apps already pattern-match on owner.kind for
       UI; the new variant participates in the same union)
```

### Notes on integrating with the fuji branch

This wave's scope reduces dramatically because the fuji branch already
landed the free-primitive direction. The integration sequence is:

```
1. Rebase fuji onto buffalo. Conflict resolution philosophy:
     - fuji wins at the encryption boundary (free primitives, no facade)
     - buffalo wins on the data vocabulary (Owner replaces subject)
     - server-scoping from buffalo wave 3 moves INSIDE
       attachLocalStorage / wipeLocalStorage where it belongs

2. After rebase, the wave 4 changes are a small follow-up commit:
     - rename auth.state.signed-in fields under `session`
     - add `user` to Session and PersistedAuth
     - cascade through the same client files wave 2 and wave 3 touched
```
