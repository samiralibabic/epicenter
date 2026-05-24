# Actions: Snake Case Only, No Dots, No Translation

**Date**: 2026-05-13
**Status**: Implemented
**Author**: Braden + Claude
**Supersedes** (the key-format portion of): `20260513T210000-actions-path-first-clean-break.md`

## Sentence

```txt
Action keys are flat ASCII snake_case strings; the same key is the
local address, the peer RPC method, the daemon argument, the CLI
flag, and the AI tool name. No translation at any boundary.
```

The prior clean break flattened the registry but kept `.` as a separator and a runtime swap to `_` at the AI boundary. This spec kills the dot and the swap. One name, every boundary.

## What this spec adds beyond the prior draft

The prior spec (`actions-path-first-clean-break`) committed to:

- Flat `ActionRegistry = Record<string, Action>`
- Dotted keys (`entries.create`, `tabs.close`)
- A type-level `DotsToUnderscores<S>` and runtime `replaceAll('.', '_')` at the AI boundary
- An invariant that action keys must not contain `_`

This spec replaces the key-format decision and removes the translation infrastructure entirely:

1. Action keys conform to `^[a-z][a-z0-9_]*$`. ASCII lowercase, digits, and underscore. Must start with a letter. Length 1-64.
2. The key is the AI tool name verbatim. No `DotsToUnderscores<S>`, no `replaceAll('.', '_')`, no `ACTION_NAME_SEPARATOR`, no "underscore collision" invariant.
3. Hierarchy is a **prefix convention**, not a syntactic feature. `tabs_close`, `tabs_list`, `tabs_get_all_valid`. The "tabs" group is `Object.keys(actions).filter(k => k.startsWith('tabs_'))`.
4. Caps are forbidden, even in single-word keys. LLM tool-call accuracy is highest on lowercase snake_case (the dominant convention in OpenAI/Anthropic/Gemini tool-use training data).

## Why this set, with citations

The lowest common denominator across every boundary an action key crosses:

```
Anthropic Messages API:          ^[a-zA-Z0-9_-]{1,128}$   (no dots)
OpenAI Chat Completions / Tools: ^[a-zA-Z0-9_-]{1,64}$    (no dots)
Gemini function declarations:    snake_case recommended, no special chars
MCP spec (SEP-986):              ^[a-zA-Z0-9_\-./]{1,64}$ (dots allowed)
Claude desktop MCP client:       ^[a-zA-Z0-9_]{1,64}$     (no hyphens)
```

Intersection of those that we actually have to cross:

```
^[a-zA-Z0-9_]{1,64}$
```

Tighter still, because we're being opinionated:

```
^[a-z][a-z0-9_]*$    with length 1-64
```

The leading-letter rule excludes pure-digit and leading-underscore names (avoids `_internal`-looking keys that read as private accessors elsewhere). The lowercase-only rule eliminates case-collision risk and matches LLM training priors.

Sources for the regexes:

- Anthropic regex via 400 error: `home-assistant/core#147760`
- OpenAI regex via 400 error: OpenAI community `709823`
- MCP SEP-986: `modelcontextprotocol/modelcontextprotocol#986`
- Claude MCP client stricter regex: `modelcontextprotocol/modelcontextprotocol#1063`

## Why no dots, in one paragraph (for the spec body)

Dots make tool calling measurably less reliable. LLMs are trained on code where `tabs.close` means "the `close` method on `tabs`," not "one identifier." Tokenizers split on dots, producing more tokens per name and more sampling positions where the call can drift. JSON Schema, JSONPath, and every code generator that emits client stubs use `.` as a path separator and either reject or mis-parse names that contain one. Providers don't refuse dots because they're lazy; they refuse them because the entire stack downstream of the LLM treats `.` as a structural character. Underscore is the only separator that survives every boundary we cross.

## Why no caps, in one paragraph (for the spec body)

Mixed case adds zero capability and two costs: visual inconsistency in a flat registry (`tabsClose` next to `tabs_close` next to `entries_bulk_create`), and weaker LLM tool-call accuracy on names that diverge from the snake_case training prior. Every public tool example in Anthropic, OpenAI, and Gemini docs uses lowercase snake_case. We follow the training distribution.

## Decision

### Authoring shape

```ts
// packages/workspace/src/shared/actions.ts

export type ActionRegistry = Record<string, Action>;
export type ActionManifest = Record<string, ActionMeta>;

// Validation regex, exported for downstream use (CLI, daemon, tests).
export const ACTION_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;
```

App factories author flat, snake_case:

```ts
export function createTabManagerActions({ tables, batch, deviceId }: Deps) {
    return {
        devices_list:        defineQuery({   title: 'List Devices', ... }),
        tabs_list:           defineQuery({   title: 'List Open Tabs', ... }),
        tabs_close:          defineMutation({ title: 'Close Tabs', ... }),
        tabs_open:           defineMutation({ title: 'Open Tab', ... }),
        tabs_update:         defineMutation({ title: 'Update Tab', ... }),
        tabs_group:          defineMutation({ title: 'Group Tabs', ... }),
        saved_tabs_save:     defineMutation({ title: 'Save Tab', ... }),
        saved_tabs_restore:  defineMutation({ title: 'Restore Saved Tab', ... }),
        bookmarks_create:    defineMutation({ title: 'Create Bookmark', ... }),
    } as const satisfies ActionRegistry;
}
```

Call sites use the same key everywhere:

```ts
// Local (dot or bracket; both work because snake_case is a valid JS identifier)
tabManager.collaboration.actions.tabs_close({ tabIds });
tabManager.collaboration.actions['tabs_close']({ tabIds });

// Type extraction
Parameters<typeof tabManager.collaboration.actions.tabs_close>[0]

// Remote
peer.invoke('tabs_close', { tabIds });

// Daemon
client.run({ actionPath: 'tab-manager.tabs_close', input: { tabIds } });

// Daemon proxy
tabManager.tabs_close({ tabIds });

// AI tool name (verbatim, no translation)
'tabs_close'
```

Note: snake_case keys recover the **dot access** ergonomics that the prior path-first spec gave up. `actions.tabs_close` is a legal JS member access; `actions['tabs.close']` requires bracketing. The "local ergonomics: explicit trade" section of the prior spec dissolves.

### Validation

Runtime validation at `openCollaboration` startup, one pass:

```ts
for (const key of Object.keys(userActions)) {
    if (!ACTION_KEY_PATTERN.test(key)) {
        throw new Error(
            `Invalid action key "${key}". ` +
            `Action keys must match ${ACTION_KEY_PATTERN}.`
        );
    }
}
```

No TypeScript template-literal validator. A regex compile-time check on `Record<string, T>` keys is possible but expensive in compile time and noisy in errors. Runtime check at app boot is cheap and clear.

### AI tool bridge collapse

```ts
// Before: ~30 lines including DotsToUnderscores<S>, replaceAll, throws, prose

// After: the entire name-derivation surface
export type ActionNames<TActions> = {
    [K in keyof TActions & string]: TActions[K] extends Action ? K : never;
}[keyof TActions & string];

export function actionsToAiTools<TActions extends ActionRegistry>(
    actions: TActions,
): {
    tools: (AnyClientTool & { name: ActionNames<TActions> })[];
    definitions: ToolDefinition[];
} {
    const entries = Object.entries(actions);

    const tools = entries.map(([name, action]) => ({
        __toolSide: 'client' as const,
        name: name as ActionNames<TActions>,
        description: action.description ?? `${action.type}: ${name}`,
        ...(action.input && { inputSchema: action.input }),
        ...(action.type === 'mutation' && { needsApproval: true }),
        execute: async (args: unknown) => {
            const result = await invokeAction(action, args, name);
            if (result.error !== null) throw result.error;
            return result.data;
        },
    }));

    const definitions: ToolDefinition[] = entries.map(([name, action]) => ({
        name,
        ...(action.title && { title: action.title }),
        description: action.description ?? `${action.type}: ${name}`,
        ...(action.input && { inputSchema: normalizeSchema(action.input as JSONSchema) }),
        ...(action.type === 'mutation' && { needsApproval: true }),
    }));

    return { tools, definitions };
}
```

What dies:

- `DotsToUnderscores<S extends string>` type
- `ACTION_NAME_SEPARATOR` constant
- `path.replaceAll('.', '_')` (called twice)
- The "underscore collision" `throw` and its surrounding `if` guard
- ~15 lines of JSDoc explaining the swap

What's added:

- One regex constant (`ACTION_KEY_PATTERN`)
- One validation loop at registry construction

Net: a few lines removed, plus a substantial **conceptual** simplification: the "AI projection of the canonical name" idea disappears. There is no projection. The name IS the name.

### Daemon proxy collapse

The prior spec's daemon proxy was already flat. With snake_case keys it becomes a legal JS identifier proxy with no quoting:

```ts
// Before (works, but ugly bracket access):
fuji['entries.create']({ ... });

// After:
fuji.entries_create({ ... });
```

The proxy implementation itself does not change. Only call-site readability improves.

### Daemon route prefix

Daemon routes still use `.` to separate the route from the action key, because the route ID and action key live in different namespaces:

```
actionPath = `${route}.${actionKey}`
           = `tab-manager.tabs_close`
           = `fuji.entries_create`
```

The dot here is a delimiter between two distinct identifiers (workspace route ID, action key), not within the action key. Both sides of the dot conform to `[a-z][a-z0-9_-]*` (routes may include hyphens; action keys may not). The split is unambiguous because action keys never contain `.`.

## The full collapse pass

### 1. `shared/actions.ts`

```ts
// Add
export const ACTION_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

// Module JSDoc update
// - replace every mention of "dot path" with "snake_case key"
// - remove "single dot-to-underscore swap at the AI boundary" paragraph
// - keep the "one shape, two views" diagram (it's accurate)
```

### 2. `document/open-collaboration.ts`

Add validation at action registration:

```ts
for (const key of Object.keys(userActions)) {
    if (!ACTION_KEY_PATTERN.test(key)) {
        throw new Error(
            `Invalid action key "${key}". ` +
            `Action keys must match ${ACTION_KEY_PATTERN} (snake_case ASCII, ` +
            `starting with a letter).`
        );
    }
}
```

No other changes; the resolve/describe paths already index by string.

### 3. `ai/tool-bridge.ts`

Apply the collapse shown under "AI tool bridge collapse" above. Remove:

- `type DotsToUnderscores<S>`
- `const ACTION_NAME_SEPARATOR`
- The `path.includes(ACTION_NAME_SEPARATOR)` guard
- Both `path.replaceAll('.', '_')` call sites
- All JSDoc paragraphs describing the swap

### 4. `client/daemon-actions.ts`

No structural change. The flat proxy already returned via `Proxy.get` works for any string key. Update JSDoc references from "dot path" to "snake_case key" and update examples.

### 5. `daemon/run-handler.ts`

Update `daemonActionSuggestionLines` and `daemonActionNearestSiblingLines` to filter by snake_case prefix instead of dotted prefix:

```ts
// Before
const pfx = prefix ? `${prefix}.` : '';
...filter(([path]) => !pfx || path === prefix || path.startsWith(pfx))

// After
// "prefix" is now an action-key prefix, not a namespace
...filter(([key]) => !prefix || key.startsWith(prefix))
```

The "nearest sibling" suggestion logic gets simpler: it's just `Object.keys(actions).filter(k => k.startsWith(commonPrefix))`. There is no segment alignment because there are no segments.

### 6. App migrations

All app `create*Actions` factories switch from nested or dotted to snake_case flat:

```ts
// apps/fuji/...           entries.create        →  entries_create
//                         entries.bulkCreate    →  entries_bulk_create
//                         entries.getAllValid   →  entries_get_all_valid
//
// apps/honeycrisp/...     folders.move          →  folders_move
//                         folders.rename        →  folders_rename
//
// apps/opensidian/...     files.read            →  files_read
//                         files.write           →  files_write
//
// apps/tab-manager/...    tabs.close            →  tabs_close
//                         tabs.list             →  tabs_list
//                         savedTabs.save        →  saved_tabs_save
//                         savedTabs.restore     →  saved_tabs_restore
```

`bulkCreate` → `bulk_create`. `getAllValid` → `get_all_valid`. `savedTabs` → `saved_tabs`. The camelCase method-name pattern goes away inside action keys.

### 7. UI string updates

A few user-facing strings in `apps/opensidian/src/lib/chat/system-prompt.ts` reference dotted names (`Read file content (files_read)`). These were already underscored at the AI boundary, so no change needed; verify after migration.

`apps/tab-manager/src/lib/state/tool-trust.svelte.ts` already uses underscored examples in JSDoc. Verify.

### 8. Tests

Drop:

```ts
test('action keys with dots translate to underscores at AI boundary');
test('throws when an action key contains an underscore (would collide)');
// any other tests that exercise the swap
```

Add:

```ts
test('action keys must match ACTION_KEY_PATTERN', () => {
    expect(() =>
        openCollaboration({
            actions: { 'tabs.close': defineMutation({...}) },  // dot
        })
    ).toThrow(/Invalid action key/);

    expect(() =>
        openCollaboration({
            actions: { TabsClose: defineMutation({...}) },  // caps
        })
    ).toThrow(/Invalid action key/);

    expect(() =>
        openCollaboration({
            actions: { '0tabs': defineMutation({...}) },  // leading digit
        })
    ).toThrow(/Invalid action key/);
});

test('AI tool names equal action keys verbatim', () => {
    const actions = {
        tabs_close: defineMutation({ handler: () => ({}) }),
    } satisfies ActionRegistry;
    const { tools, definitions } = actionsToAiTools(actions);
    expect(tools[0].name).toBe('tabs_close');
    expect(definitions[0].name).toBe('tabs_close');
});
```

## Hierarchy: prefix convention, no syntax

There is no "namespace" type, no segment walker, no segment-aware filter. If you want all tab-related actions:

```ts
const tabActions = Object.fromEntries(
    Object.entries(workspace.actions).filter(([k]) => k.startsWith('tabs_'))
);
```

That's it. The "namespace" is whatever prefix the author picked.

Conventions for app authors:

1. **Pick the noun first, verb second.** `tabs_close`, not `close_tabs`. This groups by noun in alphabetical sort and matches how the LLM thinks about tools ("which tabs tool do I need?").
2. **Pluralize collection nouns.** `tabs_*`, `entries_*`, `files_*`. Singular forms (`tab_close`) read as "the tab" rather than "the collection of tabs."
3. **One-level grouping unless you have a real reason.** `tabs_groups_create` is fine if "tab groups" is a distinct concept. `tabs_close_all_in_window` is too long. Pick a shorter verb or move complexity into arguments.
4. **No abbreviations.** `entries_create`, not `entries_cr`. The LLM is better at long descriptive names than abbreviations.

These are conventions, not invariants. The validator enforces only the regex.

## Boundaries diagram

```txt
Authoring           Registry           Boundaries

defineMutation()      Object.keys()  -> awareness actionKeys
defineQuery()    -->  {              -> peer.invoke(key, input)
                        tabs_close:  -> daemon `/run` actionPath=<route>.<key>
                        tabs_list:   -> daemon proxy actions[key](input)
                        ...,         -> AI tools (name = key, verbatim)
                      }              -> ActionManifest (same keys minus handlers)
                      satisfies ActionRegistry
```

No translation. No segments. No projection.

## What survives

| Survives | Why |
|---|---|
| `defineQuery` / `defineMutation` | Read/write distinction is product. |
| `Action` (collapsed union) | One name, value-level discriminant. |
| `ActionRegistry` | The single shape. |
| `ActionMeta` / `ActionManifest` | Wire form for `peer.describe()`. |
| `invokeAction` / `invokeActionForRpc` | Boundary normalizers. |
| `isAction` / `isQuery` / `isMutation` | SQLite materializer tests rely on them. |
| `RemoteCallOptions` | Per-call options (timeout). |
| `title` / `description` (optional) | AI/UI overrides. |

## What dies (beyond the prior spec)

| Dies | Why |
|---|---|
| `DotsToUnderscores<S>` type | Key equals tool name. |
| `ACTION_NAME_SEPARATOR` constant | Nothing to swap. |
| `replaceAll('.', '_')` call sites (×2) | Nothing to swap. |
| Underscore-collision `throw` guard | Underscores are normal characters now, not separators. |
| "AI projection of the canonical name" paragraphs in JSDoc | The projection doesn't exist. |
| The "local ergonomics: explicit trade" section of prior spec | Snake_case keys are JS-legal; dot access works again. |
| Dotted-prefix segment logic in daemon suggestion helpers | Prefix is just a string. |

## Migration waves

### Wave 1: Foundation

- Add `ACTION_KEY_PATTERN` regex and validation to `shared/actions.ts` and `open-collaboration.ts`.
- Collapse `ai/tool-bridge.ts`: remove `DotsToUnderscores`, `ACTION_NAME_SEPARATOR`, the swap, the guard.
- Update module JSDoc in `shared/actions.ts` and `ai/tool-bridge.ts`.

### Wave 2: App migrations

Rename every action key from dotted (or nested) form to snake_case:

- `apps/fuji/.../workspace.ts`
- `apps/honeycrisp/.../workspace.ts`
- `apps/opensidian/src/lib/opensidian/actions.ts`
- `apps/tab-manager/src/lib/workspace/actions.ts`
- `packages/skills/src/node.ts` (if it owns a registry)

Update every call site:

```ts
// Before
fuji.collaboration.actions['entries.create']({});
peer.invoke('entries.create', { ... });

// After
fuji.collaboration.actions.entries_create({});
peer.invoke('entries_create', { ... });
```

Audit grep:

```bash
grep -rn "actions\.\([a-z]\+\)\.\([a-z]\+\)(" apps/        # nested dot call
grep -rn "actions\['[a-z]\+\.[a-z]\+'\]" apps/             # dotted bracket call
grep -rn "peer\.invoke('[^']*\.[^']*'" apps/ packages/      # dotted RPC
grep -rn "actionPath: '[^']*\.[^.]*\.[^.']*" apps/ packages/  # 3-segment route.action
```

### Wave 3: Prove

```bash
bun test packages/workspace/src/shared/actions.test.ts
bun test packages/workspace/src/document/open-collaboration.test.ts
bun test packages/workspace/src/daemon/run-handler.test.ts
bun test packages/workspace/src/client/daemon-actions.test.ts
bun test packages/workspace/src/ai/tool-bridge.test.ts
```

Plus app-level typechecks.

### Wave 4: Remove

Delete swap code, swap tests, "projection" JSDoc paragraphs, and the `ACTION_NAME_SEPARATOR` constant.

## Edge cases

### Key validation timing

Authoring-time validation lives in `defineActions(...)`, which sees literal
registry keys and rejects dotted, camelCase, leading-digit, and leading-underscore
keys at the edit site. Runtime validation still runs in `openCollaboration`
because that public boundary accepts an `ActionRegistry` and callers can bypass
the helper with casts, dynamic objects, or plain JavaScript.

### Hyphens

Forbidden in action keys, even though Anthropic and OpenAI accept them. Reason: Claude's MCP client regex is `[a-zA-Z0-9_]`, which is stricter. If we ever expose actions as MCP tools, the keys must clear this floor without translation.

### Leading underscore / leading digit

Forbidden. `^[a-z][a-z0-9_]*$` requires a leading lowercase letter. Eliminates `_private`-looking keys, eliminates names that can't be JS identifiers (leading digit).

### Empty key

Forbidden by the regex (`+` semantics via `[a-z][a-z0-9_]*` requires at least one character; the leading letter is mandatory).

### Reserved names

None. `describe`, `invoke`, `run` are all legal action keys. They ride a different plane (`RUNTIME_REQUEST`, not the action plane) and there is no collision.

### Existing tool-trust IDs

`apps/tab-manager/src/lib/workspace/definition.ts` stores tool-trust rows keyed by tool name (`'tabs_close'`, `'tabs_open'`). These already match the new format. No migration needed.

### Daemon action paths

`actionPath: 'tab-manager.tabs_close'` is a two-segment ID: route ID, then action key. The dot separates two distinct identifiers. Route IDs follow `[a-z][a-z0-9-]*` (allow hyphen, since they're identifiers for whole workspaces, not LLM tools). Action keys follow `[a-z][a-z0-9_]*`. Disjoint character sets on each side of the dot make the parse unambiguous: split on the **first** `.`.

### "I want hierarchy"

Use a longer prefix. `tabs_groups_create`, `tabs_groups_remove`, `tabs_groups_set_color`. If the prefix list is itself getting long, it probably means the action belongs in a different domain or you should split the workspace. Don't build a syntactic hierarchy back in.

## Open questions

1. **Should we keep `_` in route IDs for daemon paths?**
   - Current convention seems to allow hyphens in route IDs (`tab-manager`). Should they snap to snake_case too?
   - Recommendation: keep route IDs as kebab-case `[a-z][a-z0-9-]*`. Route IDs are not LLM tool names; they map to package/app slugs. Kebab matches npm/package naming. The dot in `tab-manager.tabs_close` is still unambiguous because action keys can't contain hyphens.

2. **Should `title` and `description` change?**
   - No change. They are human-readable, free-form strings. Caps, spaces, and punctuation are fine. The regex only constrains the **key**.

3. **Should we allow length > 64?**
   - OpenAI's limit is 64. Anthropic allows 128. To stay portable, cap at 64. Encode this in `ACTION_KEY_PATTERN` if we want hard enforcement: `/^[a-z][a-z0-9_]{0,63}$/`.
   - Recommendation: enforce 64. Anyone hitting 64 chars on a tool name has a naming problem, not a regex problem.

4. **Should we lint for action-key style in CI?**
   - The runtime validator catches everything at boot. A lint rule would catch it one diff earlier. Not worth a custom rule yet; revisit if we ship more apps.

## Final state checklist

- [x] `ACTION_KEY_PATTERN` defined in `shared/actions.ts` and exported
- [x] Validation runs in `openCollaboration` and throws on invalid keys
- [x] `DotsToUnderscores<S>`, `ACTION_NAME_SEPARATOR`, and both `replaceAll('.', '_')` sites deleted
- [x] All app `create*Actions` factories use snake_case keys
- [x] All call sites (peer.invoke, daemon client.run, local `actions.x_y()`) updated
- [x] Tests added: regex validator, AI tool name equals key
- [x] Tests removed: dot-to-underscore swap, underscore collision throw
- [x] Module JSDoc in `shared/actions.ts` no longer mentions dot paths or projection
- [x] `tool-bridge.ts` JSDoc no longer mentions dot-to-underscore swap
- [x] grep audit has no real dotted action-key hits in `apps/` or `packages/`

## One-line summary for commit message

```
refactor(actions): snake_case action keys end-to-end; remove dot-to-underscore swap
```

## Review

**Completed**: 2026-05-13
**Branch**: `codex/sync-room-plus-stacked-refactors`

### Summary

Action keys are now authored as lowercase snake_case and cross the local,
daemon, RPC, CLI, and AI boundaries without dot-to-underscore translation.
`defineActions(...)` is the authoring helper for typed registries, while
`openCollaboration(...)` remains the runtime guard for untyped or casted input.

### Deviations from Spec

- Added `defineActions(...)` so literal registry keys fail at compile time as
  well as runtime. This is the right type location because `ActionRegistry =
  Record<string, Action>` cannot validate object literal keys on its own.
- Renamed the peer awareness action listing from `actionPaths` to `actionKeys`
  to remove the last public surface that taught the old path vocabulary.

### Verification

- `bun test packages/workspace`
- `bun test packages/cli/src/load-config.test.ts`
- `bun test packages/workspace/src/document/peer.test.ts packages/workspace/src/document/open-collaboration.test.ts packages/workspace/src/daemon/run-handler.test.ts packages/cli/src/commands/list.test.ts packages/cli/src/commands/run-peer-errors.test.ts`
- `bun run typecheck` in `packages/workspace`
- `bun run typecheck` in `packages/sync`
- `bun x tsc --noEmit -p packages/cli/tsconfig.json`
