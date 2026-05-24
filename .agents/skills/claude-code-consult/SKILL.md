---
name: claude-code-consult
description: Use this skill when the user asks to consult Claude, ask Claude Code, get another model's take, run a taste check, find cleaner options, grill a design, or prepare a Claude prompt. Run or draft a bounded read-only Claude Code consult, then verify Claude's claims against local files.
---

# Claude Code Consult

Codex stays the harness: it reads the repo, frames the question, runs or drafts the consult, checks the answer, and owns any follow-up changes. When the user asks Codex to consult, grill, or get another model's take, run the consult and continue the task unless they specifically want to run it themselves.

## When To Use It

Use Claude Code for judgment work that benefits from a different model's read:

- Architecture, API shape, naming, and abstraction critique.
- Clean-break pressure before preserving compatibility.
- Taste checks for UI, copy, domain language, and developer experience.
- Debugging hypotheses when the local evidence is confusing.
- Risk review before a broad refactor.

Do not use it for routine edits, final correctness, autonomous implementation, or open-ended "think about everything" prompts.

## Consult Shape

Every consult must fit in one pass:

1. Ask one concrete question.
2. Give exact file paths or short snippets.
3. Name the critique lens: debugging hypotheses, taste critique, clean-break pressure, or risk review.
4. Say what answer shape is useful.
5. Tell Claude not to edit files, commit, push, delete, or run destructive commands.

For architecture or API-shape questions, ask Claude to start with one concrete sentence describing the current surface, then look for radical options, asymmetric wins, and clean breaks before suggesting local patches.

Do not paste a template mechanically. Write the prompt a sharp senior engineer would send to another senior engineer.

## Running The Consult

If the user wants to run it themselves, provide only the prompt.

If the user wants Codex to run it, or asks for Claude's judgment as part of the work, use a direct `claude -p` call with no wrapper script. For repo consults, restrict Claude to read/search tools:

```bash
claude -p "[prompt]" \
  --tools "Read,Grep,Glob" \
  --output-format json \
  --max-budget-usd 1
```

Do not set `--model` by default. Let the user's Claude Code configuration choose the model. Add `--model` only when the user explicitly asks for a specific model.

For pure judgment consults that do not need workspace files, omit `--tools`.

Do not use MCP for this pattern. Use the subprocess consult unless the user explicitly asks to expose Claude Code as an MCP server.

Codex's default sandbox may not see Claude Code auth or network access. If a sandboxed call reports `Not logged in`, auth failure, or network failure, rerun with shell escalation.

## After Claude Answers

Treat the answer like a strong code review comment, not truth.

1. Check `is_error` first, then read the `.result` field from the JSON envelope.
2. Separate concrete findings from opinion.
3. Check each claim against local files.
4. Keep only recommendations that fit repo constraints.
5. Make any code changes in Codex, with normal validation.

If Claude's answer is generic, unsupported, or contradicted by local files, discard that part and say so.
