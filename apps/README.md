# Apps

Each app under `apps/` owns its hosted UI plus, when needed, one local daemon extension.

## Layout

```
apps/<app>/
├── daemon.ts        optional local daemon extension
├── workspace.ts     shared schema, branded IDs, opener, actions factory
├── src/             SvelteKit app
└── package.json     "exports": { ".": "./workspace.ts" }
```

The repo root `epicenter.config.ts` registers app daemon modules. `epicenter daemon up -C <repoRoot>` starts those configured routes; `apps/<app>/daemon.ts` is the local module each app can expose.

## Boundaries

`workspace.ts` is the sync contract. It defines table shapes, KV schemas, branded IDs, and shared openers. Forking that file means forking sync compatibility.

`daemon.ts` is the local extension. It opens the shared workspace with node-only attachments: machine auth, Yjs persistence, collaboration, SQLite and Markdown materializers, and daemon-exposed actions.

Browser code composes browser-only attachments around the same `open<App>Workspace(...)` opener. Scripts usually skip Yjs entirely: they read materialized files or SQLite and call daemon actions through `connectDaemonActions`.

## Adding a Daemon App

1. Add `apps/<app>/workspace.ts`.
2. Point `package.json` `exports["."]` at `./workspace.ts`.
3. Add `apps/<app>/daemon.ts` exporting `open<App>Daemon(ctx)` as a free factory. The project's `epicenter.config.ts` default-exports `defineWorkspace({ open: openXDaemon })` (single-workspace shape) or registers it under `defineConfig({ daemon: { routes: { ... } } })` (multi-route monorepo shape).
4. Run `epicenter daemon up -C <repoRoot>` and confirm the route appears in `epicenter list`.
