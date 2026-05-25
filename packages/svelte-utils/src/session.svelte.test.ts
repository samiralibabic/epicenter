import { expect, test } from 'bun:test';
import type { AuthClient, AuthState } from '@epicenter/auth';
import { asOwnerId } from '@epicenter/constants/identity';
import { Ok } from 'wellcrafted/result';
import { createSession } from './session.svelte.js';

(globalThis as unknown as { $state: <T>(value: T) => T }).$state = (value) =>
	value;

const keyring = [
	{
		version: 1,
		keyBytesBase64: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
	},
] as const;

const signedIn = (id: string): AuthState => ({
	status: 'signed-in',
	ownerId: asOwnerId(id),
	keyring: [...keyring],
});

const ownerLabel = (state: AuthState) =>
	state.status === 'signed-out' ? 'signed-out' : state.ownerId;

test('signed-out gap disposes old payload before building the next owner', () => {
	const { auth, setState } = createAuthHarness(signedIn('alice'));
	const events: string[] = [];

	const session = createSession({
		auth,
		build: ({ ownerId }) => {
			events.push(`build:${ownerId}`);

			return {
				label: ownerId,
				[Symbol.dispose]() {
					events.push(`dispose:${ownerId}`);
				},
			};
		},
	});

	setState({ status: 'signed-out' });
	setState(signedIn('bob'));

	expect(events).toEqual(['build:alice', 'dispose:alice', 'build:bob']);
	expect(session.current?.label).toBe(asOwnerId('bob'));

	session[Symbol.dispose]();
});

test('build receives signedIn with projected fields and explicit auth capabilities', () => {
	const { auth } = createAuthHarness(signedIn('alice'));

	const session = createSession({
		auth,
		build: (received) => {
			expect(received.server).toBe('api.test');
			expect(received.baseURL).toBe(auth.baseURL);
			expect(received.ownerId).toBe(asOwnerId('alice'));
			expect(typeof received.keyring).toBe('function');
			expect(received.keyring()).toEqual([...keyring]);
			expect(received.openWebSocket).toBe(auth.openWebSocket);
			expect(received.onReconnectSignal).toBe(auth.onStateChange);
			expect(ownerLabel(auth.state)).toBe(asOwnerId('alice'));
			return {
				[Symbol.dispose]() {},
			};
		},
	});

	expect(session.current).not.toBeNull();
	session[Symbol.dispose]();
});

function createAuthHarness(initial: AuthState) {
	let state = initial;
	const listeners = new Set<(state: AuthState) => void>();
	const auth: AuthClient = {
		get state() {
			return state;
		},
		baseURL: 'https://api.test',
		onStateChange(fn) {
			listeners.add(fn);
			return () => {
				listeners.delete(fn);
			};
		},
		startSignIn: async () => Ok(undefined),
		signOut: async () => Ok(undefined),
		fetch: async () => new Response(null, { status: 204 }),
		openWebSocket: async () => {
			throw new Error('openWebSocket is not used by this test.');
		},
		[Symbol.dispose]() {
			listeners.clear();
		},
	};

	return {
		auth,
		setState(next: AuthState) {
			state = next;
			for (const listener of listeners) listener(next);
		},
	};
}
