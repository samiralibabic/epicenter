/**
 * Single Credential Middleware Tests
 *
 * Verifies that `singleCredential` rejects multi-credential requests at the
 * edge and lifts WebSocket subprotocol bearers into a canonical
 * `Authorization` header before downstream handlers run.
 */

import { expect, test } from 'bun:test';
import { Hono } from 'hono';
import { singleCredential } from './single-credential.js';

function createTestApp() {
	const app = new Hono();
	app.use('*', singleCredential);
	app.get('/', (c) =>
		c.json({
			authorization: c.req.header('authorization') ?? null,
			cookie: c.req.header('cookie') ?? null,
			subprotocol: c.req.header('sec-websocket-protocol') ?? null,
		}),
	);
	return app;
}

test('only-cookie passes through unchanged', async () => {
	const res = await createTestApp().request('/', {
		headers: { cookie: 'theme=dark; better-auth.session_token=session-1' },
	});

	expect(res.status).toBe(200);
	const body = (await res.json()) as Record<string, string | null>;
	expect(body.cookie).toContain('better-auth.session_token=session-1');
	expect(body.authorization).toBeNull();
});

test('only-bearer passes through unchanged', async () => {
	const res = await createTestApp().request('/', {
		headers: { authorization: 'Bearer token-1' },
	});

	expect(res.status).toBe(200);
	const body = (await res.json()) as Record<string, string | null>;
	expect(body.authorization).toBe('Bearer token-1');
	expect(body.cookie).toBeNull();
});

test('only-WS-bearer is lifted into Authorization and stripped from the protocol', async () => {
	const res = await createTestApp().request('/', {
		headers: { 'sec-websocket-protocol': 'epicenter, bearer.token-1' },
	});

	expect(res.status).toBe(200);
	const body = (await res.json()) as Record<string, string | null>;
	expect(body.authorization).toBe('Bearer token-1');
	expect(body.subprotocol).toBe('epicenter');
});

test('only-WS-bearer with no remaining protocols drops the header entirely', async () => {
	const res = await createTestApp().request('/', {
		headers: { 'sec-websocket-protocol': 'bearer.token-1' },
	});

	expect(res.status).toBe(200);
	const body = (await res.json()) as Record<string, string | null>;
	expect(body.authorization).toBe('Bearer token-1');
	expect(body.subprotocol).toBeNull();
});

test('two WS bearer entries are rejected as multiple_credentials', async () => {
	const res = await createTestApp().request('/', {
		headers: {
			'sec-websocket-protocol': 'epicenter, bearer.token-1, bearer.token-2',
		},
	});

	expect(res.status).toBe(400);
});

test('matching HTTP and WS bearers are accepted', async () => {
	const res = await createTestApp().request('/', {
		headers: {
			authorization: 'Bearer token-1',
			'sec-websocket-protocol': 'epicenter, bearer.token-1',
		},
	});

	expect(res.status).toBe(200);
	const body = (await res.json()) as Record<string, string | null>;
	expect(body.authorization).toBe('Bearer token-1');
});

test('cookie + HTTP bearer is rejected', async () => {
	const res = await createTestApp().request('/', {
		headers: {
			authorization: 'Bearer token-1',
			cookie: 'better-auth.session_token=session-1',
		},
	});

	expect(res.status).toBe(400);
});

test('cookie + WS bearer is rejected', async () => {
	const res = await createTestApp().request('/', {
		headers: {
			cookie: 'better-auth.session_token=session-1',
			'sec-websocket-protocol': 'epicenter, bearer.token-1',
		},
	});

	expect(res.status).toBe(400);
});

test('two distinct bearers (HTTP + WS) are rejected', async () => {
	const res = await createTestApp().request('/', {
		headers: {
			authorization: 'Bearer token-1',
			'sec-websocket-protocol': 'epicenter, bearer.token-2',
		},
	});

	expect(res.status).toBe(400);
});

test('no credentials passes through cleanly', async () => {
	const res = await createTestApp().request('/', {
		headers: { accept: 'application/json' },
	});

	expect(res.status).toBe(200);
	const body = (await res.json()) as Record<string, string | null>;
	expect(body.authorization).toBeNull();
	expect(body.cookie).toBeNull();
});
