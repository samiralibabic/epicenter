# defineActions: Compile-Time + Runtime Key Validation

**Date**: 2026-05-13
**Status**: Implemented
**Author**: Braden + Claude
**Supersedes** (the validation portion of): `20260513T231157-actions-snake-case-only-no-dots.md`

## Sentence

```txt
Authors call defineActions({...}) instead of {...} satisfies ActionRegistry.
The same helper enforces snake_case at compile time (template-literal type)
and at construction (regex test), so bad keys fail at the edit site, not at
app boot.
```

One owner per invariant. `defineActions` owns the key shape, in types and at runtime.

## Why this spec adds beyond the prior draft

The snake_case spec landed on a runtime-only check inside `openCollaboration`:

```ts
for (const key of Object.keys(userActions)) {
    if (!ACTION_KEY_PATTERN.test(key)) throw new Error(...);
}
```

It explicitly refused a template-literal validator with this reasoning:

> A regex compile-time check on `Record<string, T>` keys is possible but
> expensive in compile time and noisy in errors. Runtime check at app boot
> is cheap and clear.

Both halves of that are wrong on closer look. Verified empirically against
this repo:

1. **Compile time is cheap.** The recursive type bottoms out at 64 characters.
   `arkregex` already lives in `node_modules`; we measured it. The much heavier
   `DaemonActions<T, D extends ReadonlyArray<1>>` recursion that the path-first
   spec deleted was an 8-level walker traversing arbitrary object shapes, and
   it shipped for months. A 64-step linear walk on individual string keys is
   nothing in comparison.

2. **Errors are not noisy if branded with a message.** Using the same
   `​`-suffix trick `arktype`'s `@ark/util/ErrorMessage` uses, the error
   reads as an English sentence:
   ```
   Type 'Action' is not assignable to type
   'Invalid action key "tabs.close", must be snake_case ASCII'.
   ```

3. **arktype/arkregex does not unify the two sources of truth.** Verified:
   `arkregex@0.0.5` infers `regex('^[a-z][a-z0-9_]*$')` to `Regex<string>`
   because character classes are intentionally widened to avoid combinatorial
   explosion. We need a hand-written template-literal type either way.

4. **The "find out at boot" failure mode is real.** The path-first execution
   surfaced exactly this: authoring `'tabs.close'` (a dotted leftover) typechecked
   fine, shipped, and crashed two tests at `openCollaboration` startup. The
   type-level check would have flagged it at the edit site.

The runtime check stays. It catches `Object.fromEntries(dynamic)` registries
and `as ActionRegistry` casts that bypass the type. But the runtime check
moves **inside** `defineActions`, so there is one owner.

## Decision

### Authoring

```ts
// packages/workspace/src/shared/actions.ts

const LOWER = ['a','b','c','d','e','f','g','h','i','j','k','l','m',
               'n','o','p','q','r','s','t','u','v','w','x','y','z'] as const;
type Lower = typeof LOWER[number];
type Digit = '0'|'1'|'2'|'3'|'4'|'5'|'6'|'7'|'8'|'9';
type WordChar = Lower | Digit | '_';

type IsTail<S extends string> =
    S extends ''                                ? true
    : S extends `${WordChar}${infer Rest}`      ? IsTail<Rest>
                                                : false;

type IsSnakeCase<S extends string> =
    S extends `${Lower}${infer Rest}`
        ? IsTail<Rest> extends true ? true : false
        : false;

/**
 * Branded error message returned from `ValidatedKey<S>` for invalid keys.
 * The trailing `​` (zero-width space) makes this literal type structurally
 * distinct from any plain string a user could type. TypeScript renders the
 * message in IDE tooltips without showing the invisible character.
 *
 * Pattern borrowed from `@ark/util`'s `ErrorMessage`. See
 * `docs/articles/<date>-type-level-error-messages.md`.
 */
type InvalidActionKey<S extends string> =
    `Invalid action key "${S}", must be snake_case ASCII matching /^[a-z][a-z0-9_]*$/​`;

type ValidatedKey<S extends string> =
    IsSnakeCase<S> extends true ? S : InvalidActionKey<S>;

export const ACTION_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export function defineActions<T extends ActionRegistry>(
    actions: {
        [K in keyof T & string]: ValidatedKey<K> extends string
            ? T[K]
            : ValidatedKey<K>;
    },
): T {
    for (const key of Object.keys(actions)) {
        if (!ACTION_KEY_PATTERN.test(key)) {
            throw new Error(
                `Invalid action key "${key}". Must match ${ACTION_KEY_PATTERN.source}.`,
            );
        }
    }
    return actions as T;
}
```

App factories switch from `satisfies` to the helper:

```ts
// Before (snake_case spec, runtime-only)
export function createFujiActions(tables: FujiTables) {
    return {
        entries_create: defineMutation({...}),
        ...
    } satisfies ActionRegistry;
}

// After
export function createFujiActions(tables: FujiTables) {
    return defineActions({
        entries_create: defineMutation({...}),
        ...
    });
}
```

The exported type stays derived:

```ts
export type FujiActions = ReturnType<typeof createFujiActions>;
```

`ReturnType<typeof defineActions<TGuess>>` widens to `T`, preserving the
literal key types in the returned shape.

### Validation moves to one place

`openCollaboration` drops its key-validation loop. The trust chain is:

```txt
authoring -> defineActions({...})           edit-time TS error + boot-time regex
openCollaboration({ actions })              trusts what defineActions produced
peer wire -> userActions[badKey]            ActionNotFound (already defensive)
```

If someone bypasses `defineActions` (cast, raw object literal, dynamic
build), the wire path still returns `ActionNotFound` per `rpc.action`, not
silent dispatch. There is no security or correctness hole, only a slightly
later error report for misuse that the type system already flagged.

### What dies beyond the prior spec

| Dies | Why |
|---|---|
| Key-validation loop in `openCollaboration` | `defineActions` owns the rule. |
| `satisfies ActionRegistry` on every app factory | `defineActions({...})` carries the constraint. |
| The implicit "you must remember to validate" contract | Replaced by a typed function. |

### What's added

| Added | Cost |
|---|---|
| `defineActions` helper | ~10 lines incl. types. |
| `IsSnakeCase`, `IsTail`, `ValidatedKey`, `InvalidActionKey` types | ~12 lines. |
| `LOWER` const + `Lower`/`Digit`/`WordChar` types | ~3 lines. |
| Export `defineActions` from the package barrel | One line. |

Net: ~25 lines added in `shared/actions.ts`, ~5 lines removed from
`openCollaboration.ts`. Significant ergonomics win.

## The ​ trick (one paragraph for the spec body)

TypeScript template literal types are great for embedding human-readable
errors at the type level, but a raw error message like `'Invalid action
key "${S}"'` has two pitfalls: autocomplete will suggest the message as
a valid string value when the contextual type accepts it, and the literal
might accidentally match `S extends string` checks in other unrelated
type machinery. Appending `​` (Unicode zero-width space) brands the
type with an invisible character no user would type, killing both the
autocomplete suggestion and the accidental-match risk. TypeScript renders
the brand in IDE error tooltips without showing the character, so the
developer sees the clean message. `arktype` uses exactly this pattern in
its internal `ErrorMessage<M>` type. We replicate it locally rather than
reach into `@ark/util` (not part of arktype's public surface).

## Migration shape

This sits on top of the snake_case spec's Wave 1 (already partially
landed). Order:

### Wave A: Helper

- Add `IsSnakeCase`, `ValidatedKey`, `InvalidActionKey`, `defineActions`
  to `shared/actions.ts`.
- Export `defineActions` from `packages/workspace/src/index.ts`.
- Remove the duplicate `for (const key of Object.keys(...))` validation
  loop from `open-collaboration.ts`.
- Update tests in `shared/actions.test.ts`: add cases that compile-time-fail
  on bad keys (via `@ts-expect-error`) and runtime-throw on dynamic bad keys.

### Wave B: Snake_case migration + helper adoption

This is the deferred work from the snake_case spec, executed simultaneously
because the type-level check is what makes the work safe.

Per app, rename every key from dotted to snake_case AND switch the factory
to `defineActions({...})`:

```ts
// apps/fuji/.../workspace.ts
//   'entries.create'       -> entries_create
//   'entries.getAllValid'  -> entries_get_all_valid
//   'entries.bulkCreate'   -> entries_bulk_create
//   ...
//   } satisfies ActionRegistry  -> } )   inside  return defineActions({
//
// apps/honeycrisp/...           'folders.delete' -> folders_delete
// apps/opensidian/...           'files.read' -> files_read, 'bash.exec' -> bash_exec
// apps/tab-manager/...          'tabs.close' -> tabs_close, 'savedTabs.save' -> saved_tabs_save
```

Update call sites from bracket-string to dot-access:

```ts
// Before
fuji.collaboration.actions['entries.create']({})
Parameters<typeof fuji.collaboration.actions['entries.update']>[0]

// After
fuji.collaboration.actions.entries_create({})
Parameters<typeof fuji.collaboration.actions.entries_update>[0]
```

CLI fixtures and tests follow the same rename.

### Wave C: AI bridge collapse (already drafted in snake_case spec)

- Drop `DotsToUnderscores<S>`.
- Drop `ACTION_NAME_SEPARATOR` constant.
- Drop both `path.replaceAll('.', '_')` sites.
- Drop the underscore-collision `throw`.
- `ActionNames<T>` becomes the identity over registry keys.

### Wave D: Skill + article

External-facing outputs (separate from production code):

- `.claude/skills/type-level-error-messages/SKILL.md`: when to apply the
  pattern, how to wire it, the `​` brand, common pitfalls.
- `docs/articles/<ts>-type-level-error-messages.md`: longer-form post on
  the pattern with the snake_case key example, why arktype uses
  zero-width space, and a comparison to the alternative branded-object
  approach.

### Wave E: Verify

- `bun test packages/workspace packages/cli packages/skills`
- `bun run tsc --noEmit` per app
- Grep sweep for stale dotted keys

## Test gates

```bash
# Wave A
bun test packages/workspace/src/shared/actions.test.ts

# Wave B (after all apps migrated)
bun run tsc --noEmit  # in each app
bun test

# Wave C
bun test packages/workspace/src/ai/tool-bridge.test.ts
```

## Edge cases

### What if a key has length > 64?

Regex `/^[a-z][a-z0-9_]{0,63}$/` caps at 64. The type's recursive
`IsTail<S>` does not encode length and would accept arbitrary lengths.
That is fine: the runtime catches length, the type catches charset. The
two checks are complementary, not redundant.

### What if an app authoring file passes a `Record<string, Action>` from a
helper (e.g. spreading from a shared factory)?

The contextual type for `defineActions(...)`'s parameter is the mapped
type `{ [K in keyof T & string]: ValidatedKey<K> extends string ? T[K] : ValidatedKey<K> }`.
A spread of a typed `Record<string, Action>` keeps `K = string`, which
fails `IsSnakeCase<string>`, so the helper rejects it at compile time.
Authors get a clear error pointing at the spread.

If the spread source has literal keys (typed by a sibling factory), the
literal keys flow through and validate individually. This is the common
case for composing multiple factory outputs.

### What if a user uses `as` to bypass?

`actions as ActionRegistry` bypasses the type check, but the runtime
check inside `defineActions` still throws. The wire layer still returns
`ActionNotFound` for bad keys. There is no path to silent dispatch.

### Why not `unique symbol` for the brand?

A `unique symbol` works for nominal types on objects (`type Brand<T, K>
= T & { [tag]: K }`) but does not compose with template literal types.
You cannot put a symbol inside `Invalid key "${S}"`. The whole point of
this pattern is that the **error message itself** is the brand. The
`​` suffix preserves that while preventing the autocomplete and
match-shadow risks.

### Why not `@ark/util`'s `ErrorMessage<M>` directly?

It is not re-exported from `arktype`'s public barrel; importing from
`@ark/util` reaches into a private subpath. Inlining the pattern is
three lines and keeps the workspace package free of internal-API
dependencies.

## Final state checklist

- [x] `defineActions<T>(actions)` exported from `packages/workspace/src/shared/actions.ts` and re-exported from the package barrel
- [x] `IsSnakeCaseKey`, `IsActionKeyTail`, `InvalidActionKey` types live alongside it
- [x] `ACTION_KEY_PATTERN` regex still exported
- [x] Runtime check inside `defineActions`. `openCollaboration` keeps its own pass as belt-and-suspenders defense for casts that bypass the helper (deviation from spec)
- [x] All app factories use `defineActions({...})` instead of `satisfies ActionRegistry`
- [x] All app action keys are snake_case ASCII matching `^[a-z][a-z0-9_]*$`
- [x] All call sites use dot-access (`actions.tabs_close`) not bracket-string
- [x] AI bridge collapsed (no `DotsToUnderscores`, no `ACTION_NAME_SEPARATOR`, no `replaceAll('.', '_')`)
- [x] CLI fixtures and inline-test fakes use snake_case keys + `defineActions`
- [x] `bun test packages/workspace packages/cli packages/skills` green: 690 pass, 1 todo, 0 fail
- [x] Per-app `bun run tsc --noEmit` clean for fuji, honeycrisp, opensidian (tab-manager has pre-existing unrelated UI errors)
- [x] Skill at `.claude/skills/type-level-error-messages/SKILL.md`
- [x] Article at `docs/articles/20260513T235515-type-level-error-messages.md`

## Review

**Completed**: 2026-05-13
**Branch**: `codex/sync-room-plus-stacked-refactors`
**Commits**:
- `417132bdf` workspace: defineActions + validation types + tests + spec
- `02f836373` apps: adopt defineActions, snake_case fixtures, drop dead replica-id export
- `3db03570f` docs: skill + article

### Summary

`defineActions<T>(actions)` is now the recommended (and only documented) way to author an `ActionRegistry`. The helper enforces snake_case keys at compile time via a recursive template-literal type `IsSnakeCaseKey<S>` and at construction via `ACTION_KEY_PATTERN`. Bad keys fail at the property in the editor with a readable error message branded with U+200B (the same trick `@ark/util`'s internal `ErrorMessage<M>` uses). Four app factories and CLI test fixtures adopted the helper.

### Deviations

- **Runtime check stayed in `openCollaboration` too.** The spec originally said "one owner per invariant: defineActions". The linter kept reintroducing the check at the wire boundary and added a test for it. Accepting that as belt-and-suspenders: both layers are cheap, the wire-side guards against `as ActionRegistry` casts that bypass the helper, and the cost is five lines.
- **Removed a dead `replica-id.js` re-export** from `packages/workspace/src/index.ts` discovered during this work. The file did not exist on disk; CLI `up` lifecycle tests were failing because the daemon could not import `@epicenter/workspace`. Cleanup unrelated to this spec but it surfaced during verification.

### Verification

- 690 tests pass, 1 todo, 0 fail across workspace + cli + skills.
- Three of four apps typecheck clean. tab-manager surfaces only pre-existing `packages/ui/src/confirmation-dialog/index.ts` TS2614 errors (default vs named imports), unrelated.
- Grep across `apps/` and `packages/` for dotted action keys (`'tabs.close'`, `'entries.create'`, etc.) returns only legitimate hits: error-context strings in `TabError.BrowserApiFailed({ operation: 'tabs.create' })`, JSDoc examples, and the test cases that intentionally exercise rejection.

### Follow-up

- `packages/ui/src/confirmation-dialog/index.ts` has named imports from a `.svelte` module with default-only export. Pre-existing, unrelated, worth a separate cleanup pass.
- Could extract the U+200B-branded template literal pattern (`InvalidActionKey<S>`) into a generic `BrandedError<M>` helper if a second use surfaces. Skipping for now (one caller).

## One-line summary for commit message

```
refactor(actions): add defineActions helper with type-level key validation
```
