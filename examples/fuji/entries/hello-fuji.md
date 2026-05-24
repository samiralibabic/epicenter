---
id: 01HM0000000000000000000001
title: Hello Fuji
subtitle: A second entry to show one-file-per-row materialization
type: []
tags: ["example"]
pinned: false
date: 2026-05-22T00:00:00Z
createdAt: 2026-05-22T00:00:00Z
updatedAt: 2026-05-22T00:00:00Z
rating: 0
_v: 2
---

# Hello Fuji

The markdown materializer writes one file per row in the `entries` table.
The filename is derived from the row's `title` by `slugFilename('title')`.

The `id` in the front-matter is the stable workspace identifier (a ULID by
convention); the filename can change as the title changes. The daemon
reconciles the two when a file is renamed.

This file is sibling to `welcome.md`, both in the `entries/` directory.
Adding a third entry means adding a third file. Removing an entry means
deleting its file (the daemon picks up the change and applies the deletion
to the Y.Doc).
