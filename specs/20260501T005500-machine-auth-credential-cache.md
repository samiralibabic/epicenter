# CLI Credential Store

**Date**: 2026-05-01
**Status**: Implemented
**Author**: AI-assisted

**Review 2026-05-01**: This is implemented in the current codebase. The
portable session contract lives under `packages/auth/src/contracts`, the Node
auth server client and credential store live under `packages/auth/src/node`,
and `packages/cli/src/commands/auth.ts` is now a thin wrapper over
`@epicenter/auth/node`. `createSessionStore()` is gone from workspace auth
consumers, and Node peers use credential-backed token and encryption key
helpers.

## Overview

Move the Node and CLI auth cache out of the workspace session-store vocabulary and make it a credential store over Better Auth sessions.

One sentence: `@epicenter/auth/node` logs the local CLI into a Better Auth server, persists credentials for that server, and hands scripts either a bearer token or encryption keys.

The shared data noun is `Session`. The browser holder is `AuthClient`, which keeps one in-memory session snapshot for UI and sync. The Node holder is `CredentialStore`, which persists credentials for one or more server origins. Both sit between a local process and the same Better Auth server; they differ because a browser is long-lived and reactive, while a CLI command is short-lived and file-backed.

## Motivation

### Current State

Node and CLI consumers currently use `createSessionStore()` from `@epicenter/workspace/node`:

```ts
// packages/workspace/src/client/session-store.ts
export type AuthSession = {
	accessToken: string;
	expiresAt: number;
	encryptionKeys: EncryptionKeysData;
	user?: { id: string; email: string; name?: string };
};

export type SaveSessionData = {
	encryptionKeys: EncryptionKeysData;
	user?: { id: string; email: string; name?: string };
};
```

The CLI logs in through Better Auth device authorization, fetches `/auth/get-session`, then rewrites the response into that local shape:

```ts
const tokenData = await api.pollDeviceToken(codeData.device_code);
const authed = createAuthApi(serverUrl, tokenData.access_token);
const sessionData = await authed.getSession();

await sessions.save(serverUrl, tokenData, sessionData);
```

That creates problems:

1. **Two `SessionStore` concepts**: `@epicenter/auth` has a synchronous browser persistence adapter. `@epicenter/workspace/node` has an async credential file. They share a name but not a contract.
2. **Two `AuthSession` concepts**: browser auth stores `{ token, user, encryptionKeys }`; workspace node auth stores `{ accessToken, expiresAt, encryptionKeys, user? }`.
3. **Better Auth session data is discarded**: the remote session has `session.token`, `session.expiresAt`, `session.userId`, `user.name`, `user.emailVerified`, timestamps, and plugin fields. The local cache keeps only a partial user and a separate token shape.
4. **Optional user lies about the normal case**: Better Auth `getSession()` returns both `user` and `session` when authenticated. The current credential format should require the full user.
5. **URL normalization is unclear policy**: `normalizeUrl()` lowercases the entire string, strips trailing slashes, and rewrites `ws` to `http`. That is cache-key logic, not Better Auth behavior, and it accepts paths/search/hash without making that choice explicit.
6. **Default session selection relies on object insertion order**: `delete store[key]; store[key] = ...` makes the newest login appear last. The store should have `lastUsedAt` or `currentServerOrigin`.
7. **Workspace owns auth state it should not own**: `packages/workspace` is a CRDT and local persistence package. It should not define Better Auth cache formats.

### Desired State

The credential store resolves one credential per server origin:

```ts
type Session = {
	user: StoredBetterAuthUser;
	session: StoredBetterAuthSession;
	encryptionKeys: EncryptionKeys;
};

type Credential = {
	serverOrigin: string;
	bearerToken: string;
	session: Session;
	savedAt: string;
	lastUsedAt: string;
};
```

`Credential` is the runtime value callers receive after secrets have been loaded. The JSON file may store those secrets inline in explicit file mode, or store only keychain references in secure mode.

The cached bearer credential is a separate field:

```ts
credential.bearerToken
```

The Better Auth session token remains part of the session snapshot:

```ts
credential.session.session.token
```

Do not treat that field as the only bearer credential. Better Auth's bearer plugin accepts raw session tokens by default, but it can also work with signed cookie-style token values and can reject raw tokens with `requireSignature: true`. The device `access_token` initializes `credential.bearerToken`; `set-auth-token` updates `credential.bearerToken`.

The expiry still comes from the Better Auth session snapshot:

```ts
credential.session.session.expiresAt
```

The user is required in the current format:

```ts
credential.session.user
```

Legacy parsing may accept older partial records, but all current writes must save the full Better Auth-backed shape.

## Research Findings

### Better Auth Device Authorization

DeepWiki over `better-auth/better-auth` and Better Auth docs agree on the CLI shape:

```txt
POST /auth/device/code
  -> device_code, user_code, verification_uri_complete, interval, expires_in

POST /auth/device/token
  -> access_token, token_type: "Bearer", expires_in

GET /auth/get-session
  Authorization: Bearer <access_token>
  -> { user, session, encryptionKeys }
```

Better Auth's device authorization docs describe the plugin as the RFC 8628 flow for CLI apps and show polling `device.token()` until `data.access_token` exists. The bearer docs show that bearer tokens can authenticate `auth.api.getSession({ headers })`.

Implication: `pollDeviceToken()` is a remote Better Auth operation. It is not local storage. The returned `access_token` is itself a bearer credential, not a one-use bootstrap token for `getSession()`. It should initialize the local `bearerToken`, then `getSession()` should fetch the JSON-safe session snapshot and encryption keys.

### Better Auth Bearer Token Handling

Better Auth's bearer plugin uses `Authorization: Bearer <token>` as the non-browser credential path. The docs also show `set-auth-token` as the response header that carries bearer token updates after authenticated requests.

DeepWiki confirms the implementation path:

```txt
request Authorization: Bearer <token>
  -> bearer plugin converts it into Better Auth session context
  -> getSession validates the session normally
  -> response may include set-auth-token
```

Implication: the Node auth layer needs the same field-level token ownership as the browser auth layer. `credential.bearerToken` is the credential source of truth. The response body is the session metadata source of truth. If `set-auth-token` appears, it updates `credential.bearerToken`; it must not overwrite `session.session.token`.

### Better Auth Custom Session Typing

Better Auth's canonical type path is:

```ts
customSession(...)
customSessionClient<typeof auth>()
typeof auth.$Infer.Session
```

The docs also call out a caveat: if server and client code are separated enough that the client cannot import the server `auth` instance as a type, custom session inference will not work directly.

Epicenter is in that second category for published packages and Node helpers. `apps/api` creates Better Auth per request from Cloudflare env, database, and runtime `baseURL`. The CLI and workspace node helpers should not import that runtime auth factory.

Implication: use Better Auth inference where the Better Auth client is local enough to use it, but define a portable contract for the cross-package HTTP response. The contract should be Better Auth-shaped, not a new auth model. It is still a lossy, versioned DTO compared with `auth.$Infer.Session`; it will not automatically track Better Auth plugin fields, `additionalFields`, or future changes to the `customSession()` return shape.

### DeepWiki Grill Corrections

The grill prompts changed the spec in five places:

1. **Bearer token ownership**: do not store only `getSession().session.token`. Store a dedicated `bearerToken`, initialized from `/device/token.access_token` and refreshed from `set-auth-token`.
2. **Device token semantics**: the device `access_token` is the bearer credential for any request that accepts `Authorization: Bearer <token>`. It is not limited to the first `getSession()` call.
3. **Custom session contract**: `Session` is an Epicenter serialized snapshot produced by `customSession()`, not a Better Auth guarantee. It must be runtime-validated and kept in sync with the server callback.
4. **Base URL boundary**: cache by concrete server origin. Keep `basePath: "/auth"` as endpoint construction config, reject path/search/hash in the cache key, and treat `ws`/`wss` mapping as Epicenter sync convenience, not Better Auth behavior.
5. **Local storage threat model**: a plain owner-only JSON file is an Epicenter v1 tradeoff. Better Auth's default security posture is cookie-first, and its platform integrations point toward secure storage where available. The spec must name the risk of co-locating bearer tokens and encryption keys.

### Current Dependency Boundaries

The current dependency graph blocks the easy answer:

```txt
apps/api
  depends on @epicenter/workspace

@epicenter/workspace
  currently exports createSessionStore()
  cannot import apps/api types without a cycle

@epicenter/auth
  currently imports @epicenter/api/types
  wraps better-auth/client for browser and extension consumers

@epicenter/cli
  is the published CLI package
  currently depends on @epicenter/workspace
```

The current `@epicenter/auth -> @epicenter/api/types` direction is backwards for a shared auth contract. The API should implement the contract, not own the contract.

Implication: move portable auth contracts out of `apps/api`. Put them in `@epicenter/auth/contracts` first. Split them into a smaller package only if publishing `@epicenter/auth` creates a real package boundary problem.

### CLI Credential Storage Research

Peer CLIs split between two patterns:

| Tool family | Normal storage shape | Takeaway |
| --- | --- | --- |
| GitHub CLI and Git Credential Manager | System keychain when available, explicit plaintext fallback | Best interactive default. Do not silently downgrade secure storage. |
| AWS, gcloud, npm, Stripe, Wrangler, Supabase, Vercel | Plain config files with owner-only permissions | Most scriptable default. Works in CI, Docker, WSL, and headless hosts. |
| Docker credential helpers | External helper or OS keychain | Good model for separable secret backends, but heavier than this migration needs. |

The Epicenter wrinkle is encryption. A bearer token can authenticate to `/auth/get-session`, and that response includes `encryptionKeys`. That means moving only `encryptionKeys` to the OS keychain while leaving `bearerToken` in plaintext is misleading: a stolen bearer token can fetch the keys again while the session is valid.

Implication: secure storage must move `bearerToken`, `session.session.token`, and `encryptionKeys`, or it must be described as plaintext file storage. There is no useful middle ground where only encryption keys move to the keychain.

## Design Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Owner | `@epicenter/auth`, not `@epicenter/workspace` | Auth contracts and credentials are auth concerns. Workspace should consume key and token providers, not define auth cache formats. |
| Shared data noun | `Session` | Browser and CLI both receive the same Better Auth-shaped `{ user, session, encryptionKeys }` response. |
| Browser holder | `AuthClient` | The browser needs a synchronous in-memory snapshot and subscriptions for UI and sync. |
| Node holder | `CredentialStore` | Node needs async persistence for one or more server origins. It does not need reactive reads. |
| Local artifact name | Credential store | The store persists credentials for this OS user. It is not the canonical Better Auth session store. |
| Remote client name | `createAuthServerClient` | The client talks to a Better Auth server. It does not read local state. |
| Local store name | `createCredentialStore` | The store reads and writes cached credentials. It does not poll device tokens or fetch sessions. |
| Composition API | `createCliAuth({ authServerClient, credentialStore }, options)` | Device login, status, and logout compose remote auth and local cache without hiding either dependency. |
| Bearer token field | `bearerToken` | The bearer credential may be the device `access_token` or a `set-auth-token` value. Do not collapse it into `session.session.token`. |
| Better Auth token field | `session.session.token` | Keep the raw Better Auth session token in the resolved runtime session for fidelity, but do not use it as the cache's canonical bearer slot. |
| Expiry field | `session.session.expiresAt` | Better Auth owns expiry. Do not duplicate `expiresAt` from device token metadata. |
| User field | Required on current writes | Authenticated `getSession()` returns `user`. |
| Server cache key | Normalized origin string | Cache key normalization is an app boundary. It should parse to `URL.origin`, reject path/search/hash, and optionally map `ws/wss` to `http/https` for sync callers. |
| Default selection | `currentServerOrigin` plus `lastUsedAt` fallback | Do not rely on object insertion order. |
| Secret storage | `file` or `osKeychain` | File mode is portable and scriptable. Keychain mode stores both bearer token and encryption keys outside the JSON file. |
| Token rotation | Update `bearerToken` from `set-auth-token` when present | Mirrors Better Auth bearer semantics and the existing browser auth client behavior. |
| JSON safety | Store ISO strings | Raw HTTP JSON stores strings. Do not type raw JSON as Better Auth `Date` objects. |
| Old cache policy | Clean break | The credential store reads only `credentials.json` v1. Old workspace auth files are unsupported state. |

## Architecture

### Before

```txt
packages/cli/src/commands/auth.ts
  ├─ createAuthApi(serverUrl)
  │    ├─ requestDeviceCode()
  │    ├─ pollDeviceToken()
  │    └─ getSession()
  │
  └─ @epicenter/workspace/node createSessionStore()
       └─ env-paths('epicenter').data/auth/<host>.json
            { [normalizedServer]: {
              accessToken,
              expiresAt,
              encryptionKeys,
              user?
            } }
```

The CLI owns the flow and workspace owns the cache type.

### After

```txt
@epicenter/auth/contracts
  ├─ StoredBetterAuthUser
  ├─ StoredBetterAuthSession
  ├─ Session
  └─ normalizeSessionResponse()

@epicenter/auth/node
  ├─ createAuthServerClient({ fetch }, { serverOrigin })
  │    ├─ requestDeviceCode()
  │    ├─ pollDeviceToken()
  │    ├─ getSession(token)
  │    └─ signOut(token)
  │
  ├─ createCredentialStore({ file, clock })
  │    ├─ save(serverOrigin, { bearerToken, session })
  │    ├─ get(serverOrigin)
  │    ├─ getCurrent()
  │    ├─ getBearerToken(serverOrigin)
  │    ├─ getEncryptionKeys(serverOrigin)
  │    ├─ getOfflineEncryptionKeys(serverOrigin)
  │    └─ clear(serverOrigin)
  │
  └─ createCliAuth({ authServerClient, credentialStore }, { clientId })
       ├─ loginWithDeviceCode()
       ├─ status()
       └─ logout()

packages/cli
  └─ thin command wrapper over createCliAuth()

@epicenter/workspace/node
  └─ consumes getToken/getEncryptionKeys helpers, or temporarily re-exports shims
```

### Login Flow

```txt
1. Normalize server input
   "https://api.epicenter.so/" -> "https://api.epicenter.so"

2. Request device code
   authServerClient.requestDeviceCode({ clientId: "epicenter-cli" })

3. Poll device token
   authServerClient.pollDeviceToken({ deviceCode, clientId })
   handles authorization_pending, slow_down, access_denied, expired_token

4. Fetch Better Auth session
   authServerClient.getSession({ token: tokenData.access_token })
   Authorization: Bearer <access_token>

5. Normalize response for disk
   normalizeSessionResponse(response)
   Date objects or ISO strings become ISO strings

6. Choose bearer credential
   bearerToken = set-auth-token ?? tokenData.access_token

7. Save credential
   credentialStore.save(serverOrigin, { bearerToken, session: storedSession })
```

### Status Flow

```txt
1. Load credential by server origin, or current credential
2. If no credential, return "not logged in"
3. If credential is expired, return stored identity plus "expired"
4. Try authServerClient.getSession({ token: credential.bearerToken })
5. If remote succeeds, refresh cache from the returned Better Auth session and any `set-auth-token` header
6. If remote fails, return stored identity plus "unverified"
```

### Logout Flow

```txt
1. Load credential by server origin, or current credential
2. If none, return "not logged in"
3. Best-effort authServerClient.signOut({ token: credential.bearerToken })
4. Always clear local credential
```

## Target Contracts

### Portable Session Contract

This contract should live outside `apps/api` so the API, browser auth, CLI, and node helpers all import the same shape.

The in-process server response remains Better Auth-shaped:

```ts
import type {
	Session as BetterAuthSession,
	User as BetterAuthUser,
} from 'better-auth';
import type { EncryptionKeys } from '@epicenter/workspace/encryption-key';

export type SessionResponse = {
	user: BetterAuthUser;
	session: BetterAuthSession;
	encryptionKeys: EncryptionKeys;
};
```

The portable `Session` contract is the JSON-safe version of that response:

```ts
import { EncryptionKeys } from '@epicenter/workspace/encryption-key';
import { type } from 'arktype';

export const StoredBetterAuthUser = type({
	id: 'string',
	name: 'string',
	email: 'string',
	emailVerified: 'boolean',
	'image?': 'string | null | undefined',
	createdAt: 'string',
	updatedAt: 'string',
});

export const StoredBetterAuthSession = type({
	id: 'string',
	token: 'string',
	userId: 'string',
	expiresAt: 'string',
	createdAt: 'string',
	updatedAt: 'string',
	'ipAddress?': 'string | null | undefined',
	'userAgent?': 'string | null | undefined',
});

export const Session = type({
	user: StoredBetterAuthUser,
	session: StoredBetterAuthSession,
	encryptionKeys: EncryptionKeys,
});
```

The runtime normalizer should accept the in-process Better Auth response and the raw JSON response:

```ts
export function normalizeSessionResponse(
	response: unknown,
): Session {
	const parsed = RawSessionResponse.assert(response);

	return Session.assert({
		user: normalizeUserForStorage(parsed.user),
		session: normalizeSessionForStorage(parsed.session),
		encryptionKeys: parsed.encryptionKeys,
	});
}
```

The API `customSession()` should return `SessionResponse`. `CredentialStore.save()` accepts a full `Session`. Do not force the server callback to stringify Better Auth `Date` fields just to satisfy disk persistence. Do not use this normalizer to inject bearer-token rotation into `session.session.token`; token rotation belongs to `Credential.bearerToken`.

Do not expose a public `__brand` type for server origins. The parser is the boundary:

```ts
export function normalizeServerOrigin(input: string | URL): string {
	const raw = String(input)
		.replace(/^wss:/, 'https:')
		.replace(/^ws:/, 'http:');
	const url = new URL(raw);

	if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
		throw new Error('Expected a server origin like https://api.epicenter.so.');
	}

	return url.origin;
}
```

### Credential File

The public store returns a resolved `Credential` with secrets loaded:

```ts
export const Credential = type({
	serverOrigin: 'string',
	bearerToken: 'string',
	session: Session,
	savedAt: 'string',
	lastUsedAt: 'string',
});
```

The JSON file stores metadata plus either inline secrets or keychain references. In keychain mode, it must not contain any bearer-equivalent secret:

```ts
export const StoredBetterAuthSessionMetadata = type({
	id: 'string',
	userId: 'string',
	expiresAt: 'string',
	createdAt: 'string',
	updatedAt: 'string',
	'ipAddress?': 'string | null | undefined',
	'userAgent?': 'string | null | undefined',
});

export const CredentialSession = type({
	user: StoredBetterAuthUser,
	session: StoredBetterAuthSessionMetadata,
});

export const InlineCredentialSecrets = type({
	storage: "'file'",
	bearerToken: 'string',
	sessionToken: 'string',
	encryptionKeys: EncryptionKeys,
});

export const CredentialSecretRef = type({
	service: 'string',
	account: 'string',
});
export type CredentialSecretRef = typeof CredentialSecretRef.infer;

export const KeychainCredentialSecrets = type({
	storage: "'osKeychain'",
	bearerTokenRef: CredentialSecretRef,
	sessionTokenRef: CredentialSecretRef,
	encryptionKeysRef: CredentialSecretRef,
});

export const CredentialSecrets =
	InlineCredentialSecrets.or(KeychainCredentialSecrets);

export const CredentialFileEntry = type({
	serverOrigin: 'string',
	session: CredentialSession,
	secrets: CredentialSecrets,
	savedAt: 'string',
	lastUsedAt: 'string',
});

export const CredentialFile = type({
	version: "'epicenter.auth.credentialStore.v1'",
	'currentServerOrigin?': 'string | null | undefined',
	credentials: CredentialFileEntry.array(),
});
```

The array shape makes metadata explicit and avoids relying on record insertion order. The store can still index it internally by `serverOrigin`. In file mode, the JSON file contains all credential material. In keychain mode, the JSON file contains only references and non-secret session metadata.

`CredentialStore.save()` accepts a full runtime `Session`, strips `session.session.token` before writing metadata, and stores that token through the same secret path as the bearer token. `CredentialStore.get()` resolves the secrets and reconstructs the full runtime `Credential`.

### Secret Storage Strategy

Use a small secret-store interface under the credential store. The file parser should not know whether a secret is inline or in the OS keychain:

```ts
export type CredentialSecretStore = {
	kind: 'file' | 'osKeychain';
	isAvailable(): Promise<boolean>;
	selfTest(): Promise<void>;
	save(ref: CredentialSecretRef, value: string): Promise<void>;
	load(ref: CredentialSecretRef): Promise<string | null>;
	delete(ref: CredentialSecretRef): Promise<void>;
};
```

File mode keeps `bearerToken`, `sessionToken`, and `encryptionKeys` inline in `CredentialFileEntry.secrets`. Keychain mode stores all three secrets through the secret store and writes only references:

```ts
const bearerTokenRef = {
	service: 'epicenter.auth.bearerToken',
	account: `${serverOrigin}:${session.user.id}`,
};

const sessionTokenRef = {
	service: 'epicenter.auth.sessionToken',
	account: `${serverOrigin}:${session.user.id}`,
};

const encryptionKeysRef = {
	service: 'epicenter.auth.encryptionKeys',
	account: `${serverOrigin}:${session.user.id}`,
};

await secrets.save(bearerTokenRef, bearerToken);
await secrets.save(sessionTokenRef, session.session.token);
await secrets.save(encryptionKeysRef, JSON.stringify(session.encryptionKeys));
```

The keychain implementation should use `@napi-rs/keyring` behind this interface. Import it dynamically inside `@epicenter/auth/node` only, so browser bundles never touch the native package:

```ts
export function createKeychainSecretStore(): CredentialSecretStore {
	return {
		kind: 'osKeychain',
		async isAvailable() {
			const { Entry } = await import('@napi-rs/keyring');
			return typeof Entry === 'function';
		},
		async selfTest() {
			const { Entry } = await import('@napi-rs/keyring');
			const ref = {
				service: 'epicenter.auth.selfTest',
				account: crypto.randomUUID(),
			};
			const entry = new Entry(ref.service, ref.account);
			entry.setPassword('ok');
			const value = entry.getPassword();
			entry.deletePassword();
			if (value !== 'ok') throw new Error('OS keychain self-test failed.');
		},
		async save(ref, value) {
			const { Entry } = await import('@napi-rs/keyring');
			const entry = new Entry(ref.service, ref.account);
			entry.setPassword(value);
		},
		async load(ref) {
			const { Entry } = await import('@napi-rs/keyring');
			const entry = new Entry(ref.service, ref.account);
			return entry.getPassword();
		},
		async delete(ref) {
			const { Entry } = await import('@napi-rs/keyring');
			const entry = new Entry(ref.service, ref.account);
			entry.deletePassword();
		},
	};
}
```

`@napi-rs/keyring` is a Node-API native package. Bun supports Node-API, but native packages still need a smoke test in this repository. Add a Bun-only test that dynamically imports `@napi-rs/keyring` and creates an `Entry`; keep real keychain writes behind an integration test or a manual test because CI hosts often lack an unlocked keychain or Linux Secret Service.

Interactive CLI behavior should be fail-closed when secure storage was requested:

1. If `--secure-storage` is passed and keychain access fails, do not write secrets to the file. Return an error that names the keychain failure and suggests `--insecure-storage`.
2. If `--insecure-storage` is passed, write inline secrets with `0600` file mode and print a short warning.
3. If neither flag is passed, the default may be `auto`: try keychain first for local interactive login, then require explicit confirmation before falling back to file mode. Non-interactive callers should pass their desired mode directly.

Do not advertise keychain mode as protection from a malicious local process. It mainly protects against accidental file disclosure, backups, support bundles, and casual inspection. A process running as the same OS user can usually ask the OS keychain for the same item. That is still better than putting all secrets in a JSON file, but it is not a sandbox.

### Factory Functions

Core factories follow the two-argument dependency pattern:

```ts
export function createAuthServerClient(
	{ fetch }: { fetch: typeof globalThis.fetch },
	{ serverOrigin }: { serverOrigin: string },
) {
	return {
		requestDeviceCode,
		pollDeviceToken,
		getSession,
		signOut,
	};
}

export function createCredentialStore(
	{
		file,
		clock,
		secrets,
	}: {
		file: JsonFile;
		clock: Clock;
		secrets: CredentialSecretStore;
	},
) {
	return {
		save,
		get,
		getCurrent,
		getBearerToken,
		getEncryptionKeys,
		getOfflineEncryptionKeys,
		clear,
	};
}

export function createCliAuth(
	{
		authServerClient,
		credentialStore,
		openBrowser,
	}: {
		authServerClient: AuthServerClient;
		credentialStore: CredentialStore;
		openBrowser?: (url: string) => Promise<void>;
	},
	{ clientId = 'epicenter-cli' }: { clientId?: string } = {},
) {
	return {
		loginWithDeviceCode,
		status,
		logout,
	};
}
```

Default factories can wire normal paths without creating a global singleton:

```ts
export function createDefaultCredentialStore({
	path = epicenterPaths.authCredentials(),
	storageMode = 'auto',
}: {
	path?: string;
	storageMode?: 'file' | 'osKeychain';
} = {}) {
	return createCredentialStore({
		file: createBunJsonFile({ path, mode: 0o600 }),
		clock: systemClock,
		secrets: createDefaultCredentialSecretStore({ storageMode }),
	});
}
```

The default machine-auth path now follows the top-level path cleanup rule:

```txt
env-paths('epicenter').data/auth/<host>.json
```

Every normal Node consumer derives the file from the API host by default. Tests and custom daemon hosts pass a different path. The old `$EPICENTER_HOME/auth/sessions.json` file is no longer read by the credential store, and new code must not reintroduce `EPICENTER_HOME`.

### Token And Key Reads

Token reads and key reads have different expiry policies:

| Method | Expired credential behavior | Intended caller |
| --- | --- | --- |
| `getBearerToken(serverOrigin?)` | returns `null` | network and sync |
| `getEncryptionKeys(serverOrigin?)` | returns `null` | online flows that should require a valid session |
| `getOfflineEncryptionKeys(serverOrigin?)` | may return stored keys after expiry | explicit offline decrypt flows |

Do not make expired key use the default. Offline decrypt is a separate capability because encrypted local data may still need to be readable when the server is offline or a token has expired, but that policy should be visible at the call site.

## API Naming

Avoid `createAuthApi()` for the new layer. It hides whether the object is remote, local, or both.

| Name | Meaning |
| --- | --- |
| `createAuthServerClient` | Stateless HTTP client for Better Auth endpoints on one server origin |
| `createCredentialStore` | Local credential file store |
| `createCliAuth` | Workflow service that composes remote auth plus local credentials |
| `Session` | JSON-safe Better Auth `getSession()` response with Epicenter `encryptionKeys` |
| `Credential` | One cached bearer credential and session snapshot for one server origin |

## Implementation Plan

### Phase 1: Move Portable Contracts

- [x] **1.1** Create `packages/auth/src/contracts/session.ts` with `StoredBetterAuthUser`, `StoredBetterAuthSession`, `Session`, `SessionResponse`, and normalizers.
- [x] **1.2** Move `SessionResponse` ownership out of `apps/api/src/auth/contracts/get-session.ts`.
- [x] **1.3** Update `apps/api/src/auth/create-auth.ts` so `customSession()` returns a value that satisfies `SessionResponse`.
- [x] **1.4** Update `packages/auth/src/create-auth.ts` to import the contract from `@epicenter/auth/contracts`, not `@epicenter/api/types`.
- [x] **1.5** Add a runtime validation test that compares the portable contract against a Better Auth-shaped response so manual DTO drift is caught.
- [x] **1.6** Publish `@epicenter/auth/contracts` as the first shared boundary. Split to `@epicenter/auth-contracts` only if the CLI package cannot depend on `@epicenter/auth`.

### Phase 2: Build the Node Auth Layer

- [x] **2.1** Add `packages/auth/src/node/server-origin.ts` with `normalizeServerOrigin()`.
- [x] **2.2** Add `packages/auth/src/node/auth-server-client.ts` for `/auth/device/code`, `/auth/device/token`, `/auth/get-session`, and `/auth/sign-out`.
- [x] **2.3** Add `packages/auth/src/node/credential-secret-store.ts` with file and keychain implementations behind `CredentialSecretStore`.
- [x] **2.4** Add `packages/auth/src/node/credential-store.ts` with explicit `bearerToken`, versioned `credentials.json` parsing, atomic writes, owner-only file mode, and secret reference resolution.
- [x] **2.5** Add `packages/auth/src/node/cli-auth.ts` to compose device login, status, and logout.
- [x] **2.6** Export the Node surface from `@epicenter/auth/node`.
- [x] **2.7** Add a Bun smoke test for dynamic import of `@napi-rs/keyring`; keep actual keychain writes in an opt-in integration test.

### Phase 3: Switch CLI Commands

- [x] **3.1** Replace `packages/cli/src/auth/api.ts` with `@epicenter/auth/node` usage, or delete it if no longer needed.
- [x] **3.2** Update `packages/cli/src/commands/auth.ts` to call `cliAuth.loginWithDeviceCode()`, `cliAuth.status()`, and `cliAuth.logout()`.
- [x] **3.3** Keep CLI output behavior equivalent except for better stored user names from the full Better Auth user.
- [x] **3.4** Add `--secure-storage` and `--insecure-storage` flags. If secure storage is requested and unavailable, fail without writing plaintext secrets.
- [x] **3.5** Add tests for device polling control flow, dedicated bearer-token persistence, `set-auth-token` updates, and secure-storage fallback behavior using fake `fetch` and fake `CredentialSecretStore`.

### Phase 4: Move Workspace Node Consumers

- [x] **4.1** Replace `createSessionTokenGetter()` with a credential-backed token getter from `@epicenter/auth/node`.
- [x] **4.2** Replace `attachSessionUnlock()` with direct `CredentialStore.getEncryptionKeys()` calls at Node peer boundaries.
- [x] **4.3** Update Fuji script snapshot code to read encryption keys from the new credential store.
- [x] **4.4** Remove temporary deprecated re-exports from `@epicenter/workspace/node`.

### Phase 5: Remove the Old Store

- [x] **5.1** Delete `packages/workspace/src/client/session-store.ts` after all call sites move.
- [x] **5.2** Remove `AuthSession`, `SaveSessionData`, and `SessionStore` exports from `@epicenter/workspace/node`.
- [x] **5.3** Remove `packages/cli/src/auth/api.ts` if the new auth server client replaces it.
- [x] **5.4** Update live docs and current specs that mention `createSessionStore()`. Older completed specs keep historical references.

## Invariants

1. Only save a credential after Better Auth `getSession()` succeeds.
2. The saved bearer token is `credential.bearerToken`.
3. If a response includes `set-auth-token`, store that value as `credential.bearerToken`.
4. The saved current-format credential always has `user`, `session`, and `encryptionKeys`.
5. The credential file key is a normalized server origin.
6. `getBearerToken()` returns `null` for missing or expired credentials.
7. `getEncryptionKeys()` returns `null` for expired credentials. `getOfflineEncryptionKeys()` is the explicit opt-in for offline decrypt flows.
8. Logout clears local credentials even if remote sign-out fails.
9. Default credential selection uses `currentServerOrigin` or `lastUsedAt`, never object insertion order.
10. The credential file is written atomically and with owner-only permissions where the OS supports it.
11. If secure storage is enabled, `bearerToken`, `session.session.token`, and `encryptionKeys` are stored outside the JSON file.
12. If secure storage is requested and unavailable, the store fails closed. Plaintext fallback requires explicit file mode.
13. Legacy cache parsing is read-only. Any successful write emits the new versioned format.

## Threat Model

The local credential store protects against common local mistakes, not a fully compromised user account.

| Threat | File mode | Keychain mode |
| --- | --- | --- |
| Another Unix user reads the file | Protected by `0600` if the filesystem honors it | Protected by `0600` metadata plus keychain access control |
| Credential file is copied into a support bundle or dotfiles repo | Bearer token and encryption keys leak | Only metadata and keychain references leak |
| Laptop backup includes the env-paths data directory | Bearer token and encryption keys are in the backup | Secrets stay in OS credential storage if the backup excludes keychain material |
| Malicious process running as the same OS user | Compromised | Usually compromised too, because the process can ask the keychain for the same item |
| Bearer token leaks while valid | Account access leaks, and `/auth/get-session` can expose encryption keys | Same unless the bearer token is also in keychain |

The last row is why keychain mode stores `bearerToken`, `session.session.token`, and `encryptionKeys`. Storing only encryption keys in the keychain is a false boundary when a bearer-equivalent token can fetch those keys from the server.

File mode is still useful. It is scriptable, works in CI and containers, and matches common CLI practice. It must be named honestly: plaintext credential storage with owner-only permissions.

## Edge Cases

### Server URL With Path

Input:

```txt
https://api.epicenter.so/auth
```

Expected result: reject it. The credential cache keys by server origin, and the auth base path is a Better Auth client option, not part of the server identity.

### WebSocket URL From Sync Config

Input:

```txt
wss://api.epicenter.so
```

Expected result:

```txt
https://api.epicenter.so
```

This is application cache-key normalization. It does not imply Better Auth accepts a WebSocket URL.

### Token Rotates During Status

1. Stored credential has `bearerToken: "old"`.
2. `status()` calls `getSession()` with `Authorization: Bearer old`.
3. Server returns valid session and `set-auth-token: new`.
4. Store updates `credential.bearerToken` to `new`.

Expected result: subsequent requests use `new`.

### Remote Server Unreachable

1. Stored credential exists.
2. `status()` cannot reach the remote server.

Expected result: return stored user plus an unverified status. Do not delete credentials just because the network failed.

### Expired Stored Session

1. Stored `session.expiresAt` is in the past.

Expected result: token getter returns `null`. Status can still show stored identity as expired. Encryption key access is an explicit policy decision covered in Open Questions.

### Keychain Unavailable During Login

1. User runs `epicenter auth login --secure-storage`.
2. `@napi-rs/keyring` imports successfully, but the OS keychain is unavailable, locked, or missing a Linux Secret Service backend.

Expected result: login fails before writing credential secrets. The command prints the storage error and suggests rerunning with `--insecure-storage` if plaintext file storage is acceptable.

### Keychain Entry Missing After Metadata Exists

1. `credentials.json` has a `CredentialFileEntry` with `storage: "osKeychain"`.
2. The referenced bearer token or encryption keys are missing from the OS keychain.

Expected result: `getBearerToken()` returns `null`, `getEncryptionKeys()` returns `null`, and `status()` reports a local credential metadata record with missing secrets. Do not silently rewrite the file into plaintext mode.

### Secure Storage Migration From Legacy File

1. Legacy file contains plaintext `accessToken` and `encryptionKeys`.
2. `status()` verifies the credential with the server.
3. Secure storage is available.

Expected result: the rewrite stores bearer token, session token, and encryption keys in the keychain and writes only metadata plus secret references to `credentials.json`.

### Legacy Cache File

Input:

```json
{
	"https://api.epicenter.so": {
		"accessToken": "token",
		"expiresAt": 1770000000000,
		"encryptionKeys": [{ "version": 1, "userKeyBase64": "..." }],
		"user": { "id": "user-1", "email": "user@example.com" }
	}
}
```

Expected result: parser can load enough to preserve login for one release. Legacy `accessToken` becomes the in-memory `bearerToken`, and the next successful remote verification writes the new format.

## Open Questions

1. **Should `@epicenter/auth` become a published package?**
   - Option A: publish `@epicenter/auth` and let `@epicenter/cli` depend on `@epicenter/auth/node`.
   - Option B: create `@epicenter/auth-contracts` plus `@epicenter/auth-node`.
   - Option C: keep node auth in `@epicenter/workspace/node` but import shared contracts from a new package.
   - Recommendation: Option A if package publishing is acceptable. Option B if `@epicenter/auth` must stay app-private.

2. **Should expired credentials still expose encryption keys offline?**
   - Token usage must stop after expiry.
   - Offline script reads may still need cached keys to decrypt local logs.
   - Recommendation: keep `getBearerToken()` and `getEncryptionKeys()` strict. Use `getOfflineEncryptionKeys()` only at call sites that intentionally support offline decrypt after expiry.

3. **Should the remote auth client use Better Auth's `createAuthClient()` or raw fetch?**
   - Better Auth client plus `deviceAuthorizationClient()` is the docs-aligned path for standard device flow.
   - Better Auth client can expose `set-auth-token` through `fetchOptions.onSuccess`, and it preserves device polling errors.
   - Raw fetch is still defensible if the CLI package wants a standalone wire client with explicit runtime JSON validation and no dependency on Better Auth client inference.
   - Recommendation: prefer `createAuthClient()` for the standard device flow unless implementation shows the runtime validation boundary is worth the raw-fetch client. Do not justify raw fetch by claiming Better Auth hides polling errors or headers.

4. **Should browser auth store full `Session` too?**
   - Today browser auth stores `{ token, user, encryptionKeys }`.
   - Full session storage would make browser and CLI session data closer.
   - Recommendation: defer. Fix the node cache first. Browser auth already uses Better Auth client inference and has a smaller persisted shape for UI needs.

5. **Should `auto` mode become the CLI default immediately?**
   - Decision: no `auto` mode for the clean break.
   - Default interactive login uses `osKeychain` and fails closed.
   - `--insecure-storage` is the explicit plaintext file mode.
   - Existing `sessions.json` files are unsupported state and are not migration input.

## DeepWiki Grill Prompts

Use these prompts before implementation. The goal is to challenge the spec, not to confirm it.

### Prompt 1: Device Flow and Bearer Semantics

```txt
Repository: better-auth/better-auth

We are designing a Node CLI credential cache for an app that uses Better Auth with deviceAuthorization(), bearer(), and customSession(). The CLI calls /auth/device/code, polls /auth/device/token, then calls /auth/get-session with Authorization: Bearer <access_token>.

Please challenge this spec:
- The credential cache stores getSession().session.token as the only bearer token.
- The device token access_token is used only to fetch getSession().
- If a response includes set-auth-token, the cache overwrites session.token with that header value.
- The cache stores a JSON-safe copy of { user, session, encryptionKeys }.

Are any of these assumptions wrong for Better Auth 1.5.x? Point to the source files or docs sections that prove the answer.
```

### Prompt 2: Custom Session Type Source of Truth

```txt
Repository: better-auth/better-auth

We use customSession() on the server to append encryptionKeys to the getSession/useSession response. Browser clients can use createAuthClient plus customSessionClient<typeof auth>() when the auth type is importable. Our published CLI cannot import the Cloudflare runtime auth instance, so the spec proposes a portable JSON contract named Session.

Please challenge this design:
- Is a portable JSON contract the right fallback when customSessionClient<typeof auth>() is not practical?
- What type information do we lose compared with auth.$Infer.Session?
- What caveats should the spec include about Date fields, plugin fields, cookie cache, secondary storage, and customSession execution?
```

### Prompt 3: Better Auth Base URL Boundary

```txt
Repository: better-auth/better-auth

The spec distinguishes Better Auth baseURL/basePath from our application's credential cache key. The cache accepts only a server origin like https://api.epicenter.so, rejects path/search/hash, and optionally maps wss/ws to https/http before storing credentials.

Please challenge this:
- Does Better Auth client or server normalize baseURL in ways we should mirror?
- Is rejecting paths correct when the server uses basePath: "/auth"?
- How should dynamic baseURL or allowedHosts affect a CLI credential cache?
```

### Prompt 4: Raw Fetch Versus Better Auth Client

```txt
Repository: better-auth/better-auth

The spec currently recommends a raw-fetch Node client for the CLI endpoints instead of Better Auth createAuthClient() with deviceAuthorizationClient(). The reason is explicit control over polling errors, JSON validation, and set-auth-token persistence.

Please challenge this:
- Would createAuthClient() be safer or more future-proof for deviceAuthorization()?
- Can createAuthClient() expose set-auth-token reliably through fetchOptions.onSuccess?
- Can it type customSession fields without importing the runtime auth instance?
- Which approach best follows Better Auth internals and docs?
```

### Prompt 5: Security and Local Storage

```txt
Repository: better-auth/better-auth

The spec stores credential metadata under `env-paths('epicenter').data/auth/<host>.json`. In file mode, bearer token, Better Auth session token, and Epicenter encryption keys are inline with owner-only permissions and atomic writes. In keychain mode, those secrets move to OS credential storage and the JSON file contains only references.

Please challenge this from Better Auth's threat model:
- Are bearer tokens expected to be stored by CLI clients?
- What does Better Auth recommend for local token storage?
- Does set-auth-token rotation change local storage requirements?
- Are there Better Auth features we should use instead of storing session.token directly?
- Is moving only encryption keys to keychain unsafe if bearer tokens can fetch keys?
```

## Implementation Handoff Prompt

Use this after the grill prompts have been answered and the spec has been updated.

```txt
Implement specs/20260501T005500-machine-auth-credential-cache.md.

Goal: move Node and CLI auth persistence from @epicenter/workspace/node createSessionStore() to a Better Auth-backed credential store under @epicenter/auth/node.

Context:
- Current cache: packages/workspace/src/client/session-store.ts
- Current CLI auth endpoints: packages/cli/src/auth/api.ts
- Current CLI commands: packages/cli/src/commands/auth.ts
- Current browser auth core: packages/auth/src/create-auth.ts
- Current browser auth session types: packages/auth/src/auth-types.ts
- Current API customSession: apps/api/src/auth/create-auth.ts
- Current API session contract: apps/api/src/auth/contracts/get-session.ts
- Encryption key schema: packages/workspace/src/document/encryption-key.ts

Must do:
- Keep Better Auth as the source of truth for session and user fields.
- Store the current bearer credential at Credential.bearerToken in the resolved runtime value.
- Keep session.session.token as part of the Better Auth session snapshot, not as the canonical bearer cache field.
- Initialize bearerToken from /auth/device/token access_token.
- Treat set-auth-token as the immediate bearer rotation signal for bearerToken.
- Store credential metadata at `env-paths('epicenter').data/auth/<host>.json` unless the caller passes a custom path.
- Treat `$EPICENTER_HOME/auth/sessions.json` as unsupported legacy state. Do not read it, and do not add a new `EPICENTER_HOME` fallback.
- In keychain mode, store bearerToken, session.session.token, and encryptionKeys outside the JSON file.
- If secure storage is requested and unavailable, fail closed unless plaintext file storage is explicitly enabled.
- Use factory signatures shaped as createSomething(dependencies, options?).
- Do not preserve legacy cache reads.
- Add focused tests for URL normalization, clean-break credential parsing, token rotation, expired token reads, secure storage fallback, custom session DTO validation, and CLI device polling errors.
- Prefer Better Auth createAuthClient plus deviceAuthorizationClient for standard device flow unless raw fetch earns its keep through explicit runtime JSON validation.

Must not do:
- Do not keep defining AuthSession in packages/workspace/src/client/session-store.ts as a current public type.
- Do not make user optional in the current saved credential format.
- Do not key credentials by raw unparsed URLs.
- Do not rely on object insertion order for the default credential.
- Do not overwrite session.session.token with set-auth-token.
- Do not leave bearer-equivalent secrets in the JSON file when keychain mode is active.
- Do not suppress TypeScript errors.
```

## Success Criteria

- [x] `@epicenter/workspace` no longer owns the current credential cache type.
- [x] `apps/api`, `@epicenter/auth`, and CLI code share one portable Better Auth-shaped session contract.
- [x] CLI login saves a dedicated `bearerToken` plus a full Better Auth session response with required user, session, and encryption keys.
- [x] Token getters read `credential.bearerToken`.
- [x] Expired credentials do not produce bearer tokens.
- [x] Token rotation through `set-auth-token` updates `credential.bearerToken`.
- [x] Keychain mode stores bearer token, Better Auth session token, and encryption keys outside the JSON file.
- [x] Secure storage failures do not silently downgrade to plaintext file storage.
- [x] Server URL cache keys are normalized origins and reject path/search/hash.
- [x] Default session selection uses explicit metadata.
- [x] Old cache files are unsupported and are not read by the credential store.
- [x] Tests cover the new contracts, clean-break credential parsing, token rotation, and secure storage policy.

## References

- `packages/workspace/src/client/session-store.ts`: current credential cache to replace.
- `packages/workspace/src/client/session-token.ts`: current token getter.
- `packages/workspace/src/client/attach-session-unlock.ts`: current encryption key unlock helper.
- `packages/cli/src/auth/api.ts`: current raw Better Auth endpoint client.
- `packages/cli/src/commands/auth.ts`: current CLI login, status, and logout flows.
- `packages/auth/src/create-auth.ts`: existing browser Better Auth client wrapper and token rotation handling.
- `packages/auth/src/auth-types.ts`: existing browser persisted auth shape.
- `apps/api/src/auth/create-auth.ts`: server Better Auth config, bearer plugin, device authorization plugin, and customSession enrichment.
- `apps/api/src/auth/contracts/get-session.ts`: current portable session response contract, currently owned by the API package.
- `packages/workspace/src/document/encryption-key.ts`: encryption key runtime schema used in session responses and local cache parsing.
- Better Auth docs: `https://better-auth.com/docs/plugins/device-authorization`
- Better Auth docs: `https://better-auth.com/docs/plugins/bearer`
- Better Auth docs: `https://better-auth.com/docs/concepts/session-management`
- Bun Node-API docs: `https://bun.sh/docs/api/node-api`
- `@napi-rs/keyring`: `https://github.com/Brooooooklyn/keyring-node`
- GitHub CLI auth storage behavior: `https://cli.github.com/manual/gh_auth_login`
