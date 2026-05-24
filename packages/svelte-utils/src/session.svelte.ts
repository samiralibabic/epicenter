import type { AuthClient, AuthState, Owner } from '@epicenter/auth';

type SignedInState = Extract<AuthState, { status: 'signed-in' }>;
type Keyring = SignedInState['keyring'];

/**
 * Auth-gated identity payload that `createSession` hands to the build
 * callback whenever an identity-bearing auth state is present.
 *
 * Flat shape, not an intersection: `owner` and `keyring` come from auth's
 * signed-in state, and `auth` is the live auth client. Per-app openers take
 * this whole and use what they need:
 *
 * - `attachEncryption(ydoc, { keyring: signedIn.keyring })` reads keyring.
 * - `attachLocalStorage(ydoc, { server, owner, keyring })` reads `server`,
 *   `owner`, and `keyring` explicitly.
 * - `openCollaboration(ydoc, { openWebSocket: signedIn.auth.openWebSocket,
 *   onReconnectSignal: signedIn.auth.onStateChange })` consumes the two
 *   function refs explicitly so the primitive does not hold a reference
 *   to the full auth client.
 *
 * `owner` is stable for the lifetime of a single `SignedIn`: a
 * different-owner sign-in produces a new payload via the session's
 * dispose / rebuild cycle. `keyring` is a callback because the same-owner
 * keyring can rotate (reauth-required to identity-bearing) without a
 * rebuild.
 */
export type SignedIn = {
	/** API origin host, derived once from `auth.baseURL`. Threads into
	 * `attachLocalStorage` and `wipeLocalStorage` so two team deployments
	 * on the same machine partition local storage separately. */
	server: string;
	owner: Owner;
	keyring: () => Keyring;
	auth: AuthClient;
};

/**
 * Auth-gated payload built once per identity-bearing auth state and disposed
 * on sign-out. `reauth-required` keeps the existing payload mounted: OAuth
 * sessions publish a signed-out gap before a different owner mounts, so two
 * consecutive identity-bearing states are always the same owner.
 *
 * The build callback receives a `SignedIn` value: `owner` for local storage
 * scoping, `keyring` (callback) for encryption, and the live `auth` client
 * for cloud sync and reconnect listeners. The keyring reader pulls from
 * the live `state.keyring` so refreshed keyrings from `/api/session` are
 * picked up on next access without rebuilding the payload.
 *
 * Requires an `AuthClient` whose `state` is Svelte-reactive (use
 * `@epicenter/auth-svelte`, not `@epicenter/auth` directly).
 */
export function createSession<T extends Disposable>({
	auth,
	build,
}: {
	auth: AuthClient;
	build: (signedIn: SignedIn) => T;
}) {
	let payload = $state<T | null>(null);
	// `server` is constant across auth states (the client signs into one API
	// per construction). Compute once; reuse across every payload rebuild.
	const server = new URL(auth.baseURL).host;

	function reconcile(state: AuthState) {
		if (state.status === 'signed-out') {
			payload?.[Symbol.dispose]();
			payload = null;
			return;
		}
		if (payload) return;

		buildPayload(state);
	}

	function buildPayload(state: Exclude<AuthState, { status: 'signed-out' }>) {
		payload = build({
			server,
			owner: state.owner,
			keyring: () => {
				if (auth.state.status === 'signed-out') {
					throw new Error('[session] keyring() called while signed-out.');
				}
				return auth.state.keyring;
			},
			auth,
		});
	}

	const unsubscribe = auth.onStateChange(reconcile);
	reconcile(auth.state);

	return {
		get current(): T | null {
			return payload;
		},
		require(): T {
			if (!payload) {
				throw new Error('[session] require() called while signed-out.');
			}
			return payload;
		},
		[Symbol.dispose]() {
			unsubscribe();
			payload?.[Symbol.dispose]();
			payload = null;
		},
	};
}
