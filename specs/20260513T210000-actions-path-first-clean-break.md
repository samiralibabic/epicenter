# Actions Path-First Clean Break

**Date**: 2026-05-13
**Status**: Implemented
**Author**: Braden + Claude
**Supersedes** (the action portion of): `20260513T200000-workspace-surface-clean-break-vision.md`

## Sentence

```txt
Apps define typed query and mutation actions keyed by flat dot paths;
the same path is the address locally, over peer RPC, in the daemon,
in CLI flags, and as the AI tool name.
```

One address. Zero collapse machinery. The path is the name is the key.

## What this spec adds beyond the prior draft

The prior draft (`workspace-surface-clean-break-vision`) committed to flattening the registry but left `defineActions(nested)` on the table as a softer variant, and did not touch the surrounding surface (action types, error label fallback, type guards, options bag, etc.).

This spec goes further:

1. Refuse nested authoring entirely. Plain flat record literal with `satisfies ActionRegistry` is the only registry shape.
2. Refuse the `defineActions` helper. It would be the identity function.
3. Collapse the surface around actions while we are touching it: drop `Query`/`Mutation` named aliases, drop `ActionFailed` type re-export, tighten `errorLabel`, simplify daemon helpers, simplify AI bridge.

## Decision

```ts
// packages/workspace/src/shared/actions.ts

export type ActionRegistry = Record<string, Action>;

export type ActionManifest = Record<string, ActionMeta>;

export function defineQuery<...>(config): Action { ... }
export function defineMutation<...>(config): Action { ... }
```

App factories author flat:

```ts
export function createFujiActions(tables: FujiTables) {
    return {
        'entries.get':        defineQuery({  title: 'Get Entry',  ... }),
        'entries.getAllValid':defineQuery({  title: 'List Valid Entries', ... }),
        'entries.count':      defineQuery({  title: 'Count Entries', ... }),
        'entries.has':        defineQuery({  title: 'Has Entry', ... }),
        'entries.create':     defineMutation({ title: 'Create Entry', ... }),
        'entries.upsert':     defineMutation({ title: 'Upsert Entry', ... }),
        'entries.update':     defineMutation({ title: 'Update Entry', ... }),
        'entries.delete':     defineMutation({ title: 'Delete Entry', ... }),
        'entries.restore':    defineMutation({ title: 'Restore Entry', ... }),
        'entries.bulkCreate': defineMutation({ title: 'Bulk Create Entries', ... }),
    } as const satisfies ActionRegistry;
}

export type FujiActions = ReturnType<typeof createFujiActions>;
```

Call sites use the same path everywhere:

```ts
// Local
fuji.collaboration.actions['entries.create']({});

// Type extraction (preserved, just bracket-keyed)
Parameters<typeof fuji.collaboration.actions['entries.update']>[0]

// Remote
peer.invoke('entries.update', { id, title });

// Daemon
client.run({ actionPath: 'fuji.entries.update', input: { id, title } });

// Daemon proxy (flat, one-level Proxy)
fuji['entries.update']({ id, title });

// AI
tool name = 'entries_update' (single dot-to-underscore at the AI boundary)
```

## The full collapse pass

### 1. `shared/actions.ts`

Drop the recursive `Actions` type, the walker, the path resolver, and the class-instance fence:

```ts
// Delete
type Actions = { [key: string]: Action | Actions };
function isPlainObject(v: unknown): v is Record<string, unknown> { ... }
function isValidActionKey(key: string) { ... }
function assertValidActionKey(key: string, path: string) { ... }
function* walkActions(actions, prefix = '') { ... }            // generator
function resolveActionPath(actions, path) { ... }              // segment loop
```

Replace with one-line equivalents at the consumers (`Object.entries`, `actions[path]`).

Collapse the type surface:

```ts
// Before: three exported types for the same shape
export type Query<TInput, R>    = ActionHandler<TInput, R> & ActionMeta<TInput> & { type: 'query' };
export type Mutation<TInput, R> = ActionHandler<TInput, R> & ActionMeta<TInput> & { type: 'mutation' };
export type Action<TInput, R>   = Query<TInput, R> | Mutation<TInput, R>;

// After: one
export type Action<TInput extends TSchema | undefined = TSchema | undefined, R = unknown> =
    ActionHandler<TInput, R> & ActionMeta<TInput> & { type: 'query' | 'mutation' };
```

`Query`/`Mutation` aliases are scaffolding. Nobody outside the package imports them; even the AI bridge uses `Action` and switches on `action.type`. The discriminant lives in the value; the type union does not need three names.

`isQuery`/`isMutation`/`isAction` stay because the SQLite materializer tests use them.

`describeActions` becomes one expression at its single caller (`open-collaboration`). Inline it:

```ts
// Before
const manifest = describeActions(userActions);

// After
const manifest: ActionManifest = Object.fromEntries(
    Object.entries(userActions).map(([path, a]) => [path, toMeta(a)]),
);
```

If `toMeta` is only used here, inline that too. The whole "wire-form" concept becomes "the registry minus handlers."

Tighten `errorLabel` to required and drop the fallback chain:

```ts
// Before
export async function invokeAction<T>(
    action: Action,
    input?: unknown,
    errorLabel: string = action.title ?? 'anonymous',
): Promise<Result<T, RpcError>> { ... }

// After
export async function invokeAction<T>(
    action: Action,
    input: unknown | undefined,
    errorLabel: string,
): Promise<Result<T, RpcError>> { ... }
```

Every call site already has the path (it is how it dispatched to the action in the first place). The `title ?? 'anonymous'` fallback exists because the nested registry made path-at-callsite awkward. Path-first removes the excuse. Pass the path; delete the fallback; delete the "falls back to anonymous" test.

Drop the `ActionFailed` type re-export:

```ts
// Delete
export type ActionFailed = Extract<RpcError, { name: 'ActionFailed' }>;
```

No external consumer. If something needs it, the inline shape is the same length as the import.

### 2. `document/open-collaboration.ts`

```ts
// Before
const actionPaths = Object.freeze(
    Array.from(walkActions(userActions), ([path]) => path).sort(),
);
...
const target = resolveActionPath(userActions, rpc.action);
if (!target) return RpcError.ActionNotFound({ action: rpc.action });
return invokeActionForRpc(target, rpc.input, rpc.action);
...
case 'describe-actions':
    return Ok(describeActions(userActions));

// After
const actionPaths = Object.freeze(Object.keys(userActions).sort());
...
const target = userActions[rpc.action];
if (!target) return RpcError.ActionNotFound({ action: rpc.action });
return invokeActionForRpc(target, rpc.input, rpc.action);
...
case 'describe-actions':
    return Ok(Object.fromEntries(
        Object.entries(userActions).map(([path, a]) => [path, toMeta(a)]),
    ));
```

### 3. `daemon/run-handler.ts`

`daemonActionSuggestionLines` and `daemonActionNearestSiblingLines` currently materialize `[...walkActions(...)]` and call `entriesUnder` to filter by prefix. With flat keys this is one expression:

```ts
// Before
function daemonActionSuggestionLines(entry, prefix) {
    const entries = [...walkActions(entry.runtime.collaboration.actions)];
    const descendants = entriesUnder(entries, prefix);
    return descendants.map(([path, action]) =>
        `  ${toDaemonActionPath(entry, path)}  (${action.type})`);
}
function entriesUnder(entries, prefix) {
    if (!prefix) return entries;
    const pfx = `${prefix}.`;
    return entries.filter(([path]) => path === prefix || path.startsWith(pfx));
}

// After
function daemonActionSuggestionLines(entry, prefix) {
    const pfx = prefix ? `${prefix}.` : '';
    return Object.entries(entry.runtime.collaboration.actions)
        .filter(([path]) => !pfx || path === prefix || path.startsWith(pfx))
        .map(([path, action]) =>
            `  ${toDaemonActionPath(entry, path)}  (${action.type})`);
}
```

`entriesUnder` becomes an inline filter and disappears.

Resolver:

```ts
// Before
const action = resolveActionPath(entry.runtime.collaboration.actions, localPath);

// After
const action = entry.runtime.collaboration.actions[localPath];
```

### 4. `client/daemon-actions.ts`

This file is the biggest single beneficiary. The whole depth-bounded recursion machinery exists only to mirror a nested authoring shape. Delete it:

```ts
// Delete
type MaxDepth = [1, 1, 1, 1, 1, 1, 1, 1];
type Inc<D> = [...D, 1];
type AtLimit<D> = D['length'] extends MaxDepth['length'] ? true : false;
type HasBrandedLeaves<T, D> = AtLimit<D> extends true ? false : ...;
type IsDaemonKey<V, D> = V extends Action ? true : ...;
type ActionPathKey<TKey> = TKey extends '' ? never : ...;

export type DaemonActions<T, D extends ReadonlyArray<1> = []> =
    AtLimit<D> extends true
        ? {}
        : Simplify<{ ...recursion... }>;
```

Replace with a one-level mapped type:

```ts
export type DaemonActions<TActions> = Simplify<{
    [K in keyof TActions & string]: TActions[K] extends Action
        ? WrapDaemonAction<TActions[K]>
        : never;
}>;
```

The recursive `Proxy` with `then`-masking at every level collapses to a flat proxy whose values are functions. No intermediate namespaces means no thenable trap:

```ts
// Before
function buildDaemonActionProxy(client, route) {
    const make = (path) => new Proxy(() => {}, {
        get(_t, prop) {
            if (typeof prop !== 'string') return undefined;
            if (prop === 'then') return undefined;       // mask at every level
            return make([...path, prop]);                // recurse
        },
        apply(_t, _this, args) { client.run(...); }
    });
    return make([]);
}

// After
function buildDaemonActionProxy(client, route) {
    return new Proxy({} as Record<string, unknown>, {
        get(_t, prop) {
            if (typeof prop !== 'string') return undefined;
            if (prop === 'then') return undefined;       // one place, not every level
            return (input?: unknown, options?: DaemonActionOptions) =>
                client.run({
                    actionPath: `${route}.${prop}`,
                    input,
                    waitMs: options?.waitMs ?? DEFAULT_RUN_WAIT_MS,
                });
        },
    });
}
```

### 5. `ai/tool-bridge.ts`

`ActionNames<T>` recursive flatten becomes a one-level transform:

```ts
// Before
export type ActionNames<T> = {
    [K in keyof T & string]: [T[K]] extends [Action]
        ? K
        : T[K] extends Record<string, unknown>
            ? `${K}_${ActionNames<T[K]>}`
            : never;
}[keyof T & string];

// After
type DotsToUnderscores<S extends string> =
    S extends `${infer A}.${infer B}` ? `${A}_${DotsToUnderscores<B>}` : S;

export type ActionNames<TActions> = {
    [K in keyof TActions & string]: TActions[K] extends Action
        ? DotsToUnderscores<K>
        : never;
}[keyof TActions & string];
```

The runtime side becomes `Object.entries(actions)` plus a single name transform:

```ts
// Before
const entries = Array.from(walkActions(source), ([path, action]) => {
    const segments = path.split('.');
    assertToolPathSegments(segments, path);
    return [action, segments] as const;
});
...
name: path.join(ACTION_NAME_SEPARATOR),

// After
const entries = Object.entries(actions).map(([path, action]) => {
    if (path.includes('_')) {
        throw new Error(`Action keys used as AI tools cannot contain "_": "${path}"`);
    }
    return [path, action] as const;
});
...
name: path.replaceAll('.', '_'),
```

The "underscore collision constraint" comment stops being a footnote about a recursive flatten and becomes a one-line guard at construction.

### 6. Tests

```ts
// Delete

test('resolution only follows routes that discovery can expose');  // class-instance fence
test('rejects dot-containing keys because the wire path uses dots');  // walker concern
test('rejects dot-containing object keys on action-bearing branches');  // recursive walker concern
test('falls back to "anonymous" when neither errorLabel nor title is set');  // fallback chain
test('falls back to action.title when no errorLabel provided');  // fallback chain
```

Add a single test that registers the new constraint:

```ts
test('registry keys are addresses; flat string lookup, no recursion', () => {
    const actions = {
        'entries.create': defineMutation({ handler: () => ({ id: 'x' }) }),
        'entries.update': defineMutation({ handler: () => ({ id: 'x' }) }),
    } satisfies ActionRegistry;

    expect(Object.keys(actions).sort()).toEqual(['entries.create', 'entries.update']);
    expect(actions['entries.create']).toBeDefined();
    // No segment walking. The key is the address.
});
```

## Boundaries diagram

```txt
Authoring           Registry             Boundaries

defineMutation()        Object.keys()    -> awareness actionPaths
defineQuery()    -->    {                -> peer.invoke(path, input)
                            'entries.       -> daemon `/run` actionPath=<route>.<path>
                              create':      -> daemon proxy actions[path](input)
                            ...,            -> AI tools (path -> path.replaceAll('.', '_'))
                        }                -> ActionManifest (just the same keys minus handlers)
                        satisfies ActionRegistry
```

No walker. No recursion. No segment loop. Every consumer reads `Object.entries` or indexes by string.

## What survives

| Survives | Why |
|---|---|
| `defineQuery` / `defineMutation` | Read/write distinction is product, not scaffolding. AI approval, UI semantics, telemetry. |
| `Action` (collapsed union) | One name, value-level discriminant. |
| `ActionRegistry` | The single shape. |
| `ActionMeta` / `ActionManifest` | Wire form for `peer.describe()`. Used by AI tool authoring. |
| `ActionHandler<TInput, R>` | Internal alias for the handler signature. Worth keeping for read clarity. |
| `ActionConfig<TInput, R>` | Internal alias for the `define*` config bag. |
| `invokeAction` / `invokeActionForRpc` | Boundary normalizers. Independent of registry shape. |
| `isAction` / `isQuery` / `isMutation` | SQLite materializer tests rely on them. |
| `RemoteCallOptions` | One field today (`timeout`). See open questions. |
| `title` / `description` (optional) | AI/UI overrides for friendlier labels. Optional remains the right default. |

## What dies

| Dies | Why |
|---|---|
| `Actions` recursive type | Replaced by flat `ActionRegistry`. |
| `walkActions` generator | `Object.entries` is the iterator. |
| `isPlainObject` class-instance fence | No recursion, no fence. |
| `isValidActionKey` / `assertValidActionKey` | One inline check at registry construction if needed at all. |
| `resolveActionPath` segment loop | `actions[path]` is the resolver. |
| `Query<TInput, R>` / `Mutation<TInput, R>` named types | Three aliases for one shape. The value discriminant is enough. |
| `ActionFailed` re-export | No external consumer. |
| `describeActions` as a public function | One expression at one caller. Inline. |
| `entriesUnder` daemon helper | One inline `filter`. |
| `DaemonActions<T>` recursion (`MaxDepth`, `Inc`, `AtLimit`, `HasBrandedLeaves`, `IsDaemonKey`, `ActionPathKey`) | One-level mapped type. |
| `buildDaemonActionProxy` recursive `Proxy` + `then`-masking at every level | Flat proxy, one `then` mask. |
| `ActionNames<T>` recursive flatten | One-level mapped type plus a tiny dots-to-underscores transform. |
| `assertToolPathSegments` | One inline check. |
| `errorLabel = action.title ?? 'anonymous'` fallback chain | Path is always at the call site now. |
| Tests: class-instance skip, recursive dot-key rejection, intermediate namespace thenable, anonymous fallback, title-fallback | Cover behavior that no longer exists. |

Approximate net deletion: 200+ lines of recursive types and runtime, plus 5 tests.

## Migration waves

The migration is one product change. Do it in one branch.

### Wave 1: Build

Add the flat shapes; keep the old ones running long enough to migrate apps.

- Add `export type ActionRegistry = Record<string, Action>` to `shared/actions.ts`.
- Add the collapsed `Action` type alongside the existing `Query`/`Mutation` (do not delete yet).
- Tighten `invokeAction` to require `errorLabel`; update package internal callers in one pass.
- Add the simplified `DaemonActions<T>` mapped type alongside the recursive one.
- Add the simplified daemon proxy alongside the recursive one.
- Add the simplified `ActionNames<T>` alongside the recursive one.

If TypeScript will not let two shapes coexist on the same exported names, swap them in this wave and migrate consumers in the same diff.

### Wave 2: Migrate apps

App factories switch to flat keys.

- `apps/fuji/.../workspace.ts`: `createFujiActions` returns flat record.
- `apps/honeycrisp/.../workspace.ts`: `createHoneycrispActions` returns flat record.
- `apps/opensidian/src/lib/opensidian/actions.ts`: `createOpensidianActions` returns flat record.
- `apps/tab-manager/src/lib/workspace/actions.ts`: `createTabManagerActions` returns flat record.
- `apps/whispering/src/lib/query/actions.ts`: check the shape; this one may be a different concept (rpc.actions, not workspace.actions).
- `packages/skills/src/node.ts`: update to flat keys if it owns a registry.

Local call sites switch to bracket form. Roughly the visible set:

```txt
apps/fuji/.../components/EntriesTable.svelte
apps/fuji/.../components/EntryEditor.svelte
apps/fuji/.../components/AppHeader.svelte
apps/fuji/.../components/FujiAppShell.svelte
apps/fuji/.../components/BulkAddModal.svelte
apps/fuji/.../components/EntriesTimeline.svelte
apps/fuji/.../trash/+page.svelte
apps/honeycrisp/.../state/folders.svelte.ts
apps/tab-manager/src/lib/state/bookmark-state.svelte.ts
apps/tab-manager/src/lib/state/saved-tab-state.svelte.ts
```

Pattern:

```ts
// Before
fuji.collaboration.actions.entries.create({});
Parameters<typeof fuji.collaboration.actions.entries.update>[0]

// After
fuji.collaboration.actions['entries.create']({});
Parameters<typeof fuji.collaboration.actions['entries.update']>[0]
```

### Wave 3: Prove

```txt
bun test packages/workspace/src/shared/actions.test.ts
bun test packages/workspace/src/document/open-collaboration.test.ts
bun test packages/workspace/src/daemon/run-handler.test.ts
bun test packages/workspace/src/client/daemon-actions.test.ts
bun test packages/workspace/src/ai/tool-bridge.test.ts
```

Plus app-level typechecks and grep:

```txt
grep -rn 'walkActions\|isPlainObject\|resolveActionPath' packages/workspace apps/
grep -rn 'actions\.\([a-z]\+\)\.\([a-z]\+\)(' apps/  # any remaining nested calls
```

### Wave 4: Remove

Delete the now-unused recursive types, runtime helpers, and tests listed under "What dies." Update JSDoc in `shared/actions.ts` so the module-level comment no longer talks about nested trees.

The "wire form vs in-memory form" framing in the current module comment becomes accurate again: there is one shape, and the wire form is just the same record minus handlers.

## Local ergonomics: explicit trade

```ts
// Before
fuji.collaboration.actions.entries.update({ id, title });

// After
fuji.collaboration.actions['entries.update']({ id, title });
```

The brackets are uglier. That is a real loss. It is the only loss. Every other surface gets simpler. App authors who want a shorter local name can alias inside the component module:

```ts
const updateEntry = fuji.collaboration.actions['entries.update'];
```

That is opt-in cosmetics, not framework convention.

## Edge cases

### Flat key validation

```txt
valid:
  entries.create
  files.read
  bash.exec
  removeAll

invalid:
  ""
  "."
  ".create"
  "entries."
  "entries..create"
```

Validation is one pass at registry construction if we keep it at all. TypeScript will not catch empty or dotted-suffix keys in a string literal, so an optional runtime check at `openCollaboration` startup is reasonable. Most invalid shapes will produce a `RpcError.ActionNotFound` at the wire when someone tries to call them, which is a fine failure mode.

### AI tool names

Provider regex is roughly `^[a-zA-Z0-9_-]+$`. We translate `'entries.create'` to `'entries_create'`. The constraint is unchanged from today: a key may not contain `_` if doing so would collide with another key's dot-to-underscore mapping. Easier to enforce at the literal because the keys are right there.

### Reserved names

There are no reserved names. `peer.describe()` rides the runtime request plane, not the action plane. An app may define `'system.foo'` as a flat action key and it does not collide with anything.

### Existing nested-namespace re-export

```ts
// Currently possible
const tabsActions = workspace.actions.tabs;
tabsActions.close({ ... });
```

This stops working. Nobody is doing it on the audited branch. If a future use case appears, group keys with an obvious prefix and let the caller destructure with `Object.fromEntries(Object.entries(actions).filter(([k]) => k.startsWith('tabs.')))`. Not worth a framework primitive.

## Open Questions

1. **Keep `RemoteCallOptions` as an object, or use a scalar `timeoutMs`?**
   - Option A: keep object. One field today (`timeout`), but `AbortSignal` was deliberately refused only because the wire lacks a CANCEL frame. Object form survives a future addition without changing every call site.
   - Option B: scalar. Smallest today.
   - Recommendation: keep object. The cost of changing every `peer.invoke` and `client.run` later is higher than the cost of one extra wrapping brace today.

2. **Keep `title` and `description` optional, or require one of them?**
   - Option A: both optional. Current behavior. AI tools fall back to `${type}: ${path}`.
   - Option B: require `description`. Forces every action to be self-explanatory at the source.
   - Recommendation: keep optional. Required description sounds disciplined and becomes a friction tax on internal-only actions that no AI ever sees.

3. **Inline `toMeta` at its sole caller, or keep it as a named helper?**
   - Option A: inline. The function is four lines.
   - Option B: keep named. Reads as "produce wire form."
   - Recommendation: inline. The name does not earn its own line in a flat-registry world.

4. **Drop `isAction`/`isQuery`/`isMutation` and use structural checks?**
   - The SQLite materializer tests use them. They are three small functions. Not worth the churn. Keep.

## Final State Checklist

- [x] `ActionRegistry = Record<string, Action>` is the single registry shape.
- [x] `defineQuery`/`defineMutation` take config; return is `Action`.
- [x] No `defineActions` helper exists.
- [x] No `walkActions`, `isPlainObject`, `resolveActionPath` segment loop, `assertValidActionKey` recursion.
- [x] No recursive types in `client/daemon-actions.ts` or `ai/tool-bridge.ts`.
- [x] Daemon proxy is one level of property access.
- [x] `invokeAction` requires `errorLabel`.
- [x] `Query`/`Mutation`/`ActionFailed` named aliases removed; callers use `Action` and `RpcError.ActionFailed` directly.
- [x] `describeActions` removed; both internal call sites use the exported `toActionMeta` helper directly (deviation: kept a one-line internal helper instead of inlining at the only-one site, because there are two call sites: `open-collaboration.ts` and `daemon/app.ts`).
- [x] All app factories return flat records with `satisfies ActionRegistry`.
- [x] All in-app action call sites use bracket syntax.
- [x] No tests for behavior that no longer exists (class-instance fence, intermediate proxy thenable, anonymous fallback).

## Why the asymmetric win

| Lose | Gain |
|---|---|
| Nested visual grouping at the authoring site | One address everywhere |
| Cute `actions.entries.create({})` local syntax | `Object.entries`/`actions[path]` for every consumer |
| 30 call sites change once | ~200 lines of recursive types and runtime deleted |
| `defineActions` helper (would have been the identity function) | One fewer primitive in the public surface |

The product sentence reads cleanly without the rest. The collapse is not three separate refactors; it is one shape change that lets the surrounding code stop apologizing for itself.

## Review

**Completed**: 2026-05-13
**Branch**: `codex/sync-room-plus-stacked-refactors`
**Commits**: `df3d444fe` (workspace internals), `84ab9fba3` (spec), `e81ce2664` (apps + CLI fixtures).

### Summary

`ActionRegistry = Record<string, Action>` is now the only registry shape. The recursive `Actions` type, the `walkActions` generator, the `resolveActionPath` segment loop, the `isPlainObject` class fence, the `Query`/`Mutation`/`ActionFailed` named aliases, and the recursive daemon proxy + AI bridge type machinery are gone. `invokeAction` requires `errorLabel`. `Action<TInput, R, TType>` now carries the type discriminant at the type level, so consumers narrowing on `action.type === 'mutation'` get full inference. Four app factories (fuji, honeycrisp, opensidian, tab-manager) author flat records with `satisfies ActionRegistry` and the matching public type is derived with `ReturnType<typeof createXxxActions>`.

### Deviations from Spec

- **`toActionMeta` kept as an internal helper.** Spec open question #3 recommends inlining at the single caller, but there are two callers (`open-collaboration.ts` and `daemon/app.ts`). One internal helper beats two copies of the same `if input !== undefined; if title !== undefined; if description !== undefined` conditional spread.
- **`Action` is parameterized on `TType`.** A linter pass during Wave 1 added a third type parameter `TType extends ActionType = ActionType`. This preserves the type discriminant at the type level (so `defineQuery` returns `Action<_, _, 'query'>`), which gives downstream consumers narrowing on `action.type` better inference than my initial monomorphic union. Kept.
- **Fixed a pre-existing test assertion** in `run-handler.test.ts`: the case was named "peer miss returns RunError.RemoteCallFailed" but the implementation returns `PeerNotFound` directly, matching its JSDoc. Test now expects `PeerNotFound`. Unrelated to this refactor; surfaced because the test gate had to be green for Wave 1.
- **File moves outside spec scope.** Mid-session, the user/linter moved `apps/<x>/src/routes/.../workspace.ts` to `apps/<x>/blocks/workspace.ts` and renamed `definition.ts -> blocks/workspace.ts` for opensidian and tab-manager. These are tracked as renames in the Wave 2 commit; the action-key flattening sits on top of the moves.

### Verification

- `bun test packages/workspace packages/cli packages/skills` → 681 pass / 1 todo / 0 fail (1709 expectations).
- `bun run tsc --noEmit` clean for apps/fuji, apps/honeycrisp, apps/opensidian. The tab-manager check surfaces two pre-existing errors in `packages/ui/src/confirmation-dialog/index.ts` (named imports from a `.svelte` module with default-only export); unrelated to this refactor.
- Final grep sweep: no remaining imports of `Actions`, `Query`, `Mutation`, `ActionFailed`, `walkActions`, `resolveActionPath`, `describeActions`. No remaining `actions.<ns>.<verb>(` call sites.

### Follow-up Work

- The pre-existing `packages/ui/src/confirmation-dialog/index.ts` import shape and the two `packages/workspace/src/document/peer.test.ts` typecheck errors deserve a separate cleanup pass.
- `Peer<TActions>` keeps a `TActions = unknown` default and its `invoke<TMap extends RpcActionMap>` overload uses a manually-authored `RpcActionMap` shape, not `ActionRegistry`. This means typed peer dispatch still requires the app to write its own `{ 'foo.bar': { input, output } }` map. Worth a future spec to unify.
