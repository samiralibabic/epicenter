# Code-Composed Daemon Route Map

**Date**: 2026-05-20
**Status**: Implemented
**Author**: Braden + AI-assisted
**Supersedes**: daemon registration portions of `20260519T150000-epicenter-project-as-first-class.md`

## One Sentence

`epicenter.config.ts` is executable TypeScript project composition: it defines one project daemon with a route map, route keys own daemon route identity, daemon modules no longer repeat `route`, and `.epicenter/` remains generated project data.

## Overview

This spec keeps the recent project-config direction but changes the public daemon API from an array of imported modules to a route-keyed map of daemon definitions. The route name lives once, as the object key in `epicenter.config.ts`; daemon definitions carry behavior and options, not their own local address.

## Motivation

### Previous State

Before this spec, the branch used `epicenter.config.ts` as both project marker and route registry:

```ts
import { defineConfig } from '@epicenter/workspace';
import fuji from './workspaces/fuji/daemon.ts';
import honeycrisp from './workspaces/honeycrisp/daemon.ts';

export default defineConfig({
	routes: [fuji, honeycrisp],
});
```

Each daemon module repeats the route:

```ts
import { defineDaemonWorkspace } from '@epicenter/workspace/daemon';

export default defineDaemonWorkspace({
	route: 'fuji',
	async open(ctx) {
		return runtime;
	},
});
```

This creates problems:

1. **Route identity is repeated**: `workspaces/fuji`, the config import name, the module `route`, docs, and scripts can disagree.
2. **The array hides local addresses**: `routes: [fuji, honeycrisp]` does not show the route names without opening the imported values.
3. **Materializer policy has no natural home**: project-specific output paths such as `./notes` or `./attachments` belong next to daemon registration, not in generated `.epicenter/` data.
4. **Folder routing was too implicit**: `workspaces/*/daemon.ts` made install layout ergonomic, but it treated file presence as daemon enablement.

### Desired State

Use a route map:

```ts
import { defineConfig } from '@epicenter/workspace';
import fuji from './workspaces/fuji/daemon.ts';
import honeycrisp from './workspaces/honeycrisp/daemon.ts';

export default defineConfig({
	daemon: {
		routes: {
			fuji,
			honeycrisp,
		},
	},
});
```

Daemon modules are route-agnostic:

```ts
export default defineDaemonWorkspace({
	async open(ctx) {
		// ctx.route is "fuji", supplied by the config key.
		return runtime;
	},
});
```

The project folder stays simple:

```txt
My Vault/
  epicenter.config.ts
  notes/
  attachments/
  .epicenter/
    yjs/
    sqlite/
    md/
```

## Research Findings

### Local History

The repository has tried three nearby shapes:

| Shape | Example | Finding |
| --- | --- | --- |
| Folder-routed discovery | `workspaces/fuji/daemon.ts` | Good install layout, but too implicit for trusted local code. |
| Array config registry | `routes: [fuji]` | Explicit enablement, but route identity moves into daemon modules. |
| Route-map config | `routes: { fuji: defineFujiDaemon() }` | Explicit enablement and route identity in one place. |

**Key finding**: the route map is the best synthesis. It preserves explicit project composition while removing `route: 'fuji'` from daemon modules.

### External Lessons

| Project | Relevant pattern | Lesson for Epicenter |
| --- | --- | --- |
| Cloudflare Workers | Config is the control plane for runtime concerns. | Copy config-owned runtime composition and policy. Do not require pure JSON if local TypeScript composition is valuable. |
| Hono | Code-first app composition with mounted routes. | Copy route maps inside trusted project code. |
| Better Auth | Plugins are composed in TypeScript config. | Copy typed extension helpers with options. |
| WXT | File conventions are ergonomic entrypoint defaults. | Keep `workspaces/<name>/daemon.ts` as convention, not as registry. |
| SvelteKit | Folder route identity works when routing is the framework's domain. | Avoid blindly copying file routing for trusted daemon execution. |
| Tauri | Capabilities and local power need explicit control. | Daemon enablement should be visible in project config. |
| Drizzle | TypeScript config points tooling at runtime artifacts. | Use typed config for project policy and output directories. |
| Yjs | Document identity is not route identity. | Keep Y.Doc `guid` in workspace code and daemon route in config. |

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Project marker | 2 coherence | Keep `epicenter.config.ts` | The existing project-root work already moved toward a file marker and it gives future policy a home. |
| Project data | 2 coherence | Keep `.epicenter/` generated | Yjs update logs, SQLite materializers, and caches are managed project data, not config or daemon runtime files. |
| Daemon process count | 2 coherence | One process per project | One auth client, one socket, one lease, one lifecycle. |
| Daemon route count | 2 coherence | Many routes inside one process | Separate action namespaces and runtimes without separate daemons. |
| Route identity | 2 coherence | Route map keys | The key is visible, unique by construction, and removes `route` from daemon modules. |
| Config value style | 3 taste | Compose daemon definitions directly | This is the most TypeScript-native shape and matches the local trusted-project model. |
| Path strings | 3 taste | Use only for user-owned output paths | Strings like `./notes` are project policy. Strings for daemon modules are less idiomatic than imports. |
| Markdown materializer output | 2 coherence | Configurable outside `.epicenter/` | Markdown can be a user-owned, git-committed projection. |
| Workspace source folders | 3 taste | Convention only | `workspaces/` can organize local source, but it is not the daemon registry. |

## Architecture

```txt
epicenter.config.ts
  daemon.routes
    fuji -> DaemonWorkspaceDefinition
    honeycrisp -> DaemonWorkspaceDefinition
        |
        v
epicenter daemon up
  load config
  validate route keys
  claim project lease
  create machine auth
  open each daemon definition with ctx.route
        |
        v
one daemon process
  /list   -> fuji.*, honeycrisp.*
  /run    -> route-key dispatch
  /peers  -> all route devices
        |
        v
.epicenter/
  generated yjs, sqlite, markdown, and cache data

project folders like ./notes and ./attachments
  user-owned projections and files when configured
```

## Public API

### Config

```ts
export type EpicenterConfig = {
	daemon?: {
		routes?: Record<string, DaemonWorkspaceDefinition>;
	};
};

export function defineConfig(config: EpicenterConfig): EpicenterConfig {
	return config;
}
```

### Daemon Definition

```ts
export type DaemonWorkspaceDefinition<
	TRuntime extends DaemonRuntime = DaemonRuntime,
> = {
	open(ctx: DaemonWorkspaceContext): MaybePromise<TRuntime>;
};

export function defineDaemonWorkspace<TRuntime extends DaemonRuntime>(
	definition: DaemonWorkspaceDefinition<TRuntime>,
): DaemonWorkspaceDefinition<TRuntime> {
	return definition;
}
```

### Startup

```ts
export type StartDaemonWorkspaceAppsOptions = {
	projectDir: ProjectDir | string;
	auth: AuthClient;
	routes: Readonly<Record<string, DaemonWorkspaceDefinition>>;
};
```

Startup validates route keys, then passes the key into context:

```ts
for (const [route, definition] of Object.entries(routes)) {
	const ctx: DaemonWorkspaceContext = {
		projectDir,
		route,
		clientId: hashClientId(projectDir),
		installationId: `${route}-daemon`,
		attachEncryption,
		openWebSocket,
	};
	await definition.open(ctx);
}
```

## Project Layout

### Package Daemon Helper

```ts
// @epicenter/fuji/daemon
export default defineDaemonWorkspace({
	async open(ctx) {
		const workspace = openFujiWorkspace(ctx.attachEncryption, {
			clientId: ctx.clientId,
		});

		return attachDaemonInfrastructure(workspace.ydoc, {
			projectDir: ctx.projectDir,
			openWebSocket: ctx.openWebSocket,
			installationId: ctx.installationId,
			actions: workspace.actions,
		});
	},
});
```

### Consumer Project

```txt
My Vault/
  epicenter.config.ts
  notes/
  attachments/
  .epicenter/
    yjs/
    sqlite/
    md/
```

```ts
// epicenter.config.ts
import { defineConfig } from '@epicenter/workspace';
import fuji from './workspaces/fuji/daemon.ts';

export default defineConfig({
	daemon: {
		routes: {
			fuji,
		},
	},
});
```

## Rejected Alternatives

### Keep `routes: [fuji]`

Rejected because route identity must live inside daemon modules:

```ts
export default defineDaemonWorkspace({
	route: 'fuji',
	open(ctx) {},
});
```

That makes the module less reusable and keeps drift alive.

### Return to folder-only discovery

Rejected because file presence should not be the final trusted-code enablement model. A folder convention is useful for organization, but config should say what the project daemon runs.

### Use path strings for daemon entries

Rejected for now because the project is trusted TypeScript code and imports give better editor ergonomics. Revisit if Epicenter needs static route inspection without executing config.

### Use multiple daemon processes by default

Rejected for now because the default user model should be one daemon per project. Multiple processes can come later for isolation, but routes inside one process solve the current namespace problem with less machinery.

## Implementation Plan

### Phase 1: Type Surface

- [x] **1.1** Change `EpicenterConfig` from top-level route arrays to `daemon?: { routes?: Record<string, DaemonWorkspaceDefinition> }`.
- [x] **1.2** Use `DaemonWorkspaceDefinition` as the only current route definition type.
- [x] **1.3** Remove `route` from `defineDaemonWorkspace` input.
- [x] **1.4** Update runtime validation to accept a route record whose values have `open`.

### Phase 2: Startup

- [x] **2.1** Update `runUp` to pass `config.daemon?.routes ?? {}`.
- [x] **2.2** Update `startDaemonWorkspaceApps` to validate `Object.keys(routes)`.
- [x] **2.3** Update `openOneDaemonRoute` to accept `{ route, definition }`.
- [x] **2.4** Keep existing partial-open cleanup and signed-out auth behavior.

### Phase 3: First-Party Daemons

- [x] **3.1** Remove `route` from `apps/fuji/daemon.ts`, `apps/honeycrisp/daemon.ts`, `apps/opensidian/daemon.ts`, and `apps/zhongwen/daemon.ts`.
- [x] **3.2** Add or preserve package helper functions where useful, without putting route identity inside daemon modules.
- [x] **3.3** Keep existing materializer behavior inside daemon helpers for this migration.

### Phase 4: Tests And Docs

- [x] **4.1** Update config tests for route maps and invalid values.
- [x] **4.2** Update startup tests for invalid route keys.
- [x] **4.3** Update CLI fixtures from `routes: [demo]` to `daemon.routes.demo`.
- [x] **4.4** Update `packages/cli/README.md` and `docs/scripting.md`.
- [x] **4.5** Add a regression test that daemon `ctx.route` comes from the config key.

### Phase 5: Cleanup

- [x] **5.1** Remove stale `route` wording from daemon module docs.
- [x] **5.2** Grep for `route:` in daemon definitions and justify remaining hits.
- [x] **5.3** Decide whether to keep a backward-compatible top-level `routes` array for one release or make this a clean break.

## Validation

```bash
bun test packages/workspace/src/config
bun test packages/workspace/src/workspace-apps
bun test packages/cli/src/commands/up.test.ts
bun test packages/cli
rg "routes: \\[|route: 'fuji'|route: 'honeycrisp'|route: 'opensidian'|route: 'zhongwen'|folder-routed daemon"
```

Any remaining `route:` in daemon registration should be either removed or explained as non-daemon route data.

## Open Questions

1. Resolved: top-level `routes` is not kept as a compatibility alias.
2. Should `defineDaemonWorkspace` be renamed to `defineDaemonRoute` or `defineDaemonExtension`, or is the existing name good enough until the product language settles?
3. Future decision: if route-specific options return, app helper closures own them. Startup only supplies host context.
4. Resolved for this migration: first-party Markdown materializers keep existing `.epicenter/md/<workspaceId>` behavior.

## Review

**Completed**: 2026-05-20
**Branch**: `codex/api-session-clean-break`

### Summary

Implemented the clean route-map break. Project configs now register daemon definitions under `daemon.routes`, route identity comes from the object key, and startup injects `ctx.route` from that key.

### Deviations from Spec

- Removed the stale compatibility alias after the route-map break made `DaemonWorkspaceDefinition` the only current definition type.
- Did not change Markdown materializer output options; first-party daemons keep the existing `.epicenter/md/<workspaceId>` behavior.
- Added `./daemon` package exports for first-party daemon helper imports.
- `docs/scripting.md` did not need a config change because its remaining `route: 'fuji'` example is for `connectDaemonActions`, not daemon registration.

### Follow-up Work

- Several older archived specs still show the previous array shape. They were left as historical records.

## Execution Prompt

```txt
You are implementing `specs/20260520T120000-code-composed-daemon-route-map.md` in `/Users/braden/Code/epicenter`.

Follow `AGENTS.md`. Use bun. Do not use npm, yarn, pnpm, or node commands. Do not use direct console.* in library code. Do not use em dashes or en dashes in prose, comments, strings, or docs.

Goal:
Change daemon registration from the current explicit array shape to a code-composed route map:

  export default defineConfig({
    daemon: {
      routes: {
        fuji: defineFujiDaemon(),
        honeycrisp: defineHoneycrispDaemon(),
      },
    },
  });

Key API rules:
- Route identity comes from the `daemon.routes` object key.
- `defineDaemonWorkspace` inputs must not include `route`.
- `ctx.route` is supplied by startup from the route key.
- `.epicenter/` remains generated project data only.
- `workspaces/` is only an organization convention, not daemon discovery.
- One daemon process can host many routes.

Start by reading:
- AGENTS.md
- specs/20260520T120000-code-composed-daemon-route-map.md
- packages/workspace/src/config/define-config.ts
- packages/workspace/src/config/load-project-config.ts
- packages/workspace/src/workspace-apps/start-daemon-workspace-apps.ts
- packages/workspace/src/daemon/define-daemon-workspace.ts
- packages/workspace/src/workspace-apps/errors.ts
- packages/cli/src/commands/up.ts
- packages/cli/README.md
- docs/scripting.md
- first-party daemon files under apps/*/daemon.ts
- CLI fixtures under packages/cli/test/fixtures

Implementation plan:
1. Update config types and runtime schema to `daemon.routes` record.
2. Remove `route` from daemon definition modules.
3. Update daemon startup to iterate route entries and pass the key as `ctx.route`.
4. Update tests and fixtures.
5. Update docs.
6. Re-read every touched file before final response and run the focused bun tests from the spec.

Be careful:
- Do not keep both array and map paths unless you intentionally choose a compatibility phase and document it.
- Do not move materializer outputs out of `.epicenter/` unless the spec explicitly calls for an option and tests.
- Do not add generated install registries under `.epicenter/`.
- Preserve existing teardown behavior when one route opens and another fails.

Final response:
Summarize the API shape, list changed files, and report test results.
```
