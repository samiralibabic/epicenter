---
name: handoff
description: Compact the current conversation into a self-contained handoff document so a fresh agent can continue the work without prior context. Use when the user says "hand this off", "compact this", "wrap up for the next session", "write a continuation prompt", or invokes /handoff at the end of a long working session.
argument-hint: "What will the next session be used for?"
metadata:
  upstream: mattpocock/skills
  forked: 2026-05-17
---

Write a handoff document summarising the current conversation so a fresh agent can continue the work. Save it to a path produced by `mktemp -t handoff-XXXXXX.md` (read the file before you write to it).

Suggest the skills to be used, if any, by the next session.

Do not duplicate content already captured in other artifacts (PRDs, plans, ADRs, issues, commits, diffs). Reference them by path or URL instead.

If the user passed arguments, treat them as a description of what the next session will focus on and tailor the doc accordingly.
