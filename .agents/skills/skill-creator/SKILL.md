---
name: skill-creator
description: Create or update Vercel-backed Agent Skills for this repository. Use when the user asks to write a skill, revise a skill, standardize .agents/skills, validate skill discovery, or decide what belongs in SKILL.md, references, scripts, or assets.
---

# Skill Creator

Use this skill to create and maintain repository skills under `.agents/skills` using the Vercel-backed Agent Skills format.

The source of truth for format and discovery is the `skills` CLI from `vercel-labs/skills`. Do not maintain a separate local validator unless the user explicitly asks for one.

## Supported Shape

Every skill is a directory with a required `SKILL.md`:

```txt
.agents/skills/<skill-name>/
├── SKILL.md
├── references/   optional, detailed context loaded only when needed
├── scripts/      optional, executable helpers for repeatable fragile work
└── assets/       optional, files used in generated output
```

The required frontmatter is:

```yaml
---
name: skill-name
description: What this skill does and when agents should use it.
---
```

`metadata.internal: true` is the only optional Vercel-backed field this skill should teach by default. It hides a skill from normal discovery unless internal skills are explicitly included.

The CLI does not reject arbitrary extra frontmatter keys in general parsing, but do not add extra keys unless the target agent or tool explicitly supports them.

## What Not To Add

Keep repository skills portable and boring. Do not add Codex-specific helper layers as part of the standard:

```txt
agents/openai.yaml
scripts/init_skill.py
scripts/quick_validate.py
scripts/generate_openai_yaml.py
references/openai_yaml.md
decorative assets
```

Those can exist in personal or system skill installations, but they are not the Vercel-backed skill format.

## Create A Skill

Default to project-local skills:

```bash
cd /Users/braden/Code/epicenter/.agents/skills
bun x --package skills skills init <skill-name>
```

Then edit `.agents/skills/<skill-name>/SKILL.md` directly.

Use lowercase hyphenated names. Prefer short names that describe the job:

```txt
good: github-issues
good: workspace-api
bad: Helpful Epicenter Knowledge Pack
```

## Write The Description First

The description is always loaded and drives skill selection. Include:

1. What the skill does.
2. The concrete situations that should trigger it.
3. Important file types, packages, tools, or phrases the user might mention.

Good:

```yaml
description: Workspace API patterns for defineTable, defineKv, migrations, observation, and attach primitives. Use when defining schemas, reading or writing table data, observing changes, writing migrations, or composing workspace attachments.
```

Weak:

```yaml
description: Helps with workspace stuff.
```

Do not rely on a "When To Use" section in the body for triggering. The body is loaded only after the skill is already selected.

## Keep SKILL.md Small

Put essential workflow in `SKILL.md`. Move detailed material into `references/` only when the skill would otherwise become noisy.

Use this split:

```txt
SKILL.md
  Core rules, decision points, commands, and links to resources.

references/
  Long examples, API details, migration notes, tables, and edge cases.

scripts/
  Deterministic helpers that avoid rewriting fragile code each time.

assets/
  Templates, images, fonts, boilerplate, or other output inputs.
```

If a reference file is longer than about 100 lines, add a short table of contents at the top so agents can decide whether to read it.

## Validate With Vercel CLI

Validate discovery with the same path the CLI uses before installation:

```bash
bun x --package skills skills add /Users/braden/Code/epicenter/.agents/skills --list
```

For one skill:

```bash
bun x --package skills skills add /Users/braden/Code/epicenter/.agents/skills/<skill-name> --list
```

The useful signal is:

```txt
Local path validated
Found N skill(s)
```

If the skill does not appear, fix `SKILL.md` and run the command again.

## Update A Skill

When updating an existing skill:

1. Read the current `SKILL.md`.
2. Check whether any linked `references/`, `scripts/`, or `assets/` still earn their keep.
3. Remove stale local-only scaffolding from the guidance.
4. Validate with `bun x --package skills skills add <path> --list`.

Forward-test only when behavior is subtle. Ask an agent to use the skill on a realistic task; do not tell it what answer you expect.
