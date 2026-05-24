# Signed-In Component Co-location

**Date**: 2026-05-05
**Status**: Implemented
**Author**: AI-assisted (follow-up to `20260505T180000-signed-in-context-scope.md`)
**Branch**: feat/encrypted-local-workspace-storage

## Overview

Move every component, state file, and module that only makes sense inside the signed-in subtree out of `$lib` and into `src/routes/(signed-in)/`. The file tree becomes the proof of scope: if a file lives under `(signed-in)/`, it can assume `getSignedIn()` is available; if it lives in `$lib`, it must work regardless of auth state.

This spec is a follow-up to `20260505T180000-signed-in-context-scope.md` (the SignedIn gate). That spec must complete Phase 3 (import migration to `getSignedIn()`) before this one can run cleanly.

Current repo note: parts of Fuji may already be midway through the previous spec. Some routes may already live under `(signed-in)/` while signed-in-only components still live in `$lib/components/`. Treat this spec as the cleanup pass that makes location match scope; do not assume the source tree is still in the "before" state.

## Motivation

### Core Tension

`$lib` is convenient because imports are short and familiar, but it is a weak boundary. A component in `$lib/components/` reads as "safe to use anywhere in this app." That is false for components like `EntryEditor.svelte`, `BulkAddModal.svelte`, and `AppHeader.svelte` once they call `getSignedIn()` or touch Fuji. Those components only work after the signed-in gate has mounted.

The route group is the stronger boundary. A file under `src/routes/(signed-in)/` carries the invariant in its path: this file belongs to the signed-in subtree, so `getSignedIn()` is valid here. The trade-off is longer relative imports and a less traditional `$lib`-centric layout, but the payoff is that scope becomes visible before reading any code.

The decision is not "route folders are better than `$lib`." The decision is narrower: files whose runtime contract depends on `<SignedIn>` should live under the route group that provides that contract. Files that work in any auth state stay in `$lib`.

### Current State

Each app keeps signed-in-only components and state in `$lib`:

```
apps/fuji/src/lib/
├── components/
│   ├── AppHeader.svelte             # uses signedIn.fuji indirectly
│   ├── BulkAddModal.svelte          # uses workspace
│   ├── EntriesSidebar.svelte        # uses workspace
│   ├── EntriesTable.svelte          # uses workspace
│   ├── EntryEditor.svelte           # uses workspace
│   └── FujiWorkspaceProvider.svelte # the old gate (deleted by previous spec)
├── entries-state.svelte.ts          # depends on workspace
├── fuji/                            # workspace primitive
│   ├── index.ts
│   └── script.ts
├── workspace.ts                     # workspace bindings
└── auth.ts                          # used everywhere
```

Concrete example: `apps/fuji/src/lib/components/EntryEditor.svelte` does

```svelte
import { type Entry, fuji } from '$lib/workspace';
```

After the previous spec starts landing, the same smell can look like this:

```svelte
import { getSignedIn } from '$lib/signed-in';

const signedIn = getSignedIn();
```

The direct workspace import is gone, but the file still lives in `$lib/components`, which suggests "reusable across the app." It is not reusable across auth states. The file location still lies about the file's actual scope.

This creates problems:

1. **The file tree doesn't match the scope.** A new contributor opens `$lib/components/EntryEditor.svelte` and reasonably assumes it's reusable from anywhere. It is not. They learn this only by reading the imports or trying to use it from `/sign-in`.
2. **Cross-boundary imports are silently allowed.** Nothing prevents the sign-in page or a future signed-out route from importing `EntryEditor.svelte`. Doing so crashes at runtime when `getSignedIn()` throws.
3. **Workspace singletons leak.** Direct imports like `import { fuji } from '$lib/workspace'` predate the `<SignedIn>` context pattern. The previous spec replaces these with `getSignedIn().fuji`, but the file location still implies the old shape.
4. **State files duplicate the smell.** `entries-state.svelte.ts` reads workspace internals; same problem as the components.

### Desired State

The file tree expresses the invariant:

```
apps/fuji/src/
├── lib/
│   ├── auth.ts                      # used by all auth states; stays
│   └── components/                  # ONLY components that work in any auth state
│       ├── Loading.svelte
│       └── ErrorState.svelte
└── routes/
    ├── +layout.svelte               # pending gate
    ├── sign-in/
    │   └── +page.svelte
    └── (signed-in)/
        ├── +layout.svelte           # SignedIn wrapper
        ├── signed-in.ts             # type + createContext
        ├── components/
        │   ├── SignedIn.svelte
        │   ├── AppHeader.svelte
        │   ├── BulkAddModal.svelte
        │   ├── EntriesSidebar.svelte
        │   ├── EntriesTable.svelte
        │   └── EntryEditor.svelte
        ├── state/
        │   └── entries.svelte.ts    # was entries-state.svelte.ts
        ├── fuji/                    # workspace primitive (signed-in only)
        │   ├── index.ts
        │   └── workspace.ts
        ├── +page.svelte
        └── entries/[id]/+page.svelte
```

A reader scanning `$lib/` sees only true cross-context utilities. A reader scanning `(signed-in)/` knows everything inside can call `getSignedIn()`.

## Research Findings

### SvelteKit treatment of non-route files in `src/routes/`

Verified against SvelteKit docs.

- Only files prefixed with `+` (`+page.svelte`, `+layout.svelte`, `+page.ts`, `+server.ts`, etc.) and matching named conventions are treated as routes.
- All other files in `src/routes/` are normal source files. They are not turned into routes; they don't appear in the URL tree.
- Folders wrapped in parens like `(signed-in)/` are route groups: they affect layout grouping but not URLs.

**Implication**: `src/routes/(signed-in)/components/EntryEditor.svelte` is a normal component. SvelteKit does not route to it. Co-location is safe and idiomatic.

### Conventions in other Svelte/SvelteKit codebases

| Project pattern | Convention |
|---|---|
| Default SvelteKit demos | Components in `$lib/components/`, regardless of scope |
| Larger SvelteKit apps (looksin, sk-templates) | Often co-locate per route folder; `_components` or `components` |
| Next.js app-router parallel | `app/(signed-in)/_components/` is the closest analogue |
| Remix | Components co-located in route folders (`routes/dashboard/Header.tsx`) |

**Key finding**: no single convention dominates. Co-locating by scope is increasingly common in app-router-style frameworks. SvelteKit accepts both `$lib`-centric and route-centric layouts; the choice is architectural.

**Implication**: pick one rule and apply it consistently. The spec rule: **scope follows file location.**

### Path aliases

SvelteKit alias config in `svelte.config.js`:

```js
kit: {
  alias: {
    '$signed-in': 'src/routes/(signed-in)',
  },
}
```

Aliases work for any folder. The hyphen in `$signed-in` is allowed. Parens in target path are allowed.

**Implication**: aliases are a Class 3 taste call (see Open Questions).

## Design Decisions

| Decision | Class | Choice | Rationale |
|---|---|---|---|
| Scope follows file location | 2 coherence | Anything that imports `getSignedIn()` or workspace lives under `(signed-in)/` | Single rule; file tree is the spec |
| Per-route-group `components/` folder | 3 taste | `src/routes/(signed-in)/components/` | One known location per app; avoids a sea of co-located components per route |
| Per-route-group `state/` folder | 3 taste | `src/routes/(signed-in)/state/` for state files | Symmetric with `components/`; keeps reactive state next to its consumers |
| Workspace primitive location | 2 coherence | Move `fuji/` and `workspace.ts` into `(signed-in)/` | Workspace primitives are signed-in-only; same rule applies |
| `signed-in.ts` location | 2 coherence | `src/routes/(signed-in)/signed-in.ts` | The context's only consumers live in the route group |
| Auth client (`auth.ts`) location | 2 coherence | Stays in `$lib/auth.ts` | Used by sign-in page (signed-out) and gate (signed-in); cross-context |
| Generic UI primitives location | 2 coherence | Stay in `$lib/components/` (Loading, ErrorState, etc.) | Used in both auth states |
| Path alias for the route group | Deferred | None for v1; revisit if relative imports become painful | Open Question 1 |
| Audit method | 1 evidence | Search for imports of `getSignedIn`, `$lib/workspace`, `$lib/fuji`, signed-in state files | Direct evidence of which files are signed-in-only |
| Apps in scope | 2 coherence | All three (Fuji, Honeycrisp, Zhongwen) | Same rule applies; per-app file lists differ |
| Sequencing relative to previous spec | 2 coherence | Run after previous spec's Phase 3 | Co-location depends on imports already using `getSignedIn()` |

## Architecture

### The single rule

```
                ┌──────────────────────────────────────┐
                │  Does the file import:               │
                │   - getSignedIn() from signed-in.ts  │
                │   - the workspace primitive          │
                │   - signed-in-only state             │
                └──────────────────────────────────────┘
                              │
                  ┌───────────┴───────────┐
                  │                       │
                YES                      NO
                  │                       │
                  ▼                       ▼
        src/routes/(signed-in)/        src/lib/
```

Reverse direction is forbidden:

```
   $lib/  ────/X────►  src/routes/(signed-in)/        (must not happen)
   src/routes/(signed-in)/  ────►  $lib/              (allowed)
   src/routes/sign-in/  ────/X────►  src/routes/(signed-in)/  (must not happen)
```

### Before / after (Fuji)

```
BEFORE                              AFTER
─────────────────────────           ──────────────────────────────────────
apps/fuji/src/                      apps/fuji/src/
├── lib/                            ├── lib/
│   ├── auth.ts                     │   ├── auth.ts                       (stays)
│   ├── components/                 │   └── components/                   (only generics)
│   │   ├── AppHeader.svelte                  ↓
│   │   ├── BulkAddModal.svelte               (everything moves)
│   │   ├── EntriesSidebar.svelte             ↓
│   │   ├── EntriesTable.svelte
│   │   ├── EntryEditor.svelte
│   │   └── FujiWorkspaceProvider.svelte (deleted by prev spec)
│   ├── entries-state.svelte.ts               ↓
│   ├── fuji/                                 ↓
│   ├── workspace.ts                          ↓
└── routes/                         └── routes/
    ├── +layout.svelte                  ├── +layout.svelte
    ├── +page.svelte           ─►       ├── sign-in/
    ├── entries/[id]/+page.svelte       │   └── +page.svelte
    ├── trash/+page.svelte              └── (signed-in)/
    └── stress-test/+page.svelte            ├── +layout.svelte
                                            ├── signed-in.ts
                                            ├── components/
                                            │   ├── SignedIn.svelte
                                            │   ├── AppHeader.svelte
                                            │   ├── BulkAddModal.svelte
                                            │   ├── EntriesSidebar.svelte
                                            │   ├── EntriesTable.svelte
                                            │   └── EntryEditor.svelte
                                            ├── state/
                                            │   └── entries.svelte.ts
                                            ├── fuji/
                                            │   ├── index.ts
                                            │   └── workspace.ts
                                            ├── +page.svelte
                                            ├── entries/[id]/+page.svelte
                                            ├── trash/+page.svelte
                                            └── stress-test/+page.svelte
```

## Implementation Plan

Per app: audit, move, update imports, verify. Fuji first as the reference; the per-app file lists differ but the procedure is identical.

### Phase 1: Pre-flight

- [x] **1.1** Confirm `20260505T180000-signed-in-context-scope.md` Phase 3 is complete for the target app. Concretely: search for direct workspace imports. If any remain, finish the previous spec first.
  ```sh
  rg "from ['\"]\\$lib/workspace['\"]|from ['\"]\\$lib/fuji['\"]|from ['\"]\\$lib/honeycrisp['\"]" apps/<app>/src
  ```
- [x] **1.2** Pick the target app (start with Fuji). Open the scope audit task for it.

### Phase 2: Audit (per app)

- [x] **2.1** Search the app for files importing signed-in-only modules. For Fuji:
  ```
  rg "from ['\"]\\$lib/workspace['\"]|from ['\"]\\$lib/fuji|from ['\"]\\$lib/entries-state|from ['\"]\\$lib/signed-in['\"]|getSignedIn" apps/fuji/src/lib apps/fuji/src/routes
  ```
- [x] **2.2** Build a list of files that import any of those. Each one is a candidate for the move.
- [x] **2.3** For each candidate, verify it is **not** imported from outside the signed-in subtree (sign-in page, root layout, generic components in `$lib/`). If it is, that's a layering bug to address before the move.
- [x] **2.4** Identify what stays in `$lib`:
  - `auth.ts` (always)
  - Components/utilities used by both `(signed-in)/` and `sign-in/` or root
  - Generic primitives that are auth-state-agnostic
- [x] **2.5** Write the move list down in the spec or a scratch file before moving. The move is mechanical once the list is clear.

### Phase 3: Move workspace primitive (per app)

- [x] **3.1** `git mv apps/fuji/src/lib/fuji/ apps/fuji/src/routes/(signed-in)/fuji/`
- [x] **3.2** `git mv apps/fuji/src/lib/workspace.ts apps/fuji/src/routes/(signed-in)/fuji/workspace.ts` (or wherever the binding belongs; consolidate inside `fuji/`)
- [x] **3.3** Update imports across the moved files (relative paths now)
- [x] **3.4** Update consumers: `import { ... } from '$lib/fuji'` becomes a relative import from `../fuji` or the appropriate path from the moved file
- [x] **3.5** Run `bun run check` to catch broken imports

### Phase 4: Move signed-in state (per app)

- [x] **4.1** `mkdir apps/fuji/src/routes/(signed-in)/state/`
- [x] **4.2** `git mv apps/fuji/src/lib/entries-state.svelte.ts apps/fuji/src/routes/(signed-in)/state/entries.svelte.ts`
- [x] **4.3** Rename if helpful (drop `-state` suffix; the folder is `state/`)
- [x] **4.4** Update imports

### Phase 5: Move signed-in components (per app)

- [x] **5.1** `mkdir apps/fuji/src/routes/(signed-in)/components/`
- [x] **5.2** `git mv` each signed-in component from `$lib/components/` to `(signed-in)/components/`
- [x] **5.3** Move `SignedIn.svelte` (created by previous spec) into `(signed-in)/components/SignedIn.svelte` if it isn't already
- [x] **5.4** Update imports app-wide. Inside the route group, prefer relative imports until alias is added (see Open Question 1)
- [x] **5.5** Update `signed-in.ts` location: move to `src/routes/(signed-in)/signed-in.ts` if not already there

### Phase 6: Verify (per app)

- [x] **6.1** Run `bun run check` repo-wide
- [x] **6.2** Search for any remaining import from `$lib/components/` of moved files:
  ```sh
  rg "from ['\"]\\$lib/components/(EntryEditor|EntriesTable|EntriesSidebar|BulkAddModal|AppHeader|FujiAppShell)" apps/fuji/src
  ```
- [x] **6.3** Search for layering violations: any file in `$lib/` or `src/routes/sign-in/` importing from `src/routes/(signed-in)/`. Should be zero.
  ```sh
  rg "routes/\\(signed-in\\)|\\.\\./\\(signed-in\\)|\\.\\./\\.\\./\\(signed-in\\)" apps/fuji/src/lib apps/fuji/src/routes/sign-in
  ```
- [ ] **6.4** Smoke test: signed-out, sign-in, signed-in, render entries, sign out. Same flows as previous spec's Phase 4.

### Phase 7: Repeat for Honeycrisp

- [x] **7.1** Phases 2-6 for Honeycrisp. Substitute `honeycrisp` for `fuji` throughout.

### Phase 8: Repeat for Zhongwen

- [x] **8.1** Phases 2-6 for Zhongwen. **Caveat**: Zhongwen may not have a workspace (per Open Question 2 of the previous spec). If so, skip Phase 3 and only move whatever signed-in components exist into `(signed-in)/components/`.

### Phase 9: Repo-wide cleanup

- [x] **9.1** Confirm `$lib/components/` in each app contains only auth-state-agnostic components
- [x] **9.2** If any app's `$lib/` is now empty or near-empty beyond `auth.ts`, that's a signal the rule is being applied correctly
- [x] **9.3** Update `apps/<app>/README.md` if it documents the old structure
  > **Note**: Grep across `apps/{fuji,honeycrisp,zhongwen}/README.md` found no references to the old `lib/components/`, `lib/<app>/`, `lib/workspace`, or `lib/state` paths. Nothing to update.
- [ ] **9.4** Final `bun run check`, `bun run lint`, smoke tests across all three apps

## Edge Cases

### A `$lib` component imports from a moved file

After the move, an existing `$lib/components/Foo.svelte` imports `$lib/components/EntryEditor.svelte`. The import will fail.

1. Diagnose: does `Foo.svelte` actually need `EntryEditor`? If yes, `Foo` is signed-in-only too. Move it into `(signed-in)/components/`.
2. If `Foo` is genuinely cross-context, refactor: extract the parts of `EntryEditor` that don't need workspace into a shared primitive in `$lib`, and keep the workspace-using composition in `(signed-in)/`.

### A `+page.svelte` outside `(signed-in)/` imports from `(signed-in)/`

This is a layering violation by definition. Either:
1. The route belongs inside `(signed-in)/`, or
2. The imported component should be split into a generic part (in `$lib`) and a signed-in part (in the route group).

Caught in Phase 6.3.

### Tests that import the moved files

If unit/integration tests live in `__tests__/` or `*.test.ts` next to the original files, the test files should move alongside the components. If tests live elsewhere, update import paths.

### Storybook or playground routes that consume signed-in components

If a route exists for development-only previews of signed-in components (e.g., `/stress-test`), that route is itself signed-in-only and belongs in `(signed-in)/`. The previous spec already covered this in Phase 3; re-confirm here.

### Co-located route-specific components

Some components are used by exactly one route (e.g., `entries/[id]/EntryEditorToolbar.svelte`). Co-location with the route is acceptable: `src/routes/(signed-in)/entries/[id]/EntryEditorToolbar.svelte`. The `(signed-in)/components/` folder is for components used by **2+ routes** in the group.

## Open Questions

1. **Add a path alias `$signed-in` to `src/routes/(signed-in)`?**
   - Options: (a) yes, configure in `svelte.config.js` per app, (b) no, use relative imports
   - **Recommendation**: defer. Relative imports inside a single route group are usually fine because the depth is shallow (`../components/X`). Add the alias only if cross-folder imports become noisy after the moves. Class 3 keep / defer.

2. **Should `state/` be a flat folder or mirror the route structure?**
   - Options: (a) flat `state/entries.svelte.ts`, (b) mirror routes `state/entries/list.svelte.ts`, (c) co-locate state with the route (`entries/state.svelte.ts`)
   - **Recommendation**: (a) flat for now. Add subfolders only when the flat list grows beyond ~5 files.

3. **Should `SignedIn.svelte` and `signed-in.ts` live at the route group root (next to `+layout.svelte`) or inside `components/`?**
   - Options: (a) `(signed-in)/SignedIn.svelte` + `(signed-in)/signed-in.ts` at root, (b) inside `(signed-in)/components/`
   - **Recommendation**: root for `signed-in.ts` (it's the contract); `components/` for `SignedIn.svelte` (it's a component). The two files live near `+layout.svelte` because `+layout.svelte` is the only file that imports `SignedIn.svelte`.

4. **What about `apps/zhongwen` if it has no workspace?**
   - **Recommendation**: still apply the file-location rule for any signed-in-only components. The "no workspace" caveat from the previous spec only affects the gate component shape, not the co-location rule.

5. **Should we add a lint rule (eslint or a custom check) to enforce the layering invariant?**
   - **Recommendation**: not yet. Manual audit in Phase 6.3 catches it. Add a check only if violations recur after this spec ships. Class 3 defer.

## Decisions Log

- **Keep `auth.ts` in `$lib`**: it is used by the sign-in form (signed-out scope) and the gate (signed-in scope). Moving it inside `(signed-in)/` would force the sign-in page to import across the boundary, which is exactly the layering violation the spec forbids.
  Revisit when: a future signed-out flow stops using auth (unlikely) or auth becomes single-scope.

- **Keep workspace primitive (`fuji/`, `workspace.ts`) inside `(signed-in)/` rather than a shared package**: the primitive depends on the user identity at construction; it is not auth-state-agnostic. Promoting it to a package would re-introduce the "this only works inside signed-in" smell at a lower layer.
  Revisit when: the workspace primitive is needed in a context that doesn't yet exist (e.g., a CLI that opens a workspace given an explicit identity).

### Boundary map

This spec narrows the older app layout rule. Browser factories do not move under
`(signed-in)/` because they are named `browser.ts`. They move when the browser
workspace can only be opened from a signed-in identity and the route group owns
that lifecycle.

```txt
Fuji        routes/(signed-in)/fuji/browser.ts        signed-in gate owns workspace
Honeycrisp  routes/(signed-in)/honeycrisp/browser.ts  signed-in gate owns workspace
Zhongwen    routes/(signed-in)/zhongwen/browser.ts    signed-in gate owns workspace
Opensidian  lib/opensidian/browser.ts                 client singleton still owns workspace
Skills      lib/skills/browser.ts                     local browser workspace, no auth gate
```

The rule is about ownership, not filename. A browser factory that accepts
`AuthIdentity` but is opened by a route-group `SignedIn` component belongs with
that route group. A browser factory opened by a `$lib` client singleton stays
with that singleton until the app adopts the signed-in route-group pattern.

## Success Criteria

- [x] In each app, `$lib/components/` contains only auth-state-agnostic components
- [x] In each app, every component that calls `getSignedIn()` lives under `src/routes/(signed-in)/`
- [x] Workspace primitives (`fuji/`, `workspace.ts`, `honeycrisp/`, etc.) live under `src/routes/(signed-in)/`
- [x] `signed-in.ts` lives at `src/routes/(signed-in)/signed-in.ts`
- [x] No file in `$lib/` imports from `src/routes/`
- [x] No file in `src/routes/sign-in/` or other signed-out routes imports from `src/routes/(signed-in)/`
- [ ] `bun run check` passes repo-wide
- [ ] All flows from previous spec's Phase 4 still work after the moves

## Review

**Completed**: 2026-05-06
**Branch**: `feat/encrypted-local-workspace-storage`
**Status**: Implemented; smoke testing pending.

### Summary

All three apps now follow the rule "scope follows file location":
$lib holds only auth-state-agnostic code; everything that imports
`getSignedIn()`, the workspace primitive, or signed-in state lives
under `src/routes/(signed-in)/`. The Phase 6.3 layering grep
returned zero violations per app.

### Per-app file moves

- **Fuji**: `lib/fuji/`, `lib/entries-state.svelte.ts`,
  `lib/view-state.svelte.ts`, `lib/signed-in.ts`, and the eight
  signed-in components (`SignedIn`, `AppHeader`, `EntryEditor`,
  `EntriesTable`, `EntriesTimeline`, `EntriesSidebar`,
  `BulkAddModal`, `FujiAppShell`) moved into `(signed-in)/`. State
  files renamed: `entries-state.svelte.ts` -> `state/entries.svelte.ts`,
  `view-state.svelte.ts` -> `state/view.svelte.ts`. Generic
  primitives (`Loading`, `BadgeList`, `TagInput`, `ProseMirrorEditor`)
  and `format.ts` stayed in `$lib`.
- **Honeycrisp**: `lib/honeycrisp/`, `lib/workspace.ts` (consolidated
  into `honeycrisp/workspace.ts`), `lib/state/*`,
  `lib/search-params.svelte.ts`, `lib/signed-in.ts`, and the seven
  signed-in components (`SignedIn`, `Sidebar`, `NoteCard`,
  `CommandPalette`, `FolderMenuItem`, `NoteList`, `NoteBodyPane`)
  moved. Generic UI (`Loading`, `editor/Editor`), `query/client.ts`,
  `utils/date.ts`, and `auth.ts` stayed in `$lib`.
- **Zhongwen**: `lib/zhongwen/`, `lib/workspace/` (consolidated into
  `zhongwen/workspace/`), `lib/chat/`, `lib/signed-in.ts`, and four
  signed-in components (`SignedIn`, `ZhongwenSidebar`, `ChatInput`,
  `ModelPicker`) moved. `ChatMessage` and `AssistantMessagePart`
  stayed in `$lib` because they import nothing from signed-in scope;
  `pinyin/annotate.ts` and `auth.ts` likewise stayed.

### Deviations from Spec

- **One commit per app, not one commit per phase.** Splitting Phase 3
  (workspace primitive) from Phases 4-5 (state + components) forces
  files-still-in-$lib to point at `routes/(signed-in)/...` paths
  that immediately get rewritten when those files move themselves.
  Per the spec's rule that every move batch must leave the working
  tree typecheckable, the cleanest path was to bundle phases 3-5
  per app and commit once per app. The spec's example commit messages
  are preserved as section headers in the per-app commit body.
- Honeycrisp's `lib/workspace.ts` and Zhongwen's `lib/workspace/` were
  consolidated **inside** the workspace primitive folder
  (`honeycrisp/workspace.ts`, `zhongwen/workspace/`) rather than left
  as siblings, mirroring Fuji's existing `lib/fuji/workspace.ts`
  layout. Same coherence rationale as the spec's workspace-primitive
  decision.

### Layering Verification

- `rg "routes/\(signed-in\)" apps/*/src/lib` -> zero hits
- `rg "routes/\(signed-in\)" apps/*/src/routes/sign-in` -> zero hits
- Per-app `bun run typecheck`: only pre-existing errors in
  `packages/ui` and `packages/svelte-utils`; one pre-existing
  `EntriesTable.svelte:224` error (unrelated to moves). No new
  errors introduced.

### Follow-up Work

- Smoke-test signed-in flows (cold boot, sign-in, sign-out,
  account switch) per-app.
- Resolve pre-existing typecheck errors in `packages/ui` and
  `apps/landing` blocking a clean `turbo run typecheck`.

## References

- `specs/20260505T180000-signed-in-context-scope.md` - prerequisite spec defining `getSignedIn()` and the route group
- `apps/fuji/src/lib/components/EntryEditor.svelte` - example of the smell this spec resolves
- `apps/fuji/src/lib/workspace.ts` - workspace bindings, candidate for move
- `apps/honeycrisp/src/lib/components/` - parallel structure
- `apps/zhongwen/src/lib/auth.ts` - example of a file that stays in `$lib`
- SvelteKit routing docs (route groups, non-route files)
