# Workspace Surface Clean Break Vision

**Date**: 2026-05-13
**Status**: Partially superseded
**Landed**: flat action registry (under snake_case via `specs/20260513T231157-actions-snake-case-only-no-dots.md`); the script-vs-daemon overlap collapsed by deleting `apps/honeycrisp/blocks/script.ts`, `apps/opensidian/blocks/script.ts`, `apps/zhongwen/blocks/script.ts` and removing their jsrepo entries.
**Reversed**: dot-path action keys (`'entries.create'`) became snake_case (`entries_create`); `attachYjsSync` was deleted and content docs now use `openCollaboration(ydoc, { actions: {} })` (see `packages/workspace/src/document/open-collaboration.ts:1-25, 71-74`).
**Superseded (script-surfaces portion)**: the "Fuji-shape script as a per-app recipe" goal is replaced by `20260514T160000-script-surfaces-resolution.md`. The conclusion is sharper: no `script.ts` recipe for any app. Scripts read SQLite and write via `connectDaemonActions`.
**Still live**: markdown link helpers exported from the root `@epicenter/workspace` barrel (`packages/workspace/src/index.ts:281-292`).
**Related**: `20260514T170000-single-daemon-multi-workspace.md` (the daemon becomes one process hosting N workspace routes).
**Author**: Braden + Codex

## Overview

This spec turns the six audit prompts into one implementation direction: flatten the action system, keep the sync and collaboration primitives split, standardize app runtime files, and move markdown link helpers out of the root workspace barrel.

The clean sentence:

```txt
Apps build a typed Y.Doc bundle, open collaboration for workspace docs, attach sync for content docs, and expose flat dot-path actions locally or by peer.
```

## Spoon Feed The Vision

The final shape should feel boring in the best way.

```txt
document.ts
  creates local app data
  no network
  no auth
  no IndexedDB user keys
  no daemon

browser.ts or extension.ts
  adds browser persistence
  adds local tab sync
  opens collaboration
  owns wipe

daemon.ts
  adds machine auth
  writes Yjs logs and materializers
  opens collaboration
  owns async teardown

script.ts
  reads local snapshots
  calls daemon actions
  does not open a second live synced workspace
```

In code, workspace docs look like this:

```ts
const doc = openFujiDocument({ encryptionKeys });
const idb = doc.encryption.attachIndexedDb(doc.ydoc, { userId });

const collaboration = openCollaboration(doc.ydoc, {
	url: websocketUrl(`${APP_URLS.API}/workspaces/${doc.ydoc.guid}`),
	waitFor: idb.whenLoaded,
	openWebSocket,
	identity: peer,
	actions: createFujiActions(doc.tables),
});
```

Content docs look like this:

```ts
const ydoc = new Y.Doc({ guid: entryContentDocGuid({ workspaceId, entryId }) });
const idb = doc.encryption.attachIndexedDb(ydoc, { userId });

const sync = attachYjsSync(ydoc, {
	url: websocketUrl(`${APP_URLS.API}/documents/${ydoc.guid}`),
	waitFor: idb.whenLoaded,
	openWebSocket,
});
```

Actions become flat:

```ts
export function createFujiActions(tables: FujiTables) {
	return {
		'entries.get': defineQuery({ ... }),
		'entries.create': defineMutation({ ... }),
		'entries.update': defineMutation({ ... }),
		'entries.delete': defineMutation({ ... }),
	} as const;
}
```

Local calls use the same path the daemon, peers, CLI, and AI tools see:

```ts
fuji.collaboration.actions['entries.create']({});

await peer.invoke('entries.update', {
	id,
	title,
});
```

That is the point. One action address, everywhere.

## Current State

Parts of the target already exist on this branch.

```txt
packages/workspace/src/document/open-collaboration.ts
  openCollaboration(ydoc, config)
  publishes identity and action paths
  hosts inbound actions
  exposes peers

packages/workspace/src/document/attach-yjs-sync.ts
  attachYjsSync(ydoc, config)
  sync-only content doc primitive

packages/workspace/src/document/internal/sync-supervisor.ts
  shared transport, reconnect, liveness, awareness frames, RPC frames

apps/*/.../document.ts
  pure encrypted Y.Doc constructors already exist for several apps
```

The remaining mismatch is the public action shape and a few stale ownership seams.

```ts
// Current action registry
return {
	entries: {
		create: defineMutation({ ... }),
		update: defineMutation({ ... }),
	},
};

// Target action registry
return {
	'entries.create': defineMutation({ ... }),
	'entries.update': defineMutation({ ... }),
};
```

Current `script.ts` files are inconsistent:

```txt
Fuji script.ts
  local readonly snapshot
  daemon action proxy
  good target shape

Honeycrisp, Opensidian, Zhongwen script.ts
  machine auth
  live attachYjsSync
  yjs log reader
  no clear async disposer
  overlaps daemon.ts
```

The root workspace barrel still exports markdown link helpers:

```ts
export {
	convertEpicenterLinksToWikilinks,
	convertWikilinksToEpicenterLinks,
	EPICENTER_LINK_RE,
	makeEpicenterLink,
	parseEpicenterLink,
} from './links.js';
```

Those helpers are useful, but they are markdown/editor format helpers. They do not belong to the root sentence for `@epicenter/workspace`.

## Product Sentences

### Workspace Package

```txt
@epicenter/workspace defines typed Yjs-backed workspace data and actions, then attaches persistence, local sync, WebSocket sync, awareness, encryption, and RPC to a caller-owned Y.Doc.
```

### Collaboration

```txt
Workspace docs expose live peers and remote actions; content docs sync quietly as leaves.
```

### Actions

```txt
Apps define typed query and mutation actions that are callable locally and invokable remotely by peer through one flat dot-path address.
```

### App Runtime Files

```txt
document.ts creates data, browser.ts opens the browser runtime, daemon.ts opens the daemon runtime, and script.ts talks to the daemon or reads a local snapshot.
```

## Design Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Public sync shape | Keep `openCollaboration` and `attachYjsSync` separate | A single optional config bag recreates the old mixed `attachSync` problem. Presence and RPC are collaboration features, not sync-only features. |
| Shared sync implementation | Keep `createSyncSupervisor` internal | Transport lifecycle is shared, but callers should not choose partial collaboration modes. |
| Action registry | Flat dot-path record | The daemon, peer RPC, CLI, AI tools, errors, and manifests already speak dot paths. Nested local ergonomics force the largest code family. |
| Dot-path strings | Keep | Tuple addresses would still need serialization at every boundary. Dot paths are the common language. |
| `query` vs `mutation` | Keep | AI/tool approval and user trust depend on read/write classification. This is part of the product sentence. |
| `title` and `description` | Keep | AI tools, UI labels, and action discovery need friendly metadata. The code cost is modest. |
| Runtime introspection | Keep on runtime plane | `peer.describe()` should stay separate from user actions. No reserved `system.*` action namespace. |
| Scripts | Refuse live script workspaces | Scripts should read snapshots or call daemon actions. They should not become a second daemon. |
| Root markdown links | Move to a subpath | Link conversion is useful, but it is not root workspace composition. |

## Architecture

```txt
App document constructor
  openFujiDocument()
    -> Y.Doc
    -> encryption
    -> tables
    -> kv
    -> pure local helpers

Browser runtime
  openFujiBrowser()
    -> document
    -> IndexedDB
    -> BroadcastChannel
    -> child content docs
    -> openCollaboration()
    -> wipe()

Daemon runtime
  defineFujiDaemon().start()
    -> machine auth
    -> document
    -> Yjs log writer
    -> materializers
    -> openCollaboration()
    -> async dispose

Script facade
  openFujiScript()
    -> readonly local snapshot
    -> connectDaemonActions()
```

Action flow:

```txt
Definition:
  createFujiActions()
    -> { 'entries.create': defineMutation(...) }

Local:
  collaboration.actions['entries.create'](input)

Boundary:
  invokeAction(actions['entries.create'], input, 'entries.create')

Peer:
  peer.invoke('entries.create', input)

Daemon:
  client.run({ actionPath: 'fuji.entries.create', input })

AI:
  action path 'entries.create'
    -> tool name 'entries_create'
```

Sync flow:

```txt
openCollaboration()
  -> attach awareness
  -> publish identity and flat action paths
  -> createSyncSupervisor({ awareness, onActionRequest, onRuntimeRequest })
  -> create peers surface

attachYjsSync()
  -> createSyncSupervisor({ no awareness, no RPC handlers })
```

## Implementation Plan

### Phase 1: Flatten The Action System

- [ ] Replace `Actions` recursive type with a flat `ActionRegistry` type.
- [ ] Add `ActionPath` validation helpers for flat keys.
- [ ] Replace `walkActions(actions)` with `actionEntries(actions)`.
- [ ] Replace `resolveActionPath(actions, path)` with direct lookup plus validation.
- [ ] Make `describeActions(actions)` map flat keys directly to `ActionMeta`.
- [ ] Update `openCollaboration` to publish `Object.keys(actions).sort()`.
- [ ] Update `run-handler.ts` suggestions to work from flat entries.
- [ ] Update `actionsToAiTools` to derive tool names from flat dot paths.
- [ ] Update `DaemonActions<T>` so flat action keys produce bracket-callable methods.
- [ ] Update tests for `shared/actions`, `open-collaboration`, daemon run, daemon action client, and AI tools.

Target core shape:

```ts
export type ActionRegistry = Record<string, Action>;

export function actionEntries(
	actions: ActionRegistry,
): Array<[path: string, action: Action]> {
	return Object.entries(actions);
}

export function resolveActionPath(
	actions: ActionRegistry,
	path: string,
): Action | undefined {
	return actions[path];
}
```

### Phase 2: Migrate App Actions

- [ ] Fuji: flatten `createFujiActions`.
- [ ] Honeycrisp: flatten `createHoneycrispActions`.
- [ ] Opensidian: flatten `createOpensidianActions`.
- [ ] Tab Manager: flatten `createTabManagerActions`.
- [ ] Skills package and Skills app: flatten skill actions if they are on this same public action surface.
- [ ] Update all local action calls to bracket syntax.
- [ ] Update type references that index nested action members.

Examples:

```ts
// Before
fuji.collaboration.actions.entries.update({ id, title });

// After
fuji.collaboration.actions['entries.update']({ id, title });
```

```ts
// Before
Parameters<typeof fuji.collaboration.actions.entries.update>[0]

// After
Parameters<typeof fuji.collaboration.actions['entries.update']>[0]
```

### Phase 3: Prove Flat Actions

- [ ] Run `bun test packages/workspace/src/shared/actions.test.ts`.
- [ ] Run `bun test packages/workspace/src/document/open-collaboration.test.ts`.
- [ ] Run `bun test packages/workspace/src/daemon/run-handler.test.ts`.
- [ ] Run `bun test packages/workspace/src/client/daemon-actions.test.ts`.
- [ ] Run `bun test packages/workspace/src/ai/tool-bridge.test.ts`.
- [ ] Run package or app typechecks for changed apps.
- [ ] Search for `walkActions`, nested `.actions.foo.bar`, and `Actions` recursive assumptions.

Do not delete compatibility helpers until this phase passes.

### Phase 4: Standardize Script Facades

- [ ] Keep Fuji as the reference shape: `openFujiSnapshot()` plus `openFujiScript()`.
- [ ] For Honeycrisp, Opensidian, and Zhongwen, choose one:
  - add snapshot plus daemon action proxy, if scripts are needed
  - delete `script.ts`, if no script facade is needed yet
- [ ] Ensure scripts do not call `createMachineAuthClient`.
- [ ] Ensure scripts do not call `attachYjsSync`.
- [ ] Ensure scripts either own a readonly local snapshot or a daemon client proxy, not both live runtime ownership and daemon overlap.

Target script shape:

```ts
export async function openHoneycrispSnapshot(options = {}) {
	// read local Yjs log
	// return readonly tables
}

export async function openHoneycrispScript(options = {}) {
	return {
		snapshot: await openHoneycrispSnapshot(options),
		actions: await connectHoneycrispDaemonActions(options),
	};
}
```

### Phase 5: Move Link Helpers Out Of Root Barrel

- [ ] Add an explicit package export such as `@epicenter/workspace/links`.
- [ ] Move public imports in Opensidian from `@epicenter/workspace` to `@epicenter/workspace/links`.
- [ ] Keep internal relative imports in workspace materializers as-is unless a local barrel makes that clearer.
- [ ] Remove link helpers from `packages/workspace/src/index.ts`.
- [ ] Run link tests and Opensidian typecheck.

Target:

```ts
import { makeEpicenterLink } from '@epicenter/workspace/links';
```

Root `@epicenter/workspace` should stop answering markdown/editor link questions.

### Phase 6: Smaller Smell Sweep

- [ ] Remove inert pending request fields in the sync supervisor.
- [ ] Move pending request bookkeeping before send if tests can model synchronous responses.
- [ ] Replace single-member sync mini-unions with plain fields or add real variants.
- [ ] Route `apps/api` background logging through one diagnostics boundary.
- [ ] Decide whether `defineTable` keeps the overload casts or gets a separate builder shape.
- [ ] Remove unused exported protocol types or use them in decoder return types.

These are cleanup follow-ups. They should not block the action and runtime clean break.

## Build, Prove, Remove

Use this sequence for the action migration:

```txt
Build:
  add flat helpers
  migrate package internals
  migrate apps

Prove:
  run focused tests
  run typechecks
  grep for old nested assumptions

Remove:
  delete recursive walking
  delete plain-object branch handling
  delete class-instance skip tests
  delete docs that explain nested action trees
```

Use this sequence for script cleanup:

```txt
Build:
  add snapshot plus daemon action facade where needed

Prove:
  verify scripts compile
  verify daemon action proxy still works

Remove:
  delete live script sync setup
  delete machine-auth script ownership
```

## Edge Cases

### Flat Key Validation

Flat keys are public action addresses. They must be non-empty and must not contain empty segments.

```txt
valid:
  entries.create
  files.read
  bash.exec

invalid:
  ""
  ".create"
  "entries."
  "entries..create"
```

Underscores remain valid in action paths, but AI tool conversion must still guard against collisions when converting dots to underscores.

### Local Ergonomics Loss

Bracket syntax is less cute than nested property calls.

```ts
actions['entries.create'](input);
```

That is acceptable because the action path is the durable public address. The old local nicety forced recursive runtime and type machinery everywhere else.

### Reserved Names

There should be no reserved `system` action namespace. Runtime verbs stay on the runtime request plane.

```txt
peer.invoke('system.foo')
  user action, if the app defines that flat key

peer.describe()
  runtime request, not user action
```

### Peer Discovery

Awareness should publish only flat action paths, not schemas. Full metadata still comes from `peer.describe()`.

```txt
awareness:
  identity
  actionPaths

runtime request:
  describe-actions -> ActionManifest
```

## Open Questions

1. **Should `ActionRegistry` allow non-action values during migration?**
   - Option A: strict `Record<string, Action>` immediately.
   - Option B: temporary `Record<string, unknown>` with validation.
   - Recommendation: strict immediately. This is a clean break, and loose input preserves the old ambiguity.

2. **Should app call sites get a helper to avoid bracket syntax?**
   - Option A: no helper, use `actions['entries.create']`.
   - Option B: add app-local aliases for hot paths.
   - Recommendation: no framework helper. App-local aliases are fine where they improve component readability.

3. **Should `script.ts` be deleted for apps without a real script consumer?**
   - Option A: delete until needed.
   - Option B: keep a placeholder snapshot facade.
   - Recommendation: delete. Empty facades become stale boundaries.

4. **Should link helpers live at `@epicenter/workspace/links` or under a markdown subpath?**
   - Option A: `@epicenter/workspace/links`.
   - Option B: `@epicenter/workspace/document/markdown-links`.
   - Recommendation: `@epicenter/workspace/links`, because the helpers are generic Epicenter link format utilities, not only markdown materializer internals.

## Final State Checklist

- [ ] Root workspace exports describe caller-owned Y.Doc composition.
- [ ] `openCollaboration` is the only workspace-doc collaboration primitive.
- [ ] `attachYjsSync` is the only content-doc sync primitive.
- [ ] `createSyncSupervisor` stays internal.
- [ ] Actions are flat dot-path records.
- [ ] Local, peer, daemon, CLI, and AI action surfaces use the same path.
- [ ] App `document.ts` files have no runtime side effects beyond constructing local document attachments.
- [ ] App `browser.ts` or `extension.ts` files own browser runtime wiring.
- [ ] App `daemon.ts` files own Bun daemon runtime wiring.
- [ ] App `script.ts` files either read snapshots and call daemon actions, or do not exist.
- [ ] Markdown link helpers are imported from a link subpath, not the root workspace barrel.

