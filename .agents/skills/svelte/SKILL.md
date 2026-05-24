---
name: svelte
description: 'Svelte 5 component patterns for `.svelte` files: runes, snippets, keyed lifecycles, `{#await}`, TanStack Query, SvelteMap, shadcn-svelte, and workspace observers. Use when editing Svelte components or Svelte state modules.'
metadata:
  author: epicenter
  version: '2.1'
---

# Svelte Guidelines

Use this skill for Svelte 5 components and Svelte state modules in Epicenter apps. Keep the first pass focused on Svelte runes, component lifecycle, workspace-backed state, TanStack Query usage, and local UI composition.

## Reference Repositories

- [Svelte](https://github.com/sveltejs/svelte): Svelte 5 framework with runes and fine-grained reactivity
- [shadcn-svelte](https://github.com/huntabyte/shadcn-svelte): Port of shadcn/ui for Svelte with Bits UI primitives
- [shadcn-svelte-extras](https://github.com/ieedan/shadcn-svelte-extras): Additional components for shadcn-svelte

## Upstream Grounding

When Svelte 5 runes, compiler behavior, SvelteKit integration, or component-library APIs affect correctness, ask DeepWiki a narrow question against `sveltejs/svelte` or the relevant upstream repo before relying on memory. Use it to orient, then verify decisive details against local installed types, source, or official docs before changing code.

Skip DeepWiki for stable basics and repo-local patterns already documented here or in references.

## Related Skills

- `query-layer`: TanStack Query integration
- `error-handling`: `toastOnError`, `extractErrorMessage`, and component error handling
- `styling`: CSS and Tailwind conventions, including the flex column scroll trap
- `epicenter-ui`: loading, empty, pending, tooltip, and component selection patterns

## When To Apply This Skill

Use this skill when you need to:

- Build or refactor Svelte 5 components using runes.
- Choose between `$state`, `$derived`, `$effect`, snippets, and keyed blocks.
- Wire TanStack Query mutations from `.svelte` or `.ts` files.
- Convert workspace table or KV data into reactive Svelte state.
- Refactor shallow aliases, repetitive markup, or unstable reactive data sources.
- Follow shadcn-svelte import and composition patterns.
- Fix template gotchas such as unicode escapes in HTML context.

## Svelte 5 Baseline

- Use `$state` for reactive values that the component mutates. Use `$state.raw` for large reassigned objects or handles that should not be deep-proxied.
- Prefer `$derived` for computed state. Treat `$effect` as an escape hatch for DOM integration, analytics, subscriptions, and external systems.
- Props can change. Values derived from `$props()` should usually be `$derived`, not one-time initialization.
- Prefer snippets and `{@render}` over slots for new Svelte 5 code. Type snippet props with `Snippet<[...args]>`.
- Avoid legacy patterns in runes-mode code: `$:` declarations, `export let`, `on:click`, `<svelte:component>`, `<svelte:self>`, `beforeUpdate`, `afterUpdate`, and `createEventDispatcher`.

## Core Decisions

- If a disposable resource identity depends on a prop, let the parent own mount and unmount with `{#key}` or `{#if}`; open the resource synchronously in the child. Read [lifecycle and reactivity](references/lifecycle-and-reactivity.md).
- If readiness is a stable promise, use `{#await}` in the template instead of a `$state(false)` flag and a cancellation effect.
- Inline shallow property aliases. Keep `$derived` and `{@const}` only when they compute, narrow, or stabilize something useful.
- Map finite unions with a `satisfies Record` lookup, not nested ternaries or `$derived.by()` switches.
- Use `SvelteMap` for ID-keyed collections where individual entries need to update reactively. Convert maps to arrays with `$derived` before passing them to components.
- Create TanStack Query mutations in `.svelte` files and call `mutation.mutate(...)` directly from template handlers unless the action earns a semantic helper. Read [mutations and workspace inputs](references/mutations-and-workspace-inputs.md).
- For workspace string fields, prefer commit-on-blur over writing a CRDT transaction on every keystroke.
- Keep component props inline and push large view-mode branches into focused child components. Read [component and UI patterns](references/component-ui-patterns.md).
- Use local `@epicenter/ui` loading, empty, pending, and tooltip components before ad hoc markup.

## Reference Map

- [Lifecycle and reactivity](references/lifecycle-and-reactivity.md): keyed resources, async gates, shallow aliases, value maps, `SvelteMap`, table state, state modules.
- [Mutations and workspace inputs](references/mutations-and-workspace-inputs.md): TanStack Query mutation placement, inline handlers, commit-on-blur.
- [Component and UI patterns](references/component-ui-patterns.md): shadcn-svelte, props, self-contained components, branching limits, repetitive markup, loading and empty states, template gotchas.
