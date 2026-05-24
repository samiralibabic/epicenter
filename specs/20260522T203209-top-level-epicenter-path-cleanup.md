# Top-Level Epicenter Path Cleanup

**Date**: 2026-05-22
**Status**: Implemented

## Overview

Epicenter should not write machine-wide state into top-level `~/.epicenter/` anymore. Durable user data should use platform directories from `env-paths('epicenter')`, process runtime files should use the OS runtime directory, and generated project data should stay under `<projectDir>/.epicenter/`.

## Motivation

### Current State

Active code now has three path owners:

```txt
machine auth
  -> env-paths('epicenter').data/auth/<host>.json

daemon sockets, metadata, leases
  -> $XDG_RUNTIME_DIR/epicenter/<hash>.* when available
  -> os.tmpdir()/epicenter/<hash>.* otherwise

project generated data
  -> <projectDir>/.epicenter/{sqlite,yjs,md,log}
```

The old model still appears in stale specs and docs:

```txt
~/.epicenter/auth.json
~/.epicenter/persistence/<workspaceId>.db
~/.epicenter/run/<hash>.sock
~/.epicenter/log/<hash>.log
EPICENTER_HOME
```

This creates problems:

1. **False implementation map**: Specs and docs can tell future agents to recreate a path we just removed.
2. **Mixed ownership**: `~/.epicenter/` used to mean auth, runtime, persistence, installed workspaces, and server keys depending on the document.
3. **Test drift**: Fixtures that seed `HOME/.epicenter/auth.json` can pass locally while production code reads `env-paths`.

### Desired State

The durable rule is small:

```txt
No active or forward-looking code, tests, specs, or docs should introduce
top-level ~/.epicenter writes.

Allowed:
  <projectDir>/.epicenter/     generated project workspace data
  historical specs/articles    only when clearly marked stale or superseded
```

## Research Findings

### Active Code Search

Searches to run during cleanup:

```bash
rg "~/.epicenter|EPICENTER_HOME|homedir\\(|\\.epicenter/auth|auth\\.json" packages apps examples docs specs
rg "epicenterPaths|EPICENTER_HOME|~/.epicenter/persistence" packages apps examples docs specs
rg "runtimeDir\\(|metadataPathFor|socketPathFor|leasePathFor|logPathFor|envPaths\\('epicenter'" packages apps
```

Initial finding: active machine auth and daemon runtime no longer need top-level `~/.epicenter`. One unused playground helper, `packages/workspace/src/client/epicenter-paths.ts`, still exposed `EPICENTER_HOME ?? ~/.epicenter`; it should be removed with the export.

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Machine auth path | 1 evidence | `env-paths('epicenter').data/auth/<host>.json` | Matches `machineAuthFilePath` and keeps API targets separate. |
| Runtime files | 1 evidence | `runtimeDir()` for sockets, metadata, leases | `packages/workspace/src/daemon/paths.ts` already owns this. |
| Logs | 1 evidence | `env-paths('epicenter').log` | Logs are persistent diagnostics, not runtime files. |
| Project data | 2 coherence | Keep `<projectDir>/.epicenter/` | This is project-owned generated data, not user-global machine state. |
| Historical docs | 3 taste | Update forward-looking docs; leave archived specs only when clearly historical | Rewriting every old design note risks churn. Stale instructions that look actionable should be fixed. |

## Architecture

```txt
                 Epicenter filesystem ownership

  User auth token bundle
    -> platform data dir
    -> env-paths('epicenter').data/auth/<host>.json

  Daemon process coordination
    -> runtime dir
    -> runtimeDir()/<hash>.sock
    -> runtimeDir()/<hash>.meta.json
    -> runtimeDir()/<hash>.lease.sqlite

  Daemon diagnostics
    -> platform log dir
    -> env-paths('epicenter').log/<hash>.log

  Workspace materialized data
    -> project dir
    -> <projectDir>/.epicenter/
```

## Implementation Plan

### Phase 1: Remove Active Footguns

- [x] **1.1** Move the daemon e2e fixture off `HOME/.epicenter/auth.json`.
- [x] **1.2** Delete unused `epicenterPaths` and its `EPICENTER_HOME` fallback.
- [x] **1.3** Verify no active package or app code writes top-level `~/.epicenter`.
- [x] **1.4** Add a regression test for banned top-level path vocabulary in active source.

### Phase 2: Clean Forward-Looking Docs

- [x] **2.1** Audit `docs/` and package READMEs for actionable `~/.epicenter` path guidance.
- [x] **2.2** Audit current specs from 2026-05 for actionable `~/.epicenter` path guidance.
- [x] **2.3** Audit older specs for stale instructions that are likely to be copied into future work.

### Phase 3: Commit Safely

- [x] **3.1** Re-read every touched file.
- [x] **3.2** Run focused tests and typechecks.
- [x] **3.3** Stage only files changed for this cleanup.
- [x] **3.4** Commit with a conventional commit message and no AI attribution.

## Edge Cases

### Project-Local `.epicenter`

`<projectDir>/.epicenter/` is still valid. It is the generated data directory for project-local workspace state. The cleanup should not remove or rename it.

### Historical Articles

Some articles intentionally describe old decisions. If they are clearly historical, leave them alone or add a short note. If they read like current setup instructions, update them.

### External Users of Removed Export

`@epicenter/workspace/node` is a public export surface. Removing `epicenterPaths` is acceptable only if typecheck and in-repo search show no internal callers. If release compatibility matters for published consumers, call that out before committing.

## Open Questions

1. **Should stale specs be edited or marked superseded?**
   Recommendation: update only specs that look like current implementation instructions. Leave obvious historical planning docs alone unless they point agents at active files.

2. **Should docs/articles arguing for `~/.epicenter` be removed?**
   Recommendation: do not delete articles in this pass. Add a note or leave them as historical writing unless they are linked from current user docs.

## Success Criteria

- [x] No active source file writes machine auth, daemon runtime, daemon logs, or global persistence to top-level `~/.epicenter`.
- [x] Docs and forward-looking specs do not instruct future work to add top-level `~/.epicenter` writes.
- [x] `<projectDir>/.epicenter/` remains documented as project-local generated data.
- [x] Focused tests and typechecks pass.
- [x] Cleanup is staged and committed without unrelated worktree changes.

## References

- `packages/auth/src/node/machine-auth.ts`: machine auth path resolver.
- `packages/workspace/src/daemon/paths.ts`: daemon runtime and log path resolver.
- `packages/workspace/src/document/workspace-paths.ts`: project-local generated data paths.
- `packages/cli/src/commands/up.ts`: project data directory provisioning.
- `packages/cli/README.md`: current CLI path documentation.
