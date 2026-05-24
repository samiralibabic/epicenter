# Tier 2: Actions Documentation Rewrite

**Date**: 2026-05-14
**Status**: Implemented
**Author**: Braden + Claude
**Follow-up to**: `20260513T233714-define-actions-typed-key-validation.md`

## Sentence

Three published docs (`packages/workspace/README.md`, `packages/workspace/SYNC_ARCHITECTURE.md`, `packages/ai/README.md`) still describe the pre-snake_case action world: nested authoring, `walkActions`, `describeActions`, `type Mutation`/`type Query`, dot-to-underscore tool name projection. Bring them current with `defineActions`, flat snake_case keys, and no projection.

## Why

Source code is clean post-refactor. Docs lag. Anyone copy-pasting the action examples from `packages/workspace/README.md` today will hit:

- `Cannot find name 'walkActions'` (export removed)
- `Module has no exported member 'Mutation'` (type removed)
- `'tabs.close' is not assignable to '"Invalid action key …"'` (snake_case enforced)

Same on the AI side: `packages/ai/README.md` says `actionsToAiTools()` walks the source with `walkActions()`. It does not; it uses `Object.entries`.

This is a documentation pass, not a code refactor. Drafted as a separate spec so it can be executed by an agent, a human, or a /loop later without holding up the actions work.

## Out of scope

- Any code change. If a doc claim contradicts the code, fix the doc.
- New examples that aren't already in the existing docs.
- The articles in `docs/articles/` (each is point-in-time prose; leave historical accuracy alone unless a claim is misleading today).
- The historical specs (`20260513T200000-workspace-surface-clean-break-vision.md`, `20260513T210000-actions-path-first-clean-break.md`, `20260513T231157-actions-snake-case-only-no-dots.md`). Status fields are already set; bodies are records of decisions.

## Execution note

Current status: already implemented in the published docs. `packages/workspace/README.md`, `packages/workspace/SYNC_ARCHITECTURE.md`, and `packages/ai/README.md` already describe flat `ActionRegistry` authoring with `defineActions({...})`, snake_case action keys, `Object.entries(...)` iteration, and AI tool names that equal action keys verbatim.

Implemented now: marked this spec as implemented and kept the docs unchanged because the current tracked files already match the source barrel in `packages/workspace/src/index.ts`.

Out of scope now: no source changes, no article rewrites, and no historical spec rewrites.

Validation: stale-term greps below should return zero hits except generic words such as `Actions` in headings or type names like `Collaboration<TActions>`.

## Affected files

```
packages/workspace/README.md           (~1700 lines, several sections touched)
packages/workspace/SYNC_ARCHITECTURE.md (one sequence diagram cell)
packages/ai/README.md                   (three lines + adjacent claims)
```

## Handoff prompt

Use this prompt to delegate the work. Self-contained.

---

You are updating three published documentation files to match the current state of the action system in `@epicenter/workspace` after a clean-break refactor. The runtime/source code is already correct. Only update the docs.

### Current state of the system (truth)

1. `ActionRegistry` is a flat record: `Record<string, Action>`. No nesting.
2. Action keys are snake_case ASCII matching `/^[a-z][a-z0-9_]{0,63}$/`. Validated at compile time (template-literal type `IsSnakeCaseKey<K>`) and at runtime (`ACTION_KEY_PATTERN`).
3. App factories return `defineActions({...})`, never `... satisfies ActionRegistry`.
4. The AI tool name equals the action key verbatim. No `replaceAll('.', '_')`, no `DotsToUnderscores<S>`, no projection of any kind.
5. The manifest produced by `peer.describe()` and the daemon `/list` route is built with `Object.entries(actions).map(([key, action]) => [key, toActionMeta(action)])`, NOT `describeActions(actions)`.
6. Removed exports: `Actions` (recursive type), `Query` (alias), `Mutation` (alias), `ActionFailed` (re-export), `walkActions`, `describeActions`, `resolveActionPath`, `ActionMeta` (no longer in barrel), `isQuery` (no longer in barrel), `isMutation` (no longer in barrel).
7. Surviving public exports (in `packages/workspace/src/index.ts`): `Action`, `ActionManifest`, `ActionRegistry`, `ACTION_KEY_PATTERN`, `defineActions`, `defineMutation`, `defineQuery`, `invokeAction`, `invokeActionForRpc`, `isAction`, `toActionMeta`.

### File 1: `packages/workspace/README.md`

Audit the whole `## Core Concepts` to `### Actions` section (around line 395) and the worked examples around lines 1085-1280. The pattern of stale claims is:

- Authoring shape: examples use `actions = { posts: { list: defineQuery(...) } }`. Rewrite to flat:
  ```ts
  const actions = defineActions({
      posts_list: defineQuery({...}),
      posts_get_by_id: defineQuery({...}),
      posts_create: defineMutation({...}),
      posts_publish: defineMutation({...}),
  });
  ```
- Type extraction: `workspace.actions.posts.list.type` → `workspace.actions.posts_list.type`.
- Any mention of `walkActions(...)` → replace with `Object.entries(actions)`. Around line 333 in the "Use `walkActions(...)` and each action's metadata" callout, rewrite to:
  > Iterate `Object.entries(actions)` and read each action's metadata (`type`, `title`, `description`, `input`) if you want to build adapters such as HTTP, CLI, or MCP.
- Any import of `type Mutation`, `type Query`, or `Actions` from `@epicenter/workspace`: remove. They are not exported. If an example needs to type a registry it does so via `ReturnType<typeof createXxxActions>`.
- Any "nested action tree" prose: rewrite as "flat action registry". The registry is one level deep, keyed by snake_case.
- Any mention of `describeActions(actions)`: replace with the inline form, or rewrite as "the wire form is the registry minus handlers" without naming a function.
- Any "namespace" / "segments" wording: rewrite as prefix convention. Hierarchy is a string-prefix matter, not a syntactic one. "All posts actions" = `Object.entries(actions).filter(([k]) => k.startsWith('posts_'))`.

Run after editing:
```bash
grep -n "walkActions\|describeActions\|type Mutation\|type Query\|: Actions\b" packages/workspace/README.md
# Should return zero hits.

grep -n "actions: { [a-z]\+: { [a-z]\+" packages/workspace/README.md
# Should return zero hits (no nested authoring shape).
```

### File 2: `packages/workspace/SYNC_ARCHITECTURE.md`

One spot: the sequence diagram around line 425. It currently shows:

```
6. switch(rpc.verb) {
     case 'describe-actions':
       return Ok(describeActions(userActions))
   }
```

Replace with the actual code shape:

```
6. switch(rpc.verb) {
     case 'describe-actions':
       return Ok(
         Object.fromEntries(
           Object.entries(userActions).map(([key, action]) =>
             [key, toActionMeta(action)]
           )
         )
       )
   }
```

Keep the column alignment so the ASCII diagram still renders cleanly. If the line wraps and breaks the box, write it as: `return Ok(toManifest(userActions))` and add a footnote pointing to `toActionMeta` and the inline `Object.entries(...)` map.

### File 3: `packages/ai/README.md`

Three specific lines plus surrounding sentences:

Line 28:
> Workspace actions are nested objects. `actionsToAiTools()` walks the source with `walkActions()` from `@epicenter/workspace`, joins path segments with `_`, and returns TanStack AI client tools plus wire-safe definitions.

Rewrite:
> Workspace actions are a flat `ActionRegistry` keyed by snake_case strings. `actionsToAiTools()` reads each entry with `Object.entries(actions)` and returns TanStack AI client tools plus wire-safe definitions. The AI tool name is the action key verbatim; there is no projection.

Line 40 (under `### actionsToAiTools(source)`):
> Converts an action tree into TanStack AI client tools and JSON definitions. Tool names come from the action path, so a nested action like `tabs.close` becomes `tabs_close`.

Rewrite:
> Converts an action registry into TanStack AI client tools and JSON definitions. The tool name is the action key (already snake_case ASCII), e.g. an action keyed `tabs_close` produces a tool named `tabs_close`.

Line 59:
> `@epicenter/workspace` defines actions and exposes `walkActions()`.

Rewrite:
> `@epicenter/workspace` defines actions and exposes `defineActions` / `defineQuery` / `defineMutation`.

After the rewrites, grep `packages/ai/README.md` for `walkActions`, `path`, `nested`, `segments`, `projection`, `tree`. Any remaining hit should refer to AI tooling concepts (TanStack AI's tool tree, for example), not workspace actions.

### Final verification

```bash
# No stale terms anywhere in published docs
grep -rn "walkActions\|describeActions\|type Mutation\|type Query\|DotsToUnderscores\|ACTION_NAME_SEPARATOR" \
  packages/workspace/README.md \
  packages/workspace/SYNC_ARCHITECTURE.md \
  packages/ai/README.md
# Should return zero hits.

# Spot-check by typechecking an example. Paste one example block into a scratch
# .ts file in any app and run `bun run tsc --noEmit`. It should compile.
```

### Constraints

- No em dash or en dash characters. Use colon, comma, semicolon, parenthesis, or sentence break.
- No emojis (existing docs do not use them).
- Keep section ordering and headings unless a heading is itself stale.
- Where two equivalent phrasings exist, prefer the one that names the actual API in `packages/workspace/src/index.ts`.

### Commit message

```
docs: rewrite action sections in three READMEs for snake_case + defineActions

- packages/workspace/README.md: flat ActionRegistry authoring with
  defineActions, remove walkActions/describeActions/type Mutation/type
  Query references, rewrite "nested action tree" prose as flat
  prefix-keyed registry.
- packages/workspace/SYNC_ARCHITECTURE.md: sequence diagram cell now
  shows the actual Object.entries + toActionMeta inline form.
- packages/ai/README.md: tool name equals action key verbatim; no
  projection; uses Object.entries, not walkActions.
```

---

## Notes for the operator

If you fire this as an agent prompt, set `subagent_type: general-purpose` and pass it the full text above plus a one-line summary like "Execute Tier 2 documentation rewrite per the prompt." The agent has everything it needs and can verify its own work with the grep commands.

If you do it by hand, follow the runbook below. The workspace README is the long one. Open it, search-and-replace the recurring phrases first (`walkActions` → `Object.entries`, `type Mutation` → remove, nested examples → flat), then read the section narratively to catch anything that's correct in the small but inconsistent in the large.

Estimated effort:
- workspace README: ~30 minutes (largest, most examples)
- SYNC_ARCHITECTURE: ~5 minutes (one diagram cell)
- ai README: ~10 minutes (three lines + surrounding paragraphs)

## Hand execution runbook

Step-by-step instructions for executing this by hand. Follow in order.

### Pre-flight

```bash
cd /Users/braden/Code/epicenter
git status   # should be clean or only have unrelated work
```

Open three files in your editor side-by-side:
1. `packages/workspace/README.md`
2. `packages/workspace/SYNC_ARCHITECTURE.md`
3. `packages/ai/README.md`

Keep this spec file open in a fourth tab.

### Step 1: workspace README, the imports block (line ~1489)

Search for `### Actions` in `packages/workspace/README.md`. There are two; find the one inside `## Public adapter surface` (around line 1489).

Current:
```typescript
import {
    defineMutation,
    defineQuery,
    isAction,
    isMutation,
    isQuery,
    walkActions,
    type Action,
    type Mutation,
    type Query,
} from '@epicenter/workspace';
```

Replace with:
```typescript
import {
    defineActions,
    defineMutation,
    defineQuery,
    isAction,
    toActionMeta,
    type Action,
    type ActionRegistry,
} from '@epicenter/workspace';
```

Why each change:
- `walkActions` is gone; consumers iterate `Object.entries(actions)`.
- `isMutation` and `isQuery` are dropped from the public barrel (Tier 1).
- `type Mutation` and `type Query` are gone; both collapsed into `Action<TInput, R, TType>`.
- `defineActions` and `toActionMeta` are the new helpers worth surfacing.
- `ActionRegistry` is the type to name when documenting the registry shape.

### Step 2: workspace README, the introspection example (lines 1235-1280)

Look for `### Introspection` (around line 1236).

Current shape:
```typescript
import {
    defineMutation,
    defineQuery,
    isAction,
    isMutation,
    isQuery,
    walkActions,
} from '@epicenter/workspace';

const actions = {
    posts: {
        list: defineQuery({ handler: () => [] as string[] }),
        create: defineMutation({
            input: Type.Object({ title: Type.String() }),
            handler: ({ title }) => ({ title }),
        }),
    },
};

for (const [path, action] of walkActions(actions)) {
    if (isAction(action)) {
        console.log(path, action.type);
    }
}

const listAction = actions.posts.list;
if (isQuery(listAction)) {
    console.log(listAction.type);
}

const createAction = actions.posts.create;
if (isMutation(createAction)) {
    console.log(createAction.type);
}
```

Replace with:
```typescript
import {
    defineActions,
    defineMutation,
    defineQuery,
    isAction,
} from '@epicenter/workspace';
import Type from 'typebox';

const actions = defineActions({
    posts_list: defineQuery({ handler: () => [] as string[] }),
    posts_create: defineMutation({
        input: Type.Object({ title: Type.String() }),
        handler: ({ title }) => ({ title }),
    }),
});

for (const [key, action] of Object.entries(actions)) {
    if (isAction(action)) {
        console.log(key, action.type);
    }
}

const listAction = actions.posts_list;
if (listAction.type === 'query') {
    console.log(listAction.type);
}

const createAction = actions.posts_create;
if (createAction.type === 'mutation') {
    console.log(createAction.type);
}
```

Why: `isQuery`/`isMutation` were dropped from the barrel; consumers narrow on `action.type` directly. The discriminant is carried by `Action<_, _, TType>`.

### Step 3: workspace README, the queries example (lines 1080-1130)

Search for `### Query actions`. Replace nested authoring with flat + `defineActions`:

```typescript
const actions = defineActions({
    posts_list: defineQuery({
        title: 'List Posts',
        description: 'List all posts.',
        handler: () => tables.posts.getAllValid(),
    }),
    posts_get_by_id: defineQuery({
        title: 'Get Post',
        description: 'Get one post by ID.',
        input: Type.Object({ id: Type.String() }),
        handler: ({ id }) => tables.posts.get(id),
    }),
});
```

Add `defineActions` to the imports list at the top of that example block.

Update the trailing assertion at line ~1126:
```typescript
// Before
const actionType = workspace.actions.posts.list.type;

// After
const actionType = workspace.actions.posts_list.type;
```

### Step 4: workspace README, the mutations example (lines 1145-1200)

Search for `### Mutation actions`. Same treatment:

```typescript
const actions = defineActions({
    posts_create: defineMutation({
        title: 'Create Post',
        description: 'Create a new post row.',
        input: Type.Object({ title: Type.String() }),
        handler: ({ title }) => {
            const id = generateId();
            tables.posts.set({ id, title, published: false, _v: 1 });
            return { id };
        },
    }),
    posts_publish: defineMutation({
        title: 'Publish Post',
        description: 'Mark a post as published.',
        input: Type.Object({ id: Type.String() }),
        handler: ({ id }) => tables.posts.update(id, { published: true }),
    }),
});
```

Add `defineActions` to the imports.

### Step 5: workspace README, the Actions Concepts paragraph (line ~395)

Replace:
> Include them in your bundle as `actions: { ... }` (typically via a `createMyAppActions({ tables, batch })` helper defined nearby)

With:
> Include them in your bundle as `actions: defineActions({...})` (typically via a `createMyAppActions({ tables, batch })` helper defined nearby). The helper enforces snake_case ASCII keys at compile time and runtime; consumers index by string or iterate with `Object.entries`.

### Step 6: workspace README, the "How It All Fits Together" callout (line ~333)

Current:
> 6. Use `walkActions(...)` and each action's metadata (`type`, `title`, `description`, `input`) if you want to build adapters such as HTTP, CLI, or MCP.

Replace:
> 6. Iterate `Object.entries(bundle.actions)` and read each action's metadata (`type`, `title`, `description`, `input`) if you want to build adapters such as HTTP, CLI, or MCP.

### Step 7: workspace README, the API list (line ~1415)

There's a bullet list of exported names. Search for `walkActions`:
- Remove `- \`walkActions(...)\``.
- If `describeActions(...)` or `resolveActionPath(...)` appear, remove them.
- Add `- \`defineActions(actions)\``.
- Add `- \`toActionMeta(action)\``.

### Step 8: workspace README, the long-form walkActions description (lines 1576-1660)

Search for `walkActions(source)` paragraph. Rewrite:

> `Object.entries(actions)` lets you iterate the flat registry. Combined with each action's `type`, `title`, `description`, and `input` schema, that is enough to build HTTP, CLI, or MCP adapters without coupling the core package to a transport.

And the bullet list `- \`walkActions(...)\` to flatten a nested action tree` becomes:
> - `Object.entries(actions)` to iterate the flat registry

Update the code block at line ~1629 that imports `walkActions` and uses nested `posts: { list, create }`. Replace with the flat snake_case + `Object.entries` form (mirror Step 2's pattern).

### Step 9: SYNC_ARCHITECTURE diagram (line ~425)

Open `packages/workspace/SYNC_ARCHITECTURE.md`. Find:

```
6. switch(rpc.verb) {
     case 'describe-actions':
       return Ok(describeActions(userActions))
   }
```

Replace with:
```
6. switch(rpc.verb) {
     case 'describe-actions':
       return Ok(
         Object.fromEntries(
           Object.entries(userActions).map(([key, action]) =>
             [key, toActionMeta(action)]
           )
         )
       )
   }
```

If the ASCII box collapses (line gets too long), use the shorthand:
```
6. switch(rpc.verb) {
     case 'describe-actions':
       return Ok(<flat key -> ActionMeta>)
   }
```
And add a footnote: `<flat key -> ActionMeta>` is `Object.fromEntries(Object.entries(userActions).map(([key, a]) => [key, toActionMeta(a)]))`.

### Step 10: ai README, line 28

Open `packages/ai/README.md`. Find the paragraph that starts:

> Workspace actions are nested objects. `actionsToAiTools()` walks the source with `walkActions()` from `@epicenter/workspace`, joins path segments with `_`, and returns TanStack AI client tools plus wire-safe definitions.

Replace:

> Workspace actions are a flat `ActionRegistry` keyed by snake_case ASCII strings. `actionsToAiTools()` reads each entry with `Object.entries(actions)` and returns TanStack AI client tools plus wire-safe definitions. The AI tool name is the action key verbatim; there is no projection.

### Step 11: ai README, line 40

Find the description under `### actionsToAiTools(source)`:

> Converts an action tree into TanStack AI client tools and JSON definitions. Tool names come from the action path, so a nested action like `tabs.close` becomes `tabs_close`.

Replace:

> Converts an action registry into TanStack AI client tools and JSON definitions. The tool name is the action key, which is already snake_case ASCII (e.g. an action keyed `tabs_close` produces a tool named `tabs_close`).

### Step 12: ai README, line 59

Find:

> `@epicenter/workspace` defines actions and exposes `walkActions()`.

Replace:

> `@epicenter/workspace` defines actions and exposes `defineActions` / `defineQuery` / `defineMutation`.

### Verification

Run from repo root:

```bash
# 1. No removed exports referenced anywhere in published docs.
grep -rn "walkActions\|describeActions\|type Mutation\|type Query\|DotsToUnderscores\|ACTION_NAME_SEPARATOR\|resolveActionPath" \
  packages/workspace/README.md \
  packages/workspace/SYNC_ARCHITECTURE.md \
  packages/ai/README.md
# Expect: zero hits.

# 2. No nested authoring shape examples.
grep -n "posts: {[[:space:]]*$" packages/workspace/README.md
# Expect: zero hits.

# 3. Bracket-string access has been replaced with dot-access.
grep -n "actions\['[a-z]" packages/workspace/README.md packages/ai/README.md
# Expect: zero hits.

# 4. Spot-check by typechecking an example. Copy one of the updated code blocks
# into a scratch file under apps/fuji/src/, then run `bun run tsc --noEmit` from
# apps/fuji. Should compile.
```

If verification grep #1 returns hits, you missed a spot; jump back to the relevant step.

### Commit

```bash
git add packages/workspace/README.md packages/workspace/SYNC_ARCHITECTURE.md packages/ai/README.md
git commit -m "$(cat <<'EOF'
docs: rewrite action sections in three READMEs for snake_case + defineActions

- packages/workspace/README.md: flat ActionRegistry authoring with
  defineActions; remove walkActions, describeActions, type Mutation,
  type Query references; rewrite "nested action tree" prose as flat
  prefix-keyed registry.
- packages/workspace/SYNC_ARCHITECTURE.md: sequence diagram cell now
  shows the actual Object.entries + toActionMeta inline form.
- packages/ai/README.md: tool name equals action key verbatim; no
  projection; uses Object.entries, not walkActions.
EOF
)"
```

### If you get stuck

- The "search for `### Actions`" instruction matches twice in the workspace README. The first one is in `## Core Concepts` (a short paragraph; Step 5). The second is in `## Public adapter surface` (the imports block; Step 1). Both need updating.
- The `posts: {` pattern in Step 2 also matches inside the unchanged JSDoc above the import block; that's fine, the search is just navigation.
- If you find a stale reference NOT covered above (e.g. a comment in a code block that says "the action tree"), fix it inline. The runbook hits the obvious spots; the file is long.
- If you'd rather punt and let an agent do it, use the "Handoff prompt" section earlier in this spec.
