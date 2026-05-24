# CLI: collapse `list` to one local primitive, drop `--peer` / `--all`

**Status**: shipped (commits `e9f95d10a`, `0dfa5386c` on `post-pr-1705-cleanup-v1`)
**Date**: 2026-04-28
**Builds on**: `20260428T140000-cli-mandatory-daemon-collapse.md` (established the CLI-as-shortcut model and the mandatory-daemon path).

## Why this exists

The prior `epicenter list` was bundling three unrelated scripts behind flags:

```
list                  ->  describeActions(workspace.actions)         local, in-process, free
list --peer <id>      ->  describePeer(sync, id)                     one RPC
list --all            ->  for (p of sync.peers()) describePeer(sync, p.id)   N RPCs, fan-out
```

Three different scripts. Three different cost profiles. Three different failure modes. Wiring them into one verb forced a `ListMode` discriminated union, a `parseMode()` mutual-exclusion check, a `Section[]` wrapper so fan-out had somewhere to put its N answers, a `multi` flag in the renderer, `--wait` plumbing for peer awareness, `ListError.PeerMiss`, `peerSection`/`selfSection` helpers, and a 3-case test matrix.

That violated the principle established in `20260428T140000-cli-mandatory-daemon-collapse.md`:

```
library  (loadConfig + workspace API)            ← the substrate
   ▲
   ├── vault-style scripts   `bun ./script.ts`   ← power user automation
   │     • opens its own workspace
   │     • dispatches local actions
   │     • dispatches remote RPC via sync.rpc
   │     • composes / loops / branches freely
   │
   └── epicenter CLI         `epicenter <verb>`  ← shell shortcuts
         • run / list / peers REQUIRE a local `up`
         • the CLI is "type one line at a shell prompt"
         • not "build automation on top of"
```

A CLI shortcut should map to one workspace primitive. The moment it bundles several behind flags, it's become a script runtime in disguise, and a vault-style script would express the same intent more clearly.

## The model in one diagram

```
                 ┌──────────┬───────────────────────────────────┐
                 │   Verb   │          Workspace primitive      │
                 ├──────────┼───────────────────────────────────┤
   Enumerate     │  list    │  describeActions(workspace.actions)
   Invoke        │  run     │  invokeAction(...)  /  sync.rpc(...)
   Presence      │  peers   │  workspace.sync.peers()
                 └──────────┴───────────────────────────────────┘
```

`run` is the only verb that branches; the branching is forced (an RPC call needs exactly one target) rather than chosen. No fan-out flag exists or could exist on `run`: the verb returns one result.

## Invariants

1. **`list` describes only this device.** `executeList` is `Ok(describeActions(entry.workspace.actions ?? {}))`. Nothing more. The route handler is one line in `app.ts`.

2. **`list` has no peer concept.** No `--peer`, no `--all`, no `--wait`. No `ListError.PeerMiss`. The wire payload is `{ workspace? }`. The result is `ActionManifest` (no envelope).

3. **Per-peer schema introspection is a script.** `describePeer(sync, deviceId)` is a one-line call from any vault-style script. The CLI does not provide a shortcut for it; if a future need is large enough to justify one, it goes on `peers`, not `list`.

4. **Fan-out is a script.** Walking `sync.peers()` and calling `describePeer` (or any other action) for each is a five-line loop in TypeScript. The CLI does not grow flags that shadow this.

5. **One Result shape per verb, no envelopes.** `ListResult` is `Result<ActionManifest, ResolveError>`. `RunResult` is `Result<unknown, RunError | ResolveError>`. No `{ entries: ActionManifest }` or `{ data: unknown }` one-field wrappers.

6. **Wire fields name what they are.** `runCtxSchema.workspace` (renamed from `workspaceArg`) matches `listCtxSchema.workspace` and `peersArgsSchema.workspace`. The CLI's `--workspace` arg has one name across the protocol.

## What got deleted

```
packages/cli/src/commands/list.ts                   554 →  243 lines  (-310)
  delete: ListMode union (3 variants)
  delete: parseMode() + mutual-exclusion check
  delete: --peer / --all / --wait flags
  delete: Section[] wrapper, peerOption, allOption, waitOption
  delete: multi plumbing in renderJson / renderText
  delete: ListError.PeerMiss
  delete: ListSuccess one-field envelope (Wave 1.5)
  delete: vestigial async on renderResult / renderText (Wave 1.5)
  delete: path field on the wire payload (Wave 1.5)

packages/cli/src/daemon/handlers.ts                 226 → ø lines (renamed)
  rename: handlers.ts -> run-handler.ts (after executeList collapsed)
  delete: executeList (one liner inlined into the /list route)
  delete: peerSection, selfSection
  delete: SyncAttachment, AwarenessState, describePeer imports

packages/cli/src/daemon/schemas.ts                   47 →  41 lines
  delete: listMode arktype branch (3 variants)
  delete: listCtxSchema.path (Wave 1.5; daemon never read it)
  delete: peersArgsSchema.deviceId (Wave 2 prep, abandoned)
  rename: runCtxSchema.workspaceArg -> workspace (Wave 1.5)

packages/cli/src/daemon/app.ts
  inline: executeList -> Ok(describeActions(...)) inline in /list (Wave 1.5)
  drop:   async on /list route (no awaits inside)

packages/cli/src/daemon/client.ts
  drop:   ListSuccess type import; list returns ActionManifest directly
  drop:   RunSuccess type import; run returns unknown directly

packages/cli/src/daemon/list-route.test.ts
  collapse: 3 mode-cases -> 1 happy path + empty manifest

packages/cli/src/commands/list.test.ts
  delete: peerSection / selfSection unit tests
  keep:   filterByPath tests

packages/cli/src/util/peer-wait.ts
  delete: waitForAnyPeer (only list used it; run uses waitForPeer)

packages/cli/src/commands/peers.ts
  jsdoc:  drop references to `list --peer` / `list --all`

packages/cli/test/e2e-up-cross-peer.test.ts
  comment: list --peer -> peers <deviceId>

packages/cli/README.md
  rewrite: surface grid, examples table, flag table
  delete:  --peer / --all / --wait flags from list

examples/notes-cross-peer/README.md
  rewrite: list --peer commands -> peers + inspect-peer.ts script
─────────────────────────────────────────────────────────────────────────
total lines removed                                  ~410
total lines added                                    ~ 60
net deletion                                         ~350
```

## What got moved (not deleted)

Per-peer schema introspection is unchanged at the workspace-library layer. Anything previously typed as `epicenter list --peer <id>` now reads:

```ts
// my-script.ts
import { describePeer } from '@epicenter/workspace';
import { tabManager } from './epicenter.config';

await tabManager.whenReady;
const result = await describePeer(tabManager.sync, '0xabc');
if (result.error) console.error(result.error);
else for (const [path, meta] of Object.entries(result.data)) {
  console.log(path, meta.type, meta.description ?? '');
}
```

```bash
bun run my-script.ts
```

This is strictly more powerful than the deleted CLI shortcut: scripts can iterate, filter, format, persist, or compose with other workspace primitives.

## Sequence diagram, end-to-end

A user typing `epicenter list` against a running daemon now traces:

```
yargs.handler ─► getDaemon(target)              [config exists? daemon up?]
              ─► daemon.list({ workspace? })    [POST /list, hc<DaemonApp>]
                  └► sValidator(listCtxSchema)  [{ workspace? }]
                  └► resolveEntry(...)          [Ok | Err(UnknownWorkspace|...)]
                  └► Ok(describeActions(entry.workspace.actions ?? {}))
              ─► result.data : ActionManifest   [no envelope]
              ─► renderText(...)                [tree printer, client-side]
```

Five steps. No mode switch. No peer wait. No section wrapper.

## Outstanding follow-ups (not blocking this PR)

1. **`peersArgsSchema` is named with `Args` suffix; `listCtxSchema` and `runCtxSchema` use `Ctx`.** The `Ctx` suffix dates back to when these carried richer payloads (`mode`, `path`, `waitMs`). Now they're plain arg shapes. Picking one suffix is a follow-up rename.

2. **`PeerMiss` lives only on `RunError` now** (after `ListError.PeerMiss` was deleted). The shared-PeerMiss-factory observation in `20260428T140000-cli-mandatory-daemon-collapse.md` § "Outstanding observations" is mostly moot, but the field naming on `RunError.PeerMiss` (now `workspace`, was `workspaceArg`) was tightened in this PR.

3. **`peers.ts` client method types its arg manually** (`{ workspace?: string }`) while `list` and `run` derive via `Parameters<typeof client.X.$post>[0]['json']`. Cosmetic inconsistency.

None block shipping. Each is one small follow-up commit.
