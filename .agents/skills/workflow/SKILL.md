---
name: workflow
description: Standard feature workflow with timestamped specs under `specs/`, checklist-driven plans, autonomous checkpoints, and a post-implementation review step. Use when starting a multi-file feature, when the user says "start a new feature", "how should I plan this", "what's the process", "write a spec for this", or before any non-trivial implementation that needs a planning doc.
metadata:
  author: epicenter
  version: '1.0'
---

# Standard Workflow

1. Think through the problem, read the relevant files, and write a plan to `specs/[timestamp]-[feature-name].md` where `[timestamp]` is in `YYYYMMDDThhmmss` format and `[feature-name]` is kebab case.
2. Make the first screen useful: status, owner, one sentence, current shape, target shape, and proof.
3. Include a checklist of implementation tasks that can be checked off as work lands.
4. Execute autonomously in small checkpoints. Pause for user input only when the plan has competing product or architecture choices, unresolved requirements, destructive actions, or broad scope risk.
5. For non-trivial changes with multiple plausible approaches, 3+ files, or architecture shifts, present competing options with before/after diffs and ASCII diagrams before implementing. See [change-proposal](../change-proposal/SKILL.md).
6. Mark checklist items complete as you go and keep progress notes high level: changed, verified, remaining, blocked.
7. Keep every task and code change as small as possible. Avoid unrelated cleanup and broad refactors.
8. Before final handoff, run `post-implementation-review` against the touched files. Use it to catch stale abstractions, dead paths, invariant drift, naming issues, and missing verification.
9. Add a review section to the spec with a summary of changes, review findings, verification, and relevant follow-up work.

## When to Apply This Skill

Use this pattern when you need to:

- Start a non-trivial feature with a timestamped planning spec in `specs/`.
- Build a checklist-driven implementation plan before writing code.
- Write specs that respect maintainer time with a clear first screen and visual rhythm.
- Execute work in small, simple checkpoints with high-level progress updates.
- Pause only for unresolved product choices, architecture choices, destructive actions, or broad scope risk.
- Run a post-implementation review before handing work back.
- Close work by adding a review summary to the spec.

# Spec Placement

All specs live in the root `/specs/` directory. Do not create nested specs in `apps/` or `packages/`.

Large specs are allowed when the topic warrants it. Do not split by line count. Split, add an active slice, or create a companion execution spec only when one file mixes reader jobs: north-star architecture, historical debate, implementation logs, handoff prompts, and the current execution path.

Prompt and handoff artifacts can live beside specs with explicit suffixes like `.prompt.md`, `.handoff.md`, or `.execute.md`. They should link back to the canonical spec and should not be treated as the current implementation plan unless the suffix says so.
