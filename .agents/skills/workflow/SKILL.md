---
name: workflow
description: Standard feature workflow with timestamped specs under `specs/`, checklist-driven plans, autonomous checkpoints, and a post-implementation review step. Use when starting a multi-file feature, when the user says "start a new feature", "how should I plan this", "what's the process", "write a spec for this", or before any non-trivial implementation that needs a planning doc.
metadata:
  author: epicenter
  version: '1.0'
---

# Standard Workflow

1. Think through the problem, read the relevant files, and write a plan to `specs/[timestamp] [feature-name].md` where `[timestamp]` is in `YYYYMMDDThhmmss` format.
2. Include a checklist of implementation tasks that can be checked off as work lands.
3. Execute autonomously in small checkpoints. Pause for user input only when the plan has competing product or architecture choices, unresolved requirements, destructive actions, or broad scope risk.
4. For non-trivial changes with multiple plausible approaches, 3+ files, or architecture shifts, present competing options with before/after diffs and ASCII diagrams before implementing. See [change-proposal](../change-proposal/SKILL.md).
5. Mark checklist items complete as you go and keep progress notes high level: changed, verified, remaining, blocked.
6. Keep every task and code change as small as possible. Avoid unrelated cleanup and broad refactors.
7. Before final handoff, run `post-implementation-review` against the touched files. Use it to catch stale abstractions, dead paths, invariant drift, naming issues, and missing verification.
8. Add a review section to the spec with a summary of changes, review findings, verification, and relevant follow-up work.

## When to Apply This Skill

Use this pattern when you need to:

- Start a non-trivial feature with a timestamped planning spec in `specs/`.
- Build a checklist-driven implementation plan before writing code.
- Execute work in small, simple checkpoints with high-level progress updates.
- Pause only for unresolved product choices, architecture choices, destructive actions, or broad scope risk.
- Run a post-implementation review before handing work back.
- Close work by adding a review summary to the spec.

# Spec Placement

All specs live in the root `/specs/` directory. Do not create nested specs in `apps/` or `packages/`.
