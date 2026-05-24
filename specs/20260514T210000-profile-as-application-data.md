# Profile is application data, not auth state

**Date**: 2026-05-14
**Status**: Implemented
**Author**: AI-assisted
**Supersedes** (in part):
- `specs/20260514T200000-api-me-three-field-token-bundle.md` (the "Profile is memory-only" section and the `email` / `profileStatus` fields on `AuthState`; the grant/unlock split and the network gate are retained)
**Composes with**:
- `specs/20260514T120000-machine-auth-oob-clean-break.md` (CLI auth.json holds grant + unlock only; CLI never prints email from local state)

## Overview

`auth.state` exposes capability material (`status`, `unlock`) and nothing else. Email is not auth state; it is what `/api/me` returns when the surface that needs to display it asks. The three call sites that show email today either drop it or query for it at the component layer.

## One Sentence

```
The account is something you have, not something you see;
auth holds capability, and profile is application data
fetched where it is shown.
```

This is the cohesion sentence. The previous draft tried to keep email in auth state as a memory-only label with a freshness flag. The freshness flag and the null fallbacks were the smell. The correct split is: anything keyed by `userId` that the runtime needs to decrypt or authenticate belongs in `auth.state`; anything the UI happens to want to show is a query.

## Motivation

### Current State (after Wave 3 of the prior spec)

```ts
// packages/auth/src/auth-types.ts
type AuthState =
  | { status: 'signed-out' }
  | {
      status: 'signed-in';
      unlock: LocalUnlockBundle;
      email: string | null;          // memory-only, fetched from /api/me
      profileStatus: 'missing' | 'refreshing' | 'fresh' | 'stale';
    }
  | {
      status: 'reauth-required';
      unlock: LocalUnlockBundle;
      email: string | null;
      profileStatus: ProfileStatus;
    };
```

Three call sites read `email`:

```svelte
<!-- apps/dashboard/src/routes/(signed-in)/+layout.svelte -->
<UserMenu user={{ id: auth.state.unlock.userId, email: auth.state.email ?? 'Account' }} />

<!-- apps/zhongwen/src/routes/(signed-in)/+page.svelte -->
<span>{auth.state.status === 'signed-out' ? '' : (auth.state.email ?? 'Account')}</span>

<!-- packages/svelte-utils/src/account-popover/account-popover.svelte -->
<p>{auth.state.email ?? 'Account'}</p>
```

### Problems

1. **Hybrid framing**: email sits halfway between identity and decoration. It is in `AuthState` but typed as nullable; consumers branch on `null`; the runtime tracks `profileStatus` to model when the null means "not loaded yet" vs "loading" vs "load failed."
2. **Synthetic-identity reconstruction**: dashboard manually rebuilds `{ id, email }` at the call site because `UserMenu` was designed against the old bundled-identity shape.
3. **Null-fallback noise**: `?? 'Account'` repeats at every read site; the placeholder is meaningless ("Account" is not a label, it is the absence of one).
4. **Surface tied to the wrong thing**: future profile fields (name, avatar, preferences) would each need their own slot in `AuthState`, their own freshness handling, their own null fallback at every site. The shape does not compose.
5. **The slippery slope is real**: the prior spec correctly identified that persisting email creates pressure to persist more decorative fields. It then solved this by carving out a memory-only Profile bucket in `AuthState`, which solved the disk pressure but left the state-shape pressure intact.

### Desired State

```ts
// packages/auth/src/auth-types.ts
type AuthState =
  | { status: 'signed-out' }
  | { status: 'signed-in'; unlock: LocalUnlockBundle }
  | { status: 'reauth-required'; unlock: LocalUnlockBundle };
```

Three variants. One field beyond `status`. No nulls, no freshness flags. Email lives at the query layer:

```svelte
<!-- packages/svelte-utils/src/account-popover/account-popover.svelte -->
<script lang="ts">
  const profile = createQuery(() => ({
    queryKey: ['profile', auth.state.status === 'signed-in' ? auth.state.unlock.userId : null],
    queryFn: () => auth.fetch('/api/me').then((r) => r.json()),
    enabled: auth.state.status !== 'signed-out',
    staleTime: Infinity,
  }))
</script>
{profile.data?.user.email ?? 'Loading…'}
```

## The journey to this design

Six proposals preceded this one. The prior spec's table covered five; this one adds the sixth and concludes the lineage:

```
1. /workspace-identity (status quo before Wave 1)
   freshness bug: keys go stale, no recovery path

2. WorkspaceIdentityStore second package
   over-engineered; the parallel store dissolved at a different layer

3. id_token-bearing encryption keys
   OIDC abuse; signature theater; widens leakage surface

4. /api/me + in-memory-only identity
   offline cold-boot breaks; daemon cannot decrypt local Yjs

5. /api/me + bundled identity (status quo before THIS spec)
   conceptually muddy; refresh writes identity bytes for no reason

6. /api/me + grant/unlock split + memory-only profile (prior spec, current code)
   grant/unlock split is the win; profile-as-state is the residual smell
   AuthState carries email and freshness flag; UI carries null fallbacks
   refused to persist email but never asked the prior question:
   should email be in state AT ALL?

7. THIS spec: refuse the feature of "email in auth state"
   profile is what /api/me returns when the account surface asks
   AuthState is purely capability; profile is application data
```

Proposal (7) is the asymmetric win the prior spec was one step short of. The mechanical change is small (drop one nullable field plus a status enum). The conceptual change is the load-bearing one: email stops being a thing the runtime tracks.

## Research Findings

### Comparable apps and how they surface account email

No prior comparison artifact exists in this codebase (`/Users/braden/.claude` and `epicenter/specs/` searched; nothing found). The taxonomy below is introduced here as part of this spec and is a candidate for extraction into a future skill.

| App | Category | Email in chrome? | Where email appears | Persisted? |
| --- | --- | --- | --- | --- |
| Gmail | Communication-first | Yes, prominently | Avatar chip top-right, every dialog, every "send as" | Yes |
| Slack | Communication-first | Yes, in workspace switcher | Sidebar, workspace switcher, profile card | Yes |
| Signal | Communication-first (phone-keyed) | N/A (phone instead) | Settings only | Yes |
| 1Password | Credential vault | Yes, on unlock screen | Vault unlock disambiguator | Yes (multi-vault) |
| Bitwarden | Credential vault | Yes, on unlock screen | Account switcher | Yes (multi-vault) |
| Tailscale | Infra/identity tool | Yes, in tray menu | Tray, account switcher | Yes (multi-tailnet) |
| Linear | Tool with identity | No in chrome, yes in popover | Avatar in sidebar; email in profile menu | Yes |
| Notion | Tool with identity | Avatar only in chrome | Email in account settings | Yes |
| Figma | Tool with identity | Avatar only in chrome | Email in account menu | Yes |
| Cursor | IDE | Avatar only | Email in account dropdown | Yes |
| VS Code | IDE | Account icon | Email behind account icon click | Yes |
| Obsidian | Local-first workspace | No | Settings > About > Account (Sync only) | Yes (Sync only) |
| Logseq | Local-first workspace | No | Settings only (Sync only) | Yes (Sync only) |
| Anytype | Local-first workspace | No | Settings only | Yes |
| Tana | Workspace tool | Avatar only | Settings panel | Yes |

**Key finding**: across "tool" and "local-first workspace" apps, email is recessive in chrome and revealed by intent (clicking an avatar, opening settings). Across "communication" and "vault" apps, email is prominent because it disambiguates accounts the user actively switches between. Epicenter is squarely in the local-first workspace category and has no multi-account model (one storage cell per app surface).

**Implication**: refusing to show email in UI chrome is consistent with comparable tools. The Linear/Notion/Figma/Cursor/VS Code pattern (avatar in chrome, email behind a click) is the right reference, not Gmail/Slack.

**Asymmetric win**: refusing the feature of "email in chrome" collapses the entire memory-only profile concept. Email becomes a query result at the one or two surfaces that genuinely want to show it.

### What "show email" actually costs

```
Sites that show email today    3 (dashboard layout, zhongwen page, account popover)
Sites that show it in chrome   2 (dashboard layout, zhongwen page; recessive avatar would do)
Sites that need the real email 1 (account popover when opened)
```

Two of three sites can drop email entirely (replace with avatar/initials). One site (the popover) queries `/api/me` when opened. Zero sites need email in central state.

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| `email` on `AuthState` | 2 coherence | Remove | Auth state is capability; profile is application data. The prior spec's hybrid framing produced the null/freshness smell. |
| `profileStatus` on `AuthState` | 2 coherence | Remove | Without `email` in state there is nothing to track freshness on. |
| Where email shows up in chrome | 3 taste | Avatar/initials only | Matches Linear/Notion/Figma/Cursor/VS Code; constraint is "Epicenter is a local-first workspace tool, not a communication app." |
| How the popover gets email | 2 coherence | TanStack Query against `auth.fetch('/api/me')` | Email is application data; the codebase already uses TanStack Query for application data; `staleTime: Infinity` because email almost never changes within a session. |
| Avatar derivation | 3 taste | Initials from `unlock.userId` first 2 chars, deterministic color hash | UUID-shaped userIds do not produce human-readable initials. Generic person glyph is an acceptable fallback if initials feel ugly in practice. |
| `/api/me` internal use in createOAuthAppAuth | 2 coherence | Keep, but discard `user.email` from the response | The network gate (same-user guard, encryptionKeys rotation) still calls `/api/me`. It just stops piping `user.email` into state. |
| Reauth-required copy | 3 taste | "Session expired. Sign in again." (no email) | Email is unavailable in this state by design (refresh token expired). Other tools say "Sign in again" without the prior email. |
| Sign-out confirmation copy | 3 taste | "Sign out?" (no email) | Same reasoning; consistent with comparable tools. |
| Auth-svelte profile helper export | Deferred | Decide during implementation | Could expose `createProfileQuery(auth)` for consumer reuse, or leave wiring to each consumer. Defer until the second consumer wants it. |

## Architecture

The collapsed surface:

```
┌──────────────────────────────────────────────────────────────┐
│ createOAuthAppAuth                                           │
│ ├── state: AuthState                                         │
│ │   ├── { status: 'signed-out' }                             │
│ │   ├── { status: 'signed-in';      unlock: LocalUnlock }    │
│ │   └── { status: 'reauth-required'; unlock: LocalUnlock }   │
│ ├── fetch:           (input, init?) => Promise<Response>     │
│ ├── openWebSocket:   (url) => WebSocket                      │
│ ├── signIn:          () => Promise<...>                      │
│ └── signOut:         () => Promise<...>                      │
└──────────────────────────────────────────────────────────────┘
         │
         │ /api/me (network gate; internal; same-user guard + key rotation)
         ▼
┌──────────────────────────────────────────────────────────────┐
│ Persisted cell on disk (PersistedAuth)                       │
│ ├── grant:  { accessToken, refreshToken, expiresAt }         │
│ └── unlock: { userId, encryptionKeys }                       │
└──────────────────────────────────────────────────────────────┘

         (no profile bucket; no email; no freshness flag)

┌──────────────────────────────────────────────────────────────┐
│ Account popover (only surface that displays email)           │
│   const profile = createQuery({                              │
│     queryKey: ['profile', unlock.userId],                    │
│     queryFn: () => auth.fetch('/api/me'),                    │
│     enabled: status !== 'signed-out',                        │
│     staleTime: Infinity,                                     │
│   })                                                         │
└──────────────────────────────────────────────────────────────┘
```

The arrows tell the story: `auth` calls `/api/me` for its own reasons (guard + rotation); the popover calls `/api/me` for its own reasons (display). These are two separate calls. Most apps will only see one of them per cold boot in practice because of TanStack's deduping plus the bearer cache, but the spec does not promise dedupe.

### Lifecycles (changes from the prior spec)

```
SIGN-IN
  1. OAuth PKCE dance
  2. POST /auth/oauth2/token  → grant
  3. GET  /api/me             → unlock (userId + encryptionKeys); email DISCARDED
  4. write PersistedAuth atomically
  5. state = signed-in
  (NO memory profile written)

COLD BOOT
  1. read persisted cell
  2. state = signed-in immediately (unlock present)
  3. if online:
     a. refresh grant if stale
     b. GET /api/me
        success → rotate unlock if encryptionKeys changed;
                  same-user guard on userId; on mismatch wipe cell
        failure → state stays signed-in; no freshness state to update
  4. UI renders avatars from unlock.userId; popover query fires when opened
  (NO email piping; NO profileStatus transitions)

REFRESH / SIGN-OUT / REAUTH-REQUIRED
  Unchanged from prior spec EXCEPT:
  - reauth-required carries no email
  - sign-out wipes the cell; no memory profile to drop
```

## Implementation Plan

### Phase 1: Build (auth package)

- [x] **1.1** `packages/auth/src/auth-contract.ts`: remove `email` and `profileStatus` from `signed-in` and `reauth-required` variants; reduce `AuthState` to the three-variant shape above.
- [x] **1.2** `packages/auth/src/auth-state-store.ts`: state derivation operates on `(cellPresent)` alone. Reference equality on `persisted` continues to drive change events.
- [x] **1.3** `packages/auth/src/create-oauth-app-auth.ts`: keep the `/api/me` call (same-user guard + unlock rotation); discard `user.email` from the parsed response; remove all writes to memory profile.
  > **Note**: Replaced the old `email !== null` freshness predicate with a `verifiedPersisted` reference. The network gate still refuses bearer attachment until `/api/me` confirms the current persisted cell, but that proof no longer carries profile data.
- [x] **1.4** `packages/auth/src/index.ts`: re-export the trimmed `AuthState`; no profile types to export.
  > **Note**: No index edit was needed because the public export already derived from `auth-contract.ts`.
- [x] **1.5** `packages/auth-svelte/src/index.ts`: drop any profile re-exports.
  > **Note**: No auth-svelte edit was needed because no profile type was exported there.
- [x] **1.6** Update `packages/auth/src/contract.test.ts`: drop profile assertions; keep network-gate test; assert `email` is not present on state.

### Phase 2: Build (UI consumers)

- [x] **2.1** `packages/svelte-utils/src/account-popover/account-popover.svelte`: introduce `createQuery` against `auth.fetch('/api/me')` with `staleTime: Infinity` and `enabled` gated on `auth.state.status !== 'signed-out'`. Show `profile.data?.user.email` with a "Loading…" placeholder while the query is in flight.
  > **Note**: The shared popover passes a component-local `QueryClient` to `createQuery`. That keeps the query inline while avoiding new provider requirements in tab-manager, opensidian, fuji, and other consumers that do not already mount TanStack Query.
- [x] **2.2** `apps/dashboard/src/routes/(signed-in)/+layout.svelte`: replace `UserMenu user={...}` with a `UserMenu` that takes no user prop (or `userId` only) and renders avatar/initials from `auth.state.unlock.userId`. If `UserMenu` is in svelte-utils, update its API there.
  > **Note**: Dashboard now uses a generic account icon and an "Epicenter account" label in the menu instead of deriving initials from email or userId.
- [x] **2.3** `apps/zhongwen/src/routes/(signed-in)/+page.svelte`: remove the email span. Either drop it entirely or replace with the same avatar pattern as the dashboard.
- [x] **2.4** Audit other apps (whispering, honeycrisp, opensidian, fuji, tab-manager) for any chrome-level email read sites that the Wave-3 commit may have introduced; apply the same treatment.
  > **Note**: `rg "auth\.state\.(identity|email)"` across the audited apps found no remaining chrome-level reads.

### Phase 3: Prove

- [ ] **3.1** Typecheck across the workspace: `bun run build` and `bun run check`.
  > **Note**: Focused typechecks passed for `@epicenter/auth`, `@epicenter/api`, and `@epicenter/dashboard` after this follow-up. Full workspace proof remains open because `bun run typecheck` now reaches unrelated existing diagnostics in `@epicenter/ui`, and `bun run check` still sees unrelated format drift outside this spec wave.
- [x] **3.2** Run existing auth contract tests; add a regression test asserting `auth.state` shape is the three-variant collapsed form.
- [ ] **3.3** Manual smoke: cold-boot online (popover query fires, email loads), cold-boot offline (popover shows "Loading…" or an offline placeholder, no other UI broken), sign-out (popover query disables, state goes to signed-out).
- [x] **3.4** Verify network-gate semantics still hold via the existing test that pre-writes a cell with userId=alice and stubs `/api/me` to return userId=bob.

### Phase 4: Remove

- [x] **4.1** Delete `Profile` type, `ProfileStatus` type, and any `profile.email` references that survived Phase 1.
- [x] **4.2** Delete the prior spec's "Profile is memory-only" section (or mark it superseded inline with a pointer to this spec).
  > **Note**: Marked the old section superseded inline so the historical grant/unlock rationale remains readable while pointing profile-state readers here.
- [x] **4.3** Search for `?? 'Account'` across the workspace; expect zero hits.

## Edge Cases

### Cold boot offline, popover opened

1. User has signed in previously; refresh token still valid; device is offline.
2. App boots; `auth.state.status === 'signed-in'`; unlock is present; encrypted Yjs reads work.
3. User clicks account popover; the query fires; `auth.fetch('/api/me')` fails (no network).
4. Popover shows "Offline" placeholder or the query's error state. The user sees no email.
5. This is acceptable. The popover is not a load-bearing surface offline; the user knows which account they signed into.

### Refresh token expired, popover opened

1. State is `reauth-required`; unlock is preserved; grant is unusable.
2. User opens popover; query fires; `auth.fetch` attempts a refresh, fails, surfaces a 401.
3. Popover renders an error state (or the same "Loading…" if the error is silent).
4. The popover should also expose the sign-in CTA when the underlying auth state is `reauth-required`; this is already a UX requirement independent of email display.

### Same-user guard fires (`/api/me` returns different userId)

1. `createOAuthAppAuth` wipes the persisted cell; state → `signed-out`.
2. The popover's `createQuery` is gated on `status !== 'signed-out'`; the query disables and the cached data is invalidated when `unlock.userId` in the query key changes.
3. The popover shows the signed-out empty state.

### Multi-tab: tab A signs out

1. Storage event fires; tab B's `createOAuthAppAuth` reads `null`; state → `signed-out`.
2. Tab B's popover query disables (gated on `status`); TanStack Query's `queryKey: ['profile', null]` removes the cached result on next render.
3. Popover shows signed-out state in both tabs.

### Future: multi-account on a single device

Not in scope. Today, `PersistedAuthStorage` is one cell. If multi-account lands, the cell becomes a list; identifying the active account in chrome would justify showing an email (or a per-account label) for disambiguation. Revisit this spec at that time.

## Open Questions

1. **Avatar derivation from `userId` (UUID).**
   - Options: (a) initials from the first 2 hex chars of UUID + deterministic background color, (b) generic person glyph for everyone, (c) a small library like `boring-avatars` keyed on userId.
   - **Recommendation**: (b) generic glyph for the first pass; promote to (a) or (c) if user feedback says the chrome feels impersonal. The point of this spec is that the chrome is recessive.

2. **Where the popover query lives.**
   - Options: (a) inline in `account-popover.svelte`, (b) a shared `createProfileQuery(auth)` factory exported from `packages/auth-svelte`, (c) a `useProfile()` hook colocated with each consumer app.
   - **Recommendation**: start with (a). Promote to (b) when a second consumer appears. Do not predict the second consumer.

3. **Should `auth.fetch('/api/me')` and the popover's `/api/me` query share a cache?**
   - Options: (a) treat them as independent calls (current draft), (b) expose `auth.profile()` returning a Promise that the runtime memoizes, (c) wire the popover query through `auth` so the network gate and the display share one fetch.
   - **Recommendation**: (a) for the initial implementation. The two calls are cheap; deduplication is a micro-optimization that would couple the network gate to the UI layer. Revisit if `/api/me` becomes hot.

4. **Reauth-required copy.**
   - Options: (a) "Session expired. Sign in again.", (b) "Session expired. Signed in as your-account@..." (which requires holding the last-seen email in memory after all), (c) fetch `/api/me` with the dying grant on the way into reauth-required and cache the email locally for this banner only.
   - **Recommendation**: (a). The "signed in as X" affordance is comforting but not load-bearing; reintroducing email-in-memory just for this banner re-creates the smell this spec exists to remove.

5. **What about `Whispering`'s account UI?**
   - Whispering predates the OAuthSession migration in some places. Spec implementer should verify (`rg "auth\.state\.(identity|email)" apps/whispering`) and apply the same treatment if hits are found.
   - **Recommendation**: include in Phase 2.4 audit; do not block the rest of the spec on Whispering specifics.

## Decisions Log

- **Keep `/api/me` as the network gate's call, even though email is discarded.**
  Constraint: the same-user guard and the encryptionKeys rotation are the gate's reason to exist; both come from `/api/me`. Discarding only the `user.email` field is one line of code in the response handler. Revisit when: a cheaper endpoint exists that returns userId + encryptionKeys without the user object.

- **Keep the popover's email display, even though chrome no longer shows email.**
  Constraint: the popover is the place where a user verifies "am I signed in as the right account before doing something destructive." Removing email there too would force users to open settings to confirm identity. Revisit when: an account-settings page exists in every app, at which point the popover can link to it instead.

## Success Criteria

- [x] `grep -r "auth\.state\.email" apps/ packages/` returns zero hits.
- [x] `grep -r "profileStatus" apps/ packages/` returns zero hits.
- [x] `grep -r "?? 'Account'" apps/ packages/` returns zero hits.
- [x] `AuthState` is exactly three variants and contains no field named `email`, `profile`, `profileStatus`, or `identity`.
- [x] The account popover renders the email from a query, not from auth state.
- [x] Existing network-gate and same-user-guard tests pass unchanged.
- [ ] Manual smoke: cold-boot offline does not block UI rendering; popover does not throw when query is disabled or errors.

## References

- `specs/20260514T200000-api-me-three-field-token-bundle.md` - prior spec; this one supersedes its profile sections.
- `specs/20260514T120000-machine-auth-oob-clean-break.md` - CLI auth flow; CLI side already does not display email from local state.
- `packages/auth/src/create-oauth-app-auth.ts` - where the network gate lives; where email piping is removed.
- `packages/auth/src/auth-contract.ts` - `AuthState` shape lives here.
- `packages/svelte-utils/src/account-popover/account-popover.svelte` - the one consumer that still needs to display email.
- `apps/dashboard/src/routes/(signed-in)/+layout.svelte` - chrome example to adapt.
- `apps/zhongwen/src/routes/(signed-in)/+page.svelte` - chrome example to adapt.
- TanStack Query patterns in this codebase: `packages/svelte-utils/` and `apps/*/src/lib/query/` for `createQuery` usage and conventions.

## Review

**Completed**: 2026-05-15
**Branch**: `codex/wave1-cli-callback-and-health`

### Summary

Auth state is now capability-only in the implemented surface: consumers no longer read `auth.state.email`, and the account popover fetches `/api/me` as application data. Dashboard and Zhongwen chrome stopped showing account email, while the shared popover remains the place where the email appears when profile data loads.

### Deviations from Spec

- The shared account popover uses a component-local `QueryClient` passed directly to `createQuery`. This keeps the query inline without requiring every app that mounts `AccountPopover` to add a `QueryClientProvider`.
- The dashboard account menu uses a generic user icon and "Epicenter account" label instead of deriving initials from `unlock.userId`.
- `auth.fetch('/api/me')` support for relative API paths was already present in the auth implementation in this checkout; the wave added a regression test covering it.
- The review pass also fixed the reauth-required popover button so "Reconnect" is clickable.

### Follow-up Work

- Full workspace typecheck is still blocked by unrelated existing diagnostics in `@epicenter/ui`.
- Full workspace check is still blocked by unrelated format drift outside this spec wave.
- Manual browser smoke for cold boot online, cold boot offline, and sign-out remains to be run against a live auth/API setup.
