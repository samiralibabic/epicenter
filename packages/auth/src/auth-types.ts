import { OwnerId } from '@epicenter/constants/identity';
import { Keyring } from '@epicenter/encryption';
import { type } from 'arktype';
import type { Brand } from 'wellcrafted/brand';

/**
 * A signed-in account identifier. Issued by Better Auth, opaque to clients.
 * In personal mode, the bytes happen to equal the owner id; in team mode
 * they do not. The brand prevents accidental cross-assignment.
 *
 * The validator is declared first; the type is derived from it via `.infer`
 * so schema and type stay in lockstep under one PascalCase name. Use
 * {@link UserId} directly inside schemas (`id: UserId`); at trusted call
 * sites that receive a known `string`, brand it with {@link asUserId}.
 */
export const UserId = type('string').as<string & Brand<'UserId'>>();
export type UserId = typeof UserId.infer;
/**
 * Syntactic sugar for `value as UserId`. The function body is a single typed
 * cast; the constrained `string` parameter is what earns it over a raw `as`
 * (callers can't accidentally widen to `unknown`). The only place in the
 * codebase where `as UserId` appears.
 */
export const asUserId = (value: string): UserId => value as UserId;

export const AuthUser = type({
	'+': 'delete',
	id: UserId,
	email: 'string',
});

export type AuthUser = typeof AuthUser.infer;

/**
 * OAuth token grant. Persisted under `PersistedAuth.grant`.
 *
 * Server-access material: required to call `/api/*` online; offline-useless
 * on its own. Refresh tokens rotate on every successful refresh.
 */
export const OAuthTokenGrant = type({
	'+': 'delete',
	accessToken: 'string',
	refreshToken: 'string',
	/**
	 * Absolute access-token expiry as epoch milliseconds.
	 *
	 * Computed from the OAuth `expires_in` seconds returned with the token
	 * grant (`accessTokenExpiresAt = now() + expires_in * 1000`). Used only as
	 * a transport refresh hint: the resource server is still the source of
	 * truth for token validity, so this value is checked locally to decide
	 * when to refresh, never to authorize a request.
	 */
	accessTokenExpiresAt: 'number',
});

export type OAuthTokenGrant = typeof OAuthTokenGrant.infer;

/**
 * The single persisted auth cell.
 *
 * Browser persists to localStorage, extension to chrome.storage.local, CLI
 * to a per-API-target file under the platform data directory (mode 0o600);
 * see {@link machineAuthFilePath}. All three cells validate against this
 * arktype, which satisfies StandardSchemaV1 natively via `~standard`, so it
 * plugs straight into Standard-Schema consumers like createPersistedState.
 * Profile data is intentionally absent; application surfaces fetch it when
 * they display it.
 *
 * `userId`, `ownerId`, and `keyring` are persisted separately from the OAuth
 * grant because they remain useful offline. The grant lets the app call the
 * server; the rest let the app select and decrypt this user's local
 * workspace data.
 *
 * `userId` is stored explicitly (rather than synthesised from `ownerId`) so
 * the daemon can read it directly in team mode, where `ownerId` is the
 * literal `TEAM_OWNER_ID` and is structurally not a `UserId`. The deployment
 * shape itself (personal vs team) is not stored here: it is a property of
 * the server, not of an authenticated cell, and any consumer that needs to
 * branch on it is asking the wrong question. Branch on `ownerId` instead
 * (`ownerId === TEAM_OWNER_ID` for team, `ownerId === userId` for personal).
 */
export const PersistedAuth = type({
	'+': 'delete',
	grant: OAuthTokenGrant,
	userId: UserId,
	ownerId: OwnerId,
	keyring: Keyring,
});

export type PersistedAuth = typeof PersistedAuth.infer;

/**
 * Canonical `/api/session` response shape. The single contract between the
 * API and every Epicenter auth client (browser, extension, CLI machine,
 * daemon).
 *
 * Flat by design: `user` is the Better Auth profile slice displayed in
 * account UI; `ownerId` is the partition key clients use to key local
 * storage and server-side identifiers; `keyring` decrypts local workspace
 * data.
 *
 * `ownerId` and `keyring` are intentionally not nested under an `owner`
 * object: grouping them adds an indirection without earning it, and any
 * future presentational owner facts (display name, avatar, quota) live in
 * dedicated endpoints rather than the session boot manifest.
 *
 * The deployment shape (personal vs team) is not carried on the wire. The
 * server is configured with it at construction, and clients that need to
 * branch derive it from `ownerId === TEAM_OWNER_ID`. Carrying it twice
 * created a consistency burden with no consumer.
 */
export const ApiSessionResponse = type({
	'+': 'delete',
	user: AuthUser,
	ownerId: OwnerId,
	keyring: Keyring,
});

export type ApiSessionResponse = typeof ApiSessionResponse.infer;
