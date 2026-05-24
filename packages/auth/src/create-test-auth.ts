import type { AuthClient, AuthState } from './auth-contract.js';

/**
 * Construct an `AuthClient` for tests. Override only the methods the test
 * exercises; defaults throw or no-op so accidental production-shaped reads
 * surface loudly instead of returning unrealistic stand-in values.
 *
 * Most workspace tests pass `{ openWebSocket: mockFn }`. Pass `state` (and
 * optionally `onStateChange`) when the code under test reads auth state.
 *
 * @example
 * ```ts
 * const auth = createTestAuth({ openWebSocket: fakeWebSocket });
 * const collaboration = openCollaboration(ydoc, {
 *   url,
 *   openWebSocket: auth.openWebSocket,
 *   onReconnectSignal: auth.onStateChange,
 *   actions: {},
 * });
 * ```
 */
export function createTestAuth(
	overrides: Partial<AuthClient> = {},
): AuthClient {
	const signedOut: AuthState = { status: 'signed-out' };
	return {
		state: signedOut,
		baseURL: 'https://api.test',
		onStateChange: () => () => {},
		startSignIn: () => {
			throw new Error('[test-auth] startSignIn not stubbed');
		},
		signOut: () => {
			throw new Error('[test-auth] signOut not stubbed');
		},
		fetch: () => {
			throw new Error('[test-auth] fetch not stubbed');
		},
		openWebSocket: () => {
			throw new Error('[test-auth] openWebSocket not stubbed');
		},
		[Symbol.dispose]: () => {},
		...overrides,
	};
}
