# Daemon Transport and Supervisor Integration Plan

**Date**: 2026-04-30
**Status**: Implemented
**Author**: AI-assisted
**Branch**: `codex/daemon-transport-supervisor-integration`

## Overview

This spec plans how to integrate `workspace-as-daemon-transport-v2` after the `supervisor-abortsignal` work has already landed on `origin/main`. The goal is to preserve the daemon branch's useful design work without replaying stale decisions that current main has superseded.

One sentence: start from current main, port daemon transport by intent, keep the newer supervisor and remote-action API as the authority, and explain the resulting history with a small number of focused commits plus this spec.

## Current Branch State

The branch picture after `git fetch origin` on 2026-04-30:

```txt
origin/main
  3449c81c1 refactor: update peer API to use sync for device actions
  335e47244 refactor(opensidian): extract workspace actions
  1d8cf1eb3 refactor(workspace)!: rename remote action proxy API
  3009b6ca4 refactor!: walk actions from workspace bundles
  d170d7ba7 refactor(workspace): replace runId/desired/torn flags with AbortController

supervisor-abortsignal
  same commit as origin/main

workspace-as-daemon-transport-v2
  e9a0ec2a7 docs(skill): update workspace-app-layout to v3.0
  a015586e3 refactor(apps): lift client.ts out of the workspace package folder
  5fa41335e refactor(daemon): default projectDir + stable clientID across all four apps
  a149682c5 origin/workspace-as-daemon-transport-v2
  ...
  10a1ea1d8 merge base with current main
```

Important conclusion: `supervisor-abortsignal` is not a separate integration target anymore. Its committed work is current main. The integration target is now:

```txt
origin/main + selected daemon-transport intent
```

not:

```txt
workspace-as-daemon-transport-v2 + supervisor-abortsignal
```

## Motivation

### Current State

`origin/main` owns the freshest sync and remote-action decisions:

```txt
d170d7ba7 attachSync uses AbortController supervisor state
3009b6ca4 actions are discovered by walking workspace bundles
1d8cf1eb3 public remote API is createRemoteActions and describeRemoteActions
335e47244 opensidian actions are extracted into actions.ts
3449c81c1 peer API usage in specs moved to sync/device-action wording
```

`workspace-as-daemon-transport-v2` owns valuable daemon transport work:

```txt
packages/workspace/src/daemon/*
packages/workspace/src/client/connect-daemon.ts
packages/workspace/src/client/remote.ts
packages/workspace/src/document/attach-yjs-log.ts
packages/workspace/src/document/attach-yjs-log-reader.ts
apps/*/src/lib/<app>/daemon.ts
apps/*/src/lib/<app>/script.ts
workspace-app-layout v3 docs
```

But it also carries stale or disputed choices:

```txt
packages/cli/src/commands/up.ts -> packages/cli/src/commands/serve.ts
packages/cli/src/commands/down.ts deleted
packages/cli/src/commands/ps.ts deleted
packages/cli/src/commands/logs.ts deleted
sync.peer() and describePeer() naming remains in the branch
opensidian actions are inlined back into browser.ts
```

### Problems

1. **A direct merge preserves stale decisions.** The daemon branch still says `serve`; current planning says `up`, `down`, `ps`, and `logs` are settled. A direct merge would make the wrong CLI decision win by accident.

2. **The conflict is semantic, not only textual.** Files like `packages/workspace/src/document/attach-sync.ts`, `packages/sync/src/actions.ts`, and `apps/opensidian/src/lib/opensidian/browser.ts` conflict because both branches changed the same concepts in different directions.

3. **The old daemon history tells a true story, but not the current story.** It contains useful exploration, reversions, and implementation waves. Keeping it verbatim would also keep the false starts and the now-rejected API names in the review path.

4. **A pure squash loses intent.** A one-commit squash would hide why some daemon branch changes were ported and others were rejected. The review would show a huge final tree without a clear rationale.

### Desired State

The final integration should read like this:

```txt
origin/main
  |
  v
codex/daemon-transport-supervisor-integration
  |
  +-- workspace daemon/server/client primitives
  +-- local yjs-log persistence and materializer primitives
  +-- app daemon/script factories using stable projectDir and clientID
  +-- CLI commands wired to daemon transport while keeping up/down/ps/logs
  +-- docs and skill updates explaining the layout
```

The history should explain the destination, not replay every turn that led to the old branch.

## Research Findings

### Direct Merge Simulation

A non-mutating merge simulation of `origin/main` with `workspace-as-daemon-transport-v2` reported conflicts in these clusters:

```txt
apps/opensidian/src/lib/opensidian/browser.ts
apps/tab-manager/src/lib/workspace/rpc-contract.ts
packages/cli/src/commands/list.ts
packages/cli/src/daemon/app.ts
packages/cli/src/daemon/schemas.ts
packages/cli/src/load-config.ts
packages/cli/src/util/format-output.ts
packages/cli/test/e2e-up-cross-peer.test.ts
packages/sync/src/actions.test.ts
packages/sync/src/actions.ts
packages/sync/src/remote-actions.test.ts
packages/sync/src/remote-actions.ts
packages/sync/src/rpc-types.ts
packages/sync/src/types.test.ts
packages/workspace/src/ai/tool-bridge.ts
packages/workspace/src/cache/disposable-cache.test.ts
packages/workspace/src/cache/disposable-cache.ts
packages/workspace/src/daemon/list-route.test.ts
packages/workspace/src/document/attach-sync.test.ts
packages/workspace/src/document/attach-sync.ts
packages/workspace/src/document/peer-presence-defs.ts
packages/workspace/src/document/system-describe.test.ts
packages/workspace/src/index.ts
packages/workspace/src/shared/device-id.ts
```

**Key finding**: the conflict set is concentrated and understandable. The risk is not the number of files. The risk is accidentally choosing the old branch's API and CLI vocabulary because Git presents it as one side of a conflict.

### Local-Only Daemon Commits

The local `workspace-as-daemon-transport-v2` branch has three commits above `origin/workspace-as-daemon-transport-v2`:

| Commit | Intent | Recommended treatment |
| --- | --- | --- |
| `5fa41335e` | Default `projectDir` and stable `clientID` in app daemon factories | Port after daemon factories exist |
| `a015586e3` | Lift app `client.ts` files out of workspace package folders | Port with the app layout wave |
| `e9a0ec2a7` | Update workspace app layout skill to v3.0 | Port after app layout is final |

**Key finding**: these commits are not the main conflict source. They are small follow-up changes that should apply after the branch has been re-integrated against current main.

### Branch History Versus Intent-Preserving Port

| Strategy | Pros | Cons | Verdict |
| --- | --- | --- | --- |
| Merge old daemon branch directly | Keeps every old commit and hash | Reintroduces stale `serve` naming, stale `peer()` naming, and broad conflicts | Reject |
| Rebase old daemon branch onto main | Preserves more history than a port | Forces conflicts through dozens of old commits, including commits we no longer want | Reject |
| Cherry-pick every old commit selectively | Keeps granular old intent | High conflict surface, easy to replay stale intermediate states | Reject for this branch |
| Squash final daemon tree | Small review surface | Loses why certain old work was rejected | Reject as a single commit |
| Port by intent in focused commits | Preserves current decisions and keeps review readable | Loses old commit hashes as the primary history | Recommended |

**Key finding**: preserving old hashes is less important than preserving current product and API intent. The old branch remains available for archaeology through references in this spec and commit bodies.

### Historical Compression

The daemon branch contains 148 commits above current `origin/main`:

```txt
145 commits  origin/main..origin/workspace-as-daemon-transport-v2
  3 commits  origin/workspace-as-daemon-transport-v2..workspace-as-daemon-transport-v2
148 total
```

The integration should not pretend those commits never happened. It should also not make reviewers replay every intermediate turn. The right historical shape is:

```txt
old branch
  preserved as archaeology and cited in commit bodies

new integration branch
  preserves current product intent in reviewable layers
```

That means the new branch intentionally compresses 148 daemon-branch commits into about 6 review commits. The compression is acceptable only if each commit body names the old commits it replaces and explains any rejected branch decisions that matter for future archaeology.

Cherry-picking is still useful as a staging tool:

```bash
git cherry-pick -n <old-commit>
```

Use it to inspect or stage a narrow old change, then adapt the result to current `main`. Do not preserve old commits as final history unless the commit applies cleanly, still expresses the desired public API, and does not drag stale naming or deleted commands back into the tree.

## Design Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Integration base | `origin/main` | It already includes supervisor work and the newer remote-action API |
| Branch strategy | New branch from main | Avoids mutating the stale daemon branch while preserving it as a reference |
| Commit strategy | Port by intent in 6 focused commits, with room for 7 or 8 if a layer gets noisy | Three to five commits compress too much of the 148-commit daemon history |
| CLI naming | Keep `up`, `down`, `ps`, `logs` | `specs/20260430T120000-cli-naming-decision.md` settles this |
| Remote action API | Keep `createRemoteClient` as the public factory | The bound client shape is newer than the old direct helpers and removes an unnecessary public layer |
| `attachSync` lifecycle | Keep the AbortController supervisor from main | It landed after the daemon branch diverged and fixes the runId/desired/torn model |
| App layout | Adopt v3 package-folder plus sibling `client.ts` shape | This matches the daemon/script factory split |
| Skill location | Prefer `.agents/skills/workspace-app-layout/SKILL.md` | Current repo uses `.agents`; the daemon branch updated `.claude`, which should not be the only copy |
| Old daemon docs | Port useful specs as references, not as proof the old branch wins | Some docs still say `serve`; those must be edited or marked superseded |

## Commit Shape

Do not force exactly three commits. Three commits would make each commit too wide:

```txt
commit 1: daemon primitives + yjs-log + materializers
commit 2: app factories + client.ts relocation + skill docs
commit 3: CLI integration + tests + docs
```

That shape is compact, but each commit mixes multiple layers. A better default is six commits:

```txt
1. feat(workspace): add daemon transport primitives
2. feat(workspace): add yjs-log persistence and workspace path helpers
3. refactor(sync): preserve current remote action API over daemon peer API
4. refactor(cli): route lifecycle commands through workspace daemon
5. feat(apps): add daemon and script workspace factories
6. docs: record daemon transport integration history
```

Seven or eight commits are acceptable if they buy real review clarity:

```txt
7th commit candidate: refactor(apps): lift workspace clients to lib root
8th commit candidate: test: pin daemon and script handoff across apps
```

Do not split only to mirror the old branch. Split when a reviewer can understand one concept without holding the whole daemon migration in their head. The rule is not "six commits exactly." The rule is:

```txt
Each commit should compile or have an explicit reason it cannot compile alone.
Each commit should explain one layer.
Each commit body should reference the old daemon branch commits it intentionally replaces.
Each commit body should call out stale old-branch decisions it intentionally rejects.
```

## Architecture

### Target Layering

```txt
apps/<app>/src/lib/client.ts
  app singleton, auth, session lifecycle
  |
  v
apps/<app>/src/lib/<app>/browser.ts
  browser persistence and websocket sync
  |
  +---------------------------------------------+
  |                                             |
  v                                             v
apps/<app>/src/lib/<app>/daemon.ts        apps/<app>/src/lib/<app>/script.ts
  long-lived daemon peer                       one-shot CLI peer
  yjs-log writer                               yjs-log reader
  materializers                                remote action calls
  stable project clientID                      stable script clientID
  |
  v
packages/workspace/src/daemon/*
  Unix socket app, client, metadata, run handler
  |
  v
packages/cli/src/commands/up.ts
packages/cli/src/commands/down.ts
packages/cli/src/commands/ps.ts
packages/cli/src/commands/logs.ts
packages/cli/src/commands/list.ts
packages/cli/src/commands/run.ts
```

### Sync Boundary

Current main owns this public shape:

```ts
import { createRemoteClient } from '@epicenter/workspace';

const remote = createRemoteClient({
	presence: workspace.presence,
	rpc: workspace.rpc,
});
const macbook = remote.actions<typeof actions>('macbook');
const manifest = await remote.describe('macbook');
```

The daemon branch has useful lower-level pieces, but its public shape should not win by accident:

```ts
// Old daemon branch shape. Do not reintroduce as the public API by default.
const remote = workspace.sync.peer<typeof actions>('macbook');
const manifest = await workspace.sync.describePeer('macbook');
```

The integration can still move pure action helpers into `@epicenter/sync` if that remains desirable. If it does, keep workspace compatibility exports or make the breaking change explicit in a separate commit.

### CLI Boundary

The CLI should keep this family:

```txt
epicenter up      bring this config online as a foreground peer
epicenter down    take daemon peers offline
epicenter ps      list running daemons
epicenter logs    read daemon logs
epicenter peers   show peers for a workspace
epicenter list    list local data through the daemon where needed
epicenter run     call an action through the daemon
```

The daemon branch's `serve` implementation can still donate internals:

```txt
serve.ts useful pieces
  -> daemon startup loop
  -> config loading
  -> workspace entry resolution
  -> socket binding
  -> signal handling

serve.ts rejected piece
  -> command name and deletion of down/ps/logs
```

## Conflict Resolution Policy

### `attach-sync.ts`

Use current main as the base. Port only additive or clearly better daemon pieces:

- Keep the `AbortController` supervisor from `d170d7ba7`.
- Keep the current `actions` discovery model from `3009b6ca4`.
- Keep the current public remote-action naming from `1d8cf1eb3`.
- Consider porting `WebSocketImpl` injection and `NoopWebSocket`.
- Consider porting `waitForPeer` and the `PeerMiss` error if CLI commands still need bounded peer waits.
- Consider porting the PeerLeft TOCTOU fix, translated to `createRemoteClient`.
- Do not restore the old `torn` flag model.
- Do not restore `sync.peer()` as the main public API without a fresh decision.

### `packages/sync` and `packages/workspace/src/rpc`

Prefer this split:

```txt
@epicenter/sync
  protocol encoding
  RpcError
  pure action definitions if they are package-neutral
  pure remote proxy builder if it has no workspace dependency

@epicenter/workspace
  attachSync
  createRemoteClient({ presence, rpc })
  private remote action proxy construction behind remote.actions(peerId)
  workspace-level exports and compatibility names
```

This keeps `@epicenter/sync` useful without making app code import every user-facing helper from a low-level protocol package.

### CLI Files

When a conflict appears between old daemon transport and current CLI names:

```txt
old branch implementation details win where they are transport internals
current main command names win where they are user-facing CLI surface
```

That means:

- Keep `up.ts`, `down.ts`, `ps.ts`, and `logs.ts`.
- Do not rename `up.ts` to `serve.ts`.
- Move reusable daemon server/client code into `packages/workspace/src/daemon`.
- Keep CLI as a thin command layer over workspace daemon primitives.
- Preserve shutdown and log commands if the daemon branch deleted them.

### Opensidian

Current main extracted actions to:

```txt
apps/opensidian/src/lib/opensidian/actions.ts
```

Keep that extraction. The daemon branch inlined those actions back into `browser.ts`; that should be rejected. When porting daemon/browser changes:

```txt
browser.ts keeps:
  createOpensidianActions({ fs, sqliteIndex, bash })

browser.ts ports:
  attachSync(doc, { ... }) signature changes if still valid
  core.ts import path if app layout moved from index.ts to core.ts
```

### Workspace App Layout Skill

The active local file is:

```txt
.agents/skills/workspace-app-layout/SKILL.md
```

The daemon branch updated:

```txt
.claude/skills/workspace-app-layout/SKILL.md
```

Port the v3 content into `.agents/skills/workspace-app-layout/SKILL.md`. Do not leave the updated guidance only under `.claude`.

## Implementation Plan

### Phase 0: Protect Work In Progress

- [x] Record current refs:
  ```bash
  git rev-parse origin/main
  git rev-parse workspace-as-daemon-transport-v2
  git rev-parse origin/workspace-as-daemon-transport-v2
  ```
- [x] Stash untracked planning and spike files before branch work:
  ```bash
  git stash push -u -m "wip daemon transport planning specs"
  ```
- [x] Create the integration branch:
  ```bash
  git switch -c codex/daemon-transport-supervisor-integration origin/main
  ```
- [x] Re-apply only planning files needed during implementation:
  ```bash
  git stash show --name-only stash@{0}
  git checkout stash@{0} -- specs/20260430T120000-cli-naming-decision.md
  ```

Do not execute this phase while only writing the plan. It belongs to the future implementation turn.

### Phase 1: Workspace Daemon Transport Foundation

- [x] Port `packages/workspace/src/daemon/*` from the daemon branch.
- [x] Port `packages/workspace/src/client/connect-daemon.ts`.
- [x] Port `packages/workspace/src/client/remote.ts` and `remote-workspace-types.ts`.
- [x] Port daemon metadata, Unix socket, path, run handler, and client tests.
- [x] Adapt imports to current main package exports.
- [x] Keep CLI files untouched except for type imports needed to compile.
- [x] Commit as:
  ```txt
  feat(workspace): add daemon transport primitives
  ```

Commit body should mention it replaces the useful parts of:

```txt
ea7f2f6a2 refactor(workspace)!: move daemon module from @epicenter/cli
5c1721a6e feat(workspace): add createWorkspaceServer factory
eefdcef07 feat(workspace): buildRemoteWorkspace + RemoteNotSupported
944d7983c feat(workspace): connectDaemon front door
```

Implementation note: this wave also added `findEpicenterDir` because
`connectDaemon` depends on it, and added `sync.waitForPeer` on top of the
current AbortController supervisor so the daemon run handler can use bounded
peer lookup without reviving `sync.peer()`.

### Phase 2: Local Persistence and Path Helpers

- [x] Port `attachYjsLog`.
- [x] Port `attachYjsLogReader`.
- [x] Port `sqlite-writer`.
- [x] Port `workspace-paths`.
- [x] Port `findEpicenterDir`, `ProjectDir`, `hashClientId`, and related path helpers.
- [x] Resolve naming against current main: prefer `ProjectDir`, `yjsPath`, `sqlitePath`, and `markdownPath` if still coherent.
- [x] Keep `attachSync` based on main and port only additive pieces.
- [x] Commit as:
  ```txt
  feat(workspace): add yjs-log persistence primitives
  ```

Commit body should mention it replaces the useful parts of:

```txt
071876224 feat(workspace): add mirror primitives and stable clientId derivation
0df82be33 feat(workspace): split attachSqlite into persistence + readonly-persistence
b3a548fd8 refactor(workspace): rename persistence to yjs, split path helpers
31e02681d refactor(workspace): make yjs-log attachments sync-constructed
e34bde828 refactor(workspace): drop whenLoaded from yjs-log attachments
```

Implementation note: this wave completes the old `attachSqlite` split by
moving Yjs update-log durability to `attachYjsLog` and using `attachSqlite`
for the queryable daemon-owned materializer. The older
`document/materializer/*` subpaths remain exported for existing playground
configs while new daemon factories can use the direct `attachMarkdown` and
`attachSqlite` primitives.

### Phase 3: Remote Action and Sync Boundary

- [x] Add `createRemoteClient({ presence, rpc })` as the preferred workspace API.
- [x] Collapse the lower-level proxy helper behind the public `createRemoteClient` facade.
- [x] Preserve current main's action walking behavior from workspace bundles.
- [x] Translate useful daemon branch peer-dispatch fixes to the current remote-action names.
- [x] Port `waitForPeer` and `PeerMiss` only if CLI bounded wait behavior still needs them.
- [x] If pure remote proxy helpers move to `@epicenter/sync`, keep workspace compatibility exports.
- [x] Do not restore `sync.peer()` as the main public API without a new decision.
- [x] Commit as:
  ```txt
  refactor(sync): preserve remote action API for daemon transport
  ```

Commit body should mention it replaces or supersedes the useful parts of:

```txt
8e31bb52d feat(workspace): add sync.waitForPeer + PeerMiss
b14102e19 refactor(cli): use sync.waitForPeer; delete peer-wait helpers
741f26144 feat(workspace): brand Table CRUD methods as defineQuery/defineMutation
8d1451750 refactor(workspace): replace RemoteWorkspace<W> with single Remote<T> mapped type
1e75cfe08 refactor(workspace): walk the workspace bundle directly, drop actions slot
f74ca0953 refactor(sync): drop dead safety wrapper, rename peer.ts -> remote-proxy.ts, close PeerLeft TOCTOU window
```

Commit body should explicitly say:

```txt
This commit keeps current main's remote client shape. The daemon branch's sync.peer() and describePeer() shape is useful history, not the public API this integration restores.
```

Implementation note: pure action helpers stayed in `@epicenter/workspace`
for this integration. The only remote-action behavior change was the
PeerLeft re-check after subscribing to awareness changes, translated to the
current remote client helper.

### Phase 4: CLI Integration While Keeping `up`

- [x] Keep `packages/cli/src/commands/up.ts`.
- [x] Keep `packages/cli/src/commands/down.ts`.
- [x] Keep `packages/cli/src/commands/ps.ts`.
- [x] Keep `packages/cli/src/commands/logs.ts`.
- [x] Port the daemon branch's useful startup loop from `serve.ts` into `up.ts`.
- [x] Route `list.ts`, `run.ts`, and `peers.ts` through workspace daemon primitives.
- [x] Preserve current main's remote-action naming in CLI output and tests.
- [x] Update `packages/cli/src/load-config.ts` to load daemon/script factories without reviving stale `serve` docs.
- [x] Commit as:
  ```txt
  refactor(cli): route lifecycle commands through workspace daemon
  ```

Commit body should explicitly say:

```txt
This keeps the user-facing up/down/ps/logs command family and ports the daemon branch's transport internals underneath it. The old serve command name is intentionally not carried forward.
```

Implementation note: the CLI command files now import daemon transport,
metadata, path, and client primitives from `@epicenter/workspace`. The old
duplicate `packages/cli/src/daemon/*` implementation was removed so `up`,
`down`, `ps`, `logs`, `list`, `run`, and `peers` share the workspace-owned
transport.

### Phase 5: App Daemon and Script Factories

- [x] Keep current `index.ts` iso factories and add `clientID`; reject the old branch `core.ts` rename for this integration.
- [x] Port `daemon.ts` and `script.ts` for Fuji, Honeycrisp, Opensidian, and Zhongwen.
- [x] Port integration tests that prove daemon plus script handoff.
- [x] Apply stable defaults:
  ```txt
  daemon projectDir = findEpicenterDir()
  daemon clientID = hashClientId(projectDir)
  script projectDir = findEpicenterDir()
  script clientID = hashClientId(Bun.main) or a deliberate equivalent
  ```
- [x] Leave app singleton `client.ts` files in place for this wave; defer relocation unless a later review wants it.
- [x] Keep Opensidian actions extracted in `actions.ts`.
- [x] Commit as:
  ```txt
  feat(apps): add daemon and script workspace factories
  ```

Commit body should mention the three local-only commits:

```txt
5fa41335e default projectDir and stable clientID
a015586e3 lift client.ts out of the workspace package folder
e9a0ec2a7 workspace app layout v3 docs, if docs land in this wave
```

If the `client.ts` relocation creates too many app conflicts, split it into its own commit:

```txt
refactor(apps): lift workspace clients to lib root
```

If app integration tests become large enough to obscure factory review, split them into:

```txt
test(apps): pin daemon and script handoff
```

### Phase 6: Docs, Specs, and Skills

- [x] Update `.agents/skills/workspace-app-layout/SKILL.md` to v3.
- [x] Update or add docs that explain daemon/script factories.
- [x] Record `specs/20260430T120000-cli-naming-decision.md` as the naming authority for old `serve` references.
- [x] Keep `specs/20260430T120000-cli-naming-decision.md` as the naming authority.
- [x] Link this integration spec from the final integration history.
- [ ] Commit as:
  ```txt
  docs: record daemon transport integration history
  ```

This phase can merge into earlier commits if docs are purely local to a code change. Keep it separate if the docs explain rejected branch choices.

## Implementation Result

The integration compressed the old daemon branch into eight review commits:

```txt
d36f12e5b feat(workspace): add daemon transport primitives
3e84ef4c3 feat(workspace): add yjs-log persistence and workspace path helpers
7e3580c7a refactor(sync): preserve remote action API for daemon transport
8a3a9f9ad refactor(cli): route lifecycle commands through workspace daemon
116fbf7a2 feat(apps): add daemon and script workspace factories
221ab3de3 refactor(apps): name yjs log attachments explicitly
94b5667c6 refactor(cli): normalize peer misses in run responses
docs: record daemon transport integration history
```

The old branch remains archaeology. Its useful daemon transport intent was
ported, while these stale decisions were rejected:

```txt
serve as the public lifecycle command
sync.peer() and describePeer() as the main public API
Opensidian action inlining
bulk client.ts relocation during the app factory wave
```

The final shape follows current main by preserving the AbortController sync
supervisor, `createRemoteClient`, and the extracted Opensidian actions file.

## Verification Plan

Run verification after each implementation wave when practical:

```bash
bun run typecheck
bun test packages/workspace
bun test packages/sync
bun test packages/cli
```

Targeted tests to expect or add:

```txt
packages/workspace/src/document/attach-sync.test.ts
packages/workspace/src/daemon/*.test.ts
packages/workspace/src/client/*.test.ts
packages/cli/src/commands/up.test.ts
packages/cli/src/commands/down.test.ts
packages/cli/src/commands/ps.test.ts
packages/cli/src/commands/logs.test.ts
apps/fuji/src/lib/fuji/integration.test.ts
apps/honeycrisp/src/lib/honeycrisp/integration.test.ts
apps/opensidian/src/lib/opensidian/integration.test.ts
apps/zhongwen/src/lib/zhongwen/integration.test.ts
```

Manual smoke shape:

```bash
bun run epicenter up --dir vault/fuji-example
bun run epicenter ps
bun run epicenter peers --dir vault/fuji-example
bun run epicenter list --dir vault/fuji-example
bun run epicenter down --dir vault/fuji-example
```

The exact package scripts may differ. Use the monorepo skill before running the final commands.

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Accidentally reintroduce `serve` | Medium | High | Keep CLI naming spec open during conflict resolution |
| Accidentally restore `sync.peer()` as public API | Medium | High | Treat `1d8cf1eb3` as authoritative |
| `attachSync` loses AbortController supervisor fixes | Medium | High | Resolve `attach-sync.ts` from main, then port additive daemon pieces |
| App `client.ts` relocation breaks `$lib` imports | High | Medium | Use `rg "\\$lib/.*/client"` and update imports mechanically |
| Package boundary between `@epicenter/sync` and `@epicenter/workspace` gets muddled | Medium | Medium | Keep pure protocol in sync, workspace-facing helpers in workspace |
| Old daemon docs contradict new CLI names | High | Medium | Search for `serve` and update or mark as superseded |
| Too few commits hide review intent | Medium | Medium | Default to 6 commits, with 7 or 8 allowed when they clarify review |

## Open Questions

1. **Should pure action helpers move to `@epicenter/sync` now?**
   - Option A: Move `defineQuery`, `defineMutation`, action walking, and remote proxy builder into `@epicenter/sync`.
   - Option B: Keep public action helpers in `@epicenter/workspace` for this integration, defer package-boundary cleanup.
   - Recommendation: Move only pure helpers if the implementation is already clean. Keep workspace compatibility exports either way.

2. **Should `sync.waitForPeer` become public?**
   - The daemon branch used it for CLI wait behavior.
   - Current main can also express peer lookup through `createRemoteClient`, but bounded wait is a separate primitive.
   - Recommendation: Keep `waitForPeer` if CLI needs it; document it as presence lookup, not remote action dispatch.

3. **Should `client.ts` relocation land with app daemon factories?**
   - It makes the app layout cleaner.
   - It causes many app import updates and may distract from daemon transport.
   - Recommendation: Include it if app factory ports already touch those imports; split it if conflicts become noisy.

4. **Should the old daemon branch be merged after the port for ancestry?**
   - This would preserve a graph link but risks reintroducing old tree state.
   - Recommendation: Do not merge it. Reference the old branch and key commits in this spec and commit bodies instead.

## Success Criteria

- [x] The integration branch starts from current `origin/main`.
- [x] The old daemon branch remains available as a reference.
- [x] The final code keeps `up`, `down`, `ps`, and `logs`.
- [x] The final code keeps `createRemoteClient` as the remote-action API and hides the lower-level proxy helper.
- [x] `attachSync` keeps the AbortController supervisor model.
- [x] Daemon and script factories exist for the intended apps.
- [x] The workspace daemon/client primitives live in `packages/workspace`, not only `packages/cli`.
- [x] Local yjs-log persistence and path helpers are available through stable workspace exports.
- [x] The app layout skill documents the v3 layout in `.agents/skills/workspace-app-layout/SKILL.md`.
- [x] Tests and typecheck pass for workspace, sync, CLI, and touched apps, with root app typecheck caveats recorded in the final branch summary.
- [x] Commit history is reviewable without replaying stale daemon branch commits.

## References

- `workspace-as-daemon-transport-v2`: source branch for daemon transport, app factories, yjs-log persistence, and app layout v3.
- `origin/workspace-as-daemon-transport-v2`: remote checkpoint before local follow-up commits.
- `supervisor-abortsignal`: now equal to `origin/main`; no separate merge target.
- `d170d7ba7`: AbortController supervisor refactor.
- `3009b6ca4`: workspace bundle action walking.
- `1d8cf1eb3`: remote action API rename to `createRemoteActions` and `describeRemoteActions`.
- `335e47244`: Opensidian action extraction.
- `3449c81c1`: spec updates for sync/device-action wording.
- `5fa41335e`: local-only daemon default `projectDir` and stable `clientID`.
- `a015586e3`: local-only app `client.ts` relocation.
- `e9a0ec2a7`: local-only workspace app layout v3 docs.
- `specs/20260430T120000-cli-naming-decision.md`: authority for `up`, `down`, `ps`, and `logs`.
- `specs/20260430T103959-split-attach-sync-into-transport-presence-rpc.md`: future direction for splitting `attachSync`.
- `packages/workspace/specs/20260430T104326-attach-sync-supervisor-evolution.md`: future direction for supervisor v2.
