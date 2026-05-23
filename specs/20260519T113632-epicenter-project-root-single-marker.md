# Epicenter project root: single `.epicenter/` marker

**Status**: Superseded. Do not implement.

Superseded by `specs/20260519T150000-epicenter-project-as-first-class.md`. This draft fixed the immediate dual-marker bug, but the later spec chooses `epicenter.config.ts` as the project marker and route registry.

## One-sentence model

A project is any directory containing `.epicenter/`; `workspaces/<route>/daemon.ts` registers routes; `~/.epicenter/` holds per-user process state.

## Problem

Project root discovery is inconsistent across three call sites:

| Caller | `workspaces/` is marker? | `.epicenter/` is marker? |
|---|---|---|
| `findEpicenterDir` | yes | yes |
| `daemon/client.ts::getDaemon` | yes | no |
| `runUp` / `claimDaemonLease` | trusts `-C` | trusts `-C` |

A user can follow the documented walk-up rule, resolve a project via `.epicenter/`, then `connectDaemonActions` rejects with `MissingConfig` because `workspaces/` is missing. The README documents a contract the client does not honor.

Additionally, `packages/cli/README.md` and `apps/fuji/README.md` claim `.epicenter/daemon.sock` lives in the project. It does not; sockets are per-user under `~/.epicenter/run/<dirHash>/` (or `$XDG_RUNTIME_DIR/epicenter/...`).

## Two `.epicenter/` directories, two responsibilities

This split is intentional and stays.

```
~/.epicenter/                      per-user, process state
  run/<dirHash>/daemon.sock        socket (XDG_RUNTIME_DIR on Linux)
  log/<dirHash>/                   logs
  (lease, metadata)

<project>/.epicenter/              per-project, data state + ROOT MARKER
  sqlite/  yjs/  markdown/         materialized workspace data
  (future) config.ts
```

|                    | `~/.epicenter/`              | `<project>/.epicenter/`           |
| ------------------ | ---------------------------- | --------------------------------- |
| Scope              | per-user, per-machine        | per-project, travels with repo    |
| Lifetime           | process                      | project                           |
| In git?            | never                        | yes (selective gitignore)         |
| Project marker?    | no                           | **yes**                           |
| Created by         | daemon at first boot         | `epicenter daemon up` at first run |
| `rm -rf project`?  | unaffected                   | gone with the project (correct)   |

Pure-root would lose portability (clone a repo and you have no materialized SQLite). Pure-local fights XDG_RUNTIME_DIR conventions and pollutes git with sockets and logs. The split stays; the spec names it loudly.

## Decision

1. Project root is resolved by walking upward for **`.epicenter/` only**.
2. `workspaces/` is route registration, never a root marker.
3. `epicenter daemon up -C <dir>` creates `<dir>/.epicenter/` if missing, before claiming the lease. This is the only command that creates the marker.
4. No `epicenter init` needed. No config file needed. No second discovery path.

## Options considered

| Option | Verdict | Why |
|---|---|---|
| Current dual-marker | Reject | Already inconsistent across callers; docs document a half-truth |
| **`.epicenter/`-only + `up` auto-creates** | **Pick** | One owner, one rule, zero new commands |
| Top-level default, no walk | Reject | Kills "run scripts from any subdir" with no compensating win |
| Config-first (`epicenter.config.ts`) | Reject (for now) | Forces a config file before anything works; `up` would have to parse user TS to bind a socket |
| No implicit walking | Reject | Strictly worse than top-level-default |

## Constraint check

- Explainable in one sentence: yes.
- One owner for "what is the project root": `findEpicenterDir`.
- One owner for "where runtime state lives": `daemon/paths.ts` (per-user) + `document/workspace-paths.ts` (per-project).
- Registration vs runtime state not conflated: `workspaces/` = registration, `<project>/.epicenter/` = data, `~/.epicenter/` = process.
- Daemon does not latch parent project accidentally: a child with its own `.epicenter/` shadows the parent; a child without one either intentionally finds the parent or fails loudly at the filesystem root.
- Scripts deterministic: one marker, one walk.
- Multi-project isolation unchanged: `dirHash(realpathSync(projectDir))` keys sockets/logs/leases.

## Patch plan (one PR, two commits)

### Commit 1: semantics + tests

- `packages/workspace/src/client/find-epicenter-dir.ts`: drop the `hasWorkspaces` branch and `WORKSPACES_DIRNAME` import; update JSDoc and throw message to reference only `.epicenter/`.
- `packages/workspace/src/client/connect-daemon-actions.ts`: JSDoc lines 43, 57: state only `.epicenter/`.
- `packages/workspace/src/daemon/client.ts::getDaemon`: replace the `existsSync(workspacesPath)` gate with `existsSync(join(projectDir, '.epicenter'))`. Rename `DaemonError.MissingConfig` message to point at `epicenter daemon up`.
- `packages/cli/src/commands/up.ts::runUp`: before `claimDaemonLease(projectDir)`, run `mkdirSync(join(projectDir, '.epicenter'), { recursive: true, mode: 0o700 })`. Best-effort, idempotent.
- `packages/workspace/src/client/find-epicenter-dir.test.ts`: delete the `workspaces/` marker test; flip the nested test to `.epicenter/`; update throw-message regex.
- `packages/cli/src/commands/up.test.ts`: assert `existsSync(join(workDir, '.epicenter'))` after happy-path `runUp`.
- `packages/cli/test/fixtures/inline-actions`: audit; ensure `.epicenter/` exists (or `up` creates it).

### Commit 2: docs + help text

- `packages/cli/src/util/common-options.ts`: rewrite `-C` description to "Project root (or any directory under it; discovery walks up to the nearest `.epicenter/`)."
- `packages/cli/README.md`: rewrite the discovery sentence; remove the stale "`.epicenter/daemon.sock` lives in the project" claim; note sockets live under `~/.epicenter/run/` (or `$XDG_RUNTIME_DIR/epicenter`).
- `docs/scripting.md` line 46: single-marker walk-up.
- `apps/fuji/README.md`: drop the in-project `daemon.sock` line; fix any "workspaces/ or .epicenter/" prose.
- `.agents/skills/workspace-app-layout/SKILL.md`: update if it carries the dual-marker line.

### Untouched

`discover.ts` (still scans `workspaces/`; that is registration, correct), `daemon/paths.ts`, `lease.ts`, `runtime-files.ts`, `metadata.ts`, `workspace-paths.ts`. No on-disk format change. No socket/lease change. Running daemons unaffected.

## Verification

- `bun test packages/workspace/src/client/find-epicenter-dir.test.ts`
- `bun test packages/workspace/src/workspace-apps/discover.test.ts`
- `bun test packages/cli/src/commands/up.test.ts`
- `bun test packages/cli/test/e2e-up-cross-peer.test.ts`
- `bun run --cwd packages/cli test`

## Migration impact

Existing projects already have `.epicenter/` (any prior `daemon up` or materialization created it). The only flow that changes: a fresh checkout with only `workspaces/<route>/daemon.ts` and no prior `up` run. That flow now requires `epicenter daemon up` once, which auto-creates the marker. No explicit `init` command needed.

## What is refused

- Dual-marker compatibility. Reading `workspaces/` as a root marker is gone, not kept behind a flag. The "compat" path is what made the system incoherent.
- A separate `epicenter init` command. `daemon up` already provisions runtime state on first run; adding a parallel init command is the soft-convention trap.
- A config file as the project marker. The future home for `<project>/.epicenter/config.ts` is named, but the marker is the directory's existence, not the file's.
