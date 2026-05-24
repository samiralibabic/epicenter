# Online grant, local unlock, profile: three concerns, three lifecycles

**Date**: 2026-05-14 (revised)
**Status**: Accepted (revision 4; Waves 2-4 landed on 2026-05-14 with asymmetric simplifications applied during implementation)
**Supersedes**:
- `specs/20260514T154500-id-token-bearing-encryption-keys.md` (the id_token-carries-keys design)
- `specs/20260514T160000-execute-id-token-and-oob-cli.md` (the Wave 1-4 plan based on that design)
- `specs/20260514T091255-tokens-only-auth-extract-identity-to-workspace.md` (the WorkspaceIdentityStore variant)
**Composes with**: `specs/20260514T120000-machine-auth-oob-clean-break.md` (the OOB CLI flow; this spec adjusts the persisted shape the CLI's env-paths machine auth file holds)

## One Sentence

```
There are three concerns, not two: an online grant (server access),
a local unlock (offline decryption), and a profile (UI labels).
Each persists where it earns its keep: the grant and the unlock on
disk in one cell with two clearly-labeled sections; the profile
in memory only, fetched from /api/me when online.
```

This is the cohesion sentence. The previous draft tried to split on "tokens vs identity" and broke offline cold-boot. The correct split is on lifecycle and authority, not on the wire shape.

## The journey to this design

Five proposals preceded this one. Listing them as alternatives considered, with the specific failure mode that eliminated each:

```
1. /workspace-identity (status quo)
   identity captured at sign-in, never refreshed
   freshness bug: keys go stale, no recovery path

2. WorkspaceIdentityStore as a second package (spec 20260514T091255)
   adds a parallel store with its own attach/detach lifecycle
   over-engineered; the smell it attacked dissolved at a different layer

3. id_token-bearing encryption keys (spec 20260514T154500)
   identity rides in id_token's claims; one-cell, decode-on-read
   OIDC abuse: keys are capability material, not identity facts
   leakage surface widens: loggers treat id_tokens as non-sensitive
   signature theater: client decodes but does not verify

4. /api/me + in-memory-only identity (revision 2 of THIS spec)
   tokens persist; identity fetched on cold boot
   offline cold-boot breaks: daemon cannot decrypt local Yjs data
   loading-as-failure-mode: long network outage looks like infinite loading

5. /api/me + bundled identity (Option B "charitable")
   tokens and identity in one cell, same shape as today
   freshness fix via cold-boot refresh
   conceptually muddy: bundles "what's needed for the server" with
   "what's needed for offline decrypt" with "what UI shows"
```

This proposal is the response to (5)'s muddiness. The mechanical answer is the same one-cell shape, but the conceptual model is sharper.

## The split

```
ONLINE GRANT
  what:        server access; the bearer for /api/* and the rotation key
  fields:      accessToken, refreshToken, accessTokenExpiresAt
  fetched:     /auth/oauth2/token (sign-in; refresh on 401)
  persisted:   yes (offline-useless, but needed to call the server when online)
  refreshed:   on 401 (auto); rotation invisible to callers
  cleared:     sign-out

LOCAL UNLOCK
  what:        device capability to decrypt local Yjs data without the server
  fields:      userId, encryptionKeys
  fetched:     /api/me (sign-in; cold-boot when online)
  persisted:   yes (offline cold-boot reads this to decrypt)
  refreshed:   /api/me on cold-boot when online; updated only if keys changed
  cleared:     sign-out, OR same-user guard mismatch on next /api/me

PROFILE
  what:        UI display labels for the human (email; future: name, avatar)
  fields:      email
  fetched:     /api/me (sign-in; cold-boot when online)
  persisted:   NO (memory only; cold-boot offline degrades to generic label)
  refreshed:   /api/me on cold-boot when online
  cleared:     sign-out, process exit
```

The asymmetric move: refuse to persist email even though we could. The reason is policy-by-construction, not byte-counting. Drawing the line at "disk holds device capability material, nothing decorative" means future contributors do not face "is this OK to persist?" debates each time a UI feature wants a label cached.

## Persisted shape

```ts
// packages/auth/src/auth-types.ts

export const OAuthTokenGrant = type({
  '+': 'delete',
  accessToken:           'string',
  refreshToken:          'string',
  accessTokenExpiresAt:  'number',
});
export type OAuthTokenGrant = typeof OAuthTokenGrant.infer;

export const LocalUnlockBundle = type({
  '+': 'delete',
  userId:          'string',
  encryptionKeys:  EncryptionKeys,
});
export type LocalUnlockBundle = typeof LocalUnlockBundle.infer;

export const PersistedAuth = type({
  '+': 'delete',
  grant:  OAuthTokenGrant,
  unlock: LocalUnlockBundle,
});
export type PersistedAuth = typeof PersistedAuth.infer;
```

One cell. Two sections. The browser persists this to localStorage; the extension to chrome.storage.local; the CLI to `env-paths('epicenter').data/auth/<host>.json` (mode 0o600). All three storage cells validate against the same arktype.

`OAuthSession` (today's `{ tokens, identity }`) is deleted; this is a clean break, not a rename.

## Persisted storage contract

```ts
type PersistedAuthStorage = {
  get(): PersistedAuth | null;
  set(value: PersistedAuth | null): void | Promise<void>;
};
```

Two methods. No `watch` hook: cross-tab and cross-context sign-out propagates through the server authority, not through a client-side subscription. If Tab A wipes its cell on a same-user-guard mismatch, Tab B's next bearer-bearing call hits the network gate, calls `/api/me`, gets either a different userId (wipes Tab B's cell too) or a 401 from the revoked refresh token (drops Tab B to `reauth-required`). Brief cross-tab UI desync is acceptable; the network gate is the actual reconciliation mechanism.

This was an asymmetric win during Wave 2: the `watch` hook added an optional storage method, an `adoptExternalCell` handler with three branches, a self-write echo filter, and per-app `createPersistedState.watch` / `createStorageState.watch` wiring. The server-as-authority model collapses that surface back to zero.

## Profile is memory-only

> **Superseded by**: `specs/20260514T210000-profile-as-application-data.md`.
> The grant/unlock split and network gate below remain load-bearing. The
> memory-only profile part does not: auth state no longer carries `email`, and
> `/api/me` display data is fetched by the account surface that shows it.

Email is exposed directly on the AuthState as `email: string | null`. There is no separate `Profile` type and no arktype for it: the value is fetched from `/api/me`, never persisted, and `null` means "no `/api/me` has succeeded for the current persisted cell in this runtime."

## AuthState

```ts
type AuthState =
  | { status: 'signed-out' }
  | {
      status: 'signed-in';
      unlock: LocalUnlockBundle;
      email: string | null;
    }
  | {
      status: 'reauth-required';
      unlock: LocalUnlockBundle;
      email: string | null;
    };
```

Three variants. `unlock` is always present in `signed-in` and `reauth-required` because we persist it. `email` is `null` until `/api/me` succeeds at least once for the current cell; UIs gate decryption on `unlock`, display labels on `email`. Freshness is implicit: an `email` value means it was confirmed by `/api/me` for the current persisted cell. Every cell mutation (sign-in, sign-out, same-user-guard wipe) clears `email` back to `null`, forcing a fresh verification before the next bearer attachment.

No `loading` state. Disk reads are synchronous in browsers (localStorage) and fast in Node (`fs.readFile` of a tiny JSON file); the transition from "nothing in memory" to "signed-in" happens in one tick. Offline-and-cannot-unlock would be a degenerate state (unlock cell missing) that we map to `signed-out`, forcing re-auth.

Local workspace construction can proceed with `unlock` while `email` is `null`; bearer-bearing network calls cannot (see Network gate).

This was an asymmetric win during Wave 2: the earlier draft carried a 4-value `profileStatus` enum (`missing | refreshing | fresh | stale`) and a separate named `Profile` type. The implementation showed both were redundant: `email !== null` IS the freshness predicate, and the four-value vocabulary encoded distinctions the auth client never branches on.

## Network gate

`auth.fetch` and `auth.openWebSocket` only attach a bearer after the current runtime has confirmed `/api/me` for the current persisted cell. The rule:

```
Before attaching Authorization or bearer.<token>:
  1. if email !== null, continue
  2. if grant is expired or within refresh skew, refresh grant first
  3. call GET /api/me with the fresh-enough access token
  4. if /api/me returns the same userId:
       update unlock if keys changed
       set email
       attach bearer and continue
  5. if /api/me returns a different userId:
       clear persisted cell
       email = null
       state = signed-out
       do not attach bearer
  6. if /api/me fails for network/server reasons:
       keep unlock for local decrypt
       email stays at its previous value (null or the prior fresh value)
       do not attach bearer
```

This is the fix for the sync race. Cold boot can mount encrypted local Yjs data immediately, including offline. Collaboration and API requests wait until the same-user guard has passed in this runtime. If the device is offline, no bearer is attached, so the network path fails closed while local-first data remains usable.

## Server endpoints

```
POST /auth/oauth2/token   standard OAuth 2.1 token response
                          no server-side wrapping
                          { access_token, refresh_token, expires_in,
                            token_type, scope, id_token? }

GET  /api/me              { user: { id, email }, encryptionKeys }
                          single identity refresh point;
                          inherits bearer + workspaces:open from
                          resolveRequestWorkspaceIdentity
```

Two endpoints, both standard. No id_token claim hook. No customAccessTokenClaims. Better Auth may still include `id_token` when `openid` is granted; the client ignores it and never persists it. The `/api/me` route already shipped in commit `9f32ea0bc` and earns its keep in this design as the identity refresh point.

`/workspace-identity` stays alive as a legacy alias until Wave 4 deletes it.

## Lifecycles

### Sign-in (cold)

```
1. user clicks "sign in"
2. OAuth PKCE dance: redirect, consent, code
3. POST /auth/oauth2/token              → { access_token, refresh_token, expires_in }
4. write grant cell                       (3 fields)
5. GET /api/me                          → { user: { id, email }, encryptionKeys }
6. write unlock cell                      (userId + encryptionKeys; NOT email)
7. set memory profile                     (email)
8. same-user guard fires:
   - if prior unlock cell existed AND userId differs, treat as fresh sign-in
     (drop prior memory; new identity wins; old workspace data is unreachable
     because the key derivation differs)
9. state = signed-in
```

Two round-trips on sign-in (token, then me). This is the rare event; the cost is invisible.

### Cold boot

```
1. read persisted cell                    (one file; both sections)
   - cell absent       → state = signed-out (end)
   - cell present      → continue
2. state = signed-in immediately
   (unlock has userId + encryptionKeys; workspace can decrypt local Yjs;
    email = null at this point; UI shows generic account label)
3. UI renders. Lazy verification: the first auth.fetch or auth.openWebSocket
   triggers the Network gate:
   a. if access_token is stale, refresh the grant first
      (touches grant cell only)
   b. GET /api/me
      success → update unlock cell if encryptionKeys changed;
                set memory email;
                same-user guard: if response.user.id !== unlock.userId,
                  wipe cell, drop email, state = signed-out (force re-auth)
      failure → keep state = signed-in;
                email stays null (or stays at its prior fresh value);
                no bearer attached this round
```

Offline cold-boot stops at step 2; data is decryptable; the user can read and write to local Yjs blobs. Reconciliation happens lazily on the first online network call.

This was an asymmetric win during Wave 2: an earlier draft fired `/api/me` eagerly at construction. Lazy verification removes the construction-time race, removes the test knob (`skipBootProfile`), and matches "do work on demand" semantics: if the user does nothing, there's nothing to verify.

### Refresh (on 401 during a fetch)

```
1. auth.fetch hits a 401
2. force-refresh: POST /auth/oauth2/token grant_type=refresh_token
3. response → write grant cell (3 fields)
4. unlock cell untouched
5. profile untouched
6. retry the original request
```

Refresh is purely an online-grant concern. It does not write or read unlock; it does not touch profile.

### Sign-out

```
1. auth.signOut()
2. POST /auth/oauth2/revoke with refresh_token (RFC 7009)
3. clear persisted cell (both sections, atomic)
4. clear memory email
5. state = signed-out
```

### Reauth-required (refresh fails)

```
1. /auth/oauth2/token refresh returns 401 (refresh_token expired/revoked)
2. state = reauth-required, unlock preserved, email preserved if loaded
3. UI shows "session expired; signed in as ${email ?? 'your account'}"
4. user re-signs-in:
   - new tokens arrive; new /api/me call
   - same-user guard at step 5 of sign-in flow handles continuity or swap
```

## Why each field earns its keep

```
grant.accessToken            proves authorization until accessTokenExpiresAt;
                             sent on every /api/* request;
                             ~700 bytes JWT (ES256 + standard claims)

grant.refreshToken           obtains the next accessToken when this one expires;
                             opaque; ~32 bytes; the survival key

grant.accessTokenExpiresAt   skip a refresh round-trip when accessToken is fresh;
                             also signals "you might be offline a while";
                             number

unlock.userId                same-user guard (if /api/me returns different user,
                             this device is now serving a different account);
                             binds encryptionKeys to a subject;
                             string

unlock.encryptionKeys        decrypt local Yjs blobs; the whole reason unlock
                             persists at all;
                             array of { version, userKeyBase64 }

profile.email (memory only)  UI display in account popover, sign-out confirm,
                             share dialogs; absent on cold-boot offline;
                             string
```

What does NOT earn its keep:

```
unlock.validatedAt           a TOFU receipt for "when did /api/me last confirm
                             these keys?"; useful only if we have a policy like
                             "refuse offline decrypt after 30 days unvalidated."
                             We don't have that policy. YAGNI.

email on disk                decorative; not capability material; cold-boot
                             offline UI degrades to "Account" gracefully.
                             Persisting it sets a precedent for caching more
                             profile fields, which is the slippery slope this
                             spec exists to prevent.

id_token                     dead. Federation roadmap is empty; the signed
                             envelope proves nothing TLS hadn't already.

OAuthSession bundle          deleted. The "two concerns, one blob" shape was
                             what caused the freshness bug to begin with.
```

## Same-user guard

The guard fires in two places, both at /api/me response time:

```
Place 1: sign-in completes
  prior unlock cell exists AND response.user.id !== unlock.userId
    → treat as fresh sign-in: drop prior unlock; new unlock wins
    (the user is signing in as a different account on this device;
     prior workspace data is unreachable, which is intentional)

Place 2: cold-boot online refresh
  response.user.id !== unlock.userId
    → wipe persisted cell; drop profile; state = signed-out
    (the persisted unlock is stale OR an attacker injected refresh_token
     for a different user; either way, force re-auth)
```

The guard moved from "compare two id_token decodes" to "compare /api/me response.user.id to cached unlock.userId." Simpler placement, same intent.

## Comparison to alternatives considered

| Concern | id_token spec | C.2 in-memory | Option B bundle | THIS spec |
| --- | --- | --- | --- | --- |
| Offline cold-boot | works (id_token decode) | BREAKS | works | works |
| OIDC abuse | yes (custom claim) | no | no | no |
| Signature theater | yes (no verify) | no | no | no |
| JWT decode dance | yes | no | no | no |
| Persisted cells | 1 | 1 | 1 | 1 (two sections) |
| Persists email | yes (in JWT) | no | yes | no (memory only) |
| Refresh writes identity | yes (every refresh) | n/a | yes (bundled) | no (tokens only) |
| Round-trips on sign-in | 1 | 2 | 1 (today) / 2 (revised) | 2 |
| Same-user guard | sub equality on JWT | n/a | replaceSession | /api/me response |
| AuthState variants | 3 | 4 | 3 | 3 |
| Profile cache slippery slope | mitigated by JWT contract | n/a | not addressed | drawn at unlock |

The 2 round-trips on sign-in (token, then /api/me) are the price of separating the OAuth dance from the identity surface. We pay this because:
- OAuth 2.1's token endpoint has a standard response shape; we do not extend it
- Sign-in is rare; cold-boot online is rarer-still per-user
- Cold-boot offline does not pay this cost at all

## More radical options considered (and rejected)

```
A. Drop OAuth entirely; use Better Auth's email/password endpoints
   rejected: cross-origin bearer issuance is OAuth's actual job;
   whispering.app cannot share session cookies with api.epicenter.so
   in modern browser privacy modes (Safari ITP, Chrome's cookie phaseout).

B. Single long-lived bearer; no refresh
   rejected: short-lived access + rotating refresh is real defense in depth;
   a leaked access token expires in ~1 hour, vs ~30 days for a leaked bearer.

C. Encryption keys derived client-side from the access_token's sub
   rejected: requires the server secret to be on the client (it isn't);
   true zero-knowledge encryption requires a user-typed password or
   WebAuthn PRF; out of scope.

D. Per-workspace data keys; LocalUnlockBundle is a set of receipts
   rejected for THIS spec; promising as a follow-up.
   The receipt shape would be:
     { userId, workspaceId, encryptedWorkspaceDataKey, keyVersion }
   Wins: smaller blast radius per leak; collaboration-ready; honest authority.
   Costs: crypto migration on existing data; encryption layer contract change.
   Defer to a follow-up spec after this lands.

E. Encrypt the persisted cell with a device key
   rejected: device key needs to be retrievable on cold-boot without user
   input, which means storing it... where? OS keychain reintroduces the
   libsecret-on-Linux fragility the OOB spec rejected.
   At-rest encryption is the OS's job (FileVault, BitLocker, LUKS).

F. Wrap /auth/oauth2/token to inline identity in the response
   rejected: extending OAuth's wire shape ties the auth client to a
   non-standard token endpoint; the round-trip saved on sign-in is rare
   and invisible; the standardness we keep is valuable.

G. Persist email "in case we want offline UI to show it"
   rejected: the slippery-slope concern is real (avatar next, then
   recent workspaces, then theme preferences); the UX cost of "Account"
   vs "alice@..." on cold-boot offline is minor.

H. Persist unlock.validatedAt for future TOFU policy
   rejected: YAGNI; add the field when the policy lands.
```

## Architecture and files to touch

### Server side (already landed except Wave 4)

```
LANDED (Wave 1):
  apps/api/src/auth/create-auth.ts                ES256 jwt() configuration
  apps/api/src/auth-pages/cli-callback-page.tsx   OOB callback page
  apps/api/src/auth-pages/scripts/cli-callback.ts page script
  apps/api/src/auth-pages/styles.ts               .code-block CSS
  apps/api/src/auth-pages/index.tsx               renderCliCallbackPage export
  apps/api/src/app.ts                             /auth/cli-callback route,
                                                  /api/me route,
                                                  /api/health route
  packages/constants/src/oauth.ts                 epicenter-cli runtime: native,
                                                  HTTPS callback redirect
  apps/api/src/auth/trusted-oauth-clients.ts      toOAuthClientType two-arm switch
  apps/api/src/api-me.test.ts                     /api/me boundary tests
  apps/api/src/auth-pages/cli-callback-page.test.ts callback page tests
  apps/api/src/health.test.ts                     /api/health tests

WAVE 4 (landed): legacy /workspace-identity route deleted from apps/api/src/app.ts.
```

### Client side (Wave 2)

```
packages/auth/src/auth-types.ts                   EDIT
  - keep OAuthTokenGrant (already 3 fields)
  - NEW: LocalUnlockBundle arktype (userId + encryptionKeys)
  - NEW: PersistedAuth arktype (grant + unlock)
  - DELETE: OAuthSession entirely

packages/auth/src/auth-contract.ts                EDIT
  - AuthState gains 'signed-in' and 'reauth-required' carrying
    { unlock: LocalUnlockBundle; email: string | null }
  - DELETE WorkspaceIdentity from the public AuthState surface
    (it stays internal as a helper type for /api/me responses)

packages/auth/src/auth-state-store.ts             EDIT
  - state derivation operates on (cellPresent, email)
  - state-change events fire on email change and on unlock change

packages/auth/src/create-oauth-app-auth.ts        EDIT (significant rewrite)
  - rename config field: sessionStorage -> persistedAuthStorage
  - PersistedAuthStorage is { get, set }; cross-tab sync resolves via server
  - verifyProfile(): GET /api/me, returns { user, encryptionKeys }
  - same-user guard at verifyProfile response time
  - auth.fetch/openWebSocket refresh expired grants before verifyProfile and
    do not attach a bearer until email !== null for the current cell
  - refresh path writes only the grant section
  - sign-in path writes the cell atomically (both sections)

packages/auth/src/auth-errors.ts                  EDIT
  - add FetchProfileFailed variant (non-fatal in offline cold-boot)
  - keep StartSignInFailed, SignOutFailed

packages/auth/src/require-identity.ts             DELETE
  - consumers reach for state.unlock or state.email directly

packages/auth/src/require-session.ts              DELETE
  - consumers compose auth.fetch / auth.openWebSocket + state.unlock inline

packages/auth/src/index.ts                        EDIT
  - drop OAuthSession and WorkspaceIdentity exports
  - add LocalUnlockBundle, PersistedAuth, PersistedAuthStorage
  - drop requireIdentity / requireSession exports

packages/auth/src/contract.test.ts                EDIT
  - cover three-state machine
  - cover sign-in writes both sections
  - cover refresh writes only grant
  - cover cold-boot signed-in with email=null
  - cover same-user guard on /api/me response
  - cover network gate: cold boot can expose unlock immediately, but fetch and
    openWebSocket do not attach a bearer until /api/me confirms same user

packages/auth/src/node/machine-tokens-store.ts    NEW (renamed from machine-session-store)
  - persists PersistedAuth (grant + unlock; no profile)
  - file path: env-paths('epicenter').data/auth/<host>.json mode 0o600
  - atomic write via .tmp + rename
  - corrupt-blob -> Ok(null) + warn
  - permissions-too-open -> refuse load with chmod hint
  - MachineAuthStorageError defined here

packages/auth/src/node/machine-session-store.ts   DELETE
packages/auth/src/node/machine-session-store.test.ts  DELETE
packages/auth/src/node/machine-tokens-store.test.ts  NEW
packages/auth/src/node.ts                         EDIT
  - export loadMachineTokens, saveMachineTokens
  - drop loadMachineSession, saveMachineSession
```

### Wave 3 (consumer adoption)

```
packages/auth-svelte                              rename config field;
                                                  verify exports

apps/whispering, dashboard, honeycrisp,
apps/opensidian, zhongwen, fuji                   rename sessionStorage ->
                                                  persistedAuthStorage at the
                                                  createOAuthAppAuth call site;
                                                  verify persisted shape

apps/tab-manager                                  same rename; chrome.storage
                                                  cell key migrates to
                                                  local:auth.persisted

packages/auth/src/node/oob-launcher.ts            NEW per OOB spec
                                                  returns OAuthTokenGrant
                                                  (caller pairs with /api/me
                                                   to fetch unlock + profile)
packages/auth/src/node/oob-launcher.test.ts       NEW
packages/auth/src/node/machine-auth.ts            REPLACE per OOB spec
  - loginWithOob: tokens + /api/me; write grant + unlock
  - status: load cell; ping /api/health; decode profile from /api/me on demand
  - logout: revoke + clear cell
  - createMachineAuthClient: load cell; build createOAuthAppAuth
packages/cli/src/commands/auth.ts                 EDIT
  - call loginWithOob; report identity summary
```

### Wave 4 (cleanup)

```
apps/api/src/app.ts                               delete /workspace-identity
                                                  after env-flagged 503 soak
apps/api/src/auth/resource-boundary.ts            keep resolveBearerIdentity
                                                  (used by /api/me)
docs/encryption.md                                update /workspace-identity
                                                  references to /api/me
packages/cli/README.md                            document OOB flow + env-paths machine auth file
specs/20260512T111335-post-oauth-audit-remediation.md
                                                  prepend "superseded by ..."
                                                  notice on Phase 4
```

## Migration

Clean break, same as the prior specs. Pre-launch product; zero existing users; the migration is one forced sign-in per tester.

Storage cell keys are renamed so old `OAuthSession`-shaped data does not accidentally validate against the new arktype:

```
Browser localStorage:    <app>.auth.session   -> <app>.auth.persisted
Extension chrome.storage:           auth.session  -> auth.persisted
CLI file path:           keychain (deleted)    -> env-paths('epicenter').data/auth/<host>.json
```

Old keys are ignored. The new `PersistedAuth` arktype refuses to parse `OAuthSession`-shaped blobs (the field names do not match: `tokens` vs `grant`, `identity` vs `unlock`).

## Verification targets

```
V1. resolveRequestWorkspaceIdentity at apps/api/src/auth/resource-boundary.ts:131-139
    enforces bearer + workspaces:open scope and returns { user, encryptionKeys }.
    Wired in app.ts:248-262 for /api/me; verified by apps/api/src/api-me.test.ts.

V2. PersistedAuth arktype validates against the actual shape written by
    createOAuthAppAuth on sign-in. Test: round-trip a sign-in token response
    + /api/me response into the persisted shape; assert arktype accepts it.

V3. Refresh path writes ONLY grant. Test: pre-write a PersistedAuth cell;
    force a refresh; assert unlock.encryptionKeys is byte-identical before
    and after.

V4. Cold-boot offline: pre-write a cell; stub fetch to throw; assert
    state transitions to signed-in (not signed-out, not stuck-loading) with
    unlock present, profile null.

V5. Same-user guard: pre-write a cell with userId=alice; stub /api/me to
    return userId=bob; assert cell is wiped and state = signed-out.

V6. OAuth /token endpoint is unchanged; standard response shape.
    Test against node_modules/@better-auth/oauth-provider/dist/index.mjs:403
    (the createUserTokens response). id_token may be present when openid is
    granted; clients ignore and never persist it.

V7. Network gate: pre-write a cell; construct auth; assert state exposes
    unlock immediately with email=null; call auth.fetch and assert /api/me
    is called before the protected request, and the protected request
    receives Authorization only after /api/me returns matching userId.

V8. Expired grant ordering: pre-write an expired accessToken with a valid
    refreshToken; construct auth; trigger auth.fetch; assert refresh writes
    only grant before /api/me is called.

V9. (Removed.) Earlier draft required cross-context storage watch; Wave 2
    dropped the watch hook and relies on the server authority + network gate
    for cross-tab reconciliation.

V10. Profile freshness: /api/me failure on cold boot leaves unlock present,
     email null, and no bearer attached to network requests; a later
     successful /api/me sets email to the user's address.
```

## Open questions

1. **Should `LocalUnlockBundle.validatedAt` be added preemptively for a future TOFU policy?** Recommendation: no. Add when the policy lands. Adding it now invites premature decisions about "how stale is too stale."

2. **Should sign-in be one round-trip via a server-wrapped /token endpoint?** Recommendation: no. The standardness of OAuth /token is worth preserving. Two round-trips on the rare sign-in event is invisible.

3. **Should we delete `requireIdentity` and `requireSession` helpers?** Today they bundle identity-presence checks. With the three-concern split, consumers asking for "the user's keys" should reach for `state.unlock.encryptionKeys` directly; consumers asking for email should reach for `state.email`. Recommendation: delete both; let consumers compose what they need.

4. **Where does `WorkspaceIdentity` live now?** It is no longer a top-level domain concept. The shape `{ user, encryptionKeys }` is a `/api/me` response type, internal to the auth package. Recommendation: keep it as `ApiMeResponse` (or similar) inside `create-oauth-app-auth.ts`; do not export.

5. **Per-workspace unlock receipts (option D above): when?** When the first collaboration feature ships, or when the encryption layer's blast radius becomes a measurable concern. Track as a separate spec.

The Wave 2 blockers from the fresh-eyes pass were resolved during implementation. The shipped shape took further asymmetric wins: `PersistedAuthStorage.watch` was dropped (server authority handles cross-tab reconciliation), `profileStatus` was dropped (`email !== null` is the implicit freshness predicate), eager `/api/me` at construction was dropped (lazy on first network call). The network gate and refresh-before-profile-fetch remain load-bearing.

## Decisions log

1. **Three concerns, three lifecycles, two persistence locations (disk + memory).** Rejects bundling identity into either tokens (id_token spec) or a single "session" blob (OAuthSession). The split is on lifecycle (does this survive a process restart? does this survive going offline?) and authority (do we trust this without re-validation?).

2. **One persistence cell, two sections (`grant` + `unlock`).** Rejects two separate files. Filesystem-level separation buys nothing the type can't express; two files invite desync.

3. **Email is memory-only.** Rejects persisting profile for offline UI. The slippery slope concern is real and the UX regression is minor (one rare event, "Account" instead of an email).

4. **`unlock.validatedAt` is not persisted.** YAGNI until we have a policy that consumes it.

5. **Same-user guard at /api/me response, not at storage write.** Moves the check to the place where actual user identity is known. The storage layer is no longer in the authority business.

6. **Refresh writes only the grant section.** Decouples token rotation from identity. Identity is refreshed only on cold-boot and on sign-in.

7. **AuthState has three variants, not four or six.** No `loading` (disk reads are fast). No `signed-in-offline` (derived from `email === null`). No `locked-offline` (degenerate; map to signed-out). The state machine carries authority; email presence carries verification freshness.

8. **`/api/me` endpoint is kept.** Already shipped; central to the cold-boot refresh path; OAuth /token stays standard.

9. **No id_token consumption client-side.** Server may still issue id_tokens (Better Auth includes them when `openid` scope is granted) but the client never reads them. The bandwidth waste is negligible; forward-compat headroom for federation is preserved.

10. **`requireIdentity` and `requireSession` are deleted.** Their existence assumed identity was one thing; the three-concern split makes them misleading. Consumers reach for the slot they need.

11. **Cross-tab and cross-context sign-out resolves via the server authority, not a client-side watch hook.** `PersistedAuthStorage` is `{ get, set }`. If another context wipes the cell or rotates to a different user, this runtime's next bearer-bearing call hits the network gate, calls `/api/me`, and reconciles (wipes its cell on a userId mismatch, or 401s back to `reauth-required` on a revoked refresh token). Brief in-memory desync between tabs is acceptable; the network gate is the actual reconciliation mechanism.

12. **Local unlock is immediate; bearer-bearing network waits for `/api/me`.** This preserves offline cold boot without allowing collaboration or protected API calls before the same-user guard has passed. If `/api/me` cannot be reached, local data remains usable and network fails closed.

13. **Cold boot refreshes stale grants before fetching profile.** `/api/me` is protected by the access token, so an expired access token must be repaired before the identity refresh can be trusted. `/api/me` itself fires lazily on the first network call rather than eagerly at construction.

14. **Superseded: profile freshness is no longer auth state.** `specs/20260514T210000-profile-as-application-data.md` keeps the grant/unlock split but removes the memory-only email field. The auth client now tracks `/api/me` verification without carrying profile data, and account UI fetches email as application data.

15. **Different-user sign-in replaces the local unlock in pre-launch builds.** Previously `replaceSession` threw on a user mismatch. This spec deliberately changes sign-in to let a new account win, which can orphan the prior account's local encrypted blobs on that device. That is acceptable while there are no launched users; reviewers should see this called out in the Wave 2 commit message.

## References

```
Server side (already landed):
  apps/api/src/app.ts:247-293                    /auth/cli-callback + /api/me routes
  apps/api/src/auth/create-auth.ts               ES256 jwt config
  apps/api/src/auth/resource-boundary.ts:99-139  resolveBearerIdentity helpers
  apps/api/src/auth/encryption.ts                deriveUserEncryptionKeys

Client side (landed):
  packages/auth/src/auth-types.ts                OAuthTokenGrant kept; OAuthSession deleted
  packages/auth/src/auth-contract.ts             AuthState union rewritten
  packages/auth/src/create-oauth-app-auth.ts     storage rename + verifyProfile + network gate
  packages/auth/src/auth-state-store.ts          state-change semantics
  packages/auth/src/node/machine-tokens-store.ts replaces machine-session-store
  packages/auth/src/require-identity.ts          DELETED
  packages/auth/src/require-session.ts           DELETED

Better Auth plugin (unchanged):
  node_modules/@better-auth/oauth-provider/dist/index.mjs:403-447
    createUserTokens - the standard /oauth2/token response we consume as-is

Encryption (unchanged):
  packages/encryption/src/keys.ts                EncryptionKey / EncryptionKeys

Predecessor specs:
  specs/20260514T091255-tokens-only-auth-extract-identity-to-workspace.md (superseded)
  specs/20260514T154500-id-token-bearing-encryption-keys.md              (superseded)
  specs/20260514T160000-execute-id-token-and-oob-cli.md                   (superseded)
  specs/20260514T120000-machine-auth-oob-clean-break.md                   (composes)
```

## Done when (spec is watertight)

```
[x] Three concerns named (online grant / local unlock / profile)
[x] Persistence shape defined: one cell, two sections
[x] AuthState defined: three variants, unlock always present in signed-in
[x] Lifecycle prose covers sign-in, cold-boot online/offline, refresh, sign-out, reauth-required
[x] Each persisted field has a "why is this here?" justification
[x] Alternatives considered include the radical ones (drop OAuth, per-workspace keys, etc.)
[x] Same-user guard placement is explicit
[x] Migration is documented as a clean break with key renames
[x] Verification targets reference real file:line locations
[x] Open questions are listed (fresh-eyes blockers resolved into spec body)
[x] Reviewed by Braden; product UX cost on cold-boot offline accepted (Waves 2-4 landed)
[x] No em or en dashes in spec body (verified by grep)
```

After Braden sign-off, this spec moves from Proposed to Accepted and Wave 2 begins.
