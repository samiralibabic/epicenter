# `@examples/fuji`

The canonical Epicenter project layout demonstrated against `@epicenter/fuji`.

## What this shows

One project, one workspace, defined inline in `epicenter.config.ts`. Table
data lives as markdown at the project root and is committed to git. Runtime
state (Yjs persistence, SQLite materializer) lives under `.epicenter/` and is
gitignored.

This example is the reference implementation of the layout spec at
`specs/20260522T220000-workspace-project-layout.md`. If the spec changes,
this example changes with it.

## Layout

```
examples/fuji/
├── package.json           dependencies (this file)
├── tsconfig.json          extends the repo base
├── epicenter.config.ts    REQUIRED. Marker + workspace definition.
├── .gitignore             Epicenter-managed (.epicenter/)
├── entries/               table data as markdown (committed)
│   ├── welcome.md
│   └── hello-fuji.md
└── .epicenter/            created on first daemon run; gitignored
    ├── yjs.db
    └── sqlite.db
```

## Run it

```sh
bun install
bun x epicenter daemon up -C examples/fuji
```

On first run the daemon creates `.epicenter/` and writes `yjs.db` and
`sqlite.db`. The markdown files in `entries/` are the source of truth; the
daemon reads them to populate the Yjs document (once markdown → Y.Doc
hydration lands; see §7.2 of the spec).

## Inspect the SQL mirror

```sh
sqlite3 examples/fuji/.epicenter/sqlite.db
sqlite> .tables
sqlite> SELECT id, title FROM entries;
```

The SQLite mirror is regenerable from `yjs.db`, which is regenerable from
the markdown in `entries/`. Anything under `.epicenter/` can be deleted; the
daemon will rebuild it on next run.

## Edit a note

Open `entries/welcome.md` in your editor and change the body. The daemon's
reverse watcher (see spec §7.2) picks up the change and applies it to the
Y.Doc, which propagates to the SQL mirror and to any connected peers.

You can also drive changes through the daemon's RPC actions. Use the CLI:

```sh
bun x epicenter run fuji.entries_get '{"id":"01HM0000000000000000000000"}' -C examples/fuji
```

The action set is defined by `@epicenter/fuji` and re-exposed through this
example's `epicenter.config.ts`.

## Add a new entry

Two equivalent ways:

1. **Write a markdown file.** Create `entries/my-new-entry.md` with the same
   front-matter shape as the existing examples. The daemon ingests it.
2. **Call a mutation.** Use the CLI's `run` subcommand to invoke the
   workspace's add action.

Both paths produce the same row in the `entries` table.

## What this example deliberately omits

- Auth and sync. The example is local-only; no `epicenter auth login` step.
- Browser or Tauri frontend. The example is daemon-only.
- Custom path overrides. Materializer paths use the spec's default
  (`.epicenter/sqlite.db` and `./entries/`).
- Multi-workspace orchestration. One workspace per project is the canonical
  shape; multi-workspace is a monorepo with sibling projects.

## See also

- `specs/20260522T220000-workspace-project-layout.md` for the full spec.
- `examples/notes-cross-peer/` for a two-peer sync demo (predates this layout).
- `apps/fuji/` for the full Tauri/Svelte app that consumes the same workspace.
