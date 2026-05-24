---
name: workspace-api
description: 'Epicenter workspace API patterns: `defineTable`, `defineKv`, migrations, actions, `attach*` primitives, `openCollaboration`, and workspace connections. Use when editing workspace schemas, table/KV access, actions, attachments, or collaboration setup.'
metadata:
  author: epicenter
  version: '6.0'
---

# Workspace API

Use this skill for Epicenter workspace definitions, table and KV access, action factories, attachment composition, collaboration setup, and workspace connections.

## Reference Repositories

- [Yjs](https://github.com/yjs/yjs): CRDT framework used by the workspace data layer

## Related Skills

- `yjs`: Yjs CRDT patterns and shared types
- `svelte`: reactive wrappers such as `fromTable` and `fromKv`, plus commit-on-blur workspace inputs
- `attach-primitive`: the full contract and invariants every `attach*` function must follow
- `arktype`: runtime schema and branded ID validation

## When To Apply This Skill

Use this skill when you are:

- Defining a table or KV store with `defineTable()` or `defineKv()`.
- Adding a version or migration to an existing table definition.
- Reading, writing, or observing table or KV data.
- Creating actions with `defineMutation` or `defineQuery`.
- Composing a live document with a direct builder and `attach*` primitives.
- Adding `createDisposableCache(builder)` for per-row or fan-out documents.
- Attaching persistence, collaboration, encryption, or materializers.
- Writing server-side Bun scripts with `connectWorkspace()`.

## Core Rules

- Tables always include `_v` with a number literal. Use single-version shorthand until a table actually needs evolution.
- Derive row types with `InferTableRow<typeof tableDefinition>` in the same module that defines the table. Consumers import the type from the workspace definition module.
- Do not re-derive row types from runtime table methods or relay them through state files.
- KV stores use `defineKv(schema, defaultValue)`. Prefer one scalar per dot-namespaced key unless the value is a true atomic object.
- Every table `id` and string foreign key uses a branded type plus a co-located generator. Call sites use the generator, never a direct cast.
- Isomorphic actions belong in `workspace/actions.ts` factories that close over `tables` and `batch`. Runtime-specific actions live in the runtime builder where browser, Node, Tauri, or extension APIs are in scope.
- Local action calls see the handler shape directly. Remote dispatch wraps raw values and failures in `Promise<Result<T, DispatchError>>`. Read the action return reference before changing handler failure behavior.
- Every action method inside the workspace action object should have JSDoc that adds developer-facing value beyond the short `description` field.
- Keep `workspace/definition.ts` and `workspace/actions.ts` isomorphic. Keep `client.ts` runtime-specific and outside the `workspace/` folder.
- Compose attachments inline in the builder after creating the `Y.Doc`. Avoid wrapper helpers that hide ordering unless the abstraction owns a real invariant.
- Use `connectWorkspace()` for one-off Bun scripts that need a connected workspace without app UI bootstrapping.

## Reference Map

- [Schema definition patterns](references/schema-definition-patterns.md): `defineTable`, `defineKv`, row type inference, KV scalar design, and branded IDs.
- [Actions, layout, and attachments](references/actions-layout-and-attachments.md): action factories, JSDoc, workspace file layout, attachment ordering, `connectWorkspace`, and `_v`.
- [Action return shapes](references/action-return-shapes.md): local vs remote action return contracts and error normalization.
- [Table, KV, CRUD, and observation](references/table-kv-crud-observation.md): table/KV read, write, observe, and derived-state details.
- [Table migrations](references/table-migrations.md): migration rules and version evolution examples.
- [Primitive API](references/primitive-api.md): lower-level primitive contracts and composition details.
