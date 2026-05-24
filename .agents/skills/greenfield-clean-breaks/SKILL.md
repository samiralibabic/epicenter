---
name: greenfield-clean-breaks
description: Greenfield clean-break review for refusing compatibility, finding inconsistent ownership, and deleting unearned branches, fallback states, duplicate paths, and premature abstractions. Use when the user says greenfield, no users, clean break, refuse compatibility, remove slop, simplify the design, or asks whether a system should be redesigned from the ideal shape.
---

# Greenfield Clean Breaks

Use this skill when the user explicitly removes compatibility pressure or asks whether the current shape would survive if designed today.

Examples:

```txt
Assume no users.
This is greenfield.
I want a clean break.
Do not preserve old behavior.
Refuse compatibility.
Delete the slop.
Would we add this if we started today?
```

This skill does not replace `cohesive-clean-breaks` or `collapse-pass`. It gives agents a sharper trigger for clean-break review when compatibility pressure has been released or was never earned.

```txt
cohesive-clean-breaks   broad redesign and asymmetric wins
collapse-pass           repeated deletion loop
greenfield-clean-breaks compatibility refusal and ideal-shape review
```

Compatibility is a product feature, not the baseline. Before preserving an old shape, name the contract that makes compatibility real.

```txt
published package API
deployed endpoint with users
durable storage format
sync wire format
documented config shape
migration reader for existing data
explicit product promise
```

If no contract exists, treat the old shape as removable. If a contract exists, decide explicitly: break, migrate, or preserve.

## Core Rule

Write the ideal product sentence first.

```txt
<noun> owns <boundary>; <caller> enters through <single path>; <runtime> does <one job>.
```

Then judge the current code against that sentence.

If the sentence still works without a branch, option, helper, state field, or compatibility path, delete it.

## Smell Catalog

In greenfield mode, look for:

```txt
two ways to do the same thing
two owners for the same value
fallbacks beside the canonical path
repair code in read paths
optional fields preserving old shapes
compatibility aliases
dual readers or dual writers
placeholder tables or services
default rows created for hypothetical future use
public types with no real consumer
helpers that only hide product decisions
test fixtures that preserve obsolete behavior
state copied across layers for convenience
branches that exist because an invariant is checked too late
```

These are not automatically wrong. They are suspicious. Keep one only when you can name the concrete product behavior it preserves.

## Ownership Pass

Name one owner for every important value and invariant.

Use project vocabulary, not generic architecture words.

```txt
auth session       signed-in identity
route params       selected resource
database row       durable product fact
UI state           navigation choice
config file        project declaration
runtime actor      live coordination
sync engine        protocol bytes
```

If two layers can create, repair, reinterpret, or cache the same value, choose one owner and delete the other path.

## Review Loop

Run this loop before editing:

```txt
1. Write the product sentence.
2. List current paths that create, read, update, delete, infer, cache, repair, or adapt the thing.
3. Name the owner of each value.
4. Mark each extra path as compatibility, fallback, convenience, repair, future option, or real product behavior.
5. Ask whether the product sentence survives if the path is refused.
6. If it survives, remove the path and record the refusal.
7. Re-run caller counts with rg.
8. Validate with targeted tests and typecheck.
```

Use this finding format before editing:

```txt
Product sentence:
  ...

Drift:
  ...

Value owners:
  ...

Code family created:
  ...

Greenfield clean break:
  ...

User loss:
  ...

Decision:
  refuse / keep / defer because ...
```

## Earned Trigger Test

Do not add a table, public type, API field, route, service, config option, or lifecycle concept for a hypothetical future.

It is earned only when the product has a concrete operation that cannot live in the current owner.

Good earned triggers:

```txt
rename it
delete it
duplicate it
disable it
bill it
permission it separately
list it as a product object
audit it as an admin action
move it across an ownership boundary
```

Weak triggers:

```txt
maybe useful later
keeps options open
matches another product
makes tests easier
preserves an old mental model
supports old callers when the user said greenfield
```

## Naming Bias

Prefer names that say what a path actually owns:

```txt
create*       construction
list*         read-only listing
resolve*      pure validation or route resolution
authorize*    permission checks
sync*         protocol movement
dispose*      teardown
```

Treat these names as review triggers:

```txt
ensure*
getOrCreate*
maybe*
legacy*
fallback*
compat*
default*
repair*
```

Those names can be valid, but they must prove their owner. For example, `ensure*` can be fine for migration or infrastructure setup where creation is the purpose. It is suspicious in a product read path.

## Spec Updates

When a refusal lands, update the relevant spec.

Use this shape:

```txt
Candidate:
  ...

Refusal:
  ...

User loss:
  ...

Decision:
  ...

Trigger to revisit:
  ...
```

The trigger matters. Without it, "deferred" becomes a vague future bucket.

## Stop And Ask

Pause before:

```txt
changing durable strings
deleting a published package API
changing auth or session schema
removing migration readers for existing on-disk user data
changing encryption or sync wire format
removing behavior the user has not actually released from compatibility pressure
```

A clean break can remove product compatibility. It does not silently break durable data formats or published contracts unless the user explicitly accepts that break.
