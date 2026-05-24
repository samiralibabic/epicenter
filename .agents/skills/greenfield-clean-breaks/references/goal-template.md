# Thin Goal Template

A `/goal` that invokes this skill should stay short. The skill carries the
compatibility-refusal review; the goal carries only what varies per pass.

## Minimal template

```txt
/goal Run a greenfield clean-break pass on <target>.

  Load skill: greenfield-clean-breaks.
  Target: <path or concept>
  Compatibility stance: <assume no users | preserve public API | ask before public breaks>
  Stop condition: <proposal only | N approved checkpoints | churn threshold>
  Starting target: <narrowest file, package, or boundary>

  Begin.
```

## Worked examples

### Proposal-only pass

```txt
/goal Run a greenfield clean-break pass on Fuji's browser/session/workspace boundary.

  Load skill: greenfield-clean-breaks.
  Target: apps/fuji/src/lib/browser.ts, apps/fuji/src/lib/session.ts, apps/fuji/src/lib/workspace.ts
  Compatibility stance: assume no users except durable workspace/storage shapes.
  Stop condition: proposal only; report before/after shape and wait for OK before editing.
  Starting target: apps/fuji/src/lib/browser.ts

  Begin.
```

### Implementation pass

```txt
/goal Run a greenfield clean-break pass on the tab manager playground daemon.

  Load skill: greenfield-clean-breaks.
  Target: playground/tab-manager-e2e/workspaces/tabManager/daemon.ts
  Compatibility stance: assume no users; preserve only documented durable workspace schema.
  Stop condition: 4 approved checkpoints or when remaining findings need product input.
  Starting target: playground/tab-manager-e2e/workspaces/tabManager/daemon.ts

  Begin.
```

### Broader boundary pass

```txt
/goal Run a greenfield clean-break pass on the workspace runtime storage boundary.

  Load skill: greenfield-clean-breaks.
  Target: packages/workspace storage and persistence modules
  Compatibility stance: ask before public API, sync wire format, or persisted data shape changes.
  Stop condition: three consecutive inspected files produce no actionable findings.
  Starting target: packages/workspace

  Begin.
```

## What does NOT belong in the goal

The skill already owns:

- The product-sentence rule
- The ownership pass
- The compatibility contract list
- The smell catalog for greenfield mode
- The review loop
- The finding format
- The earned-trigger test

If a future goal needs more ritual than this, update the skill or a reference file instead of copying the ritual into the goal.
