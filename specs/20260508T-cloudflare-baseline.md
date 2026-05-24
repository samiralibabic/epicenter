# Cloudflare baseline as code

**Date:** 2026-05-08
**Status:** Implemented

One reconciliation script that enforces a security baseline across every
Cloudflare zone we own. Run locally with a short-lived token whenever the
baseline changes or a new zone is added.

## Why

A security review surfaced that `http://api.epicenter.so` was serving plaintext
because "Always Use HTTPS" was off at the zone. The underlying problem was not
one missed setting: with 12 zones, anything managed by clicking dashboards
drifts over time. Codifying the desired state and re-running on demand keeps
the baseline legible and idempotent.

A weekly CI cron was considered and skipped: at this account size (solo, ~2
new zones/year) the realistic drift rate is ~1 event/year, which does not
justify standing a `DNS:Edit`-scoped token in GitHub Secrets year-round.

## What it manages

Per zone:

| Setting | Value |
| --- | --- |
| `always_use_https` | `on` |
| `automatic_https_rewrites` | `on` |
| `ssl` | `strict` |
| `min_tls_version` | `1.2` |
| `security_header` (HSTS) | 180 days, `includeSubDomains`, no preload |
| DNSSEC | active |

Per zone marked `email: 'lockdown'` (11 of 12; `epicenter.so` sends mail via
Google Workspace and is left alone):

| Record | Content |
| --- | --- |
| `<zone>` TXT | `v=spf1 -all` |
| `_dmarc.<zone>` TXT | `v=DMARC1; p=reject; rua=mailto:postmaster@epicenter.so; aspf=s; adkim=s` |

The script also runs a startup cross-check: every URL in `APPS` must live on
a declared zone. Adding an app on a new domain without declaring its zone
fails the script loudly.

## What it does not manage

- A/CNAME records for Worker-fronted URLs. Wrangler creates these via
  `custom_domain: true` on deploy.
- Email DNS for `epicenter.so`. Google Workspace owns its SPF/DKIM/DMARC.
- Workers / KV / R2 / Durable Object bindings. They stay in `wrangler.jsonc`.
- HSTS preload. Off deliberately; revisit after 6-12 months of stable HTTPS.

## Runbook

1. Create an **Account** API Token (Cloudflare dashboard → your account →
   Manage Account → API Tokens; not the User API Tokens page). Account-level
   tokens survive ownership changes; the User page warns you about this.
   - Name: `scripts-cf-apply` (the name in the CF dashboard mirrors the
     consumer file path so future-you can map dashboard tokens back to code
     by grep).
   - Permissions: `Zone.Zone:Read`, `Zone.Zone Settings:Edit`, `Zone.DNS:Edit`.
   - Resources: all zones from your account.
   - TTL: ~90 days. The token only gets used on demand, so a short TTL keeps
     the blast radius small if it ever leaks.
2. Store the token value as `CLOUDFLARE_ZONE_TOKEN` in Infisical under
   `/ops` in the `prod` environment. Leave the value empty in `dev` and
   `staging`; this token rewrites production DNS and has no business sitting
   in a non-prod environment. The env var name uses SCREAMING_SNAKE_CASE
   because it's an env var; the dashboard name uses `kebab-case` because it's
   a dashboard label. Two different audiences, two different conventions.
3. `bun run cf:plan` previews; `bun run cf:apply` writes. The npm scripts pin
   `--env=prod --path=/ops` so the token only resolves under those
   coordinates.
4. After apply, paste any printed DS record at the registrar for zones not
   registered at Cloudflare.
5. Revoke the token when finished, or let the TTL expire.

The script never destroys; the worst case is "PATCH a setting back to the
declared value." Safe to re-run.
