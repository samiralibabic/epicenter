import type { OwnerId } from '@epicenter/constants/identity';
import type { Keyring } from '@epicenter/encryption';
import type { Result } from 'wellcrafted/result';
import type { AuthError } from './auth-errors.js';

/**
 * Current auth state for local-first workspace clients.
 *
 * `ownerId` and `keyring` are present in `signed-in` and `reauth-required`
 * because they belong to local workspace operations. Even when the OAuth
 * grant needs reauth, the cached owner id can still pick the right local
 * storage partition and the keyring can still decrypt local workspace data.
 *
 * Auth state carries capability material only. Profile data is fetched by
 * application surfaces that display it; deployment shape (personal vs team)
 * is derived from `ownerId === TEAM_OWNER_ID` at the rare site that asks.
 */
export type AuthState =
	| { status: 'signed-out' }
	| {
			status: 'signed-in';
			ownerId: OwnerId;
			keyring: Keyring;
	  }
	| {
			status: 'reauth-required';
			ownerId: OwnerId;
			keyring: Keyring;
	  };

export type AuthClient = {
	state: AuthState;
	/**
	 * Origin of the API this client signs into. Exposed so client-side
	 * partitioning (local storage keys, BroadcastChannel names) can scope by
	 * `(server, ownerId)` and stay distinct across two signed-in deployments on
	 * the same machine. Mirrors the `baseURL` passed at construction.
	 */
	baseURL: string;
	/**
	 * Subscribe to future state changes.
	 *
	 * Read `state` once before registering when bootstrap state matters. The
	 * listener does not replay the current state, which keeps subscriptions from
	 * accidentally duplicating synchronous boot logic.
	 */
	onStateChange(fn: (state: AuthState) => void): () => void;
	/**
	 * Start the runtime's sign-in flow.
	 *
	 * Use this from UI or CLI commands that can hand control to the configured
	 * launcher. Completion means the launcher finished its work, not that a page
	 * navigation happened; callers should observe `state` for the durable signed
	 * in signal.
	 */
	startSignIn(): Promise<Result<undefined, AuthError>>;
	/**
	 * Clear local auth and revoke the refresh token when the server is reachable.
	 *
	 * Use this for explicit user logout. The local persisted cell is removed
	 * first, so local workspace access stops depending on whether the best-effort
	 * revoke request succeeds.
	 */
	signOut(): Promise<Result<undefined, AuthError>>;
	/**
	 * Fetch an API resource through the auth-owned bearer boundary.
	 *
	 * Use this instead of reading tokens from storage. The client verifies
	 * `/api/session` before attaching a bearer, refreshes on expiry or 401, and
	 * omits browser cookies so OAuth tokens remain the resource credential.
	 */
	fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
	/**
	 * Open a WebSocket using the same bearer boundary as `fetch`.
	 *
	 * Browsers cannot set `Authorization` on WebSocket upgrades, so the token is
	 * carried as an Epicenter bearer subprotocol and normalized by the API before
	 * protected route code runs.
	 */
	openWebSocket(url: string | URL, protocols?: string[]): Promise<WebSocket>;
	[Symbol.dispose](): void;
};
