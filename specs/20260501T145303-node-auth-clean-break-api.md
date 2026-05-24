# Node Auth Clean Break API

**Date**: 2026-05-01
**Status**: Draft
**Author**: AI-assisted
**Branch**: codex/explicit-daemon-host-config

## One Sentence

`@epicenter/auth/node` owns Node machine auth for an Epicenter server: it resolves the target origin, runs device login/status/logout, stores machine credentials securely by default, and exposes only summary results plus narrow token/key readers.

If this sentence is true, callers should not need to know about auth server transport headers, keychain reference layouts, credential file parsing, loaded credential shapes, or Better Auth polling details.

## Overview

The current migration moved CLI credentials into `@epicenter/auth/node`, which is the right package boundary. The next pass should make the public API match the ownership model more aggressively. `@epicenter/auth/node` should expose one machine auth surface for CLI commands and Node runtimes, while the credential file, OS keychain backend, auth server client, and polling mechanics become internal implementation details.

This is a clean break. Do not preserve old public names as aliases unless a downstream package cannot be updated in the same change.

## Locked Constraints

- Do not reintroduce `sessions.json` reads or migration.
- Do not use `SessionStorage` for CLI or daemon credentials.
- Do not make `user` optional in current credentials.
- Do not overwrite `session.session.token` with `set-auth-token`.
- Keep `credential.bearerToken` as the canonical source for `Authorization` headers.
- Default storage is OS keychain storage and must fail closed.
- `--insecure-storage` is the only plaintext file mode.
- Do not leave bearer-equivalent secrets in JSON in keychain mode.
- Do not silently downgrade secure storage to plaintext.
- Use `bun` commands only.
- Do not use em dash or en dash characters in code, docs, tests, comments, or commit messages.
- Preserve unrelated dirty work.

## Current State

The package currently exports low-level parts as public API:

```ts
export {
	createAuthServerClient,
	createCliAuth,
	createCredentialStore,
	createCredentialTokenGetter,
	createDefaultCredentialStore,
	createFileSecretStore,
	createKeychainSecretStore,
	type CredentialMetadata,
	type CredentialSecretStore,
	type CredentialStore,
	type CredentialStoreStorageMode,
} from '@epicenter/auth/node';
```

The CLI composes those parts itself:

```ts
function createAuthForServer(
	serverOrigin: string,
	storageMode: CredentialStoreStorageMode = 'osKeychain',
	credentialStore: CredentialStore = createDefaultCredentialStore({ storageMode }),
) {
	return createCliAuth({
		authServerClient: createAuthServerClient({ fetch }, { serverOrigin }),
		credentialStore,
	});
}
```

The credential store takes two independent storage controls:

```ts
createCredentialStore({
	path,
	storageMode: 'osKeychain',
	secretStore,
});
```

The auth server client exposes a transport header as part of its session API:

```ts
const remote = await authServerClient.getSession({
	token: credential.bearerToken,
});

await credentialStore.save(credential.serverOrigin, {
	bearerToken: remote.setAuthToken ?? credential.bearerToken,
	session: remote.session,
});
```

Node runtimes use a token adapter:

```ts
const sync = attachSync(doc, {
	url: websocketUrl(`${apiUrl}/workspaces/${doc.ydoc.guid}`),
	getToken: createCredentialTokenGetter({ serverOrigin: apiUrl }),
});
```

Playgrounds read credentials directly:

```ts
const credentials = createDefaultCredentialStore();

const whenCredentialsApplied = persistence.whenLoaded.then(async () => {
	const keys = await credentials.getEncryptionKeys(SERVER_URL);
	if (keys) encryption.applyKeys(keys);
});

const sync = attachSync(ydoc, {
	getToken: () => credentials.getBearerToken(SERVER_URL),
});
```

This works, but it leaves too much of the storage and transport machinery visible.

## Problems

### 1. Server origin has two owners

`createCliAuth()` receives an `authServerClient` that is already bound to a server origin. Its `status(serverOrigin?)` and `logout(serverOrigin?)` methods can then resolve a different credential from storage.

```txt
createCliAuth(authServerClient for A)
  status(B)
    load credential for B
    verify with client for A
```

The CLI happens to avoid this by carefully constructing the client. The public API should not permit the mismatch.

### 2. Storage policy is split across two options

`storageMode` chooses file versus keychain behavior. `secretStore` provides the backend. That means the type system accepts mismatched combinations:

```ts
createCredentialStore({
	storageMode: 'file',
	secretStore: createKeychainSecretStore(),
});

createCredentialStore({
	storageMode: 'osKeychain',
	secretStore: createFileSecretStore(),
});
```

The implementation may not leak secrets with those examples today, but the shape is still wrong. A caller can express an invalid policy.

### 3. Transport details leak into credential refresh

`getSession()` returns `setAuthToken`, so `createCliAuth()` owns header fallback policy in both login and status. The auth server client should return a credential-shaped value with `bearerToken` already resolved.

```ts
// Current split ownership
authServerClient.getSession() -> { session, setAuthToken }
createCliAuth()               -> setAuthToken ?? previousBearer
credentialStore.save()        -> persist bearerToken and session
```

That is three layers participating in one field ownership rule.

### 4. The public API exposes persistence internals

The public export set includes:

```txt
createCredentialStore()
createDefaultCredentialStore()
CredentialSecretStore
CredentialSecretRef
CredentialMetadata
createFileSecretStore()
createKeychainSecretStore()
```

Most consumers need one of three things:

```txt
log in
log out or check status
get a bearer token or encryption keys
```

The public shape should be built around those verbs.

### 5. Key reads mix online and offline policy through naming

`getEncryptionKeys()` returns keys only when the session is unexpired. `getOfflineEncryptionKeys()` returns keys even after expiry.

That distinction is correct, but the name `getEncryptionKeys()` hides the active-session policy. The clearer pair is:

```ts
getActiveEncryptionKeys()
getOfflineEncryptionKeys()
```

### 6. CLI display logic is doing auth assembly

`packages/cli/src/commands/auth.ts` should parse flags and print results. It should not assemble stores, transports, and server-bound clients.

### 7. Loaded credentials would leak too much public shape

The first draft exported `MachineCredential`. That contradicts the one sentence. Public command results need enough data to print a user, server, and expiry; they do not need bearer tokens, Better Auth session tokens, or encryption keys.

The public data object should be a summary derived from the portable session contract:

```ts
import type { Session } from '@epicenter/auth/contracts';

export type MachineCredentialSummary = {
	serverOrigin: string;
	user: Pick<Session['user'], 'id' | 'name' | 'email'>;
	session: Pick<Session['session'], 'expiresAt'>;
	savedAt: string;
	lastUsedAt: string;
};
```

Do not hand-write the `user` and `session` field shapes in the Node API. Derive them from `Session`, because `Session` is the runtime-validated, JSON-safe form of Epicenter's Better Auth session response.

## Better Auth Grounding

DeepWiki review of `better-auth/better-auth` and the current Better Auth docs confirm two useful constraints:

1. Better Auth's preferred TypeScript path is inference from `$Infer.Session` when a concrete `auth` or `authClient` instance is available. The docs also call out that custom session inference depends on sharing the server auth type with the client.
2. Better Auth's device authorization docs expose `authClient.device.code()` and `authClient.device.token()`, and the bearer docs describe reading `set-auth-token` and sending `Authorization: Bearer <token>`.

Epicenter should follow the type direction without importing the Cloudflare auth singleton into Node auth. `apps/api/src/auth/create-auth.ts` builds Better Auth per request, so there is no stable module-level `auth` instance for `@epicenter/auth/node` to derive from. The portable boundary is already `@epicenter/auth/contracts`: `SessionResponse` matches the custom session return value, and `Session` is the normalized runtime contract used by storage and Node consumers.

`@epicenter/api` currently exposes `./types` through `apps/api/src/auth/contracts/index.ts`, but that path is a stale shim, not a target API:

```txt
@epicenter/api/types
  -> apps/api/src/auth/contracts/index.ts
  -> apps/api/src/auth/contracts/get-session.ts
  -> re-exports SessionResponse from @epicenter/auth/contracts
```

Do not move contract ownership back into `apps/api`, and do not preserve `@epicenter/api/types` unless a real external consumer is found. The API implements the contract by returning a `customSession()` payload that satisfies `SessionResponse`; Node and browser auth consume the contract from `@epicenter/auth/contracts`.

The internal transport should be allowed to use either Better Auth's client plugins or a small raw-fetch transport. That is an implementation decision behind `createMachineAuth()`. The public contract must prove these Better Auth behaviors either way:

```txt
device code request    -> user code and verification URL
device token polling   -> access token or typed polling error
get session            -> Session plus final bearer token
set-auth-token header  -> stored as credential.bearerToken
Authorization header   -> reads credential.bearerToken
```

Start Phase 2 with a small transport spike:

```txt
Option A: Better Auth client transport
  createAuthClient({ plugins: [deviceAuthorizationClient()] })
  authClient.device.code()
  authClient.device.token()
  authClient.getSession({ fetchOptions: { headers: { Authorization } } })

Option B: raw fetch transport
  POST /auth/device/code
  POST /auth/device/token
  GET /auth/get-session
  direct JSON validation and header capture
```

Choose Option A if it keeps terminal polling errors, response headers, and custom session validation explicit. Keep Option B if the client abstraction hides those details or makes the credential invariants harder to test. This choice must not affect the public Node API.

## Target Public API

### Node package exports

The ideal `@epicenter/auth/node` export set is small:

```ts
export {
	createMachineAuth,
	createMachineTokenGetter,
	type MachineAuth,
	type MachineAuthError,
	type MachineAuthLoginResult,
	type MachineAuthLogoutResult,
	type MachineAuthStatus,
	type MachineCredentialSummary,
	type MachineCredentialStoragePolicy,
} from '@epicenter/auth/node';
```

Everything else is internal unless there is a concrete external caller:

```txt
createAuthServerClient       internal transport
createCredentialStore        internal repository
createDefaultCredentialStore internal default repository factory
CredentialSecretStore        internal backend seam
CredentialSecretRef          internal keychain ref format
createFileSecretStore        internal plaintext secret backend
createKeychainSecretStore    internal keychain backend
```

Tests can import internals by relative path inside `packages/auth/src/node`. Package consumers should not see them from `@epicenter/auth/node`.

### Machine auth factory

```ts
import { createMachineAuth } from '@epicenter/auth/node';

const machineAuth = createMachineAuth({
	fetch,
	credentialStorage: { kind: 'keychain' },
});
```

`credentialStorage` defaults to `{ kind: 'keychain' }`.

Plaintext storage must be explicit:

```ts
const machineAuth = createMachineAuth({
	fetch,
	credentialStorage: { kind: 'plaintextFile' },
});
```

Custom credential file paths are a storage policy detail, not a repository seam:

```ts
const machineAuth = createMachineAuth({
	credentialStorage: {
		kind: 'plaintextFile',
		credentialFilePath: '/tmp/epicenter-test-credentials.json',
	},
});
```

Internal tests can import repository and transport internals by relative path inside `packages/auth/src/node`. The package barrel should not expose `credentialRepository`, `secretStore`, or a memory repository factory.

### Machine auth methods

```ts
export type MachineAuth = {
	loginWithDeviceCode(input: {
		serverOrigin: string | URL;
		onDeviceCode?: (device: {
			userCode: string;
			verificationUriComplete: string;
		}) => void | Promise<void>;
		openBrowser?: (url: string) => Promise<void>;
	}): Promise<Result<MachineAuthLoginResult, MachineAuthError>>;

	status(input?: {
		serverOrigin?: string | URL;
	}): Promise<Result<MachineAuthStatus, MachineAuthError>>;

	logout(input?: {
		serverOrigin?: string | URL;
	}): Promise<Result<MachineAuthLogoutResult, MachineAuthError>>;

	getBearerToken(input?: {
		serverOrigin?: string | URL;
	}): Promise<Result<string | null, MachineAuthError>>;

	getActiveEncryptionKeys(input?: {
		serverOrigin?: string | URL;
	}): Promise<Result<EncryptionKeysData | null, MachineAuthError>>;

	getOfflineEncryptionKeys(input?: {
		serverOrigin?: string | URL;
	}): Promise<Result<EncryptionKeysData | null, MachineAuthError>>;
};
```

Public result shapes should stay summary-only:

```ts
export type MachineAuthLoginResult = {
	status: 'loggedIn';
	credential: MachineCredentialSummary;
	device: {
		userCode: string;
		verificationUriComplete: string;
	};
};

export type MachineAuthStatus =
	| { status: 'signedOut' }
	| { status: 'valid'; credential: MachineCredentialSummary }
	| { status: 'expired'; credential: MachineCredentialSummary }
	| {
			status: 'unverified';
			credential: MachineCredentialSummary;
			verificationError: AuthServerError;
	  }
	| { status: 'missingSecrets'; credential: MachineCredentialSummary };

export type MachineAuthLogoutResult =
	| { status: 'signedOut' }
	| { status: 'loggedOut'; serverOrigin: string };
```

All direct methods return `Result` so callers cannot confuse absence with integrity failure. `null` means there is no usable credential for that read. `Err` means the auth layer could not safely answer, such as invalid credential JSON, invalid server origin, or secure storage failure.

`createMachineTokenGetter()` is the callback-friendly adapter for `attachSync()`. It unwraps `getBearerToken()`, returns `null` for absence, and throws typed errors so `attachSync()` can surface them as auth failures.

### CLI call sites

Before:

```ts
const storageMode: CredentialStoreStorageMode = argv.insecureStorage
	? 'file'
	: 'osKeychain';

const cliAuth = createAuthForServer(serverUrl, storageMode);
const result = await cliAuth.loginWithDeviceCode({
	onDeviceCode: printDeviceCode,
});
```

After:

```ts
const machineAuth = createMachineAuth({
	fetch,
	credentialStorage: argv.insecureStorage
		? { kind: 'plaintextFile' }
		: { kind: 'keychain' },
});

const result = await machineAuth.loginWithDeviceCode({
	serverOrigin: serverUrl,
	onDeviceCode: printDeviceCode,
});
```

Status and logout do not construct a guessed server client:

```ts
const result = await machineAuth.status({
	serverOrigin: typeof argv.server === 'string' ? argv.server : undefined,
});
```

Inside `createMachineAuth()`, status resolution is linear:

```txt
input serverOrigin exists
  -> load that credential or summary
  -> verify against that same origin

input serverOrigin missing
  -> load current credential or current summary
  -> verify against credential.serverOrigin
```

There is no separately injected server-bound client.

### Daemon call sites

Before:

```ts
getToken = createCredentialTokenGetter({ serverOrigin: apiUrl });
```

After:

```ts
getToken = createMachineTokenGetter({ serverOrigin: apiUrl });
```

`createMachineTokenGetter()` earns its keep because `attachSync()` wants a token callback, not a full auth object. It is an adapter around the same machine auth credential source:

```ts
export function createMachineTokenGetter({
	serverOrigin,
	machineAuth = createMachineAuth(),
}: {
	serverOrigin: string | URL;
	machineAuth?: Pick<MachineAuth, 'getBearerToken'>;
}) {
	return async () => {
		const { data, error } = await machineAuth.getBearerToken({ serverOrigin });
		if (error) throw error;
		return data;
	};
}
```

The adapter must require `serverOrigin`. Sync already knows the server URL. Falling back to the current credential here can pair the most recent login with the wrong WebSocket origin.

The adapter should not expose storage mode, repositories, or secret backends.

### Playground key application

Before:

```ts
const credentials = createDefaultCredentialStore();

const whenCredentialsApplied = persistence.whenLoaded.then(async () => {
	const keys = await credentials.getEncryptionKeys(SERVER_URL);
	if (keys) encryption.applyKeys(keys);
});
```

After:

```ts
const machineAuth = createMachineAuth();

const whenCredentialsApplied = persistence.whenLoaded.then(async () => {
	const { data: keys, error } = await machineAuth.getActiveEncryptionKeys({
		serverOrigin: SERVER_URL,
	});
	if (error) throw error;
	if (keys) encryption.applyKeys(keys);
});
```

Scripts that intentionally need offline reads say so:

```ts
const { data: keys, error } = await machineAuth.getOfflineEncryptionKeys({
	serverOrigin: EPICENTER_API_URL,
});
if (error) throw error;
if (keys) encryption.applyKeys(keys);
```

## Naming

| Current name | Target name | Reason |
| --- | --- | --- |
| `createCliAuth` | `createMachineAuth` | The API is useful for daemons, scripts, and CLI commands. It is not only CLI auth. |
| `createCredentialTokenGetter` | `createMachineTokenGetter` | The adapter reads from machine auth, not a credential-store implementation. |
| `Credential` | internal `MachineCredential` | Loaded credentials contain secrets and should not be exported from `@epicenter/auth/node`. |
| `CredentialMetadata` | `MachineCredentialSummary` | This is display/status data without secrets loaded. |
| `CredentialSession` | `TokenlessSession` | The stored JSON session intentionally omits Better Auth's session token. |
| `CredentialStoreStorageMode` | `MachineCredentialStoragePolicy` | The public choice is a storage policy, not a mode flag. |
| `storageMode: 'file'` | `{ kind: 'plaintextFile' }` | The risk is in the name. |
| `storageMode: 'osKeychain'` | `{ kind: 'keychain' }` | Shorter and not tied to one OS vocabulary. |
| `secretStore` | `secretStorage` | A backend stores secrets. The higher-level store stores credentials. |
| `getEncryptionKeys` | `getActiveEncryptionKeys` | Expiry policy becomes visible at the call site. |

## Architecture

The public layer owns origin resolution and field ownership. The lower layers do one thing each.

```txt
+----------------------------------------------+
| createMachineAuth()                          |
| - resolves target server origin              |
| - runs login, status, logout                 |
| - owns bearerToken refresh policy            |
| - exposes token and key read APIs            |
+----------------------------------------------+
                    |
                    | creates per-origin transport
                    v
+----------------------------------------------+
| AuthServerTransport                          |
| - request device code                        |
| - poll device token                          |
| - fetch credential session                   |
| - sign out                                   |
| - validates response JSON                    |
+----------------------------------------------+
                    |
                    | reads and writes loaded credentials
                    v
+----------------------------------------------+
| MachineCredentialRepository                  |
| - reads and validates credentials.json       |
| - stores tokenless session metadata in JSON  |
| - stores bearer-equivalent secrets securely  |
| - returns current credential or summary      |
+----------------------------------------------+
                    |
                    | keychain or plaintext strategy
                    v
+----------------------------------------------+
| SecretStorageStrategy                        |
| - keychain: fail closed                      |
| - plaintextFile: explicit insecure mode      |
+----------------------------------------------+
```

Field ownership:

| Value | Owner | Rule |
| --- | --- | --- |
| `serverOrigin` | `createMachineAuth()` method input or resolved credential | Verify and sign out against the same origin that produced the credential. |
| `bearerToken` | Machine auth refresh policy | Initialize from device `access_token`; refresh from `set-auth-token`; use for `Authorization`. |
| `session.session.token` | Better Auth session snapshot | Preserve response body data. Do not overwrite with `set-auth-token`. |
| `encryptionKeys` | Session response and credential repository | Store with bearer-equivalent secrecy. |
| `currentServerOrigin` | Credential repository | Select most recent or explicit current credential. |
| `credentialStorage` | Machine auth construction | Default keychain; plaintext only by explicit policy. |
| CLI text | CLI command | Library returns structured results, CLI prints them. |
| Public summary fields | `@epicenter/auth/contracts` `Session` type | Derive user/session summary fields from the portable session contract. |

## Transport Contract

`AuthServerTransport.getSession()` should become a credential-shaped method:

```ts
type RemoteCredential = {
	bearerToken: string;
	session: Session;
};

async function fetchCredentialSession({
	bearerToken,
}: {
	bearerToken: string;
}): Promise<Result<RemoteCredential, AuthServerError>>;
```

The transport reads `set-auth-token` and resolves the final bearer token before returning:

```ts
return Ok({
	bearerToken: response.headers.get('set-auth-token') ?? bearerToken,
	session: normalizeSessionResponse(data),
});
```

`createMachineAuth()` then saves a single coherent value:

```ts
const remote = await transport.fetchCredentialSession({
	bearerToken: credential.bearerToken,
});

await credentials.save({
	serverOrigin: credential.serverOrigin,
	bearerToken: remote.data.bearerToken,
	session: remote.data.session,
});
```

This removes the duplicate fallback expression from login and status while keeping the transport responsible for the Better Auth header detail.

The transport may wrap Better Auth's `createAuthClient()` or use raw fetch. Either implementation must return `Result` values, validate the custom `Session` response before saving, and keep `set-auth-token` private to this layer.

## Error Model

Use `defineErrors` for domain failures. Do not make every helper return one giant catch-all error. Keep the boundaries clear:

```ts
export const ServerOriginError = defineErrors({
	InvalidServerOrigin: ({ input, cause }: { input: string; cause: unknown }) => ({
		message: `Expected a server origin like https://api.epicenter.so: ${input}`,
		input,
		cause,
	}),
});
```

```ts
export const AuthServerError = defineErrors({
	RequestFailed: ({ method, path, status, body }: ... ) => ({ ... }),
	InvalidJson: ({ method, path, body, cause }: ... ) => ({ ... }),
	EmptyBody: ({ method, path }: ... ) => ({ ... }),
	DeviceCodeExpired: () => ({ message: 'Device code expired. Run login again.' }),
	DeviceAccessDenied: () => ({ message: 'Authorization denied.' }),
	DeviceAuthorizationFailed: ({ code, description }: ... ) => ({ ... }),
});
```

```ts
export const MachineCredentialError = defineErrors({
	SecureStorageUnavailable: ({ cause }: { cause?: unknown }) => ({ ... }),
	SecureStorageSelfTestFailed: ({ cause }: { cause: unknown }) => ({ ... }),
	CredentialFileInvalid: ({ path, cause }: { path: string; cause: unknown }) => ({ ... }),
	KeychainSecretMissing: ({ serverOrigin }: { serverOrigin: string }) => ({ ... }),
	KeychainSecretInvalid: ({ serverOrigin, cause }: ... ) => ({ ... }),
});
```

Public command methods can return:

```ts
type MachineAuthError =
	| ServerOriginError
	| AuthServerError
	| MachineCredentialError;
```

CLI handlers and direct readers stay flat:

```ts
const { data, error } = await machineAuth.status({ serverOrigin });
if (error) {
	console.error(error.message);
	return;
}

printStatus(data);
```

```ts
const { data: keys, error } = await machineAuth.getActiveEncryptionKeys({
	serverOrigin,
});
if (error) throw error;
if (keys) encryption.applyKeys(keys);
```

## Experiments

### Experiment A: server-bound auth objects

```ts
const auth = createMachineAuth({ serverOrigin });
await auth.status();
await auth.logout();
```

This makes the wrong server mismatch impossible, but it handles `auth status` with no server poorly. The CLI supports "most recent session" as a real behavior. A server-bound object would either need a separate current-session factory or would push origin resolution back into the CLI.

Verdict: reject as the only public shape. Keep server binding at the method level and make `createMachineAuth()` own client construction after resolution.

### Experiment B: expose a credential repository

```ts
const credentials = createMachineCredentialRepository();
await credentials.getBearerToken({ serverOrigin });
```

This is close to the current shape with better names. It still makes consumers think about repository mechanics when they just need auth reads.

Verdict: keep internally. Public callers use `createMachineAuth()`.

### Experiment C: typed secret storage

```ts
secretStorage.saveBearerToken(ref, token);
secretStorage.saveEncryptionKeys(ref, keys);
```

This spreads auth domain concepts into the keychain adapter. The adapter should not know what a bearer token or encryption key is. It stores strings by ref. The typed boundary is the credential repository.

Verdict: reject. Keep secret storage string-only.

### Experiment D: one credential read method

```ts
const credential = await machineAuth.getCredential({ serverOrigin });
```

This is tempting, but it hands daemon code a bearer token, Better Auth session token, user, and encryption keys when most code needs one field. It also invites consumers to pick the wrong token.

Verdict: reject for public API. Keep loaded credential internal and expose narrow readers.

### Experiment E: optional origin token getter

```ts
const getToken = createMachineTokenGetter();
```

This is convenient, but it is wrong for sync. `attachSync()` connects to one WebSocket URL. If the token getter falls back to the current credential, a daemon can connect to `apiUrl` while authenticating with the most recently used unrelated server.

Verdict: reject. `createMachineTokenGetter()` requires `serverOrigin`.

### Experiment F: public repository injection

```ts
const machineAuth = createMachineAuth({
	credentialRepository: memoryCredentialRepository(),
});
```

This makes tests easy, but it leaks the internal storage boundary into the public package. It also makes the repository shape part of the clean-break API even though normal callers only choose keychain or plaintext file storage.

Verdict: reject for the public barrel. Package tests can import internals by relative path. Public callers use `credentialStorage`.

## Implementation Plan

### Phase 1: Add the machine auth surface

- [ ] Add `createMachineAuth()` in `packages/auth/src/node/machine-auth.ts`.
- [ ] Move origin resolution into machine auth methods.
- [ ] Accept `fetch`, `credentialStorage`, `clientId`, `clock`, and `sleep` options.
- [ ] Default `credentialStorage` to `{ kind: 'keychain' }`.
- [ ] Represent plaintext storage as `{ kind: 'plaintextFile' }`.
- [ ] Support `credentialFilePath` inside the storage policy for tests and custom hosts.
- [ ] Keep repository and secret-store injection out of `@epicenter/auth/node` exports.
- [ ] Return `Result` from `loginWithDeviceCode`, `status`, and `logout`.
- [ ] Return `Result<T | null, MachineAuthError>` from direct token and key readers.
- [ ] Add `createMachineTokenGetter()` as the `attachSync()` adapter that unwraps `getBearerToken()`.
- [ ] Make `createMachineTokenGetter()` require `serverOrigin`.
- [ ] Return `MachineCredentialSummary` from public command results, not loaded credentials.
- [ ] Derive `MachineCredentialSummary.user` and `.session` from the `Session` contract.

### Phase 2: Collapse the auth server client boundary

- [ ] Spike a Better Auth client transport using `createAuthClient()` plus `deviceAuthorizationClient()`.
- [ ] Keep the raw fetch transport if Better Auth client wrapping hides headers, terminal polling errors, or runtime validation.
- [ ] Rename or replace `getSession()` with a method that returns `{ bearerToken, session }`.
- [ ] Validate device code and token responses with runtime schemas.
- [ ] Convert transport, JSON, empty body, and terminal device polling errors to `defineErrors`.
- [ ] Keep `set-auth-token` private to the transport layer.
- [ ] Keep `Session` validation at the transport or machine-auth boundary before credential save.

### Phase 3: Collapse credential storage strategy

- [ ] Replace `storageMode` plus `secretStore` with one strategy value.
- [ ] Keep keychain and plaintext file backends internal.
- [ ] Keep the secret backend string-only.
- [ ] Rename internal file schemas around persisted data, not public API.
- [ ] Keep invalid credential files fail-closed.
- [ ] Keep stale keychain cleanup when replacing credentials.

### Phase 4: Update consumers in one sweep

- [ ] Update `packages/cli/src/commands/auth.ts` to construct `createMachineAuth()` once per command.
- [ ] Remove `--secure-storage`; secure storage is the default.
- [ ] Keep `--insecure-storage` as the only plaintext mode.
- [ ] Replace `createCredentialTokenGetter()` with `createMachineTokenGetter()` in app daemon defaults and examples.
- [ ] Replace direct `createDefaultCredentialStore()` playground reads with `createMachineAuth()` key readers.
- [ ] Replace `getEncryptionKeys()` call sites with `getActiveEncryptionKeys()`.
- [ ] Keep intentional local decrypt scripts on `getOfflineEncryptionKeys()`.
- [ ] Update `packages/cli/README.md` and auth docs to show only the new names.

### Phase 5: Delete old public exports

- [ ] Remove old names from `packages/auth/src/node.ts`.
- [ ] Grep for `createCliAuth`, `createCredentialStore`, `createDefaultCredentialStore`, `createCredentialTokenGetter`, `CredentialMetadata`, `CredentialSecretStore`, and `storageMode`.
- [ ] Keep relative imports in tests only where they are intentionally testing internals.
- [ ] Do not add compatibility aliases.
- [ ] Verify no public export exposes loaded credential, repository, secret refs, or secret storage backends.
- [ ] Remove the stale `@epicenter/api/types` export and `apps/api/src/auth/contracts/*` shim if no external consumer is found.

### Phase 6: Prove invariants with tests

- [ ] Status verifies against the same server origin as the resolved credential.
- [ ] Logout signs out against the same server origin as the resolved credential.
- [ ] Login stores `set-auth-token` as `bearerToken` without mutating `session.session.token`.
- [ ] Status refresh stores `set-auth-token` as `bearerToken` without mutating `session.session.token`.
- [ ] Missing keychain secrets return a missing-secret status for CLI display.
- [ ] Invalid credential file JSON and schema fail closed.
- [ ] Keychain unavailable and self-test failures fail before writing JSON.
- [ ] Keychain mode writes no bearer token, Better Auth session token, or encryption key material to JSON.
- [ ] Plaintext file mode is reachable only through explicit insecure storage policy.
- [ ] Active key reads return `Ok(null)` after expiry.
- [ ] Offline key reads return keys after expiry.
- [ ] Direct token and key readers return `Err` for integrity failures and `Ok(null)` for absence.
- [ ] `createMachineTokenGetter()` returns `null` for absent credentials and throws typed errors for integrity failures.
- [ ] `createMachineTokenGetter()` requires `serverOrigin`.
- [ ] Public command results expose only `MachineCredentialSummary`, never `MachineCredential`.
- [ ] `MachineCredentialSummary` derives user and session fields from the `Session` contract.
- [ ] Public exports contain only the new API.

## Edge Cases

### Current credential has missing keychain secrets

Status should return a structured missing-secret status that includes a `MachineCredentialSummary`, not a loaded credential. The CLI can print the user and server while warning that local secrets are missing.

Token and key readers should return `Ok(null)` for missing secrets. They should not fall back to plaintext or try to repair the credential.

### Invalid credential file

Invalid JSON or schema should fail closed. It must not be treated as an empty store, because that silently replaces evidence of corruption on the next save.

### Same server, different user

Saving a credential for the same server but a different user must remove stale keychain refs after the new credential file is written. This avoids orphaned bearer-equivalent secrets while preserving the new credential if cleanup fails.

### Device polling terminal errors

`authorization_pending` and `slow_down` are control flow. `expired_token`, `access_denied`, and unknown terminal errors become typed auth server errors.

### `set-auth-token` appears during status refresh

The response header updates `bearerToken`. The response body preserves Better Auth session data. Do not write the header value into `session.session.token`.

### Headless hosts

If the keychain is unavailable, default login fails closed with a clear error. The CLI may suggest `--insecure-storage`, but the library must not choose plaintext automatically.

## Success Criteria

- [ ] A new caller can explain Node auth without naming credential files or keychain refs.
- [ ] `packages/cli/src/commands/auth.ts` no longer imports `createAuthServerClient`, `createCliAuth`, `createCredentialStore`, or `CredentialStoreStorageMode`.
- [ ] Daemon defaults no longer import `createCredentialTokenGetter`.
- [ ] Playground configs no longer import `createDefaultCredentialStore`.
- [ ] `@epicenter/auth/node` exports only machine auth names and data/result types.
- [ ] `@epicenter/auth/node` does not export loaded credential, repository, secret ref, or secret storage types.
- [ ] `@epicenter/api/types` is removed, or a concrete external consumer is documented as the explicit compatibility reason.
- [ ] `createMachineTokenGetter()` cannot be called without a `serverOrigin`.
- [ ] Public docs show only `createMachineAuth()` and `createMachineTokenGetter()`.
- [ ] No compatibility aliases remain outside historical specs.
- [ ] All auth node tests pass with `bun test`.
- [ ] `bun run typecheck` passes for `packages/auth`.
- [ ] Targeted CLI tests pass.

## References

- `packages/auth/src/node.ts` - current public Node export surface.
- `packages/auth/src/node/cli-auth.ts` - current CLI auth orchestration and server mismatch risk.
- `packages/auth/src/node/auth-server-client.ts` - current transport and `set-auth-token` leak.
- `packages/auth/src/node/credential-store.ts` - current credential repository and storage policy split.
- `packages/auth/src/node/credential-store.test.ts` - current fail-closed and keychain invariant tests.
- `packages/cli/src/commands/auth.ts` - CLI command assembly that should collapse.
- `apps/*/src/lib/*/daemon.ts` - default daemon token getter call sites.
- `playground/*/epicenter.config.ts` - direct credential key reader call sites.
- `apps/api/src/auth/contracts/index.ts` - stale shim for `@epicenter/api/types`.
- `apps/api/src/auth/contracts/get-session.ts` - re-exports `SessionResponse` from `@epicenter/auth/contracts`.
- `apps/api/src/auth/create-auth.ts` - API implementation that returns `SessionResponse` from `customSession()`.
- `specs/20260501T005500-machine-auth-credential-cache.md` - implemented migration baseline.
- Better Auth TypeScript docs - `$Infer.Session`, separate package inference, and additional-field caveats.
- Better Auth device authorization docs - device code and token polling client APIs.
- Better Auth bearer docs - `set-auth-token` and `Authorization: Bearer` behavior.

## Clean Break Grill Prompt

Use this prompt with a separate agent before implementation:

```txt
You are reviewing /Users/braden/conductor/workspaces/epicenter/ottawa-v2.

Task: clean-break analyze and grill the Node auth API redesign in specs/20260501T145303-node-auth-clean-break-api.md. Do not implement yet. Your output should be a ranked critique and a sharper target API if you can find one.

Context:
- Epicenter is a local-first workspace monorepo using Svelte, Yjs, Better Auth, and Bun.
- @epicenter/auth/contracts owns the portable Better Auth-shaped Session contract.
- @epicenter/auth/node currently owns createAuthServerClient(), createCredentialStore(), createDefaultCredentialStore(), createCredentialTokenGetter(), createCliAuth(), and CredentialSecretStore backends.
- CLI credentials are a clean break. Do not restore sessions.json migration.
- Credential.bearerToken is canonical for Authorization headers.
- credential.session.session.token is preserved Better Auth session data, not the bearer source of truth.
- Default storage is OS keychain and must fail closed.
- --insecure-storage is the only plaintext file mode.
- SessionStorage is browser-only. Do not use it for CLI credentials.

Read these files:
- specs/20260501T145303-node-auth-clean-break-api.md
- packages/auth/src/node.ts
- packages/auth/src/node/cli-auth.ts
- packages/auth/src/node/auth-server-client.ts
- packages/auth/src/node/credential-store.ts
- packages/auth/src/node/credential-secret-store.ts
- packages/cli/src/commands/auth.ts
- apps/fuji/src/lib/fuji/daemon.ts
- apps/honeycrisp/src/lib/honeycrisp/daemon.ts
- apps/opensidian/src/lib/opensidian/daemon.ts
- apps/zhongwen/src/lib/zhongwen/daemon.ts
- playground/opensidian-e2e/epicenter.config.ts
- playground/tab-manager-e2e/epicenter.config.ts

Apply this one-sentence test first:
"@epicenter/auth/node owns Node machine auth for an Epicenter server: it resolves the target origin, runs device login/status/logout, stores machine credentials securely by default, and exposes only summary results plus narrow token/key readers."

Grill these questions:
1. Does the target API make a wrong server/client pairing impossible, or merely less likely?
2. Does createMachineAuth() own too much, or is that the right boundary because it owns origin resolution?
3. Is createMachineTokenGetter() a useful adapter or a compatibility-shaped wrapper that should be deleted?
4. Should token and key readers return Result, throw integrity errors, or keep null-for-absence semantics?
5. Is getActiveEncryptionKeys() the right name, or should the active/offline policy be expressed as an option?
6. Should keychain and plaintext storage strategies be public values, or should only --insecure-storage reach them through CLI code?
7. Can CredentialSecretStore stay string-only without making encryption key serialization too implicit?
8. Should loaded MachineCredential remain internal while MachineCredentialSummary is public?
9. Can the CLI command flow be flatter if createMachineAuth() returns display-ready status values?
10. Which old public exports must die in the same patch to preserve the clean break?
11. Should the internal transport wrap Better Auth's createAuthClient() and deviceAuthorizationClient(), or should raw fetch stay because it keeps headers and validation explicit?
12. Are MachineCredentialSummary fields correctly derived from @epicenter/auth/contracts Session instead of hand-written Better Auth user/session shapes?

Hard constraints:
- Use bun only.
- Do not use npm, yarn, pnpm, or npx.
- Do not use em dash or en dash characters.
- Do not reintroduce sessions.json reads or migration.
- Do not make user optional in current credentials.
- Do not overwrite session.session.token with set-auth-token.
- Do not leave bearer-equivalent secrets in JSON in keychain mode.
- Do not silently downgrade secure storage to plaintext.
- Preserve unrelated dirty work. Do not reset, checkout, or revert.

Deliver:
1. A revised one-sentence thesis if the spec thesis is weak.
2. A ranked list of API smells in the spec itself.
3. A proposed final public export list for @epicenter/auth/node.
4. Before and after call-site examples for CLI auth, daemon token getter, and playground encryption keys.
5. A decision table for Result versus throw versus null across login, status, logout, token reads, and key reads.
6. A list of tests that prove security and clean-break invariants.
7. No implementation patch unless the critique reveals a tiny typo or broken reference in the spec.
```
