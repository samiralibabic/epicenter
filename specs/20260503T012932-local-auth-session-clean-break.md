# Local Auth Session Clean Break

**Date**: 2026-05-03
**Status**: Implemented
**Author**: AI-assisted

## One-Sentence Test

Epicenter local clients store one reusable `AuthSession`; the server owns session metadata, expiry, and auth provider details.

Everything in this spec should serve that sentence. If a local type exists to remember Better Auth internals, support multiple auth servers, preserve status metadata, or explain where secrets went, it should be deleted unless a current first-party caller needs it.

## Overview

Collapse local auth around one stored shape:

```ts
export const AuthSession = type({
	token: 'string',
	user: AuthUser,
	encryptionKeys: EncryptionKeys,
});
```

Browser apps already store this shape. Machine auth should store the same shape too, preferably as one keychain value. The machine layer should stop storing a full `AuthCredential`, stop preserving Better Auth server-session metadata, stop tracking multiple server origins, and stop maintaining a public JSON metadata file beside a secret blob.

This is a breaking cleanup. We are choosing one first-party product invariant over self-hosting friendliness, multi-server credential management, local expiry display, and missing-secret diagnostics.

## Motivation

### Current State

The auth graph currently has several shapes:

```txt
BetterAuthSessionResponse
  user
  session
    id
    token
    expiresAt
    createdAt
    updatedAt
    ipAddress
    userAgent
  encryptionKeys

AuthCredential
  serverOrigin
  authorizationToken
  user
  serverSession
  encryptionKeys

AuthSession
  token
  user
  encryptionKeys

MachineCredential
  authCredential
  savedAt
  lastUsedAt
```

Machine storage then splits the credential again:

```txt
env-paths('epicenter').data/auth/<host>.json
  version
  currentServerOrigin
  credentials[]
    serverOrigin
    user
    serverSession without token
    keychain ref
    savedAt
    lastUsedAt

OS keychain
  authorizationToken
  serverSessionToken
  encryptionKeys
```

The browser path is much simpler:

```txt
localStorage or extension storage
  AuthSession | null
```

This creates problems:

1. **The local model has two truths**: browser auth stores `AuthSession`, while machine auth stores `AuthCredential` and projects it back into `AuthSession`.

2. **Machine auth is acting like a credential manager**: it supports multiple server origins, current-server selection, local save metadata, missing keychain diagnostics, and expiry display.

3. **Self-hosting support multiplies the graph**: once `serverOrigin` is part of credential identity, every read, write, clear, status, secret ref, and CLI command has to carry it.

4. **Better Auth internals leak locally**: `serverSession.token` is preserved even though normal local callers use `AuthSession.token` for API requests.

5. **The secret split creates its own states**: `missingSecrets` only exists because metadata and secrets are stored separately.

6. **`savedAt`, `lastUsedAt`, and local `expiresAt` are product features, not invariants**: they support status output and credential selection, but the core product can run without them.

### Desired State

Local auth should have one stored session shape everywhere:

```ts
export const AuthSession = type({
	token: 'string',
	user: AuthUser,
	encryptionKeys: EncryptionKeys,
});

export type AuthSession = typeof AuthSession.infer;
```

The server response remains a bridge:

```ts
export type BetterAuthSessionResponse = {
	user: BetterAuthUser;
	session: BetterAuthSession;
	encryptionKeys: EncryptionKeys;
};
```

The local normalizer throws away server-owned fields:

```ts
export function normalizeAuthSession(
	response: unknown,
	{ token }: { token: string },
): AuthSession {
	const record = readRecord(response, 'session response');
	return AuthSession.assert({
		token,
		user: normalizeAuthUser(record.user),
		encryptionKeys: EncryptionKeys.assert(record.encryptionKeys),
	});
}
```

Machine auth stores that exact `AuthSession`:

```txt
secure mode
  OS keychain item: AuthSession

test mode
  injected in-memory store: AuthSession | null
```

If a plaintext file mode survives, it should write the same payload:

```txt
env-paths('epicenter').data/auth/<host>.json
  AuthSession | null
```

There should be no machine-only credential aggregate, no tokenless metadata file, no `serverSessionToken`, no `serverOrigin` in stored auth, no `savedAt`, and no `lastUsedAt`.

## Product Cuts

These cuts make the invariant possible.

| Cut | What disappears | Why it is worth cutting |
| --- | --- | --- |
| Drop public self-hosted CLI auth | `epicenter auth login [server]`, per-call `serverOrigin`, multi-server lookup | First-party clients use one API URL. Supporting arbitrary servers is the largest complexity multiplier. |
| Drop multiple saved credentials | `credentials[]`, `currentServerOrigin`, most-recent selection | One local user session is enough for the default CLI and daemons. |
| Drop local expiry display | `expiresAt` in local storage, `expired` status | The server owns expiry. Local code can try the token and react to rejection. |
| Drop save metadata | `savedAt`, `lastUsedAt` | These only support status polish and credential selection, not auth. |
| Drop missing-secret diagnostics | `missingSecrets` status | A single keychain item is either present or absent. |
| Drop Better Auth server-session token preservation | `serverSession.token`, `authCredentialFromSession()` | Local callers authorize requests with `AuthSession.token`. |
| Drop public plaintext auth option | `--insecure-storage` | Keychain should be the product default. Tests can inject storage. |

The last cut is optional if developer machines without keychain support matter. If plaintext mode stays, it must store the same `AuthSession` object and remain a storage backend, not a second model.

## Storage Ownership

### Server

The server owns durable auth records:

```txt
Postgres
  user
  session
  account
  verification
  device_code
  oauth_client
  oauth_refresh_token
  oauth_access_token
  oauth_consent

Worker env
  BETTER_AUTH_SECRET
  ENCRYPTION_SECRETS
```

`ENCRYPTION_SECRETS` stay server-side. `/auth/get-session` derives per-user `encryptionKeys` and sends them to local clients.

### Browser

The browser stores one local auth session:

```txt
localStorage or extension storage
  AuthSession | null
```

The app already knows the API URL from constants:

```ts
createAuth({
	baseURL: APP_URLS.API,
	sessionStorage,
});
```

### Machine

The machine stores the same logical value:

```txt
OS keychain
  service: epicenter.auth.session
  account: current
  value: AuthSession
```

The CLI and daemons also know the API URL from constants:

```ts
createMachineAuthClient()
```

No stored auth object should include the server origin. If someone wants a fork that talks to another server, they can change the compiled API constant or build a separate CLI.

## Architecture

### Current

```txt
BetterAuthSessionResponse
  |
  v
AuthCredential
  |
  +-- AuthSession
  |
  +-- MachineCredential
        |
        +-- credentials.json metadata
        |
        +-- keychain secret blob
```

### Target

```txt
BetterAuthSessionResponse
  |
  v
normalizeAuthSession()
  |
  v
AuthSession
  |
  +-- browser storage
  |
  +-- machine keychain storage
  |
  +-- auth snapshot
```

The target has one local auth payload. The only remaining split is physical storage backend, not domain shape.

## API Shape

### Core Auth

Keep `createAuth` centered on `SessionStorage`:

```ts
export type SessionStorage = {
	load(): MaybePromise<AuthSession | null>;
	save(value: AuthSession | null): MaybePromise<void>;
};
```

Keep browser apps unchanged unless the normalizer moves:

```ts
const session = createPersistedState({
	key: 'fuji.auth.session',
	schema: AuthSession.or('null'),
	defaultValue: null,
});
```

### Machine Auth

Collapse the public machine auth API to one server:

```ts
export function createMachineAuth(): MachineAuth;
```

No public storage, fetch, sleep, client-id, or per-method `serverOrigin`:

```ts
machineAuth.loginWithDeviceCode({ onDeviceCode });
machineAuth.status();
machineAuth.logout();
machineAuth.getEncryptionKeys();
```

`createMachineAuthClient` should need no argument:

```ts
export function createMachineAuthClient(): AuthClient {
	return createAuth({
		baseURL: EPICENTER_API_URL,
		sessionStorage: machineSessionStorage,
	});
}
```

### CLI

Collapse auth commands:

```txt
epicenter auth login
epicenter auth status
epicenter auth logout
```

Remove:

```txt
epicenter auth login [server]
epicenter auth status [server]
epicenter auth logout [server]
epicenter auth login --insecure-storage
```

Status should stay modest:

```txt
Logged in as: Braden (braden@example.com)
Session:      verified
```

If remote verification fails:

```txt
Logged in as: Braden (braden@example.com)
Session:      stored, could not verify
```

No server line. No expiry line.

## Files To Edit

Primary auth files:

```txt
packages/auth/src/auth-types.ts
packages/auth/src/create-auth.ts
packages/auth/src/session-store.ts
packages/auth/src/contracts/auth-session.ts
packages/auth/src/contracts/index.ts
packages/auth/src/index.ts
packages/auth/src/node.ts
```

Machine auth files:

```txt
packages/auth/src/node/machine-auth-transport.ts
packages/auth/src/node/machine-auth.ts
packages/auth/src/node/machine-auth.test.ts
```

The old credential repository, secret storage, and server-origin normalizer are deleted. Machine storage now lives inside `machine-auth.ts` because it is one keychain value, not a repository model.

CLI files:

```txt
packages/cli/src/commands/auth.ts
packages/cli/src/cli.test.ts
```

App node consumers:

```txt
apps/fuji/src/lib/fuji/script.ts
apps/fuji/src/lib/fuji/daemon.ts
apps/honeycrisp/src/lib/honeycrisp/script.ts
apps/honeycrisp/src/lib/honeycrisp/daemon.ts
apps/opensidian/src/lib/opensidian/script.ts
apps/opensidian/src/lib/opensidian/daemon.ts
apps/zhongwen/src/lib/zhongwen/script.ts
apps/zhongwen/src/lib/zhongwen/daemon.ts
```

API bridge:

```txt
apps/api/src/auth/create-auth.ts
apps/api/src/auth/encryption.ts
apps/api/src/db/schema.ts
```

`apps/api/src/db/schema.ts` should not need behavior changes, but it is useful context for confirming that expiry and Better Auth session metadata stay server-owned.

## Implementation Plan

### Phase 1: Make `AuthSession` The Local Contract

- [x] **1.1** Keep `AuthSession` as the only local persisted auth shape.
- [x] **1.2** Add `normalizeAuthSession()` beside `normalizeAuthUser()`.
- [x] **1.3** Remove `AuthCredential`, `AuthServerSession`, `authSessionFromCredential()`, and `authCredentialFromSession()` from public exports.
- [x] **1.4** Keep `BetterAuthSessionResponse` as the raw server bridge only.
- [x] **1.5** Update `createAuth` to use `normalizeAuthSession()` when reading Better Auth session data.

### Phase 2: Replace Machine Credential Storage

- [x] **2.1** Delete the credential repository model or stop exporting it.
- [x] **2.2** Delete tokenless metadata storage and the `MachineCredential` aggregate.
- [x] **2.3** Replace keychain storage with one `AuthSession` keychain item.
- [x] **2.4** Keep an injected in-memory storage backend for tests.
- [x] **2.5** Decide whether plaintext file storage survives. If it does, make it store exactly `AuthSession | null`.
  > **Note**: Public plaintext file storage was removed. Tests use injected in-memory storage.

### Phase 3: Collapse Machine Auth API

- [x] **3.1** Remove `serverOrigin` from `MachineAuth` method inputs.
- [x] **3.2** Source the API URL from `EPICENTER_API_URL`.
- [x] **3.3** Replace `getActiveEncryptionKeys()` and `getOfflineEncryptionKeys()` with one `getEncryptionKeys()`.
- [x] **3.4** Remove public session load/save helpers. The auth client owns the `SessionStorage` bridge internally.
- [x] **3.5** Remove `expired`, `missingSecrets`, and multi-server status variants.

### Phase 4: Collapse CLI Auth

- [x] **4.1** Remove `[server]` from `login`, `status`, and `logout`.
- [x] **4.2** Remove `--insecure-storage` from the public CLI unless plaintext mode is explicitly kept.
- [x] **4.3** Remove server and expiry lines from status output.
- [x] **4.4** Update CLI tests around the new command shape.

### Phase 5: Update App Consumers

- [x] **5.1** Update daemon and script consumers to call `createMachineAuthClient()` without `serverOrigin`.
- [x] **5.2** Update direct machine-auth calls to remove `serverOrigin`.
- [x] **5.3** Keep browser app storage unchanged because it already stores `AuthSession`.

### Phase 6: Sweep The Old Vocabulary

- [x] **6.1** Remove references to `AuthCredential`.
- [x] **6.2** Remove references to `authorizationToken` outside server transport internals if possible.
- [x] **6.3** Remove references to `serverSessionToken`.
- [x] **6.4** Remove references to `currentServerOrigin`.
- [x] **6.5** Remove `MachineCredentialSummary` if CLI status can speak directly from `AuthSession`.

## Edge Cases

### Keychain Missing

If the single keychain item is missing, machine auth treats the user as signed out.

No `missingSecrets` state. No metadata recovery. The storage invariant is one value or no value.

### Expired Server Session

Local code does not predict expiry. It sends the token, the server rejects it, and auth reacts to that rejection.

If status wants to distinguish this later, it can do so by classifying the server response. It should not reintroduce locally stored expiry metadata.

### Offline Local Decryption

Machine code can still load `encryptionKeys` from the stored `AuthSession`. Offline decryption does not require server expiry metadata.

If the product later decides expired auth should revoke offline decryption, that is a server and key-management policy, not a local metadata field.

### Self-Hosted Users

The default CLI no longer supports arbitrary server URLs.

The fork path is explicit: change the API constant and build a separate CLI. Do not keep first-party auth storage complex for a caller the first-party product does not serve.

## Open Questions

1. **Should plaintext file mode survive as a public feature?**

   Recommendation: no. Keep an injected test store. If a real environment cannot use keychain, revisit with a concrete caller.

2. **Should `AuthSession.token` be renamed to `authorizationToken`?**

   Recommendation: no for this cleanup. `token` is the app-facing vocabulary, and collapsing shapes matters more than renaming a field.

3. **Should browser storage add `expiresAt` so browser and machine can share a richer shape?**

   Recommendation: no. The more aggressive simplification is to remove local expiry everywhere. The server owns expiry.

4. **Should machine status remotely verify and clear invalid sessions?**

   Recommendation: yes, if the server returns a clear auth rejection. Avoid clearing on network failure.

## Success Criteria

- [x] Browser and machine storage both persist `AuthSession | null`.
- [x] No local persisted auth shape includes `serverOrigin`.
- [x] No local persisted auth shape includes Better Auth server-session metadata.
- [x] No local auth code stores `serverSessionToken`.
- [x] Machine auth has no multi-server credential repository.
- [x] CLI auth commands do not accept a server URL.
- [x] CLI auth status does not print server origin, saved time, last-used time, or expiry time.
- [x] `rg "AuthCredential|MachineCredential|serverSessionToken|currentServerOrigin|MissingCredentialSecrets"` has no production hits, except historical specs or migration notes.
- [x] Browser apps still load their existing `AuthSession` records without migration.
- [x] `bun test packages/auth packages/cli` passes.

## Handoff Prompt

Implement `specs/20260503T012932-local-auth-session-clean-break.md`.

Use a clean-break approach. Do not preserve self-hosted CLI auth, multi-server credentials, local expiry display, missing-secret diagnostics, or Better Auth server-session token preservation unless a current first-party production caller truly requires it.

The target invariant is: browser and machine auth both persist `AuthSession | null`; the server owns session metadata, expiry, and auth provider details.

Start by tracing current production callers of `createMachineAuth`, `createMachineAuthClient`, and `AuthCredential`. Then implement in phases:

1. Make `AuthSession` the only local persisted auth contract.
2. Replace machine credential storage with one `AuthSession` keychain value plus an injected test store.
3. Remove `serverOrigin` from public machine auth methods and source the API URL from `EPICENTER_API_URL`.
4. Collapse CLI auth commands to `login`, `status`, and `logout` with no server positional.
5. Update app daemon and script consumers.
6. Delete stale credential repository, secret-storage, and summary types.

Run focused tests after each phase, then run `bun test packages/auth packages/cli`. Keep the final graph small enough to explain as: Better Auth response normalizes to `AuthSession`; local storage stores `AuthSession`; auth snapshots read `AuthSession`.

## References

- `packages/auth/src/auth-types.ts`
- `packages/auth/src/create-auth.ts`
- `packages/auth/src/contracts/auth-session.ts`
- `packages/auth/src/node/machine-auth.ts`
- `packages/cli/src/commands/auth.ts`
- `apps/api/src/auth/create-auth.ts`
- `specs/20260503T010845-auth-credential-source-of-truth.md`

## Review

**Completed**: 2026-05-03

### Summary

Machine auth now stores one `AuthSession | null` value. The old credential repository, tokenless metadata file, split secret storage, server-origin selection, and local expiry status are gone.

The CLI now exposes only `epicenter auth login`, `epicenter auth status`, and `epicenter auth logout`. App daemon and script consumers call `createMachineAuthClient()` without passing an auth server.

### Verification

- `bun test packages/auth packages/cli`
- `bun run typecheck` in `packages/auth`

The full repo `bun run typecheck` still fails in existing `@epicenter/svelte` and landing diagnostics unrelated to this auth cleanup.
