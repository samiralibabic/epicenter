---
name: typescript
description: 'TypeScript project conventions: derived types, type placement, acronym casing, imports, generics, factories, and runtime schema patterns. Use when editing `.ts` files, defining exported types, reviewing type names, or organizing type tests.'
metadata:
  author: epicenter
  version: '2.0'
---

# TypeScript Guidelines

Use this skill for project-wide TypeScript conventions before loading narrower skills such as `arktype`, `typebox`, `testing`, or `method-shorthand-jsdoc`.

## When To Apply This Skill

Use this skill when you need to:

- Write or refactor TypeScript with Epicenter naming and style conventions.
- Decide whether to derive, import, or declare a type.
- Review type ownership, copied shapes, factory return types, brands, casts, and generic names.
- Choose clear value-mapping and control-flow patterns for unions and discriminated values.
- Organize type tests, runtime schemas, or factory-focused refactors.

## Core Rules

- Try to derive or import a type before declaring a new named type. New named types must earn their place as a real contract, protocol vocabulary, discriminated result union, capability port, or multi-implementation shape.
- Treat local shape copies as boundary smells. Prefer the owning runtime type, schema inference, factory return type, function signature, or a caller-owned capability function.
- Use `type`, not `interface`.
- Use `readonly` only for arrays and maps, unless matching an upstream type exactly.
- Treat acronyms as normal words in camelCase: `parseUrl`, `defineKv`, `readJson`, `customerId`.
- Use `.js` extensions in relative imports. Do not use extensionless or `.ts` relative imports.
- Export symbols at their declarations. Reserve `export { ... } from ...` for barrel files.
- Prefer factory functions over classes. Let closure position communicate private vs public API.
- Use descriptive generic names with a `T` prefix, such as `TSchema`, `TDefs`, and `TKey`.
- Destructure options in the function signature when the object is a configuration bag. Keep a named value only when it is the domain object being transformed or forwarded.
- Let TypeScript infer private and inner return types. Annotate exported APIs only when useful for clarity or to break circular inference.
- If an exported type is exactly the object returned by a `create*` factory, derive it with `ReturnType<typeof createThing>`. Put useful annotations on returned members instead of duplicating the object shape.
- Use a `Symbol` brand when identity means a specific factory output, not a coincidental shape probe.
- Avoid `as any`. Use `unknown`, validation, brands, or narrower helpers instead.
- Prefer optional chaining over `in` checks or truthiness when checking optional properties.
- Use `is`, `has`, or `can` prefixes for booleans that answer a question.
- Prefer `switch` over `if/else` for repeated equality comparisons against the same value. Use `default: value satisfies never` for exhaustiveness when needed.
- Prefer `Record` lookup tables over nested ternaries for finite value mappings.
- Compose typed errors bottom-up. Do not filter a broad upstream error union at the boundary.
- Question silent fallbacks that hide invalid state. Preserve round-trip invariants when parsing and serializing.

## Reference Map

- [Project conventions](references/project-conventions.md): detailed examples for derived types, local shape copies, imports, barrels, factories, generics, destructuring, and factory return types.
- [Type safety and control flow](references/type-safety-and-control-flow.md): identity brands, casts, optional properties, boolean naming, switches, record lookups, error composition, fallback smells, and round-trip invariants.
- [Type organization](references/type-organization.md): `types.ts` location, co-location rules, inline-vs-extract hop test, options and ID naming.
- [Factory patterns](references/factory-patterns.md): factory-focused refactors, parameter destructuring, and coupled state extraction.
- [Runtime schema patterns](references/runtime-schema-patterns.md): arktype, branded IDs, optional property syntax, and workspace table IDs.
- [Testing patterns](references/testing-patterns.md): inline single-use setup and source-shadowing tests.
- [Advanced TypeScript features](references/advanced-typescript-features.md): iterator helpers and const generic array inference.
