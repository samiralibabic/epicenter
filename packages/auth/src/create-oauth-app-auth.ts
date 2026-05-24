import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import { BEARER_SUBPROTOCOL_PREFIX } from '@epicenter/constants/auth';
import { subjectKeyringsEqual } from '@epicenter/encryption';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { AuthClient, AuthState } from './auth-contract.js';
import { AuthError } from './auth-errors.js';
import {
	ApiSessionResponse,
	type OAuthTokenGrant,
	type PersistedAuth as PersistedAuthType,
} from './auth-types.js';
import { parseOAuthTokenGrant } from './oauth-token-response.js';
import { ownerId } from './owner.js';

/**
 * Storage adapter for the single `PersistedAuth` cell (grant + localIdentity).
 * Two methods, no watch hook: cross-context sign-out propagates via the
 * server (next bearer-bearing call hits a revoked token and reauth-requires
 * organically). The server is the authority; brief cross-tab desync is
 * acceptable.
 */
export type PersistedAuthStorage = {
	get(): PersistedAuthType | null;
	set(value: PersistedAuthType | null): void | Promise<void>;
};

export type OAuthSignInLauncher = {
	startSignIn(): Promise<Result<OAuthTokenGrant | null, unknown>>;
};

type AuthFetchInput = Request | string | URL;

export type AuthFetch = (
	input: AuthFetchInput,
	init?: RequestInit,
) => Promise<Response>;

export type CreateOAuthAppAuthConfig = {
	baseURL?: string;
	clientId: string;
	persistedAuthStorage: PersistedAuthStorage;
	launcher: OAuthSignInLauncher;
	fetch?: AuthFetch;
	WebSocket?: typeof WebSocket;
	now?: () => number;
	log?: Logger;
};

const REFRESH_SKEW_MS = 60_000;

const AuthStateChangeError = defineErrors({
	SubscriberThrew: ({ cause }: { cause: unknown }) => ({
		message: `Auth state subscriber threw: ${extractErrorMessage(cause)}`,
		cause,
	}),
});

const ApiSessionRequestError = defineErrors({
	AuthRejected: ({ status }: { status: 401 | 403 }) => ({
		message: `API session rejected the current token with ${status}.`,
		status,
	}),
	Unavailable: ({ cause }: { cause: unknown }) => ({
		message: `Could not verify API session: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
type ApiSessionRequestError = InferErrors<typeof ApiSessionRequestError>;

type NetworkAccess = 'unverified' | 'verified' | 'paused';

type RuntimeAuthState =
	| { status: 'signed-out' }
	| {
			status: 'signed-in';
			persistedAuth: PersistedAuthType;
			networkAccess: NetworkAccess;
	  };

type RefreshFlight = {
	persistedAuth: PersistedAuthType;
	promise: Promise<boolean>;
};

type IdentityVerificationFlight = {
	persistedAuth: PersistedAuthType;
	promise: Promise<ApiSessionRequestResult>;
};

type ApiSessionRequestResult = Result<
	ApiSessionResponse,
	ApiSessionRequestError
>;

/**
 * Create the app-side auth boundary for browser, extension, and machine clients.
 *
 * Use this once per runtime around one persisted auth record. The returned
 * client exposes capabilities (`fetch`, `openWebSocket`) instead of raw tokens:
 * it refreshes grants, verifies `/api/session` before attaching a bearer, and
 * keeps `localIdentity` available when network auth pauses. That preserves the
 * local-first invariant: offline workspace boot can continue, but server access
 * fails closed until the current persisted auth has been verified by the API.
 */
export function createOAuthAppAuth({
	baseURL = EPICENTER_API_URL,
	clientId,
	persistedAuthStorage,
	launcher,
	fetch: fetchImpl = globalThis.fetch.bind(globalThis),
	WebSocket: WebSocketImpl = globalThis.WebSocket,
	now = Date.now,
	log = createLogger('auth/oauth-app'),
}: CreateOAuthAppAuthConfig): AuthClient {
	const authSession = createAuthSessionRuntime({
		initialPersistedAuth: persistedAuthStorage.get(),
		persistedAuthStorage,
		log,
	});
	let refreshFlight: RefreshFlight | null = null;
	let identityVerificationFlight: IdentityVerificationFlight | null = null;
	let signInFlight: Promise<Result<undefined, AuthError>> | null = null;
	let signInGeneration = 0;

	function beginSignInGeneration() {
		signInGeneration += 1;
		return signInGeneration;
	}

	function isCurrentSignIn(generation: number) {
		return signInGeneration === generation;
	}

	function cancelInFlightSignIn() {
		signInGeneration += 1;
		signInFlight = null;
	}

	async function clearAuthSession() {
		refreshFlight = null;
		identityVerificationFlight = null;
		await authSession.clear();
	}

	async function clearPersistedAuth() {
		cancelInFlightSignIn();
		await clearAuthSession();
	}

	async function refreshGrant(force: boolean): Promise<boolean> {
		const startedFrom = authSession.persistedAuth;
		if (startedFrom === null || authSession.networkAuthPaused) return false;
		if (
			!force &&
			startedFrom.grant.accessTokenExpiresAt > now() + REFRESH_SKEW_MS
		) {
			return true;
		}
		if (refreshFlight?.persistedAuth === startedFrom) {
			return refreshFlight.promise;
		}

		const promise = (async () => {
			try {
				const grant = await refreshOAuthTokenWithEndpoint({
					baseURL,
					clientId,
					grant: startedFrom.grant,
					fetch: fetchImpl,
					now,
				});
				if (authSession.persistedAuth !== startedFrom) return false;
				const next: PersistedAuthType = {
					grant,
					owner: startedFrom.owner,
					keyring: startedFrom.keyring,
				};
				await authSession.write(next);
				if (authSession.persistedAuth !== startedFrom) return false;
				authSession.installUnverified(next);
				return true;
			} catch (cause) {
				if (authSession.persistedAuth === startedFrom) {
					authSession.pauseNetworkAuth();
					log.error(AuthError.RefreshGrantFailed({ cause }));
				}
				return false;
			} finally {
				if (refreshFlight?.persistedAuth === startedFrom) {
					refreshFlight = null;
				}
			}
		})();
		refreshFlight = { persistedAuth: startedFrom, promise };

		return promise;
	}

	async function requestApiSession(
		grant: OAuthTokenGrant,
	): Promise<ApiSessionRequestResult> {
		let response: Response;
		try {
			response = await fetchImpl(`${baseURL}/api/session`, {
				headers: { Authorization: `Bearer ${grant.accessToken}` },
				credentials: 'omit',
			});
		} catch (cause) {
			return ApiSessionRequestError.Unavailable({ cause });
		}
		if (!response.ok) {
			if (response.status === 401 || response.status === 403) {
				return ApiSessionRequestError.AuthRejected({ status: response.status });
			}
			return ApiSessionRequestError.Unavailable({
				cause: new Error(`/api/session failed with ${response.status}.`),
			});
		}
		try {
			return Ok(ApiSessionResponse.assert(await response.json()));
		} catch (cause) {
			return ApiSessionRequestError.Unavailable({ cause });
		}
	}

	/**
	 * Verify `/api/session` against the current persisted auth. Marks it
	 * verified; writes localIdentity only when the keyring actually changed.
	 * Wipes storage on same-subject-guard mismatch. Single-flight: concurrent
	 * callers for the same persisted auth share the in-flight promise.
	 */
	async function verifyPersistedAuthForNetwork(
		startedFrom: PersistedAuthType,
	): Promise<ApiSessionRequestResult> {
		if (identityVerificationFlight?.persistedAuth === startedFrom) {
			return identityVerificationFlight.promise;
		}
		const promise = (async (): Promise<ApiSessionRequestResult> => {
			const { data: session, error } = await requestApiSession(
				startedFrom.grant,
			);
			if (error) {
				if (
					error.name === 'AuthRejected' &&
					authSession.persistedAuth === startedFrom
				) {
					authSession.pauseNetworkAuth();
				}
				return Err(error);
			}
			const current = authSession.persistedAuth;
			if (current !== startedFrom) return Ok(session);

			if (ownerId(current.owner) !== ownerId(session.owner)) {
				await clearPersistedAuth();
				return Ok(session);
			}

			if (!subjectKeyringsEqual(current.keyring, session.keyring)) {
				const next: PersistedAuthType = {
					grant: current.grant,
					owner: session.owner,
					keyring: session.keyring,
				};
				await authSession.write(next);
				if (authSession.persistedAuth !== startedFrom) return Ok(session);
				authSession.installVerified(next);
				return Ok(session);
			}
			authSession.installVerified(current);
			return Ok(session);
		})().finally(() => {
			if (identityVerificationFlight?.persistedAuth === startedFrom) {
				identityVerificationFlight = null;
			}
		});
		identityVerificationFlight = { persistedAuth: startedFrom, promise };

		return promise;
	}

	/**
	 * Network gate. Returns the access token to attach to a bearer-bearing
	 * request, or `null` if no bearer should be attached.
	 *
	 * Refuses to attach unless `/api/session` has confirmed the current persisted
	 * auth in this runtime. Cold boot online: refresh grant if
	 * stale, call `/api/session`, then attach. Offline: fails closed; local
	 * workspace decrypt continues via `localIdentity`.
	 */
	async function bearerForNetwork(force: boolean): Promise<string | null> {
		if (authSession.persistedAuth === null || authSession.networkAuthPaused) {
			return null;
		}
		const refreshed = await refreshGrant(force);
		const refreshedPersistedAuth = authSession.persistedAuth;
		if (
			!refreshed ||
			refreshedPersistedAuth === null ||
			authSession.networkAuthPaused
		) {
			return null;
		}
		let verifiedPersistedAuth = authSession.verifiedPersistedAuth;
		if (verifiedPersistedAuth === null) {
			const verification = await verifyPersistedAuthForNetwork(
				refreshedPersistedAuth,
			);
			if (verification.error) return null;
			verifiedPersistedAuth = authSession.verifiedPersistedAuth;
			if (verifiedPersistedAuth === null) return null;
		}
		return verifiedPersistedAuth.grant.accessToken;
	}

	async function fetchWithAuth(
		input: AuthFetchInput,
		init: RequestInit | undefined,
		forceRefresh: boolean,
	) {
		const headers = headersFromRequest(input, init);
		const accessToken = await bearerForNetwork(forceRefresh);
		if (accessToken) {
			headers.set('Authorization', `Bearer ${accessToken}`);
		} else {
			headers.delete('Authorization');
		}
		let normalizedInput: AuthFetchInput = input;
		if (input instanceof Request) {
			normalizedInput = input.clone() as Request;
		} else if (typeof input === 'string' && input.startsWith('/')) {
			normalizedInput = new URL(input, baseURL).toString();
		}
		return fetchImpl(normalizedInput, {
			...init,
			headers,
			credentials: 'omit',
		});
	}

	async function completeSignInWithGrant(
		grant: OAuthTokenGrant,
		generation: number,
	): Promise<Result<undefined, AuthError>> {
		if (!isCurrentSignIn(generation)) return Ok(undefined);
		const previous = authSession.persistedAuth;
		const { data: session, error } = await requestApiSession(grant);
		if (error) {
			return AuthError.StartSignInFailed({ cause: error });
		}
		if (!isCurrentSignIn(generation)) return Ok(undefined);
		if (
			previous !== null &&
			ownerId(previous.owner) !== ownerId(session.owner)
		) {
			await clearAuthSession();
			if (!isCurrentSignIn(generation)) return Ok(undefined);
		}
		const next: PersistedAuthType = {
			grant,
			owner: session.owner,
			keyring: session.keyring,
		};
		await authSession.write(next);
		if (!isCurrentSignIn(generation)) return Ok(undefined);
		authSession.installVerified(next);
		return Ok(undefined);
	}

	return {
		get state() {
			return authSession.state;
		},
		baseURL,
		onStateChange(fn) {
			return authSession.onStateChange(fn);
		},
		async startSignIn() {
			if (signInFlight !== null) return signInFlight;
			const generation = beginSignInGeneration();
			const promise = (async () => {
				try {
					const result = await launcher.startSignIn();
					if (!isCurrentSignIn(generation)) {
						return Ok(undefined);
					}
					if (result.error) {
						return AuthError.StartSignInFailed({ cause: result.error });
					}
					if (result.data === null) return Ok(undefined);
					return completeSignInWithGrant(result.data, generation);
				} catch (cause) {
					if (!isCurrentSignIn(generation)) {
						return Ok(undefined);
					}
					return AuthError.StartSignInFailed({ cause });
				}
			})().finally(() => {
				if (signInFlight === promise) signInFlight = null;
			});
			signInFlight = promise;
			return promise;
		},
		async signOut() {
			try {
				const refreshTokenToRevoke =
					authSession.persistedAuth?.grant.refreshToken;
				await clearPersistedAuth();
				if (refreshTokenToRevoke) {
					void revokeOAuthRefreshTokenWithEndpoint({
						baseURL,
						clientId,
						refreshToken: refreshTokenToRevoke,
						fetch: fetchImpl,
					}).catch(() => undefined);
				}
				return Ok(undefined);
			} catch (cause) {
				return AuthError.SignOutFailed({ cause });
			}
		},
		async fetch(input, init?: RequestInit) {
			const response = await fetchWithAuth(input, init, false);
			if (response.status !== 401) return response;
			const refreshed = await refreshGrant(true);
			if (!refreshed) return response;
			const retryResponse = await fetchWithAuth(input, init, false);
			if (retryResponse.status === 401) {
				authSession.pauseNetworkAuth();
			}
			return retryResponse;
		},
		async openWebSocket(url, protocols = []) {
			const accessToken = await bearerForNetwork(false);
			const authProtocols = accessToken
				? [...protocols, `${BEARER_SUBPROTOCOL_PREFIX}${accessToken}`]
				: protocols;
			return new WebSocketImpl(String(url), authProtocols);
		},
		[Symbol.dispose]() {
			authSession.dispose();
		},
	};
}

function createAuthSessionRuntime({
	initialPersistedAuth,
	persistedAuthStorage,
	log,
}: {
	initialPersistedAuth: PersistedAuthType | null;
	persistedAuthStorage: PersistedAuthStorage;
	log: Logger;
}) {
	let runtimeState: RuntimeAuthState =
		initialPersistedAuth === null
			? { status: 'signed-out' }
			: {
					status: 'signed-in',
					persistedAuth: initialPersistedAuth,
					networkAccess: 'unverified',
				};
	let publicState = publicStateFromRuntime(runtimeState);
	let storageWriteQueue: Promise<void> = Promise.resolve();
	const stateChangeListeners = new Set<(state: AuthState) => void>();

	function publishState() {
		const next = publicStateFromRuntime(runtimeState);
		if (authStatesEqual(publicState, next)) return;
		publicState = next;
		for (const listener of stateChangeListeners) {
			try {
				listener(next);
			} catch (error) {
				log.error(AuthStateChangeError.SubscriberThrew({ cause: error }));
			}
		}
	}

	async function write(value: PersistedAuthType | null) {
		const pendingWrite = storageWriteQueue.then(() =>
			persistedAuthStorage.set(value),
		);
		storageWriteQueue = pendingWrite.catch(() => undefined);
		await pendingWrite;
	}

	return {
		get state() {
			return publicState;
		},
		get persistedAuth(): PersistedAuthType | null {
			return runtimeState.status === 'signed-out'
				? null
				: runtimeState.persistedAuth;
		},
		get networkAuthPaused() {
			return (
				runtimeState.status === 'signed-in' &&
				runtimeState.networkAccess === 'paused'
			);
		},
		get verifiedPersistedAuth(): PersistedAuthType | null {
			if (runtimeState.status === 'signed-out') return null;
			if (runtimeState.networkAccess !== 'verified') return null;
			return runtimeState.persistedAuth;
		},
		onStateChange(fn: (state: AuthState) => void) {
			stateChangeListeners.add(fn);
			return () => {
				stateChangeListeners.delete(fn);
			};
		},
		installUnverified(persistedAuth: PersistedAuthType) {
			runtimeState = {
				status: 'signed-in',
				persistedAuth,
				networkAccess: 'unverified',
			};
			publishState();
		},
		installVerified(persistedAuth: PersistedAuthType) {
			runtimeState = {
				status: 'signed-in',
				persistedAuth,
				networkAccess: 'verified',
			};
			publishState();
		},
		pauseNetworkAuth() {
			if (runtimeState.status === 'signed-out') return;
			runtimeState = {
				...runtimeState,
				networkAccess: 'paused',
			};
			publishState();
		},
		async write(value: PersistedAuthType | null) {
			await write(value);
		},
		async clear() {
			runtimeState = { status: 'signed-out' };
			publishState();
			await write(null);
		},
		dispose() {
			stateChangeListeners.clear();
		},
	};
}

function publicStateFromRuntime(runtimeState: RuntimeAuthState): AuthState {
	if (runtimeState.status === 'signed-out') return { status: 'signed-out' };
	if (runtimeState.networkAccess === 'paused') {
		return {
			status: 'reauth-required',
			owner: runtimeState.persistedAuth.owner,
			keyring: runtimeState.persistedAuth.keyring,
		};
	}
	return {
		status: 'signed-in',
		owner: runtimeState.persistedAuth.owner,
		keyring: runtimeState.persistedAuth.keyring,
	};
}

function authStatesEqual(left: AuthState, right: AuthState) {
	if (left.status !== right.status) return false;
	if (left.status === 'signed-out') return true;
	if (right.status === 'signed-out') return false;
	return (
		ownerId(left.owner) === ownerId(right.owner) &&
		subjectKeyringsEqual(left.keyring, right.keyring)
	);
}

function headersFromRequest(input: Request | string | URL, init?: RequestInit) {
	const headers = new Headers(
		input instanceof Request ? input.headers : undefined,
	);
	copyHeaders(headers, init?.headers);
	return headers;
}

function copyHeaders(target: Headers, source: RequestInit['headers']) {
	if (!source) return;

	if (source instanceof Headers) {
		source.forEach((value, key) => {
			target.set(key, value);
		});
		return;
	}

	const value = source as unknown;

	if (Array.isArray(value)) {
		for (const [key, headerValue] of value) {
			setHeaderValue(target, key, headerValue);
		}
		return;
	}

	if (isHeaderIterable(value)) {
		for (const [key, headerValue] of value) {
			setHeaderValue(target, key, headerValue);
		}
		return;
	}

	for (const [key, headerValue] of Object.entries(
		value as Record<string, string | readonly string[] | undefined>,
	)) {
		setHeaderValue(target, key, headerValue);
	}
}

function setHeaderValue(
	target: Headers,
	key: string,
	value: string | readonly string[] | undefined,
) {
	if (value === undefined) return;
	if (typeof value === 'string') {
		target.set(key, value);
		return;
	}
	for (const item of value) target.append(key, item);
}

function isHeaderIterable(
	value: unknown,
): value is Iterable<readonly [string, string]> {
	return (
		value !== null && typeof value === 'object' && Symbol.iterator in value
	);
}

async function refreshOAuthTokenWithEndpoint({
	baseURL,
	clientId,
	grant,
	fetch,
	now,
}: {
	baseURL: string;
	clientId: string;
	grant: OAuthTokenGrant;
	fetch: AuthFetch;
	now: () => number;
}): Promise<OAuthTokenGrant> {
	const body = new URLSearchParams({
		grant_type: 'refresh_token',
		refresh_token: grant.refreshToken,
		client_id: clientId,
		resource: baseURL,
	});
	const response = await fetch(`${baseURL}/auth/oauth2/token`, {
		method: 'POST',
		body,
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		credentials: 'omit',
	});
	if (!response.ok) {
		throw new Error(`OAuth refresh failed with ${response.status}.`);
	}
	const data = await response.json();
	return parseOAuthTokenGrant(data, {
		now,
		fallbackRefreshToken: grant.refreshToken,
	});
}

async function revokeOAuthRefreshTokenWithEndpoint({
	baseURL,
	clientId,
	refreshToken,
	fetch,
}: {
	baseURL: string;
	clientId: string;
	refreshToken: string;
	fetch: AuthFetch;
}) {
	const body = new URLSearchParams({
		client_id: clientId,
		token: refreshToken,
		token_type_hint: 'refresh_token',
	});
	const response = await fetch(`${baseURL}/auth/oauth2/revoke`, {
		method: 'POST',
		body,
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		credentials: 'omit',
	});
	if (!response.ok) {
		throw new Error(`OAuth revoke failed with ${response.status}.`);
	}
}
