/**
 * App route boundary tests.
 *
 * Verifies that the host routes own protected-resource authorization before
 * handing requests to the Room Durable Object, and that route registration
 * order holds where Hono's first-match semantics depend on it.
 *
 * Key behaviors:
 * - `/rooms/:room` rejects unauthenticated callers at the OAuth resource
 *   boundary.
 * - The room route body is not touched when auth fails.
 * - Authenticated room routes forward bodies to the selected Room DO and
 *   shape binary snapshot/sync responses.
 * - Oversized sync bodies are rejected before selecting a Room DO.
 * - OAuth discovery routes register before the Better Auth /auth/* catch-all.
 */

import { expect, mock, test } from 'bun:test';
import { Err, Ok } from 'wellcrafted/result';
import { OAuthError } from './auth/oauth-error.js';
import { OAUTH_OPENID_CONFIGURATION_PATH } from './auth/oauth-metadata.js';
import * as resourceBoundary from './auth/resource-boundary.js';
import { projectTrustedOAuthClientToRow } from './auth/trusted-oauth-clients.js';
import { MAX_PAYLOAD_BYTES } from './constants.js';

const AUTHENTICATED_USER = { id: 'user-1', email: 'user@example.test' };

let resolveRequestOAuthUserResult: {
	data: unknown;
	error: unknown;
} = { data: null, error: OAuthError.InvalidToken().error };
let resolveRequestOAuthUserCalls = 0;
const waitUntilPromises: Promise<unknown>[] = [];
const upsertedDoInstances: unknown[] = [];

mock.module('pg', () => ({
	default: {
		Client: class {
			async connect() {}
			async end() {}
		},
	},
}));

mock.module('drizzle-orm/node-postgres', () => ({
	drizzle: () => ({
		insert() {
			return {
				values(value: unknown) {
					upsertedDoInstances.push(value);
					return {
						onConflictDoUpdate() {
							return Promise.resolve();
						},
					};
				},
			};
		},
	}),
}));

// Mock `cloudflare:workers` so the real Room class loads without trying to
// resolve the Workers runtime module. The Room is re-exported by app.ts but
// never constructed in these route-boundary tests. We mock at the runtime
// layer (not at the Room module) so the mock cannot leak into
// `room/backends/cloudflare/durable-object.test.ts` and replace its `Room`.
mock.module('cloudflare:workers', () => ({
	DurableObject: class {
		ctx: unknown;
		env: unknown;
		constructor(ctx: unknown, env: unknown) {
			this.ctx = ctx;
			this.env = env;
		}
	},
}));

mock.module('./auth/create-auth', () => ({
	createAuth: () => ({
		api: {
			getSession: async () => null,
		},
		handler: async () => new Response(null, { status: 404 }),
	}),
}));

mock.module('./auth/encryption', () => ({
	deriveSubjectKeyring: async () => [],
}));

// Spread the real module so the exports this test does not override
// (`parseBearer`, `resolveBearerUser`) survive. `mock.module` replaces the
// whole module process-wide; a partial mock makes the un-listed exports
// vanish for any test file that loads after this one, which crashed
// `resource-boundary.test.ts` on `resolveBearerUser`.
mock.module('./auth/resource-boundary', () => ({
	...resourceBoundary,
	resolveRequestOAuthUser: async () => {
		resolveRequestOAuthUserCalls += 1;
		return resolveRequestOAuthUserResult;
	},
}));

mock.module('./auth/trusted-oauth-clients', () => ({
	ensureTrustedOAuthClients: async () => {},
	projectTrustedOAuthClientToRow,
}));

class FakeRoom {
	syncBodies: Uint8Array[] = [];

	constructor(
		private readonly options: {
			diff?: Uint8Array | null;
			storageBytes?: number;
			snapshot?: Uint8Array;
			malformed?: boolean;
		} = {},
	) {}

	async sync(body: Uint8Array) {
		this.syncBodies.push(body);
		if (this.options.malformed) {
			return Err({ name: 'MalformedSyncBody' as const });
		}
		return Ok({
			diff: this.options.diff ?? null,
			storageBytes: this.options.storageBytes ?? 42,
		});
	}

	async getDoc(): Promise<{ data: Uint8Array; storageBytes: number }> {
		return {
			data: this.options.snapshot ?? new Uint8Array([1, 2, 3]),
			storageBytes: this.options.storageBytes ?? 42,
		};
	}
}

function setup({
	room = new FakeRoom(),
	authenticated = true,
}: {
	room?: FakeRoom;
	authenticated?: boolean;
} = {}) {
	resolveRequestOAuthUserResult = authenticated
		? { data: AUTHENTICATED_USER, error: null }
		: { data: null, error: OAuthError.InvalidToken().error };
	resolveRequestOAuthUserCalls = 0;
	waitUntilPromises.length = 0;
	upsertedDoInstances.length = 0;

	const requestedRoomNames: string[] = [];
	const roomNamespace = {
		idFromName(roomName: string) {
			requestedRoomNames.push(roomName);
			return roomName;
		},
		get(roomName: string) {
			if (roomName !== requestedRoomNames[requestedRoomNames.length - 1]) {
				throw new Error(`Unexpected room id: ${roomName}`);
			}
			return room;
		},
	};

	return { requestedRoomNames, room, roomNamespace };
}

async function fetchRoomRoute(
	path: string,
	init: RequestInit,
	roomNamespace: unknown,
) {
	const { default: app } = await import('./app.js');
	const response = await app.fetch(
		new Request(`https://api.test${path}`, init),
		{
			HYPERDRIVE: { connectionString: 'postgres://test' },
			ROOM: roomNamespace,
		},
		{
			waitUntil(promise: Promise<unknown>) {
				waitUntilPromises.push(promise);
			},
			passThroughOnException() {},
			props: {},
		},
	);

	await Promise.all(waitUntilPromises);
	return response;
}

test('POST /rooms/:room rejects unauthenticated callers before sync engine entry', async () => {
	const { roomNamespace, requestedRoomNames } = setup({ authenticated: false });
	const response = await fetchRoomRoute(
		'/rooms/notes',
		{
			method: 'POST',
			headers: { 'content-type': 'application/octet-stream' },
			body: new Uint8Array([1, 2, 3]),
		},
		roomNamespace,
	);

	expect(response.status).toBe(401);
	expect(response.headers.get('WWW-Authenticate')).toBe(
		'Bearer error="invalid_token"',
	);
	expect(resolveRequestOAuthUserCalls).toBe(1);
	expect(requestedRoomNames).toEqual([]);
});

test('POST /rooms/:room forwards the request body to the resolved room name', async () => {
	const { room, roomNamespace, requestedRoomNames } = setup({
		room: new FakeRoom({
			diff: new Uint8Array([9, 8]),
			storageBytes: 128,
		}),
	});

	const response = await fetchRoomRoute(
		'/rooms/notes',
		{
			method: 'POST',
			body: new Uint8Array([1, 2, 3]),
		},
		roomNamespace,
	);

	expect(requestedRoomNames).toEqual(['subject:user-1:rooms:notes']);
	expect(room.syncBodies).toHaveLength(1);
	expect(Array.from(room.syncBodies[0] ?? [])).toEqual([1, 2, 3]);
	expect(response.status).toBe(200);
	expect(response.headers.get('content-type')).toBe('application/octet-stream');
	expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([
		9, 8,
	]);
	expect(upsertedDoInstances).toEqual([
		expect.objectContaining({
			doName: 'subject:user-1:rooms:notes',
			resourceName: 'notes',
			storageBytes: 128,
			userId: 'user-1',
		}),
	]);
});

test('POST /rooms/:room returns 204 and metering when the room has no diff', async () => {
	const { roomNamespace } = setup({
		room: new FakeRoom({ diff: null, storageBytes: 64 }),
	});

	const response = await fetchRoomRoute(
		'/rooms/notes',
		{
			method: 'POST',
			body: new Uint8Array([1]),
		},
		roomNamespace,
	);

	expect(response.status).toBe(204);
	expect(upsertedDoInstances).toEqual([
		expect.objectContaining({
			storageBytes: 64,
		}),
	]);
});

test('POST /rooms/:room rejects oversized payloads before selecting a room', async () => {
	const { room, roomNamespace, requestedRoomNames } = setup();

	const response = await fetchRoomRoute(
		'/rooms/notes',
		{
			method: 'POST',
			body: new Uint8Array(MAX_PAYLOAD_BYTES + 1),
		},
		roomNamespace,
	);

	expect(response.status).toBe(413);
	expect(await response.text()).toBe('Payload too large');
	expect(requestedRoomNames).toEqual([]);
	expect(room.syncBodies).toEqual([]);
	expect(upsertedDoInstances).toEqual([]);
});

test('POST /rooms/:room returns 400 when the Room reports a malformed sync body', async () => {
	const { room, roomNamespace } = setup({
		room: new FakeRoom({ malformed: true }),
	});

	const response = await fetchRoomRoute(
		'/rooms/notes',
		{
			method: 'POST',
			body: new Uint8Array([1, 2, 3]),
		},
		roomNamespace,
	);

	expect(response.status).toBe(400);
	expect(room.syncBodies).toHaveLength(1);
	expect(upsertedDoInstances).toEqual([]);
});

test('GET /rooms/:room returns the selected room snapshot as an octet stream', async () => {
	const { roomNamespace, requestedRoomNames } = setup({
		room: new FakeRoom({
			snapshot: new Uint8Array([4, 5, 6]),
			storageBytes: 256,
		}),
	});

	const response = await fetchRoomRoute(
		'/rooms/notes',
		{ method: 'GET' },
		roomNamespace,
	);

	expect(requestedRoomNames).toEqual(['subject:user-1:rooms:notes']);
	expect(response.headers.get('content-type')).toBe('application/octet-stream');
	expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([
		4, 5, 6,
	]);
	expect(upsertedDoInstances).toEqual([
		expect.objectContaining({
			doName: 'subject:user-1:rooms:notes',
			resourceName: 'notes',
			storageBytes: 256,
			userId: 'user-1',
		}),
	]);
});

test('OAuth discovery routes register before the /auth/* catch-all', async () => {
	// Hono matches routes in registration order. If the OpenID discovery
	// route were registered after the Better Auth /auth/* catch-all, the
	// catch-all would swallow discovery requests. app.ts depends on this
	// ordering; only a comment guarded it before.
	const { default: app } = await import('./app.js');
	const paths = app.routes.map((route) => route.path);
	const discoveryIndex = paths.indexOf(OAUTH_OPENID_CONFIGURATION_PATH);
	const catchAllIndex = paths.indexOf('/auth/*');

	expect(discoveryIndex).toBeGreaterThanOrEqual(0);
	expect(catchAllIndex).toBeGreaterThanOrEqual(0);
	expect(discoveryIndex).toBeLessThan(catchAllIndex);
});
