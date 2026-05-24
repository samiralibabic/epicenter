# UI Import Boundary Clean Break

**Date**: 2026-05-08
**Status**: Implemented
**Author**: AI-assisted

## One-sentence thesis

```txt
Apps import UI through the @epicenter/ui package API, while packages/ui source
imports its own files with relative paths only.
```

If this sentence needs "except for `#` aliases" to stay true, the boundary is
not clean yet.

## Overview

Remove the repo-wide need for `#` aliases that point at `packages/ui/src`.
`@epicenter/ui` becomes the only import path available to consumers, and
`packages/ui` stops relying on alias resolution for its own source graph.

## Motivation

### Current State

Apps currently consume UI correctly:

```ts
import { Button } from '@epicenter/ui/button';
import { cn } from '@epicenter/ui/utils';
import '@epicenter/ui/app.css';
```

But several app configs also expose UI source through `#`:

```js
// apps/honeycrisp/svelte.config.js
kit: {
	alias: {
		'#': '../../packages/ui/src',
	},
}
```

That alias exists because `packages/ui` internals import other UI files through
`#/...`:

```svelte
<script lang="ts">
	import * as Tooltip from '#/tooltip';
	import { cn } from '#/utils.js';
</script>
```

This creates problems:

1. **Consumers know a private path.** Every app that aliases `#` to
   `packages/ui/src` can accidentally bypass `@epicenter/ui` exports.
2. **One package owns two import systems.** UI has package exports for
   consumers and `#` aliases for itself. The two can drift.
3. **App config compensates for package internals.** A SvelteKit app has to
   understand how `packages/ui` happens to import itself.
4. **The current `#/...` spelling is too vague.** It does not say which package
   owns the alias, and TypeScript does not treat it as a clean package import
   without explicit path or bundler aliases.

### Desired State

Apps use only package imports:

```ts
import { Button } from '@epicenter/ui/button';
import * as Tooltip from '@epicenter/ui/tooltip';
import '@epicenter/ui/app.css';
```

UI source uses only relative imports:

```svelte
<script lang="ts">
	import * as Tooltip from '../tooltip/index.js';
	import { cn } from '../utils.js';
</script>
```

`packages/ui` remains the owner of its public API:

```json
{
	"exports": {
		"./*": "./src/*/index.ts",
		"./utils": "./src/utils.ts",
		"./utils/*": "./src/utils/*.ts",
		"./app.css": "./src/app.css"
	}
}
```

No app config mentions `packages/ui/src`.

## Research Findings

### SvelteKit aliases

SvelteKit `kit.alias` entries are passed to Vite and TypeScript, and SvelteKit
generates the matching tsconfig paths. That is why app-level `#` aliases work
today.

Source: https://svelte.dev/docs/kit/configuration#alias

### Repo Scan

`packages/ui/src` has many `#/...` imports. App source does not import `#/...`
for UI directly. The leakage is in config, not in app call sites.

```bash
rg "from ['\"]#|import\\(['\"]#" packages/ui/src
rg "from ['\"]#|import\\(['\"]#" apps packages --glob '!packages/ui/src/**'
```

The second command only found `packages/constants/src/vite.ts` using its own
package-local `#apps` import. That is unrelated to UI.

## Convention

```txt
1. Apps import UI through @epicenter/ui public subpaths.
2. Apps never alias # to packages/ui/src.
3. Apps never add tsconfig paths for packages/ui/src.
4. packages/ui source imports its own files with relative paths.
5. packages/ui does not use package imports to import itself.
6. packages/ui does not use # aliases for its source graph.
```

### Honest patterns

```ts
// App source
import { Button } from '@epicenter/ui/button';
import { cn } from '@epicenter/ui/utils';
```

```ts
// packages/ui/src/button/button.svelte
import { cn } from '../utils.js';
import * as Tooltip from '../tooltip/index.js';
```

```ts
// packages/ui/src/confirmation-dialog/confirmation-dialog.svelte
import * as AlertDialog from '../alert-dialog/index.js';
import { Input } from '../input/index.js';
import { Spinner } from '../spinner/index.js';
import { cn } from '../utils.js';
```

### Anti-patterns

```js
// App config
alias: {
	'#': '../../packages/ui/src',
}
```

```json
// App tsconfig
{
	"compilerOptions": {
		"paths": {
			"#/*": ["../../packages/ui/src/*"]
		}
	}
}
```

```ts
// packages/ui source
import { cn } from '#/utils.js';
import { cn } from '@epicenter/ui/utils';
```

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Consumer import path | 2 coherence | `@epicenter/ui/...` only | Consumers should see the package API, not source layout. |
| UI internal import path | 2 coherence | Relative imports only | The source tree is shallow. Relative imports keep ownership local and need no resolver magic. |
| Package self-reference from UI internals | 2 coherence | Do not use `@epicenter/ui/...` inside `packages/ui` | Self-reference proves public exports, but it also makes the package depend on its own package resolution during development. Relative imports are simpler. |
| Private package imports | 3 taste refused | Do not add now | They would make shadcn updates quieter, but they are still a second import system. Keep the source graph easier to explain. |
| `#internal/*` naming | 3 taste refused | Do not add now | `internal` is not a keyword. The name is clear but unnecessary if the rule is relative imports only. |
| SvelteKit alias ownership | 1 evidence | Use `kit.alias` only for app-local aliases | SvelteKit generates TypeScript alias config. Manual tsconfig paths in SvelteKit apps duplicate that work. |
| Migration style | 2 coherence | Clean break, no compatibility aliases | Existing app source already uses `@epicenter/ui`. The change is config cleanup plus UI internal import rewrites. |
| shadcn-svelte generator config | 2 coherence | Do not keep generator alias config in `packages/ui` | Direct shadcn generation wants aliases, but the package boundary is clearer without committed generator aliases. Generate in a scratch project, copy files into `src`, and normalize imports before commit. |

## Architecture

Current:

```txt
apps/*
  import @epicenter/ui/button
  svelte.config.js aliases # -> ../../packages/ui/src
                 |
                 v
packages/ui/src
  imports #/utils.js
  imports #/tooltip
```

Target:

```txt
apps/*
  import @epicenter/ui/button
                 |
                 v
packages/ui package exports
                 |
                 v
packages/ui/src
  imports ../utils.js
  imports ../tooltip/index.js
```

The app sees a package. The package sees files.

## Cross-tree Helpers

Do not introduce a cross-tree helper alias in this cleanup.

If a future UI helper is used from many unrelated directories, decide between
these two moves before adding a private import alias:

```txt
Move it near its callers
  Good when one component family owns the helper.

Export it as public UI API
  Good when apps or many component families should rely on it.
```

Only add a private import alias after both moves fail and relative imports have
become materially hard to read. That is a future design decision, not a default.

## Implementation Plan

### Phase 1: Make UI self-contained

- [x] **1.1** Replace all `#/...` imports under `packages/ui/src` with relative imports.
- [x] **1.2** Remove `imports` from `packages/ui/package.json` if no non-source tool needs it.
- [x] **1.3** Remove `paths["#/*"]` from `packages/ui/tsconfig.json`.
- [x] **1.4** Run `bun run --cwd packages/ui typecheck`.
  > **Note**: The command runs and reaches diagnostics. It fails on existing UI strictness errors in chart tooltip, dropdown menu exports, frecency, emoji picker, casing utils, link, and date input files. No failure points at removed UI aliases.

### Phase 2: Remove consumer aliases

- [x] **2.1** Remove `'#': '../../packages/ui/src'` from SvelteKit app configs.
- [x] **2.2** Remove UI `#/*` paths from app tsconfigs.
- [x] **2.3** Remove UI `#` aliases from non-SvelteKit consumers, including WXT and Astro.
- [x] **2.4** Keep app-local aliases such as `$routes` and `$platform/auth`.

### Phase 3: Fix scripts that hide drift

- [x] **3.1** Ensure every SvelteKit app that has a typecheck script runs `svelte-kit sync && svelte-check --tsconfig ./tsconfig.json`.
- [x] **3.2** Use `typecheck`, not only `check`, for apps that should participate in root `bun typecheck`.
- [x] **3.3** Run focused typechecks for every UI consumer.
  > **Note**: Svelte-utils, skills, tab-manager, honeycrisp, opensidian, and zhongwen pass. Landing, dashboard, fuji, whispering, and ui still report unrelated TypeScript or Svelte diagnostics.

### Phase 4: Guard the boundary

- [x] **4.1** Add a lint or repo audit command that fails on app-level aliases to `packages/ui/src`.
- [x] **4.2** Add a lint or repo audit command that fails on `from '#/` under `packages/ui/src`.
- [x] **4.3** Document the import rule in `packages/ui/README.md` or `AGENTS.md` if this pattern should be enforced by future agents.

## Validation

Run these commands after migration:

```bash
rg "from ['\"]#|import\\(['\"]#" packages/ui/src
rg "packages/ui/src|\"#\\/\\*\"|'#':" apps packages -g 'svelte.config.js' -g 'vite.config.ts' -g 'wxt.config.ts' -g 'tsconfig.json'
bun typecheck
```

Expected results:

```txt
No # imports under packages/ui/src.
No app config aliases or tsconfig paths pointing at packages/ui/src.
Root typecheck either passes or reports unrelated pre-existing errors.
```

## Non-goals

- Do not redesign `@epicenter/ui` exports.
- Do not rename UI components.
- Do not publish a compiled UI package.
- Do not add a private import alias during this migration.
- Do not change app source imports that already use `@epicenter/ui/...`.

## Open Questions

1. Should `packages/svelte-utils` follow the same rule for its own package-local
   aliases in a separate cleanup?
2. Should root `bun typecheck` include apps that currently expose only `check`
   scripts?
3. Should `@epicenter/ui` explicitly export every component subpath rather than
   relying on `"./*": "./src/*/index.ts"`?

## Review

**Completed**: 2026-05-08
**Branch**: detached HEAD at `3107f0c5d`

### Summary

The UI boundary now has one public consumer path: apps and packages import UI
through `@epicenter/ui/...` and `@epicenter/ui/app.css`. UI source imports its
own files through relative paths, with no private aliases or package
self-imports.

The cleanup also removes app and package config paths to `packages/ui/src`,
updates typecheck scripts that hid generated config drift, and adds
`bun run check:ui-boundary` as a lightweight repo guard.

### Deviations from Spec

- `apps/tab-manager` needed `wxt prepare` in its `typecheck` script because
  `svelte-check` extends `.wxt/tsconfig.json`.
- `bun install` failed once on the `esbuild` postinstall script in this fresh
  worktree. `bun install --ignore-scripts` succeeded, and `wxt prepare` now
  covers the generated config needed for Tab Manager typecheck.

### Validation Notes

- `rg "from ['\"]#|import\\(['\"]#" packages/ui/src` returns no matches.
- `rg "packages/ui/src|\"#\\/\\*\"|'#':" apps packages -g 'svelte.config.js' -g 'vite.config.ts' -g 'wxt.config.ts' -g 'tsconfig.json'` returns no matches.
- `bun run check:ui-boundary` passes.
- `bun run --cwd packages/ui typecheck` fails on pre-existing UI diagnostics
  unrelated to import resolution.
- Focused UI consumer checks pass for `packages/svelte-utils`, `apps/skills`,
  `apps/tab-manager`, `apps/honeycrisp`, `apps/opensidian`, and
  `apps/zhongwen`.
- Focused UI consumer checks still fail for `apps/landing`, `apps/dashboard`,
  `apps/fuji`, and `apps/whispering` on existing TypeScript or Svelte
  diagnostics unrelated to UI alias removal.
- `bun typecheck` still fails on existing diagnostics outside this import
  boundary change. The first failing package can vary with task ordering; one
  run failed at `@epicenter/ui#typecheck` on existing UI strictness diagnostics.

### Follow-up Work

- Fix the existing UI package typecheck errors so `@epicenter/ui` can become a
  reliable gate for consumers.
- Decide whether to remove remaining non-UI SvelteKit tsconfig paths, such as
  the `$lib` path in Zhongwen, in a separate cleanup.
