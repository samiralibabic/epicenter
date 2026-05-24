# Auth Credential Source Of Truth

**Date**: 2026-05-03
**Status**: Implemented
**Author**: AI-assisted
**Branch**: codex/explicit-daemon-host-config

## One-Sentence Test

Epicenter auth has one canonical credential aggregate; app sessions, machine credential summaries, server responses, and persisted storage records are projections of that aggregate.

Everything in this spec should serve that sentence. If a type exists only because Better Auth returned two sibling objects, or because browser storage once wanted a smaller shape, it must either become a projection of the credential aggregate or be deleted.

## Overview

Collapse the auth package around `AuthCredential` as the durable credential contract. The raw Better Auth custom session response remains an input boundary, but the package should normalize it once and stop passing raw Better Auth vocabulary through the rest of the code.

The implemented shape takes the aggressive direction: `AuthCredential` is the source of truth, `AuthSession` is an app-facing projection, and machine credential storage is one public metadata record plus one secret blob.

## Motivation

### Current State

The old shape had two exported types with the same name:

```ts
// packages/auth/src/auth-types.ts
export const Session = type({
	token: 'string',
	user: StoredUser,
	encryptionKeys: EncryptionKeys,
});
```

```ts
// packages/auth/src/contracts/session.ts
export const Session = type({
	user: StoredBetterAuthUser,
	session: StoredBetterAuthSession,
	encryptionKeys: EncryptionKeys,
});
```

`machine-auth.ts` had to alias them:

```ts
import type { Session as AuthSession } from '../auth-types.js';
import type { Session as StoredSession } from '../contracts/session.js';
```

That was a real smell. One `Session` was the local app snapshot persisted by `createAuth`; the other was a normalized Better Auth server response with session metadata. The names hid the ownership boundary, and `StoredUser` plus `StoredBetterAuthUser` duplicated the same shape.

The implemented shape fixes this:

```ts
// packages/auth/src/auth-types.ts
export const AuthUser = type({
	id: 'string',
	createdAt: 'string',
	updatedAt: 'string',
	email: 'string',
	emailVerified: 'boolean',
	name: 'string',
	'image?': 'string | null | undefined',
});

export const AuthSession = type({
	token: 'string',
	user: AuthUser,
	encryptionKeys: EncryptionKeys,
});
```

```ts
// packages/auth/src/contracts/auth-credential.ts
export const AuthServerSession = type({
	id: 'string',
	token: 'string',
	userId: 'string',
	expiresAt: 'string',
	createdAt: 'string',
	updatedAt: 'string',
	'ipAddress?': 'string | null | undefined',
	'userAgent?': 'string | null | undefined',
});

export const AuthCredential = type({
	serverOrigin: 'string',
	authorizationToken: 'string',
	user: AuthUser,
	serverSession: AuthServerSession,
	encryptionKeys: EncryptionKeys,
});
```

`machine-credential-repository.ts` now persists tokenless credential metadata:

```ts
const MachineCredentialMetadataRecord = type({
	user: AuthUser,
	serverSession: AuthServerSessionMetadata,
});

const MachineCredentialFileEntry = type({
	serverOrigin: 'string',
	authCredential: MachineCredentialMetadataRecord,
	secrets: MachineCredentialSecrets,
	savedAt: 'string',
	lastUsedAt: 'string',
});
```

The runtime repository resolves that metadata plus one secret blob into a full credential:

```ts
const MachineCredential = type({
	authCredential: AuthCredential,
	savedAt: 'string',
	lastUsedAt: 'string',
});
```

The two token roles are now explicit:

```txt
authCredential.authorizationToken
authCredential.serverSession.token
```

That distinction is meaningful. The authorization token is used for Epicenter API requests; the server session token is Better Auth session metadata.

### Problems

1. **The old `Session` name hid two concepts**: One type was a browser auth projection; the other was a server credential response. Aliasing them in one file forced readers to reverse engineer the model.

2. **The user shape was duplicated**: `StoredUser` and `StoredBetterAuthUser` had the same runtime fields. That was duck typing across a boundary that should have had one owner.

3. **Better Auth vocabulary leaked too far**: The raw server response is `{ user, session, encryptionKeys }` because Better Auth returns `user` and `session` separately. That does not mean our internal package should preserve the same shape everywhere.

4. **Token roles are undernamed**: `AuthSession.token` is used as the authorization token for app fetches. Machine auth also preserves the Better Auth server session token. Those are different roles and should be named as such.

5. **Machine credential secret storage was split more than the domain requires**: Keychain mode stored separate refs for authorization token, server session token, and encryption keys. The repository always saved, loaded, and deleted them together.

6. **`AuthSession` remains a first-class export**: This is acceptable as an intermediate app projection, but it should not look like a sibling source of truth next to `AuthCredential`.

### Desired State

The auth package should have one source of truth:

```ts
export const AuthCredential = type({
	serverOrigin: 'string',
	authorizationToken: 'string',
	user: AuthUser,
	serverSession: AuthServerSession,
	encryptionKeys: EncryptionKeys,
});
```

Then derive projections from it:

```ts
export type AuthSession = {
	token: AuthCredential['authorizationToken'];
	user: AuthCredential['user'];
	encryptionKeys: AuthCredential['encryptionKeys'];
};

export type MachineCredentialSummary = {
	serverOrigin: AuthCredential['serverOrigin'];
	user: Pick<AuthCredential['user'], 'id' | 'name' | 'email'>;
	serverSession: Pick<AuthCredential['serverSession'], 'expiresAt'>;
	savedAt: string;
	lastUsedAt: string;
};
```

Eventually, `createAuth` can either keep accepting `AuthSession` as a projection or move to `AuthCredentialStorage` directly. That decision is still open because browser clients do not currently need `serverSession.expiresAt`, `serverSession.id`, or `serverOrigin` inside their local snapshot.

## Vocabulary

| Term | Meaning | Owner |
| --- | --- | --- |
| `BetterAuthSessionResponse` | Raw custom session response from Better Auth plus Epicenter encryption keys. Dates may arrive as `Date` objects before JSON serialization. | API and Better Auth bridge |
| `AuthUser` | JSON-safe user snapshot shared by app auth, credential contracts, and machine storage. | `@epicenter/auth` |
| `AuthServerSession` | JSON-safe Better Auth session metadata, including the Better Auth session token. | `@epicenter/auth` credential contract |
| `authorizationToken` | Token used in `Authorization: Bearer ...` for Epicenter API fetches and machine auth refreshes. | Auth transport and credential storage |
| `AuthCredential` | Canonical durable credential aggregate. | `@epicenter/auth` |
| `AuthSession` | App-facing projection used by browser storage and snapshots. | Temporary projection under `@epicenter/auth` |
| `MachineCredential` | Node runtime record that includes local save metadata and can load secrets from keychain or plaintext storage. | `@epicenter/auth/node` |

## Research Findings

### Server Response Shape

`apps/api/src/auth/create-auth.ts` produces `/auth/get-session` through Better Auth `customSession()`:

```ts
const customSessionPlugin = customSession(
	async ({ user, session }) => {
		const encryptionKeys = await deriveUserEncryptionKeys(user.id);
		return {
			user,
			session,
			encryptionKeys,
		} satisfies BetterAuthSessionResponse;
	},
	...
);
```

The server response is split because Better Auth owns `user` and `session` as separate database concepts. Epicenter adds `encryptionKeys`.

Key finding: the split is real at the integration boundary, but it does not have to be the internal credential model.

Implication: keep `BetterAuthSessionResponse` as a bridge type, then normalize immediately into `AuthCredential`.

### App-Facing Auth Storage

`createAuth` currently reads and writes an app session:

```ts
export type SessionStorage = {
	load(): MaybePromise<AuthSession | null>;
	save(value: AuthSession | null): MaybePromise<void>;
	[Symbol.dispose]?(): void;
};
```

Browser apps persist that shape:

```ts
const session = createPersistedState({
	key: 'fuji.auth.session',
	schema: AuthSession.or('null'),
	defaultValue: null,
});
```

`createAuth` only needs three fields for its snapshot and fetch behavior:

```txt
token
user
encryptionKeys
```

Key finding: the reduced shape is useful, but it should be presented as a projection. It is not a second source of truth.

Implication: keep `AuthSession` for now if it reduces browser storage churn, but derive its type from `AuthCredential` and move conversion functions to the credential module.

### Machine Credential Storage

Machine auth has two storage layers:

```txt
credentials.json
  version
  currentServerOrigin
  credentials[]
    serverOrigin
    authCredential metadata without serverSession.token
    secrets
    savedAt
    lastUsedAt

secret storage
  bearerToken
  sessionToken
  encryptionKeys
```

Keychain mode stores refs for each secret:

```ts
export const KeychainMachineCredentialSecrets = type({
	storage: "'osKeychain'",
	bearerTokenRef: MachineCredentialSecretRefSchema,
	sessionTokenRef: MachineCredentialSecretRefSchema,
	encryptionKeysRef: MachineCredentialSecretRefSchema,
});
```

Plaintext mode stores secret values inline:

```ts
export const PlaintextMachineCredentialSecrets = type({
	storage: "'file'",
	bearerToken: 'string',
	sessionToken: 'string',
	encryptionKeys: EncryptionKeys,
});
```

Key finding: the public JSON file needs non-secret metadata for status and missing-secret reporting. It does not need three separate keychain records.

Implication: keep public metadata separate from secrets, but collapse secret storage to one blob per credential.

## Design Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Canonical model | `AuthCredential` | One aggregate names the thing Epicenter actually stores and uses. |
| Raw server type | `BetterAuthSessionResponse` | Better Auth still returns `{ user, session }`; keep that vocabulary at the bridge only. |
| User type | `AuthUser` | The user snapshot is shared. Duplicating it invites duck typing. |
| Server session type | `AuthServerSession` | Better Auth session metadata is real and should stay explicit. It should not be hidden inside the user. |
| Token names | `authorizationToken` and `serverSession.token` | These roles are distinct. The name `bearerToken` is implementation flavored; the name `token` is too vague. |
| Browser storage | Keep `AuthSession` as a derived projection for now | Browser storage only needs token, user, and keys. Keeping the projection avoids carrying unused server metadata through every UI snapshot. |
| Machine JSON file | Store public credential metadata plus save metadata | Status can show user and expiry without loading secrets. Missing keychain secrets can still be reported. |
| Machine keychain storage | One secret blob per credential | The secrets are saved, loaded, and deleted together. Three refs are storage ceremony, not domain structure. |
| Migration | None | This is a clean break and we are assuming no users. Delete old schema names and old file shapes. |

## Architecture

### Before

```txt
Better Auth customSession()
  |
  v
contracts.Session
  user: StoredBetterAuthUser
  session: StoredBetterAuthSession
  encryptionKeys

auth-types.Session
  token
  user: StoredUser
  encryptionKeys

machine-auth.ts
  imports both Session types
  manually converts between them
```

### Current Worktree

```txt
Better Auth customSession()
  |
  v
BetterAuthSessionResponse
  |
  v
normalizeAuthCredential()
  |
  v
AuthCredential
  serverOrigin
  authorizationToken
  user: AuthUser
  serverSession: AuthServerSession
  encryptionKeys

createAuth
  uses AuthSession projection
  token
  user: AuthUser
  encryptionKeys

machine auth
  MachineCredential
    authCredential
      serverOrigin
      authorizationToken
      user
      serverSession
      encryptionKeys
    savedAt
    lastUsedAt
```

### Target

```txt
BetterAuthSessionResponse
  raw bridge only
  |
  v
AuthCredential
  serverOrigin
  authorizationToken
  user
  serverSession
  encryptionKeys
  |
  +-- AuthSession projection
  |     token
  |     user
  |     encryptionKeys
  |
  +-- MachineCredentialSummary projection
  |     serverOrigin
  |     user id/name/email
  |     expiresAt
  |
  +-- Machine credential file entry
        public metadata in JSON
        secret blob ref or inline secret blob
```

### Machine Storage Target

```txt
credentials.json
  version: epicenter.auth.credentialStore.v2
  currentServerOrigin?: string | null
  credentials:
    - serverOrigin
      credential:
        user
        serverSession:
          id
          userId
          expiresAt
          createdAt
          updatedAt
          ipAddress?
          userAgent?
      secrets:
        storage: osKeychain
        ref:
          service: epicenter.auth.credential
          account: <serverOrigin>:<userId>
      savedAt
      lastUsedAt
```

```txt
keychain secret blob
  authorizationToken
  serverSessionToken
  encryptionKeys
```

Plaintext mode can use the same logical blob inline:

```txt
secrets:
  storage: file
  values:
    authorizationToken
    serverSessionToken
    encryptionKeys
```

## Implementation State

### Already In The Worktree

- [x] Deleted `packages/auth/src/contracts/session.ts`.
- [x] Added `packages/auth/src/contracts/auth-credential.ts`.
- [x] Added `AuthUser`, `AuthSession`, `AuthServerSession`, and `AuthCredential`.
- [x] Moved `serverOrigin` and `authorizationToken` into `AuthCredential`.
- [x] Renamed app storage schemas from `Session` to `AuthSession`.
- [x] Renamed the API custom session bridge from `SessionResponse` to `BetterAuthSessionResponse`.
- [x] Moved user normalization out of `create-auth.ts` and into the credential contract module.
- [x] Updated machine auth to use `authCredential` and `serverSession`.
- [x] Updated machine credential repository tests to assert `authCredential.serverSession`.
- [x] Collapsed machine secret storage from three keychain refs to one credential secret blob.
- [x] Bumped the credential file version to `epicenter.auth.credentialStore.v2`.
- [x] Added `[Symbol.dispose]` support to the then-current auth storage bridge. Current `SessionStorage` is load/save only.
- [x] Added disposed guards to persisted state updates.

### Deliberately Kept

- `AuthSession` remains the app-facing projection because browser storage and UI snapshots only need `token`, `user`, and `encryptionKeys`.
- `AuthSession` keeps the public `token` field. The type is derived from `AuthCredential['authorizationToken']`, but the projection vocabulary stays short at call sites.
- Machine credential JSON keeps a top-level `serverOrigin` for lookup and current-credential indexing. The resolved runtime credential still has the same origin inside `authCredential`.

## Implementation Plan

### Phase 1: Finish The Type Boundary

- [x] **1.1** Move `AuthCredential` to the exact canonical shape:

```ts
export const AuthCredential = type({
	serverOrigin: 'string',
	authorizationToken: 'string',
	user: AuthUser,
	serverSession: AuthServerSession,
	encryptionKeys: EncryptionKeys,
});
```

- [x] **1.2** Change `AuthServerTransportCredentialSession` to return `authCredential: AuthCredential`.

```ts
return {
	authCredential: AuthCredential.assert({
		serverOrigin: origin,
		authorizationToken:
			response.headers.get('set-auth-token') ?? authorizationToken,
		user,
		serverSession,
		encryptionKeys,
	}),
};
```

- [x] **1.3** Rename `bearerToken` to `authorizationToken` in machine auth, machine credential repository, secret storage, and tests.

- [x] **1.4** Move conversion helpers into `contracts/auth-credential.ts` so `machine-auth.ts` stops rebuilding credential objects inline.

### Phase 2: Collapse Secret Storage

- [x] **2.1** Replace separate token and key refs with one `credentialRef`.

```ts
export const KeychainMachineCredentialSecrets = type({
	storage: "'osKeychain'",
	credentialRef: MachineCredentialSecretRefSchema,
});
```

- [x] **2.2** Replace plaintext secret fields with one nested `values` object.

```ts
export const PlaintextMachineCredentialSecrets = type({
	storage: "'file'",
	values: AuthCredentialSecrets,
});
```

- [x] **2.3** Store this blob in keychain:

```ts
export const MachineCredentialSecretValues = type({
	authorizationToken: 'string',
	serverSessionToken: 'string',
	encryptionKeys: EncryptionKeys,
});
```

- [x] **2.4** Make missing or invalid blobs return `null` so machine auth can preserve the current `missingSecrets` behavior.

- [x] **2.5** Delete stale partial secret-ref cleanup logic that only exists because the previous model had three refs.

### Phase 3: Decide The App Snapshot Boundary

There are two viable choices.

Option A keeps the current app projection:

```ts
export const AuthSession = AuthCredential.pick(
	'authorizationToken',
	'user',
	'encryptionKeys',
).pipe(/* map authorizationToken to token */);
```

The caller still sees:

```ts
snapshot.session.token
snapshot.session.user
snapshot.session.encryptionKeys
```

Option B makes `AuthCredential` the signed-in snapshot:

```ts
export type AuthSnapshot =
	| { status: 'loading' }
	| { status: 'signedOut' }
	| { status: 'signedIn'; credential: AuthCredential };
```

The caller sees:

```ts
snapshot.credential.authorizationToken
snapshot.credential.user
snapshot.credential.encryptionKeys
```

Recommendation: choose Option A for this pass unless the team wants a larger app-wide API break. The duplicate schema should still be removed by deriving `AuthSession` from `AuthCredential`, but browser UI does not need server session metadata.

### Phase 4: Sweep And Verify

- [x] **4.1** Run a vocabulary sweep:

```sh
rg "StoredUser|StoredBetterAuth|SessionResponse|contracts/session|Session as AuthSession|Session as StoredSession"
```

- [x] **4.2** Run focused auth tests:

```sh
bun test packages/auth/src
```

- [x] **4.3** Run package typechecks that touch the renamed exports:

```sh
bun run --filter @epicenter/auth typecheck
bun run --filter @epicenter/auth-svelte typecheck
bun run --filter @epicenter/auth-workspace typecheck
```

- [x] **4.4** Run app typechecks for the browser storage call sites if available.

  Note: dashboard, fuji, and tab-manager app typechecks were attempted. They fail on existing unrelated Svelte, UI alias, API env, and dashboard query typing issues before this auth change. The focused auth packages typecheck cleanly.

## Edge Cases

### Response Header Token Rotation

`createAuth` updates the app token from `set-auth-token`.

Expected behavior:

1. The authorization token changes.
2. The user and encryption keys stay the same unless the Better Auth session payload also changes.
3. Machine auth persists the new authorization token without accidentally losing server session metadata.

The conversion helper must make that role visible:

```ts
authCredentialFromSession({
	current,
	session,
	updatedAt,
})
```

### Server Session Token Versus Authorization Token

Machine auth has tests that prove login and status can store a refreshed authorization token without mutating the Better Auth session token. `saveActiveSession()` now preserves the existing server session token when it projects an app session back into the credential.

Expected clean break:

```txt
authorizationToken changes when auth transport rotates API authorization.
serverSession.token changes only when Better Auth reports a new server session token.
```

If `saveActiveSession()` only receives `AuthSession`, it does not have enough information to preserve both roles unless it also reads the current credential. It already reads the current credential, so the helper should preserve `serverSession.token` unless the operation is explicitly a server session token update.

### Missing Keychain Secret Blob

If the JSON file exists but the keychain blob is missing, machine auth should keep returning `missingSecrets` with a credential summary.

This requires the JSON file to keep:

```txt
serverOrigin
user id/name/email
serverSession.expiresAt
savedAt
lastUsedAt
```

It does not require separate keychain refs for each secret value.

### Browser Storage Schema Break

The current app storage schema changed from `Session` to `AuthSession`, but the shape is still the same. If `AuthSession` becomes a derived type with the same fields, browser storage can keep working.

If browser storage moves to `AuthCredential`, existing local storage entries will fail schema validation and fall back to `null`. That is acceptable only if we are treating this as a true no-user clean break.

### Raw Better Auth Dates

`BetterAuthSessionResponse` is not a JSON-safe storage type. It can contain `Date` values before serialization. `normalizeAuthCredential()` must remain the boundary that converts dates to ISO strings.

Do not export raw Better Auth date-bearing types as storage contracts.

## Resolved Questions

1. **Should `serverOrigin` live inside `AuthCredential`?**

   Resolved: yes. A credential without an issuer origin is incomplete for machine auth and for any future multi-origin browser client.

2. **Should `AuthSession` remain public?**

   Resolved: yes, as an app-facing projection. The public snapshot remains `snapshot.session`, and the type now derives from `AuthCredential` fields.

3. **Should `authorizationToken` replace `token` in the app projection?**

   Resolved: no. `AuthSession.token` remains projection vocabulary because `snapshot.session.token` reads naturally. The source field is still `AuthCredential.authorizationToken`.

4. **Should machine storage support plaintext mode long term?**

   Resolved: yes. Plaintext mode remains useful for tests and explicit insecure mode, but it stores the same logical secret blob as keychain mode.

5. **Should the credential file version become v2 now?**

   Resolved: yes. The credential file version is now `epicenter.auth.credentialStore.v2`.

## Success Criteria

- [x] No source file imports from `contracts/session`.
- [x] No source file exports a generic auth `Session` name from `@epicenter/auth`.
- [x] `AuthUser` is the only stored user schema in `@epicenter/auth`.
- [x] `AuthCredential` is the only type that combines user, server session metadata, and encryption keys.
- [x] Any `AuthSession` type is mechanically derived from `AuthCredential`.
- [x] Machine credential repository stores one public credential metadata record and one secret blob.
- [x] Missing keychain secrets still produce `missingSecrets`, not silent signed-out state.
- [x] Token rotation tests distinguish `authorizationToken` from `serverSession.token`.
- [x] Browser apps use `AuthSession.or('null')` only because `AuthSession` remains the chosen projection.
- [x] Auth, auth-svelte, and auth-workspace typecheck.
- [ ] Affected app typechecks pass.

  Note: app typechecks were attempted and are blocked by unrelated existing failures. Examples include missing `#/utils.js` aliases in tab-manager UI imports, dashboard API env type gaps, and pre-existing Svelte utility type errors.

## References

- `packages/auth/src/contracts/auth-credential.ts` stores the new credential contract and normalizers.
- `packages/auth/src/auth-types.ts` currently stores `AuthUser` and `AuthSession`.
- `packages/auth/src/create-auth.ts` projects Better Auth session data into `AuthSession`.
- `packages/auth/src/session-store.ts` defines the app storage boundary.
- `packages/auth/src/node/auth-server-transport.ts` fetches and normalizes `/auth/get-session`.
- `packages/auth/src/node/machine-auth.ts` bridges machine credentials into app auth storage.
- `packages/auth/src/node/machine-credential-repository.ts` owns the credential JSON file shape.
- `packages/auth/src/node/machine-credential-secret-storage.ts` owns keychain and plaintext secret persistence.
- `apps/api/src/auth/create-auth.ts` produces the Better Auth custom session response.
- `packages/svelte-utils/src/persisted-state.svelte.ts` now guards against writes after disposal.

## Review

**Completed**: 2026-05-03
**Branch**: codex/explicit-daemon-host-config

### Summary

The credential clean break is implemented in the auth package. `AuthCredential` now owns `serverOrigin`, `authorizationToken`, `user`, `serverSession`, and `encryptionKeys`; `AuthSession` remains a derived app projection; machine credential storage writes public metadata plus one secret blob.

### Deviations From Spec

- `AuthSession` remains a runtime arktype schema because browser stores still need `AuthSession.or('null')`. Its TypeScript type now derives from `AuthCredential` fields, so the compile-time source of truth is still the credential aggregate.
- Machine credential JSON still keeps top-level `serverOrigin` for lookup and current-credential indexing. The resolved credential also carries the same origin inside `authCredential`.
- App typechecks were attempted but are not passing due to unrelated existing app and shared UI issues. Focused auth tests and package typechecks pass.

### Verification

```sh
bun test packages/auth/src
bun run --filter @epicenter/auth typecheck
bun run --filter @epicenter/auth-svelte typecheck
bun run --filter @epicenter/auth-workspace typecheck
```

Attempted but blocked by unrelated failures:

```sh
bun run --filter @epicenter/dashboard typecheck
bun run --filter @epicenter/fuji typecheck
bun run --filter @epicenter/tab-manager typecheck
```
