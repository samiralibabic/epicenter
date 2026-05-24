import { expect, test } from 'bun:test';
import type { AuthClient, AuthState } from '@epicenter/auth';
import { Ok } from 'wellcrafted/result';
import { createSession } from './session.svelte.js';

(globalThis as unknown as { $state: <T>(value: T) => T }).$state = (value) =>
	value;

const keyring = [
	{
		version: 1,
		subjectKeyBase64: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
	},
] as const;

const signedIn = (userId: string): AuthState => ({
	status: 'signed-in',
	owner: { kind: 'personal', userId },
	keyring: [...keyring],
});

const ownerLabel = (state: AuthState) =>
	state.status === 'signed-out'
		? 'signed-out'
		: state.owner.kind === 'personal'
			? state.owner.userId
			: 'team';

test('signed-out gap disposes old payload before building the next owner', () => {
	const { auth, setState } = createAuthHarness(signedIn('alice'));
	const events: string[] = [];

	const session = createSession({
		auth,
		build: ({ owner }) => {
			const label = owner.kind === 'personal' ? owner.userId : 'team';
			events.push(`build:${label}`);

			return {
				label,
				[Symbol.dispose]() {
					events.push(`dispose:${label}`);
				},
			};
		},
	});

	setState({ status: 'signed-out' });
	setState(signedIn('bob'));

	expect(events).toEqual(['build:alice', 'dispose:alice', 'build:bob']);
	expect(session.current?.label).toBe('bob');

	session[Symbol.dispose]();
});

test('build receives signedIn with owner, keyring callback, and auth client', () => {
	const { auth } = createAuthHarness(signedIn('alice'));

	const session = createSession({
		auth,
		build: (received) => {
			expect(received.server).toBe('api.test');
			expect(received.owner).toEqual({ kind: 'personal', userId: 'alice' });
			expect(typeof received.keyring).toBe('function');
			expect(received.keyring()).toEqual([...keyring]);
			expect(received.auth).toBe(auth);
			expect(ownerLabel(auth.state)).toBe('alice');
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
