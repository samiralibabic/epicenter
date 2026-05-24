# Dev Script Conventions

**Date**: 2026-05-11
**Status**: Superseded by `ef68955e1` (workflow runner replaced by `turbo run dev --filter=...`) and `c4269c9b2` (Infisical secrets pipe through `process.env`, no `.dev.vars` produced)
**Author**: Codex
**Branch**: codex/5028-auth-bearer-main-sync

## Overview

Development scripts now optimize for one local workflow at a time. The short path is safe and local. Broad multi-app runs and production-backed dev modes are intentionally not preserved.

One sentence test: Epicenter dev scripts should make the safe local workflow short, make supporting services visible, and avoid casual commands that touch production infrastructure.

## Motivation

### Current State

The repo had two competing ideas:

```json
{
  "dev": "turbo run dev"
}
```

and, inside most apps:

```json
{
  "dev": "bun run dev:local",
  "dev:local": "vite dev",
  "dev:remote": "vite dev --mode production"
}
```

This created problems:

1. **Root `dev` was too broad**: It started every package with a `dev` script, which is not how people usually test one app workflow.
2. **Remote looked too casual**: `dev:remote` sounded like normal development even though it could point at production services.
3. **API requirements were implicit**: Tab Manager needs the API for the normal product loop, but its app-level dev script only starts WXT.

### Desired State

App packages keep the simple local contract:

```json
{
  "dev": "bun run dev:local",
  "dev:local": "..."
}
```

Root scripts describe complete workflows:

```json
{
  "dev": "bun run dev:tab-manager",
  "dev:api": "bun run --cwd apps/api dev:local",
  "dev:tab-manager": "bun run scripts/dev.ts tab-manager",
  "dev:tab-manager:ui": "bun run --cwd apps/tab-manager dev:local"
}
```

There is no `dev:all` compatibility shim. The old behavior was clear to machines but confusing to humans. If we need a broad stress test later, it should get a new name and a new reason.

## Research Findings

### Existing Repo Pattern

Most app packages already had `dev` aliasing to `dev:local`. The mismatch was root `dev`, which used `turbo run dev`, and the remote scripts, which made production-backed runs feel ordinary.

**Key finding**: Local app scripts were mostly right. The root script and remote naming were the problem.

**Implication**: Preserve app-level `dev` and `dev:local`. Remove `dev:remote`. Replace root `dev` with a curated workflow.

### Tab Manager Runtime Shape

Tab Manager can compile with WXT alone, but the real local product loop needs:

```txt
apps/tab-manager
  WXT extension dev server

apps/api
  auth
  workspace sync
  AI chat
```

**Key finding**: `bun run dev:tab-manager` should start both API and WXT. `bun run dev:tab-manager:ui` should exist for UI-only work.

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| App default | 2 coherence | Keep `dev` as `dev:local` | The shortest app command remains safe. |
| Root default | 2 coherence | `dev` starts the core local workflow | Root commands should be complete workflows. |
| Tab Manager local workflow | 2 coherence | Start API plus WXT | The normal extension loop depends on the hub. |
| UI-only workflow | 2 coherence | Add `dev:tab-manager:ui` | Focused extension work should not spawn duplicate API servers. |
| Remote dev scripts | 2 coherence | Remove them | Production-backed work should not be named dev. |
| Backwards compatibility | 3 taste | Do not add `dev:all` | Keeping the old broad command preserves the old confusion. |

## Final Command Shape

```txt
root package.json
  dev
  dev:tab-manager
        |
        +-- apps/api          dev:local
        +-- apps/tab-manager  dev:local

  dev:tab-manager:ui
        |
        +-- apps/tab-manager  dev:local

  dev:api
        |
        +-- apps/api          dev:local

apps/*/package.json
  dev
  dev:local
```

## Implementation Plan

### Phase 1: Normalize Scripts

- [x] **1.1** Add `scripts/dev.ts` as a small Bun process orchestrator.
- [x] **1.2** Replace root `dev` with `bun run dev:tab-manager`.
- [x] **1.3** Add root `dev:api`, `dev:tab-manager`, and `dev:tab-manager:ui`.
- [x] **1.4** Remove `dev:remote` scripts from app packages.
- [x] **1.5** Do not add `dev:all`.

### Phase 2: Document the Contract

- [x] **2.1** Update the root README with the new root workflow.
- [x] **2.2** Update `apps/tab-manager/README.md` to explain local and UI-only modes.
- [x] **2.3** Update `apps/api/README.md` to clarify that remote database commands are admin operations, not dev mode.
- [x] **2.4** Remove stale `dev:remote` references from app READMEs.

### Phase 3: Prove the Workflows

- [x] **3.1** Run `bun run scripts/dev.ts unknown` and confirm invalid workflows fail clearly.
- [x] **3.2** Run JSON/script checks to confirm no `dev:remote` scripts remain.
- [x] **3.3** Run typechecks for `apps/api` and `apps/tab-manager`.

## Testing Plan

Automated checks:

```bash
bun run scripts/dev.ts unknown
bun run --cwd apps/api typecheck
bun run --cwd apps/api test
bun run --cwd apps/tab-manager typecheck
bun run --cwd apps/tab-manager build
```

Manual checks:

```txt
1. Run bun dev from the root.
2. Confirm API starts on localhost:8787.
3. Confirm WXT writes apps/tab-manager/.output/chrome-mv3-dev.
4. Load that extension in Chrome.
5. Sign in.
6. Confirm WebSocket sync connects.
7. Save a tab, reload the extension, and confirm local state returns.
```

## Notes

There is still room for a future production smoke command, but it should be designed as a release check, not resurrected as `dev:remote`.

## Review

**Completed**: 2026-05-11
**Branch**: codex/5028-auth-bearer-main-sync

### Summary

Root `dev` now starts the local Tab Manager workflow through `scripts/dev.ts`, which runs API and Tab Manager together with labeled output. App-level dev scripts are local-only, and `dev:remote` has been removed from app packages and current READMEs.

### Deviations from Spec

- Removed `dev:all` entirely instead of preserving it. The old broad command was the confusion we wanted to remove.
- Removed `dev:core` and root `dev:local` during review because they were aliases around the same Tab Manager workflow.
- Did not add a production API smoke command. We can design one later when there is a release checklist that needs it.
- Fixed existing API scripts that used the wrong Bun `--cwd` shape while touching dev workflow commands.

### Verification

- `bun run scripts/dev.ts --help`
- `bun run scripts/dev.ts unknown`
- `bun run --cwd apps/api typecheck`
- `bun run --cwd apps/api test`
- `bun run --cwd apps/tab-manager typecheck`
- `bun run --cwd apps/tab-manager build`
