# Epicenter

Local-first workspace platform. Monorepo with Yjs CRDTs and Svelte UI.

Structure: `apps/whispering/` (Tauri transcription app), `apps/tab-manager/` (Chrome extension), `apps/api/` (Cloudflare hub), `packages/workspace/` (core TypeScript/Yjs library), `packages/cli/` (published CLI package and `epicenter` binary), `packages/ui/` (shadcn-svelte components), `specs/` (planning docs), `docs/` (reference materials).

Always use bun: Prefer `bun` over npm, yarn, pnpm, and node. Use `bun run`, `bun test`, `bun install`, and `bun x` (instead of npx).

Agent instruction files: Treat `AGENTS.md` as the canonical shared instructions file. `CLAUDE.md` files are compatibility shims for Claude Code and should only import a sibling `AGENTS.md` with `@AGENTS.md`, plus rare Claude-specific notes if needed. When adding a nested `AGENTS.md`, add a sibling `CLAUDE.md` shim. Do not create orphan `CLAUDE.md` files.

Destructive actions need approval: Force pushes, hard resets (`--hard`), branch deletions.

Token-efficient execution: When the runtime permits sub-agents, use them for scoped work: parallel exploration, disjoint file edits, verification, or command-only checks. Keep prompts bounded, avoid overlapping write sets, and instruct command-only agents to execute without re-analyzing.

External grounding: When external library behavior affects correctness, verify against DeepWiki, official docs, or local installed types before changing code. Skip this for stable basics and repo-local patterns already documented in skills.

Git hygiene: Stage specific files only. Never use `git add .` or `git add -A`. Do not include AI or tool attribution in commits.

Script suffix convention: `:local` suffix scripts work on a fresh clone without Infisical login (they read committed config like `wrangler.jsonc`). `:remote` suffix scripts wrap with `infisical run --env=prod` and require Infisical authentication; treat them as production admin operations.

Library logging: Do not use direct `console.*` in library code. Use `wellcrafted/logger`, except in CLIs, tests, and benchmarks.

Svelte UI: Prefer local `@epicenter/ui` components before one-off loading, empty, spinner, skeleton, tooltip, and pending states.

Writing conventions: Load `writing-voice` skill for any user-facing text (UI strings, tooltips, error messages, docs). Do not use em dashes (`—`) or en dashes (`–`) anywhere, including prose, comments, JSDoc, and error strings. Use a colon, comma, semicolon, parenthesis, or sentence break instead. This applies to source files, markdown, and commit messages.

Explanation conventions: For spec walkthroughs, architecture explanations, and API summaries, prefer the visual style from the `git` skill reference. Interleave short prose with concrete code snippets, before/after blocks, and ASCII diagrams. Avoid long prose-only explanations when code or structure is being discussed.

Type conventions: When an exported type is exactly the object returned by a `create*` factory, make the type derive from the factory with `ReturnType<typeof createThing>` instead of annotating the factory return with that type. When the public type is a nested slice of a factory result, use a focused inference helper like `InferSignedIn<typeof session>` instead of declaring the shape up front. Keep concrete parameter and member return annotations inside the returned object when they preserve inference, JSDoc, or IntelliSense navigation. Use `satisfies` when checking an implementation against an external contract while keeping Go to Definition pointed at the returned value.

Collapse passes: For continuous indirection-reduction work ("collapse pass", "simplify pass", "reduce indirection", "shrink the surface"), load the `collapse-pass` skill. It carries the per-iteration ritual, finding format, anti-cosmetic gate, durable-strings never-touch list, stop conditions, and final report shape. Goals invoking it should declare only scope, stop condition, citation requirement, and starting target; everything else is in the skill.

Post-change review: After making code changes, re-read every touched file before final response. Mentally inline changed call sites and helpers, check for dead code, redundant work, stale exports, invariant drift, and API shape issues. For substantial implementations, public API changes, refactors, or multi-file changes, load `post-implementation-review` and follow its workflow. Flag findings before applying follow-up fixes. The gate is grounding, not authorship: never expand scope silently or on a hunch, but when the user invites cleanup or an aggressive refactor, well-grounded adjacent fixes, including pre-existing smells the review surfaced, are in scope once flagged.
