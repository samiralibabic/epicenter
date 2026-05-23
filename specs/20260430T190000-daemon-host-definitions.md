# Daemon Host Definitions

**Date**: 2026-04-30
**Status**: Superseded
**Author**: AI-assisted
**Branch**: codex/daemon-transport-supervisor-integration

**Superseded By**: `20260501T114356-daemon-startup-boundary-and-route-definition-cleanup.md`

This spec records the host-definition design before the daemon route definition
cleanup. The current code uses `DaemonRouteDefinition`, `DaemonRuntime`,
`StartedDaemonRoute`, `peerDirectory`, `[Symbol.asyncDispose]`, and
`defineConfig({ daemon: { routes: [...] } })`.

## Overview

`epicenter.config.ts` should declare daemon host definitions, and `loadConfig(projectDir)` should start those definitions with project context to produce live daemon workspaces.

One sentence: config declares daemon host definitions, the loader injects project context, and app packages start live daemon workspaces only after that context exists.

## Motivation

### Current State

The previous explicit daemon config accepted already-open daemon workspaces or promises:

```ts
const projectDir = findEpicenterDir(import.meta.dir);

export default defineConfig({
	hosts: [
		openFuji({
			projectDir,
			getToken,
		}),
	],
});
```

Some app daemon factories also default `projectDir` from `findEpicenterDir()`:

```ts
export function openFuji({
	getToken,
	projectDir = findEpicenterDir(),
	clientID = hashClientId(projectDir),
}: OpenFujiDaemonOptions) {
	// Opens the live daemon workspace now.
}
```

This creates problems:

1. **Config opens runtime state too early**: importing config immediately constructs Y.Docs, sync attachments, materializers, and persistence.
2. **Daemon factories guess project context**: `findEpicenterDir()` defaults from `process.cwd()`, but `epicenter up -C <dir>` can load a config whose project differs from the shell cwd.
3. **Static host metadata is trapped behind runtime construction**: the loader cannot inspect routes, labels, or workspace ids without opening the workspace.
4. **Naming blurs definition and execution**: `openFuji()` in config looks like delayed setup, but it actually opens the workspace.

### Desired State

The normal config should be short and explicit about what it declares:

```ts
import { defineConfig } from '@epicenter/workspace/daemon';
import { defineFujiDaemon } from '@epicenter/fuji/daemon';

export default defineConfig({
	hosts: [
		defineFujiDaemon(),
	],
});
```

`defineFujiDaemon()` returns a host definition. It does not open Yjs, sync, SQLite, or markdown. The loader opens each definition later with `projectDir` and `configDir`.

```txt
epicenter up -C /vault
  |
  v
loadConfig('/vault')
  |
  +-- import /vault/epicenter.config.ts
  |
  +-- read hosts: DaemonHostDefinition[]
  |
  +-- start each host with { projectDir: '/vault', configDir: '/vault' }
      |
      v
    WorkspaceEntry[]
```

## Research Findings

### Config Shape in Other Tools

| Tool | Normal shape | Context-sensitive shape | Relevant pattern |
| --- | --- | --- | --- |
| Vite | `defineConfig({ plugins: [...] })` | `defineConfig(({ command, mode }) => ({ ... }))` | Loader context is passed by the framework only when config needs it |
| Astro | `defineConfig({ integrations: [sitemap()] })` | Integration hooks receive project config and command context | Integration factories capture user options, hooks run later |
| Next.js | Named top-level keys like `redirects()` and `rewrites()` | Async functions return route definitions | Top-level keys name separate project concerns |

Key finding: the common pattern is not "user code calls cwd helpers." The common pattern is "config declares definitions, and the framework resolves context."

Implication: Epicenter should use a top-level `hosts` key and app-provided host definition factories. It should not require users to write `findEpicenterDir(import.meta.dir)` in normal configs.

Sources:

- Vite config: https://vite.dev/config/
- Vite plugin API: https://vite.dev/guide/api-plugin.html
- Astro integrations: https://docs.astro.build/es/guides/integrations/
- Next.js rewrites: https://nextjs.org/docs/pages/api-reference/config/next-config-js/rewrites

## Design Principles

### Naming Rule

Use `define` for delayed definitions. Use `open` for immediate runtime construction.

```txt
defineConfig()  -> returns config object
defineDaemon()           -> returns host definition
defineFujiDaemon()       -> returns Fuji host definition
definition.start()       -> starts live daemon workspace under project context
```

This keeps currying approachable:

```ts
defineFujiDaemon()
```

The line above is safe in config because it only creates metadata and stores user options. It does not open the daemon. Passing `getToken` is still supported for custom deployments, but the default comes from `@epicenter/auth/node`.

### Options Destructuring

All public functions should take one options object and destructure it in the function signature.

```ts
export function defineFujiDaemon({
	route = DEFAULT_FUJI_DAEMON_ROUTE,
	apiUrl = EPICENTER_API_URL,
	getToken = createCredentialTokenGetter({ serverOrigin: apiUrl }),
	peer = defaultFujiDaemonPeer(),
	webSocketImpl,
}: DefineFujiDaemonOptions = {}): DaemonHostDefinition {
	// ...
}
```

Avoid `options.route` style inside the body unless forwarding an opaque options object is the whole point. The call site and the signature should show the API.

### Static vs Runtime Surface

Host definitions carry cheap, inspectable facts. Daemon workspaces carry live runtime resources.

```txt
DaemonHostDefinition
  route
  title
  description
  workspaceId
  start()

DaemonWorkspace
  actions
  sync
  presence
  rpc
  dispose
```

That split lets future commands inspect hosts without opening databases or connecting sync.

## Target API

### Workspace Package Types

```ts
import type { MaybePromise, AbsolutePath, ProjectDir } from '@epicenter/workspace';
import type { Actions } from '@epicenter/workspace';
import type {
	PeerPresenceAttachment,
	SyncAttachment,
	SyncRpcAttachment,
} from '@epicenter/workspace';

export const EPICENTER_CONFIG = Symbol.for('epicenter.daemon-config');
export const EPICENTER_DAEMON_HOST = Symbol.for('epicenter.daemon-host');

export type DaemonRouteContext = {
	projectDir: ProjectDir;
	configDir: AbsolutePath;
};

export type DaemonWorkspace = {
	[Symbol.dispose](): void;
	readonly actions: Actions;
	readonly sync?: SyncAttachment;
	readonly presence?: PeerPresenceAttachment;
	readonly rpc?: SyncRpcAttachment;
	readonly [key: string]: unknown;
};

export type DaemonHostDefinition = {
	readonly [EPICENTER_DAEMON_HOST]: true;
	readonly route: string;
	readonly title?: string;
	readonly description?: string;
	readonly workspaceId?: string;
	start(options: DaemonRouteContext): MaybePromise<DaemonWorkspace>;
};

export type EpicenterConfig = {
	readonly [EPICENTER_CONFIG]: true;
	readonly hosts: readonly DaemonHostDefinition[];
};
```

### `defineDaemon`

`defineDaemon()` is the single helper for app packages to create host definitions.

```ts
export type DefineDaemonOptions = {
	route: string;
	title?: string;
	description?: string;
	workspaceId?: string;
	start(options: DaemonRouteContext): MaybePromise<DaemonWorkspace>;
};

export function defineDaemon({
	route,
	title,
	description,
	workspaceId,
	start,
}: DefineDaemonOptions): DaemonHostDefinition {
	return Object.freeze({
		[EPICENTER_DAEMON_HOST]: true,
		route,
		title,
		description,
		workspaceId,
		start,
	});
}
```

Route validation can happen either in `defineDaemon()` or in `loadConfig()`. The loader must keep validation either way because configs can still import inline objects or old data during migration.

### `defineConfig`

The top-level config helper should take an object with `hosts`.

```ts
export type DefineEpicenterConfigOptions = {
	hosts: readonly DaemonHostDefinition[];
};

export function defineConfig({
	hosts,
}: DefineEpicenterConfigOptions): EpicenterConfig {
	return Object.freeze({
		[EPICENTER_CONFIG]: true,
		hosts: Object.freeze([...hosts]),
	});
}
```

The object shape is deliberate. It leaves room for future project-level keys without overloading an array.

```ts
export default defineConfig({
	hosts: [defineFujiDaemon()],
});
```

Do not add extra top-level keys in this spec. The shape permits them later, but the first implementation should keep the surface narrow.

Likely future keys:

| Key | Meaning | Add now? |
| --- | --- | --- |
| `name` | Human label for `ps`, logs, or UI surfaces | No |
| `hosts` | Daemon host definitions | Yes |
| `paths` | Project-level path overrides for `.epicenter` layout | No |
| `plugins` | Config-level extension hooks | No |

## App Package Pattern

### Fuji Public API

The app daemon subpath should expose a definition helper, a runtime opener, and action connector helpers.

```ts
export const DEFAULT_FUJI_DAEMON_ROUTE = 'fuji';
export const FUJI_WORKSPACE_ID = 'epicenter.fuji';

export type DefineFujiDaemonOptions = {
	route?: string;
	getToken?: () => string | null | Promise<string | null>;
	peer?: PeerDescriptor;
	apiUrl?: string;
	webSocketImpl?: WebSocketImpl;
};

export function defineFujiDaemon({
	route = DEFAULT_FUJI_DAEMON_ROUTE,
	apiUrl = EPICENTER_API_URL,
	getToken = createCredentialTokenGetter({ serverOrigin: apiUrl }),
	peer = defaultFujiDaemonPeer(),
	webSocketImpl,
}: DefineFujiDaemonOptions = {}) {
	return defineDaemon({
		route,
		title: 'Fuji',
		description: 'Fuji daemon workspace',
		workspaceId: FUJI_WORKSPACE_ID,
		start: ({ projectDir }) => {
			const doc = openFujiDoc({ clientID: hashClientId(projectDir) });
			const sync = attachSync(doc, {
				url: websocketUrl(`${apiUrl}/workspaces/${doc.ydoc.guid}`),
				getToken,
				webSocketImpl,
			});
			const presence = sync.attachPresence({ peer });
			const rpc = sync.attachRpc(doc.actions);

			return {
				actions: doc.actions,
				sync,
				presence,
				rpc,
				[Symbol.dispose]() {
					doc[Symbol.dispose]();
				},
			} satisfies DaemonWorkspace;
		},
	});
}
```

The token default lives in `@epicenter/workspace/node`, not `@epicenter/cli`.
That keeps machine-local session storage available to app daemon packages
without making workspace configuration import the CLI package.

### Fuji Runtime Start

The `start` callback requires the project root and an explicit token source. It should not call `findEpicenterDir()` and should not use `import.meta.dir`.

`configDir` stays on `DaemonRouteContext`, not on app-level openers. Custom `defineDaemon()` hosts can use it for config-relative assets, but app daemons should not forward it until they actually need it.

### Script Helper

Script helpers are allowed to discover from cwd because they are user-invoked entrypoints.

```ts
export function connectFujiDaemonActions({
	route = DEFAULT_FUJI_DAEMON_ROUTE,
	projectDir,
}: {
	route?: string;
	projectDir?: ProjectDir;
} = {}) {
	return connectDaemonActions<ReturnType<typeof createFujiActions>>({
		route,
		projectDir,
	});
}
```

This preserves the distinction:

```txt
Config loading:
  projectDir comes from loadConfig(projectDir)

Scripts:
  projectDir may come from findEpicenterDir(process.cwd())
```

## Loader Behavior

The loader should import `epicenter.config.ts`, validate the `defineConfig({ hosts })` result, validate host definitions, and only then start hosts.

```txt
loadConfig(targetDir)
  |
  +-- projectDir = resolve(targetDir) as ProjectDir
  +-- configPath = join(projectDir, 'epicenter.config.ts')
  +-- configDir = dirname(configPath)
  +-- import configPath
  +-- validate EPICENTER_CONFIG
  +-- validate hosts[]
  +-- validate duplicate routes before opening
  +-- for each host:
        workspace = await host.start({ projectDir, configDir })
        validate DaemonWorkspace
  +-- return LoadConfigResult
```

Starting after duplicate route validation matters. If two definitions both declare `route: 'fuji'`, the loader should fail without starting either workspace.

### Loader Error Model

Add or revise errors around the new split:

| Error | When |
| --- | --- |
| `InvalidConfig` | Default export is not `defineConfig({ hosts })` |
| `EmptyConfig` | `hosts` is empty |
| `InvalidHostDefinition` | A host definition is missing `route` or `start` |
| `InvalidRoute` | A definition route is invalid |
| `DuplicateRoute` | Two definitions declare the same route |
| `HostFailed` | `host.start()` rejects |
| `InvalidHost` | `host.start()` resolves to something that is not a `DaemonWorkspace` |

## Before and After

### Before

```ts
import { openFuji } from '@epicenter/fuji/daemon';
import { defineConfig } from '@epicenter/workspace/daemon';
import { findEpicenterDir } from '@epicenter/workspace/node';

const projectDir = findEpicenterDir(import.meta.dir);

export default defineConfig({
	hosts: [
		openFuji({
			projectDir,
			getToken,
		}),
	],
});
```

### After

```ts
import { defineFujiDaemon } from '@epicenter/fuji/daemon';
import { defineConfig } from '@epicenter/workspace/daemon';

export default defineConfig({
	hosts: [defineFujiDaemon()],
});
```

### Custom Route

```ts
export default defineConfig({
	hosts: [
		defineFujiDaemon({
			route: 'blog',
		}),
	],
});
```

The matching script must also opt into the custom route:

```ts
const blog = await connectFujiDaemonActions({
	route: 'blog',
});
```

## E2E Shape

The main end-to-end test should prove that `-C` works even when cwd is elsewhere.

```ts
test('up injects projectDir into daemon definitions instead of using cwd', async () => {
	const projectDir = makeFixtureProject({
		config: `
			import { defineConfig } from '@epicenter/workspace/daemon';
			import { defineDaemon } from '@epicenter/workspace/daemon';

			export default defineConfig({
				hosts: [
					defineDaemon({
						route: 'demo',
						title: 'Demo',
						start: ({ projectDir }) => ({
							actions: {
								paths: {
									projectDir: defineQuery({
										handler: () => projectDir,
									}),
								},
							},
							[Symbol.dispose]() {},
						}),
					}),
				],
			});
		`,
	});

	const unrelatedCwd = mkdtempSync(join(tmpdir(), 'ep-unrelated-cwd-'));

	const up = await spawnUp({
		cwd: unrelatedCwd,
		args: ['up', '-C', projectDir],
	});

	const result = await runCli({
		cwd: unrelatedCwd,
		args: ['run', '-C', projectDir, 'demo.paths.projectDir'],
	});

	expect(result.stdout).toContain(projectDir);
	await up.stop();
});
```

Add unit-level loader tests too:

```txt
loadConfig
  - accepts defineConfig({ hosts })
  - rejects old raw arrays once migration is over
  - rejects duplicate definition routes before calling start()
  - passes { projectDir, configDir } into start()
  - disposes already-started hosts when a later start rejects
  - exposes host metadata in LoadConfigResult if needed by list or ps
```

## Implementation Plan

### Phase 1: Workspace Daemon Types

- [x] **1.1** Add `EPICENTER_DAEMON_HOST`, `DaemonHostDefinition`, `DaemonRouteContext`, `DefineDaemonOptions`, and `defineDaemon()` under `packages/workspace/src/daemon/types.ts`.
- [x] **1.2** Change `EpicenterConfig` to use object shape `{ hosts }`.
- [x] **1.3** Keep `DaemonWorkspace` as the started runtime contract.
- [x] **1.4** Export the new helpers from `@epicenter/workspace/daemon`.

### Phase 2: Config Loader

- [x] **2.1** Update `packages/cli/src/load-config.ts` to read `defineConfig({ hosts })`.
- [x] **2.2** Validate all host definitions and routes before calling `start()`.
- [x] **2.3** Pass `{ projectDir, configDir }` into each host definition.
- [x] **2.4** Keep cleanup behavior: if host N fails after hosts 0 through N-1 opened, dispose the opened hosts.
- [x] **2.5** Update loader errors and tests around definitions vs opened hosts.

### Phase 3: App Daemon Packages

- [x] **3.1** Rename public app config helpers to `defineFujiDaemon`, `defineHoneycrispDaemon`, `defineOpensidianDaemon`, and `defineZhongwenDaemon`.
- [x] **3.2** Rename or preserve low-level runtime openers as `openFujiDaemon`, `openHoneycrispDaemon`, `openOpensidianDaemon`, and `openZhongwenDaemon`.
- [x] **3.3** Make low-level runtime openers require `DaemonRouteContext`.
- [x] **3.4** Remove `findEpicenterDir()` defaults from daemon openers.
- [x] **3.5** Keep script helpers defaulting through `connectDaemonActions()`.

### Phase 4: Config Call Sites

- [x] **4.1** Migrate playground configs to `defineConfig({ hosts: [...] })`.
- [x] **4.2** Migrate example configs to `defineDaemon()` or app-specific `define*Daemon()` helpers.
- [x] **4.3** Update docs that show `defineConfig({ hosts: [...] })`.
- [x] **4.4** Keep direct script imports away from `epicenter.config.ts`.

### Phase 5: E2E and Regression Coverage

- [ ] **5.1** Add the `-C` from unrelated cwd regression test.
- [x] **5.2** Add duplicate route test that proves `start()` is not called.
- [ ] **5.3** Add host metadata test that proves route/title/workspaceId can be read before open.
- [x] **5.4** Run the focused CLI, workspace daemon, and app integration tests.

## Design Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Top-level config shape | `defineConfig({ hosts })` | Names the project-level concern and leaves room for future keys |
| App config helper verb | `define*Daemon()` | Definition is delayed and side-effect free |
| Runtime opener verb | `open*Daemon()` | Opening constructs live resources now |
| Shared helper | `defineDaemon()` | Centralizes branding and the host definition shape |
| Project context owner | `loadConfig(projectDir)` | The loader is the only layer that knows which project is being loaded |
| Context fields | `{ projectDir, configDir }` | `projectDir` anchors `.epicenter`; `configDir` supports config-relative assets |
| Static host metadata | On `DaemonHostDefinition` | Enables validation and introspection without opening runtime state |
| Runtime attachments | On `DaemonWorkspace` | Sync, presence, RPC, and actions exist only after starting |
| `findEpicenterDir()` in daemon openers | Remove | Daemon packages should not guess from cwd |
| `findEpicenterDir()` in scripts | Keep indirectly | Scripts are user entrypoints, so cwd is legitimate user intent |

## Edge Cases

### Duplicate Routes

Duplicate routes should fail before any host opens.

```ts
export default defineConfig({
	hosts: [
		defineFujiDaemon({ route: 'notes' }),
		defineHoneycrispDaemon({ route: 'notes' }),
	],
});
```

Expected result: `DuplicateRoute` and no Y.Doc construction.

### Config-Relative Assets

Some hosts may need files next to `epicenter.config.ts`.

```ts
defineDaemon({
	route: 'docs',
	start: ({ configDir, projectDir }) =>
		openDocsDaemon({
			projectDir,
			contentDir: join(configDir, 'content'),
		}),
});
```

This is why `configDir` belongs in `DaemonRouteContext` even if current app daemons only need `projectDir`.

### Custom Routes

Custom routes remain a local deployment choice. App-specific action connectors should default to the package route but accept override.

```ts
defineFujiDaemon({ route: 'blog' });
connectFujiDaemonActions({ route: 'blog' });
```

### Conditional Hosts

Do not add falsy host entries in the first implementation.

Astro ignores falsy integrations, which is convenient, but Epicenter should keep host validation strict until the definition model is stable. Conditional hosts can use normal JavaScript:

```ts
const hosts = [
	defineFujiDaemon(),
	process.env.ENABLE_NOTES === '1'
		? defineHoneycrispDaemon()
		: undefined,
].filter((host): host is DaemonHostDefinition => host !== undefined);

export default defineConfig({ hosts });
```

## Resolved Questions

1. **Should raw array configs remain as a migration bridge?**
   - Resolution: no. The implemented API is object-only: `defineConfig({ hosts })`.

2. **Should host metadata include `actions` manifest before open?**
   - Context: route/title/workspaceId are cheap. Action manifests usually require constructed action objects.
   - Recommendation: do not include actions manifest in `DaemonHostDefinition` yet. Keep action discovery after open unless a later spec defines static action descriptors.

3. **Should `defineDaemon()` validate route immediately?**
   - Options: (a) validate in `defineDaemon()`, (b) validate in loader, (c) both.
   - Recommendation: both. `defineDaemon()` catches app bugs early; loader still protects against inline or stale definitions.

## Success Criteria

- [x] Normal config uses `defineConfig({ hosts: [defineFujiDaemon()] })`.
- [x] App daemon runtime openers require `projectDir` and do not call `findEpicenterDir()`.
- [x] `loadConfig(projectDir)` passes `{ projectDir, configDir }` into every host definition.
- [x] Duplicate routes are rejected before opening any host.
- [x] Host metadata can be inspected without opening a workspace.
- [x] Script helpers keep their cwd-based ergonomics.
- [x] Focused CLI, workspace daemon, and app integration tests pass.

## References

- `packages/workspace/src/daemon/types.ts`: add `defineDaemon`, host definition types, and object-shaped config.
- `packages/workspace/src/daemon/index.ts`: export the new daemon definition API.
- `packages/cli/src/load-config.ts`: open definitions with loader context.
- `packages/cli/src/load-config.test.ts`: update config loader coverage.
- `apps/fuji/src/lib/fuji/daemon.ts`: implement `defineFujiDaemon` and `openFujiDaemon` split.
- `apps/honeycrisp/src/lib/honeycrisp/daemon.ts`: same app daemon pattern.
- `apps/opensidian/src/lib/opensidian/daemon.ts`: same app daemon pattern.
- `apps/zhongwen/src/lib/zhongwen/daemon.ts`: same app daemon pattern.
- `packages/cli/test/e2e-up-cross-peer.test.ts`: add or adapt the `-C` regression test.
- `specs/20260430T150000-explicit-daemon-host-config.md`: prior spec this one refines.
