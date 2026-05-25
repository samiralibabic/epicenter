# Technical Specifications

This directory is the working record for feature plans, architecture decisions, execution notes, and historical design context.

Specs should respect maintainer time. A reader should be able to find the current truth quickly, then decide whether they need the deeper evidence, implementation plan, or historical appendix.

## File Names

New specs use:

```txt
YYYYMMDDThhmmss-kebab-case.md
```

Examples:

```txt
20260524T153612-centralize-route-paths.md
20260524T100110-centralize-c-json-error-responses.md
```

Prompt and handoff artifacts may use explicit suffixes:

```txt
*.prompt.md
*.handoff.md
*.execute.md
```

Those artifacts should link back to the canonical spec. Do not treat them as the current implementation plan unless the suffix and header make that explicit.

## First Screen Contract

The top of a spec should answer:

```txt
What is this?
Is it active, implemented, superseded, or historical?
What is the current shape?
What is the target shape?
What proves the change is done?
```

Use this header shape for new specs:

```markdown
# [Feature Name]

**Date**: [YYYY-MM-DD]
**Status**: Draft | In Progress | Implemented | Superseded | Retrospective
**Owner**: [Name/team responsible for decisions]
**Branch**: [optional branch name]
**Supersedes**: [optional spec paths]
**Superseded by**: [optional spec path]

## One Sentence

[One concrete sentence naming the new shape and the boundary it changes.]
```

If a spec is long or partly historical, add a "How to read this spec" block near the top:

```txt
Read first:
  One Sentence
  Current State
  Target Shape
  Implementation Plan
  Verification

Read if changing the architecture:
  Design Decisions
  Rejected Alternatives
  Edge Cases

Historical only:
  Implementation Notes
  Superseded Decisions
  Execution Prompts
```

## Writing Shape

Use prose to explain why. Use visuals to show shape.

Prefer:

- Real code snippets for current state and target state.
- Before/after blocks for API and refactor changes.
- File trees for package and ownership changes.
- Route tables for HTTP, CLI, and protocol surfaces.
- Fenced text diagrams for flows, layers, and ownership.
- Decision tables when multiple choices were considered.

Avoid:

- Wall-of-prose architecture.
- Template sections that do not change implementation.
- Unlabeled historical debate mixed into the active plan.
- Handoff prompts embedded in the main execution path.

## Size

Large specs are allowed. Thorough specs are often better than scattered small ones.

Do not split by line count. Split, add an active slice, or create a companion execution spec only when one file mixes reader jobs:

```txt
north-star architecture
  + historical debate
  + implementation log
  + handoff prompt
  + current execution path
```

The failure mode is not length. The failure mode is making the reader guess which parts are still true.

## Lifecycle

Specs are living documents while work is active.

- `Draft`: design direction exists, implementation has not started or is not committed to the exact plan.
- `In Progress`: work is underway and checkboxes or implementation notes should stay current.
- `Implemented`: the planned work landed and the spec has a review or completion note.
- `Superseded`: a newer spec or commit changed the direction. Add a top note pointing to the replacement.
- `Retrospective`: records what happened and why. Do not execute from it directly.

When executing a spec, update checkboxes and implementation notes in the same review unit as the code. If implementation diverges from the spec, update the spec instead of leaving stale instructions behind.

## Minimum Useful Sections

Not every spec needs every section. The common shape is:

- One Sentence.
- Current State with concrete code, routes, types, or files.
- Target Shape with code, tree, table, or flow.
- Design Decisions with rationale.
- Implementation Plan with checkboxes or waves.
- Verification with commands, smoke tests, or grep checks.
- Open Questions when a decision is intentionally left to the implementer.

Use judgment. A small feature can stay short. A deep architecture change can be long, as long as the read path is clear.
