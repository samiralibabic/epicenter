# Explicit Daemon Host Config

**Date**: 2026-04-30
**Status**: Superseded
**Author**: AI-assisted
**Branch**: codex/daemon-transport-supervisor-integration

**Superseded By**: `20260501T114356-daemon-startup-boundary-and-route-definition-cleanup.md`

This spec records the host-definition step that led to the current daemon route
definition API. The active code no longer uses top-level `hosts`; project config
uses `defineConfig({ daemon: { routes: [defineFujiDaemon()] } })`, and app
helpers return `DaemonRouteDefinition` objects with `{ route, start }`.

## Overview

`epicenter.config.ts` should stop acting like a reusable client module. It should default-export an explicit list of hosted daemon workspaces.

One sentence: config hosts app-provided daemon workspaces, packages export APIs.

## Motivation

### Current State

Today the loader imports `epicenter.config.ts`, scans named exports, and accepts any value that looks like a workspace:

```ts
export const fuji = openFuji({
	getToken,
	peer,
});
```

The export name becomes the daemon route prefix:

```txt
fuji.entries.create
```

This creates problems:

1. **Config pretends to be an API module**: scripts are encouraged to import config exports, even though scripts can import package factories or daemon action helpers.
2. **Daemon slots leak into app objects**: `actions`, `sync`, `presence`, `rpc`, and `whenReady` become reserved names on anything the loader sees.
3. **Discovery is too implicit**: named export scanning makes the loader guess what the user meant to host.
4. **Daemon factories expose too much**: Fuji daemon returns `{ ...doc, yjsLog, sync, presence, rpc, sqlite, markdown }`, even though only a few fields are daemon surface.

### Desired State

`epicenter.config.ts` is a host declaration:

```ts
import { defineFujiDaemon } from '@epicenter/fuji/daemon';
import { defineConfig } from '@epicenter/workspace/daemon';
import { findEpicenterDir } from '@epicenter/workspace/node';

const projectDir = findEpicenterDir(import.meta.dir);
const getToken = async () =>
	(await sessions.load(EPICENTER_API_URL))?.accessToken ?? null;

export default defineConfig({
	hosts: [defineFujiDaemon({ getToken })],
});
```

`defineFujiDaemon()` returns a `DaemonHostDefinition` with a default daemon route of `fuji`.

Scripts import app-specific daemon action helpers instead of importing config route constants:

```ts
// scripts/create-entry.ts
import { connectFujiDaemonActions } from '@epicenter/fuji/daemon';

const fuji = await connectFujiDaemonActions();
```

## Naming Model

Three identifiers stay separate:

| Name | Example | Owner | Meaning |
| --- | --- | --- | --- |
| Route key | `fuji` | App daemon subpath | Local daemon address used by `epicenter run fuji.entries.create` |
| Y.Doc guid | `epicenter.fuji` | Fuji document factory | Durable workspace identity used by storage and sync |
| Yjs clientID | `hashClientId(projectDir)` | Fuji daemon factory | Writer identity for this process inside Yjs updates |

The route key and Y.Doc guid often look related, but they should not be the same source of truth. The Y.Doc guid is a product-level document identity. The route key is a host-level address. Collapsing them would make local deployment naming change storage and sync identity, which is the wrong coupling.

This separation is still useful when Fuji is only mounted once. `defineFujiDaemon()` owns the default route, and the package owns the document identity. The route is a local host address, not the durable sync or storage id.

## Rejected: Record-Key Routes

Record-key routes were considered and rejected. In this shape, config keys own route names:

```ts
export default defineConfig({
	fuji: openFuji({ projectDir, getToken }),
});
```

Then scripts need a route string. To avoid drift, config can export constants:

```ts
export const routes = {
	fuji: 'fuji',
} as const;

export default defineConfig({
	[routes.fuji]: openFuji({ projectDir, getToken }),
});
```

That avoids putting a route on the hosted workspace, but it reintroduces config imports in scripts:

```ts
import { routes } from '../epicenter.config';

const fuji = await connectDaemonActions<FujiActions>({
	route: routes.fuji,
});
```

The array shape is the chosen direction because app daemon subpaths can provide the default route and the typed connector:

```ts
export default defineConfig({
	hosts: [defineFujiDaemon({ getToken })],
});
```

If a project intentionally mounts Fuji under a custom route, the app daemon factory can still accept a route override.

The important consequence is that `epicenter.config.ts` does not own the normal route string. The app daemon subpath owns it:

```txt
@epicenter/fuji/daemon
  DEFAULT_FUJI_DAEMON_ROUTE = "fuji"
  defineFujiDaemon()      -> DaemonHostDefinition { route: "fuji", start }
  connectFujiDaemonActions() -> connectDaemonActions({ route: "fuji" })
```

That removes the common drift case. The host and the script helper share one package-level default. `epicenter.config.ts` only composes hosts.

Custom routes stay possible, but they become an explicit local deployment choice:

```ts
export default defineConfig({
	hosts: [defineFujiDaemon({ route: 'blog' })],
});

const blog = await connectFujiDaemonActions({
	route: 'blog',
});
```

This does require repeating the override at the custom script call site. That repetition is acceptable because the common path has no repetition, and the custom path is naming a local mount point rather than changing Fuji's product identity.

## Defaults and Overrides

The daemon factory should make the normal config short, but the defaults need to respect the identity boundaries above.

| Value | Default | Override? | Rationale |
| --- | --- | --- | --- |
| Route key | App daemon constant, e.g. `DEFAULT_FUJI_DAEMON_ROUTE = 'fuji'` | Yes, through `defineFujiDaemon({ route })` | Normal route is app-owned and shared by config and app-specific script helpers |
| Y.Doc guid | Hard-coded in the app doc factory, e.g. `epicenter.fuji` | No, unless the app adds a separate product feature | Changing storage and sync identity should be deliberate |
| Yjs clientID | `hashClientId(projectDir)` | Yes, mainly tests | Stable per-project writer identity is the right default |
| Project dir | Explicit `findEpicenterDir(import.meta.dir)` in config | Yes | `epicenter up -C` means `process.cwd()` may not be the config directory |
| API URL | `EPICENTER_API_URL` | Yes | Self-hosting and tests need an override |
| WebSocket impl | Runtime default | Yes | Tests and non-standard runtimes need injection |
| Peer identity | App daemon default, e.g. `{ id: 'fuji-daemon', name: 'Fuji Daemon', platform: 'node' }` | Yes | Presence identity has an obvious app default, but tests and custom hosts need stable names |
| Token getter | Prefer default only if dependency boundary stays clean | Yes | The host normally runs on the same machine as `epicenter auth login`, but app daemon subpaths should not grow an accidental CLI package cycle |
| Script route | App-specific connector default | Yes, by passing `route` to the connector | Avoids drift in the common case while preserving custom route support |

The preferred config is therefore:

```ts
const projectDir = findEpicenterDir(import.meta.dir);
const getToken = async () =>
	(await sessions.load(EPICENTER_API_URL))?.accessToken ?? null;

export default defineConfig({
	hosts: [defineFujiDaemon({ getToken })],
});
```

And the fully explicit form remains available:

```ts
export default defineConfig({
	hosts: [defineFujiDaemon({
		route: 'blog',
		getToken,
		peer: {
			id: 'custom-fuji-daemon',
			name: 'Custom Fuji Daemon',
			platform: 'node',
		},
		apiUrl,
		webSocketImpl,
	}),
	],
});
```

## Design Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Config shape | `defineConfig({ hosts: DaemonHostDefinition[] })` | No export scanning, no fake single `workspaces` key, and default routes live with app daemon factories |
| Route id | `DaemonHostDefinition.route` | App daemon subpaths own the normal route and can export matching script helpers |
| Fuji daemon start result | `DaemonWorkspace` facade only | Persistence and materializers run privately |
| Readiness | Async host construction | A hosted workspace is ready once the factory resolves. The daemon should not carry a separate `whenReady` field. |
| Script typing | `ReturnType<typeof createFujiActions>` | Scripts depend on action factories, not config exports |
| Script route | App-specific connector default | `connectFujiDaemonActions()` can use the same `DEFAULT_FUJI_DAEMON_ROUTE` as `defineFujiDaemon()` |
| Peer identity default | App daemon factory defaults `peer` | The normal daemon identity is obvious and overrideable |
| Token default | Conditional default | Add it only if the token helper can live in a small host-runtime module without an app to CLI cycle |

## Target API

```ts
import type { Actions } from '@epicenter/workspace';

export type DaemonWorkspace = {
	actions: Actions;
	sync?: SyncAttachment;
	presence?: PeerPresenceAttachment;
	rpc?: SyncRpcAttachment;
	[Symbol.dispose](): void;
};

export type DaemonHostDefinition = {
	route: string;
	start(options: DaemonRouteContext): DaemonWorkspace | Promise<DaemonWorkspace>;
};

export type EpicenterConfig = {
	readonly [EPICENTER_CONFIG]: true;
	hosts: DaemonHostDefinition[];
};

export function defineConfig({
	hosts,
}: {
	hosts: DaemonHostDefinition[];
}): EpicenterConfig {
	return Object.freeze({
		[EPICENTER_CONFIG]: true,
		hosts: Object.freeze([...hosts]),
	});
}
```

Duplicate routes are a runtime loader error, not a compile-time warning. The
record shape prevented duplicates by construction, but it also made config own
normal route names. The array shape keeps route ownership with app daemon
subpaths, and `loadConfig()` rejects duplicates before the daemon binds:

```txt
Duplicate daemon route "fuji" in /project/epicenter.config.ts.
```

## Final Vision

The end-state call sites should read like this.

Project config hosts daemon workspaces:

```ts
// epicenter.config.ts
import { defineFujiDaemon } from '@epicenter/fuji/daemon';
import { defineConfig } from '@epicenter/workspace/daemon';

export default defineConfig({
	hosts: [defineFujiDaemon()],
});
```

Fuji's daemon subpath returns a daemon definition. Its `start()` result exposes only the runtime daemon surface:

```ts
// @epicenter/fuji/daemon
export const DEFAULT_FUJI_DAEMON_ROUTE = 'fuji';

export function defineFujiDaemon({
	route = DEFAULT_FUJI_DAEMON_ROUTE,
	peer = defaultFujiDaemonPeer(),
	getToken,
	apiUrl = EPICENTER_API_URL,
	webSocketImpl,
}: OpenFujiDaemonOptions) {
	return defineDaemon({
		route,
		start({ projectDir }) {
			const doc = openFujiDoc({ clientID: hashClientId(projectDir) });
			const sync = attachSync(doc, {
				url: websocketUrl(`${apiUrl}/workspaces/${doc.ydoc.guid}`),
				getToken,
				webSocketImpl,
			});

			return {
				actions: doc.actions,
				sync,
				presence: sync.attachPresence({ peer }),
				rpc: sync.attachRpc(doc.actions),
				[Symbol.dispose]() {
					doc[Symbol.dispose]();
				},
			} satisfies DaemonWorkspace;
		},
	});
}

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

Scripts type against action factories, not config exports:

```ts
import { connectFujiDaemonActions } from '@epicenter/fuji/daemon';

const fuji = await connectFujiDaemonActions();

await fuji.entries.create({ title: 'Hello' });
```

Local daemon actions and peer RPC actions are intentionally separate:

```txt
connectDaemonActions()
  script process
    │ Unix socket
    ▼
  local epicenter up daemon
    │ local /run route
    ▼
  hosted workspace action
```

```txt
createRemoteClient().actions()
  local workspace peer
    │ presence.find(peerId)
    ▼
  remote peer clientID
    │ sync RPC
    ▼
  remote peer action
```

Use `connectDaemonActions()` when a script wants to call the project-local
`epicenter up` process by route key. Use `createRemoteClient()` when an
already-open workspace peer wants to call another peer by presence id over sync
RPC.

The loader sees one explicit host list:

```ts
const config = module.default;
const entries = await Promise.all(
	config.hosts.map(async (definition) => {
		const workspace = await definition.start({ projectDir, configDir });
		return { route: definition.route, workspace };
	}),
);
```

In this model, `epicenter.config.ts` is not a reusable client module. It is the project-local daemon host manifest.

## Fuji Target

```ts
export type OpenFujiDaemonOptions = {
	route?: string;
	peer?: PeerIdentityInput;
	getToken: () => Promise<string | null>;
	projectDir?: ProjectDir;
	clientID?: number;
	apiUrl?: string;
	webSocketImpl?: WebSocketImpl;
};

export function defineFujiDaemon({
	route = DEFAULT_FUJI_DAEMON_ROUTE,
	peer = defaultFujiDaemonPeer(),
	getToken,
	apiUrl = EPICENTER_API_URL,
	webSocketImpl,
}: OpenFujiDaemonOptions) {
	return defineDaemon({
		route,
		start({ projectDir }) {
			const doc = openFujiDoc({ clientID: hashClientId(projectDir) });
			const sync = attachSync(doc, {
				url: websocketUrl(`${apiUrl}/workspaces/${doc.ydoc.guid}`),
				getToken,
				webSocketImpl,
			});

			return {
				actions: doc.actions,
				sync,
				presence: sync.attachPresence({ peer }),
				rpc: sync.attachRpc(doc.actions),
				[Symbol.dispose]() {
					doc[Symbol.dispose]();
				},
			} satisfies DaemonWorkspace;
		},
	});
}
```

The key collapse:

```diff
- return { ...doc, yjsLog, sync, presence, rpc, sqlite, markdown };
+ return {
+   actions: doc.actions,
+   sync,
+   presence,
+   rpc,
+   [Symbol.dispose]() {
+     doc[Symbol.dispose]();
+   },
+ } satisfies DaemonWorkspace;
```

## Token Default

The host normally runs on the same machine as `epicenter auth login`, so a default token getter is attractive:

```ts
export default defineConfig({
	hosts: [defineFujiDaemon()],
});
```

The current implementation keeps `getToken` explicit. Route and peer defaults
land without forcing `@epicenter/fuji/daemon` to import the CLI auth/session
store.

The default should not make app daemon subpaths import the whole CLI package if that creates a package cycle. Prefer one of these shapes:

1. Read credentials through `@epicenter/auth/node`, which already owns the Node auth store.
2. Add a narrower auth runtime package only if app packages cannot depend on `@epicenter/auth/node`.
3. Keep `getToken` explicit until the repeated boilerplate is painful enough to justify the extraction.

The fallback explicit form is:

```ts
const credentials = createDefaultCredentialStore();
const getToken = () => credentials.getBearerToken(EPICENTER_API_URL);

export default defineConfig({
	hosts: [defineFujiDaemon({ getToken })],
});
```

Recommendation: default `getToken` if it can be implemented through a narrow auth/session runtime dependency. Do not make `@epicenter/fuji/daemon` import the full CLI root.

## Loader Migration

Current loader:

```txt
import config module
scan named exports
skip default
accept workspace-shaped values
route id = export name
```

Target loader:

```txt
import config module
read default export
validate defineConfig result
hosts = config.hosts
entries = await Promise.all(
  hosts.map(async (definition) => {
    const workspace = await definition.start({ projectDir, configDir })
    return { route: definition.route, workspace }
  })
)
route key = definition.route
```

Most daemon internals can stay stable because `loadConfig()` can still return `WorkspaceEntry[]`.

## Readiness Model

There is no `DaemonWorkspace.whenReady`.

If a daemon workspace needs local setup before actions are safe to run, its host factory awaits that work before returning:

```ts
export function defineFujiDaemon(options) {
	return defineDaemon({
		route: 'fuji',
		async start() {
			const doc = openFujiDoc(options);
			const idb = attachIndexedDb(doc.ydoc, { name: 'fuji' });
			await idb.whenLoaded;

			const sync = attachSync(doc, { ... });

			return {
				actions: doc.actions,
				sync,
				[Symbol.dispose]() {
					doc[Symbol.dispose]();
				},
			} satisfies DaemonWorkspace;
		},
	});
}
```

The daemon loader awaits host construction once, during config load. After that, local action dispatch does not need another generic readiness gate.

Network readiness is separate. A normal local action should not wait for `sync.whenConnected` unless the action itself needs the network. Peer calls already wait through presence and RPC resolution.

## Script Typing

Scripts should not import hosted clients from `epicenter.config.ts`. In the normal case they should import app-specific daemon action helpers from the app package:

```ts
import { connectFujiDaemonActions } from '@epicenter/fuji/daemon';

const fuji = await connectFujiDaemonActions();
```

The generic primitive still exists for custom routes:

```ts
export async function connectDaemonActions<TActions>(options: {
	route: string;
	projectDir?: ProjectDir;
}): Promise<DaemonActions<TActions>>;
```

App daemon subpaths can build on it:

```ts
export const DEFAULT_FUJI_DAEMON_ROUTE = 'fuji';

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

`connectDaemon<TWorkspace>()` should be removed in the clean break. It made callers pass a workspace shape even though the runtime returned only an action proxy. `connectDaemonActions<TActions>()` takes the action root type directly.

`connectDaemonActions()` should not be confused with `createRemoteClient()`.
They both return typed action proxies, but their address spaces are different:

| API | Address | Transport | Caller has |
| --- | --- | --- | --- |
| `connectDaemonActions<TActions>({ route })` | config route key, e.g. `fuji` | local Unix socket | project directory |
| `createRemoteClient({ presence, rpc }).actions<TActions>(peerId)` | presence peer id, e.g. `macbook` | sync RPC | live workspace peer |

If a project customizes the route, both the host and action helper take the same override:

```ts
export default defineConfig({
	hosts: [defineFujiDaemon({ route: 'blog' })],
});

const blog = await connectFujiDaemonActions({
	route: 'blog',
});
```

## Implementation Plan

### Phase 1: Host Types

- [x] **1.1** Add `DaemonWorkspace`, `DaemonHostDefinition`, and `defineConfig`.
- [x] **1.2** Keep `WorkspaceEntry[]` as the internal daemon server input.
- [x] **1.3** Add tests for invalid route keys and non-workspace host values.
- [x] **1.4** Remove `whenReady` from hosted workspace types and daemon dispatch.

### Phase 2: Loader

- [x] **2.1** Teach `loadConfig()` to read default host config.
- [x] **2.2** Call every definition's `start()` before building `WorkspaceEntry[]`.
- [x] **2.3** Remove named export scanning instead of adding a compatibility bridge.
- [x] **2.4** Update loader errors from "config export" to "hosted workspace".

### Phase 3: Fuji

- [x] **3.1** Change `apps/fuji/src/lib/fuji/daemon.ts` to return `DaemonHostDefinition`.
- [x] **3.2** Add `route?: string` to daemon options, defaulted by app daemon constants.
- [x] **3.3** Stop exposing `ydoc`, `tables`, `yjsLog`, `sqlite`, and `markdown` from the daemon return.
- [x] **3.4** Keep daemon setup sync because the current node attachments hydrate synchronously.
- [x] **3.5** Keep `projectDir` overrideable and default it through `findEpicenterDir()`.
- [x] **3.6** Default `peer` in app daemon factories and keep it overrideable.
- [x] **3.7** Keep `getToken` explicit until a narrow auth/session runtime dependency exists.

### Phase 4: Call Sites and Docs

- [x] **4.1** Migrate example configs to `export default defineConfig({ hosts: [...] })`.
- [x] **4.2** Replace docs that import from `epicenter.config.ts`.
- [x] **4.3** Add `connectDaemonActions<TActions>()`.
- [x] **4.4** Add app-specific helpers such as `connectFujiDaemonActions()`.
- [x] **4.5** Update script examples to use app-specific daemon action helpers.

## Implementation Notes

- `@epicenter/workspace/daemon` now exports `defineConfig`, `DaemonWorkspace`, and related host types.
- `loadConfig()` now accepts only the default `defineConfig({ hosts: [...] })` shape. Named export scanning is removed.
- Duplicate routes are rejected by `loadConfig()` with `DuplicateRoute` before the daemon server binds.
- `connectDaemon<TWorkspace>()` was removed in favor of `connectDaemonActions<TActions>()`.
- `defineFujiDaemon()` now returns a host definition with route metadata. Its `start()` result exposes `actions`, `sync`, `presence`, `rpc`, and disposal only. The internal document, tables, Yjs log, SQLite materializer, and markdown materializer stay private.
- `connectFujiDaemonActions()` destructures options in the signature and defaults to `DEFAULT_FUJI_DAEMON_ROUTE`.

## Settled Decisions And Remaining Question

1. **Where should the default token getter live?**
   - Options: app daemon subpaths import a narrow CLI auth/session subpath, session storage moves to a smaller host-runtime package, or config passes `getToken`.
   - Recommendation: default `getToken` only if the dependency stays narrow and cycle-free. Otherwise keep the explicit config closure.

2. **Should named export scanning remain as a compatibility bridge?**
   - Decision: remove it immediately.
   - Rationale: keeping both shapes would preserve the old "config as API module" ambiguity and weaken the route ownership model.

3. **Should `defineConfig()` accept a raw array without a wrapper?**
   - Options: require `defineConfig({ hosts: [...] })`, accept `export default [...]`, or support both.
   - Decision: require the helper first. It gives the loader a reliable shape and gives TypeScript a place to validate host values.

4. **Should routes be overrideable?**
   - Options: hard-code app daemon routes, allow `defineFujiDaemon({ route })`, or force custom users to call lower-level host constructors.
   - Decision: allow `route` overrides. Defaults should be strong, but custom host names should not require rebuilding the daemon factory.

5. **What should the local daemon action helper be called?**
   - Options: app-specific `connectFujiDaemonActions()`, generic `connectDaemonActions<TActions>({ route })`, or generic `openDaemonActions<TActions>({ route })`.
   - Decision: expose app-specific helpers for common scripts and keep `connectDaemonActions` as the generic primitive.
