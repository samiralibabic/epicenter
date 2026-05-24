---
id: 01HM0000000000000000000000
title: Welcome to Fuji
subtitle: A canonical Epicenter project layout
type: []
tags: ["welcome"]
pinned: true
date: 2026-05-22T00:00:00Z
createdAt: 2026-05-22T00:00:00Z
updatedAt: 2026-05-22T00:00:00Z
rating: 0
_v: 2
---

# Welcome to Fuji

This file is the committed, human-editable source of truth for one entry in a
Fuji workspace. The daemon reads files like this on startup, hydrates the
in-memory Yjs document, and keeps the markdown and Yjs in sync as either side
changes.

You can edit this file in any editor. The daemon picks up the change and
applies it to the workspace. You can also drive edits through the daemon's
actions (queries and mutations defined by `@epicenter/fuji`). Either path
produces the same end state.

## Layout

The project's data layout is documented in `specs/20260522T220000-workspace-project-layout.md`:

- `epicenter.config.ts` is both the project marker and the workspace definition.
- `entries/` (this directory) holds the markdown source of truth.
- `.epicenter/` is the runtime cache (gitignored).

## Try it

    bun install
    bun x epicenter daemon up

The daemon materializes `.epicenter/yjs.db` and `.epicenter/sqlite.db` on
first run. Inspect the SQLite mirror with `sqlite3 .epicenter/sqlite.db` for
queryable access to the same data.
