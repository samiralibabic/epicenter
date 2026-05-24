# Licensing Strategy

**Status:** Active
**Date:** 2026-04-28
**Owner:** Braden Wong

## Summary

Epicenter uses two active license tiers. Five libraries that let external developers build local-first apps on Yjs CRDTs are MIT. Everything else Epicenter ships (all 12 apps, the sync protocol, and the Epicenter-internal packages) is AGPL-3.0. A third proprietary tier is documented as an escape hatch but deferred indefinitely; revenue comes from hosting, not licensing. There is no Contributor License Agreement; we do not dual-license.

The line: **MIT is reserved for libraries an external developer might `npm install` and benignly embed in a closed-source product. AGPL applies to everything else.**

This document is the canonical reference. The companion document [FINANCIAL_SUSTAINABILITY.md](../FINANCIAL_SUSTAINABILITY.md) is the public-facing narrative for why we made these choices. The root [LICENSE](../LICENSE) is the legal dispatch. This spec is the technical reasoning, threat model, and decision procedure for new packages.

## Operating principle

AGPL is the default because it's what local-first looks like written down as a license: you run the code on your own machine, you experiment and tinker freely, and if you ever distribute a modified version, the improvements come back to the community. MIT is a small, deliberate exception for the five-package developer toolkit so anyone can embed `@epicenter/workspace` and its companions in a closed-source product without friction.

Every licensing decision is also filtered through "does this stay sustainable for a single maintainer?" The AGPL-as-default stance is operationally cheap: no proprietary build pipelines, no commercial license sales process, no enterprise plugin gating, no CLA bot to maintain. Revenue is captured at the hosting layer (uptime, ops, backups, support, compliance), not the license layer.

The proprietary tier is preserved as an option for one specific situation: a paying customer requires a specific feature that AGPL self-hosting would otherwise give away free. It will not be populated speculatively. An empty proprietary tier is the correct end-state if hosting revenue scales, and is the model used by Plausible and PostHog.

AGPL on consumer apps that run locally is a deliberate choice. AGPL §13 (the network-use clause) does not trigger for locally-run software, but the underlying GPL distribution clause still applies: anyone who forks Whispering, Honeycrisp, etc. and distributes a modified binary shares those changes back. It also makes the rule easy to explain ("library = MIT, anything we ship = AGPL") and consistent with the local-first ethos: users can always read and fork the code we ship.

## Threat model

The motivating concern is direct code copying by competitors. This is not theoretical: there is a steady drumbeat of stories in the local-first and developer-tools space of one team taking another team's open source code, rebranding it, and shipping it as a competing product, sometimes hosted, sometimes embedded inside a closed-source app.

We sort this into four scenarios:

| # | Scenario | MIT outcome | AGPL outcome | Proprietary outcome |
|---|---|---|---|---|
| 1 | An individual runs Epicenter locally for personal use | Allowed | Allowed (no §13 trigger when running locally) | Forbidden |
| 2 | A developer forks an Epicenter library to build their own app | Allowed | Their app must also be AGPL (kills adoption) | Forbidden |
| 3 | A company forks an Epicenter app and ships it under a new brand, closed-source | **Allowed** | Forbidden (must publish source) | Forbidden |
| 4 | A company forks the sync server and runs it as a competing hosted service | **Allowed** | Forbidden (§13 forces publishing source of running version) | Forbidden |

Scenarios 3 and 4 are the threat. AGPL handles both, but through different clauses depending on what's being forked:

- **For hosted infrastructure** (`apps/api`, `apps/dashboard`, `packages/sync`): AGPL §13 is the load-bearing clause. Running a modified version as a network service triggers the source-sharing requirement, so a hosted competitor cannot privately fork Epicenter Cloud.
- **For consumer apps** (`apps/whispering`, `apps/honeycrisp`, etc.): AGPL §13 does not trigger when a user runs the app locally on their own machine, but the underlying GPL distribution clause does. If anyone forks Whispering, modifies it, and distributes a binary, they share those changes back with the community. AGPL on a desktop app is GPL-equivalent in practice; the GPL semantics carry the protection.

We default to AGPL across the board (not proprietary) because AGPL preserves the right to read and fork the code (consistent with the local-first ethos), still prevents private SaaS clones and closed-source rebrands, and avoids the operational overhead of running a proprietary tier.

The brand, distribution, and update cadence are still the primary moats for end-user apps; AGPL is a secondary line of defense, not the load-bearing one. But it's a free line of defense, and it makes the licensing rule trivial to state.

## The split

### Tier 1: MIT (5 packages, the local-first-on-Yjs developer toolkit)

**Applies to:**
- `packages/workspace`: typed schemas, CRDT-backed tables, sync. The library.
- `packages/ui`: shadcn-svelte component library.
- `packages/svelte-utils` (`@epicenter/svelte`): Svelte 5 framework bridge.
- `packages/filesystem`: POSIX layer over workspace tables.
- `packages/cli`: the `epicenter` binary.

**Rationale:**
- `packages/workspace` is the developer-facing product. We want external developers to build closed-source apps on it. AGPL would forbid that and collapse the adoption story.
- The other four exist to make `packages/workspace` usable inside a real app. AGPL'ing them would re-import the friction we removed from workspace; "MIT for the protocol, AGPL for everything that lets you use the protocol" is the worst of both worlds.
- These five are the only packages an external developer should reasonably want to `npm install` and embed in a closed-source product. Anything else in the monorepo is either Epicenter-internal or a shipped product surface.

### Tier 2: AGPL-3.0 (everything else)

**Applies to:**
- All 12 apps: `apps/api`, `apps/dashboard`, `apps/whispering`, `apps/honeycrisp`, `apps/opensidian`, `apps/fuji`, `apps/zhongwen`, `apps/tab-manager`, `apps/skills`, `apps/breddit`, `apps/landing`, `apps/posthog-reverse-proxy`.
- `packages/sync`: Yjs sync protocol of the Epicenter Cloud product.
- `packages/auth`, `packages/auth-svelte`: Epicenter cloud auth wiring (private, not published).
- `packages/skills`: opinionated AI tool calling on workspace tables.
- `packages/ai`: LLM tool bridging tied to our apps (private).
- `packages/constants`: shared Epicenter URLs and version info (private).

**Rationale:**

AGPL is the default because it's the license that matches what local-first software actually means: free to run, free to modify, with shared improvements flowing back when modified versions get distributed. The same license covers three different groups for slightly different reasons:

- **Hosted infrastructure** (`apps/api`, `apps/dashboard`, `packages/sync`): §13 is the load-bearing clause. A competitor cannot run a modified version as a network service without sharing source.
- **Consumer apps** (the 10 desktop, extension, and web apps): §13 does not trigger for locally-run software, but the underlying GPL distribution clause does. Anyone forking Whispering and shipping a modified binary shares those changes back. The protection is real, just GPL-level not AGPL-level.
- **Epicenter-internal packages** (`auth`, `auth-svelte`, `ai`, `skills`, `constants`): mostly `private: true`, so license is cosmetic for adoption. AGPL signals "this is part of the Epicenter product, not a library we publish for others to embed."

### Tier 3: Proprietary (deferred)

**Applies to:** none today, and none planned.

**Rationale:** Documented as an escape hatch for one specific situation: a real paying customer requires one specific feature that AGPL self-hosting would otherwise give away free. The tier will not be populated speculatively. The empty-tier end-state is the goal; populating it is a sign that hosting revenue alone was not enough.

**Convention if ever used:**
- Live in their own subdirectory, e.g. `apps/<name>/proprietary/` or a dedicated `enterprise/` top-level directory.
- `LICENSE` file in that directory contains an "all rights reserved" notice (template in this spec).
- `package.json` uses `"license": "SEE LICENSE IN LICENSE"`.
- Listed explicitly in the root `LICENSE` dispatch under a "Proprietary" section.
- Code is publicly visible on GitHub (for transparency and customer trust) but no rights are granted to use, copy, modify, or redistribute.
- Scoped to the smallest unit that solves the customer's problem. Do not gate adjacent features speculatively.

This is the same pattern Bitwarden uses for `bitwarden_license/` and Sentry uses for `getsentry/getsentry`. We treat it as a graduation path, not a default.

## Planned `apps/api` split

`apps/api` today is a kitchen sink: Yjs sync protocol, Postgres-backed persistence, auth, workspace management, AI inference. This is fine operationally but muddies the self-host story ("self-host `apps/api` but disable these 14 features").

When `apps/api` becomes uncomfortable to maintain as a single unit, split it:

```
apps/sync-server   pure Yjs sync protocol, genuinely self-hostable
                   on a VPS with no other Epicenter infrastructure.
                   AGPL.

apps/api           cloud platform: auth, Postgres, workspace mgmt,
                   billing hooks, admin endpoints. AGPL, but
                   practically requires the full Epicenter stack.

apps/dashboard     UI for apps/api. AGPL.
```

The split is architectural, not licensing. All three remain AGPL. The benefit is a cleaner self-host story for individuals and homelabbers (`apps/sync-server` alone) without conflating it with the cloud-platform code.

This is not blocking and not scheduled. Trigger to execute: `apps/api` becomes painful to keep as a single unit, or a community member wants to self-host the sync protocol without the rest.

## Per-package breakdown

| Path | License | Notes |
|---|---|---|
| `packages/workspace` | MIT | Core CRDT library, the developer-facing product |
| `packages/ui` | MIT | shadcn-svelte components |
| `packages/svelte-utils` (`@epicenter/svelte`) | MIT | Svelte 5 reactive helpers |
| `packages/filesystem` | MIT | POSIX layer over Yjs |
| `packages/cli` | MIT | `epicenter` CLI |
| `packages/sync` | AGPL-3.0 | Yjs sync protocol of Epicenter Cloud |
| `packages/auth` | AGPL-3.0 | Auth core (private, Epicenter cloud auth) |
| `packages/auth-svelte` | AGPL-3.0 | Svelte auth wrapper (private) |
| `packages/skills` | AGPL-3.0 | Opinionated AI tool calling on workspace tables |
| `packages/ai` | AGPL-3.0 | LLM tool bridging (private, stub) |
| `packages/constants` | AGPL-3.0 | Shared Epicenter URLs and versions (private) |
| `apps/api` | AGPL-3.0 | Sync server, auth, AI inference |
| `apps/dashboard` | AGPL-3.0 | Billing and credits dashboard |
| `apps/whispering` | AGPL-3.0 | Desktop transcription |
| `apps/honeycrisp` | AGPL-3.0 | Notes app |
| `apps/opensidian` | AGPL-3.0 | Note-taking with terminal |
| `apps/fuji` | AGPL-3.0 | Personal CMS |
| `apps/zhongwen` | AGPL-3.0 | Mandarin chat app |
| `apps/tab-manager` | AGPL-3.0 | Browser extension |
| `apps/skills` | AGPL-3.0 | Agent skill editor |
| `apps/breddit` | AGPL-3.0 | Reddit data importer |
| `apps/landing` | AGPL-3.0 | Public site |
| `apps/posthog-reverse-proxy` | AGPL-3.0 | Analytics proxy |

## Decision procedure for new packages

When adding a new package or app, ask one question:

**Would an external developer benignly `npm install` this and embed it in their own closed-source product, and do we want them to be able to?**

- **Yes** → MIT. The package joins the developer toolkit alongside `@epicenter/workspace`. It must genuinely make sense as a library outside Epicenter; "could in principle" is not enough.
- **No** → AGPL-3.0. This covers everything else: shipped apps, hosted servers, Epicenter-internal packages, opinionated product-shaped libraries.

The exceptional case (paying customer requires a proprietary-gated feature) → Proprietary, scoped to that feature, in its own subdirectory. Never gate speculatively. The proprietary tier is reactive, not prospective.

When in doubt, default to AGPL. The current MIT set (5 packages) is small and deliberate; growing it requires positive justification, not absence of objection. License changes are easy in one direction (MIT → AGPL/proprietary on new code is fine for the copyright holder) and hard in the other (AGPL → MIT requires consent from every contributor, which is why CLAs exist; we don't have one).

## Contributor licensing posture

**No CLA. No DCO. No dual-licensing.**

Reasoning:
- We do not sell commercial AGPL exemptions to enterprises. Our revenue model is hosting, not licensing.
- Cal.com, dub.sh, Plausible, and most other open-core projects we are modeled on do not require CLAs either. The friction discourages contributors and provides no benefit for a hosting business.
- If we ever needed to relicense `packages/sync` or `apps/api` away from AGPL (e.g. to sell self-hosted enterprise licenses without copyleft), we would need either (a) a CLA from the start, or (b) consent from every external contributor at that point. We accept (b) as a future cost in exchange for present-day contributor friendliness. As of this spec, there are zero external contributors to AGPL components, so the cost is zero today.
- If a meaningful external PR lands on an AGPL component and we anticipate ever wanting to dual-license, we can add CLA Assistant (a GitHub bot, click-through CLA) at that point. We do not pre-commit to that decision.

By contributing to Epicenter, contributors agree their contributions are licensed under the same license as the file they are modifying. This is the standard "inbound = outbound" convention used by Linux, Rails, and most open source projects without formal CLAs.

## Prior art

Two clusters of prior art are relevant. We anchor to the first cluster (no proprietary tier, monetize hosting) and keep the second cluster as a graduation path if a specific enterprise deal forces it.

**Closest models (no proprietary tier, hosting-only revenue):**
- **Plausible Analytics:** AGPL throughout, single-founder-led for years, monetizes via hosted SaaS only. No proprietary, no CLA.
- **PostHog:** Apache and AGPL components, monetizes via hosted SaaS and enterprise SLA contracts on the same code. No proprietary tier in the standard sense.
- **Cal.com:** AGPL throughout, hosted SaaS, no CLA.
- **dub.sh:** AGPL throughout, hosted SaaS, no CLA.
- **Yjs:** MIT for the core library and client-side providers (`y-websocket`, `y-webrtc`, `y-indexeddb`); AGPL for `y-redis` (server-side scaling backend).

**Graduation models (proprietary tier alongside open core, only if needed):**
- **Liveblocks:** Apache-2.0 for client libraries; AGPL for server.
- **Bitwarden:** GPL/AGPL for clients and core server; proprietary for `bitwarden_license/` enterprise modules.
- **Sentry:** Migrated through several variants (MIT to BSL to FSL); historically used a `getsentry/getsentry` proprietary repo for paid features.

Our default model is closest to Plausible and PostHog: permissive for libraries, AGPL for apps and servers, hosting is the revenue surface, proprietary tier exists on paper but stays empty. We graduate toward the Bitwarden/Sentry pattern only if a specific enterprise customer pulls a specific feature into the proprietary tier.

## Proprietary LICENSE template

When the first proprietary module is added, use this text:

```
Copyright (c) 2023-2026 Braden Wong. All rights reserved.

This software and associated documentation files (the "Software") are
proprietary and confidential. The Software is made available on GitHub
for transparency and customer trust, but no license is granted to use,
copy, modify, merge, publish, distribute, sublicense, or sell copies of
the Software except as expressly permitted in writing by the copyright
holder or as required to view the source on GitHub.

For commercial licensing, contact: github@bradenwong.com

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
```

## Open questions and review triggers

- Revisit if a meaningful external contributor lands a PR on any AGPL component. Decide then whether to add CLA Assistant.
- Revisit if a specific paying customer requires a feature that AGPL would let them self-host for free. This is the trigger to populate the proprietary tier (one feature, scoped to a subdirectory). Until that happens, the tier stays empty by design.
- Revisit if `apps/api` becomes painful to maintain as a kitchen sink, or a community member asks to self-host the sync protocol alone. This is the trigger to execute the `apps/sync-server` split.
- Revisit if we sell self-hosted enterprise licenses. That would be the trigger for moving to a real dual-license posture (and retroactively adding CLAs).
