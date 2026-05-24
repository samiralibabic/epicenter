/**
 * Unix Socket Binding Tests
 *
 * Verifies the filesystem and hardening contract around Bun unix-socket
 * listeners. Route behavior lives in `app.ts`; this file pins the binding,
 * hardening, and best-effort cleanup behavior.
 *
 * Key behaviors:
 * - bound sockets route requests and use mode 0600
 * - graceful server stop removes the socket file
 * - manual socket unlink is best-effort when the file is already gone
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';

import { unlinkSocketFile } from './runtime-files';
import { bindUnixSocket } from './unix-socket';

let socketPath: string;
let servers: Bun.Server<undefined>[] = [];
const fetchOk = () => new Response('ok');

beforeEach(() => {
	socketPath = join(
		tmpdir(),
		`epicenter-unix-socket-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sock`,
	);
	servers = [];
});

afterEach(() => {
	for (const server of servers) {
		void server.stop(true).catch(() => {
			// already stopped
		});
	}
});

describe('bindUnixSocket', () => {
	test('binds the socket and routes through to the Hono app', async () => {
		const app = new Hono().post('/ping', (c) => c.json({ ok: true }));

		const server = bindUnixSocket({
			socketPath,
			fetch: app.fetch,
		});
		servers.push(server);

		const res = await fetch('http://daemon/ping', {
			unix: socketPath,
			method: 'POST',
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});

	test('socket file is created with mode 0600', async () => {
		const server = bindUnixSocket({
			socketPath,
			fetch: fetchOk,
		});
		servers.push(server);

		const mode = statSync(socketPath).mode & 0o777;
		expect(mode).toBe(0o600);
	});

	test('server.stop() unlinks the socket file', async () => {
		const server = bindUnixSocket({
			socketPath,
			fetch: fetchOk,
		});
		expect(existsSync(socketPath)).toBe(true);

		await server.stop(true);
		// Bun.serve auto-unlinks; sweep best-effort just in case.
		unlinkSocketFile(socketPath);
		expect(existsSync(socketPath)).toBe(false);
	});

	test('unlinkSocketFile ignores an already-missing socket file', () => {
		expect(existsSync(socketPath)).toBe(false);
		expect(() => unlinkSocketFile(socketPath)).not.toThrow();
	});
});
