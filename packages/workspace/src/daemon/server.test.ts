/**
 * Daemon Server Tests
 *
 * Verifies that `startDaemonServer` validates route names, binds exactly one
 * socket for an already-claimed daemon lease, and exposes an idempotent close
 * operation.
 *
 * Key behaviors:
 * - valid routes are served over the daemon client
 * - invalid route declarations fail before binding a socket
 * - close stops the listener, removes the socket file, and can run twice
 * - /run dispatches a real action handler over the Unix socket
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { type ActionRegistry, defineQuery } from '../shared/actions.js';
import { daemonClient } from './client.js';
import { claimDaemonLease, type DaemonLease } from './lease.js';
import { startDaemonServer } from './server.js';
import type { DaemonServedRoute } from './types.js';

let originalRuntimeDir: string | undefined;
let runtimeRoot: string;
let workDir: string;

function makeRuntime(
	actions: ActionRegistry = {},
): DaemonServedRoute['runtime'] {
	return {
		collaboration: {
			actions,
			devices: {
				list: () => [],
			},
			status: { phase: 'connected' },
			dispatch: async () => ({ data: null, error: null }) as never,
		},
	};
}

function claimTestLease(): DaemonLease {
	return expectOk(claimDaemonLease(workDir));
}

beforeEach(() => {
	originalRuntimeDir = process.env.EPICENTER_RUNTIME_DIR;
	// `/tmp/...` is short on every POSIX platform; needed because
	// socketPathFor enforces a strict path-length guard that macOS's
	// `os.tmpdir()` would blow.
	runtimeRoot = mkdtempSync('/tmp/eps-server-rt-');
	process.env.EPICENTER_RUNTIME_DIR = runtimeRoot;
	mkdirSync(runtimeRoot, { recursive: true });
	workDir = mkdtempSync('/tmp/eps-server-dir-');
});

afterEach(() => {
	if (originalRuntimeDir === undefined)
		delete process.env.EPICENTER_RUNTIME_DIR;
	else process.env.EPICENTER_RUNTIME_DIR = originalRuntimeDir;
	rmSync(runtimeRoot, { recursive: true, force: true });
	rmSync(workDir, { recursive: true, force: true });
});

describe('startDaemonServer', () => {
	test('starts the configured daemon routes', async () => {
		const lease = claimTestLease();
		const serverResult = await startDaemonServer({
			lease,
			routes: [{ route: 'demo', runtime: makeRuntime() }],
		});

		try {
			const server = expectOk(serverResult);

			const data = expectOk(await daemonClient(server.socketPath).peers());
			expect(data).toEqual([]);
		} finally {
			if (serverResult.error === null) await serverResult.data.close();
			lease.release();
		}
	});

	test('returns RouteNameRejected before binding duplicate routes', async () => {
		const lease = claimTestLease();
		try {
			const error = expectErr(
				await startDaemonServer({
					lease,
					routes: [
						{ route: 'demo', runtime: makeRuntime() },
						{ route: 'demo', runtime: makeRuntime() },
					],
				}),
			);
			expect(error).toMatchObject({
				name: 'RouteNameRejected',
				route: 'demo',
				reason: 'duplicate',
			});
			expect(existsSync(lease.socketPath)).toBe(false);
		} finally {
			lease.release();
		}
	});

	test('returns RouteNameRejected before binding invalid routes', async () => {
		const lease = claimTestLease();
		try {
			const error = expectErr(
				await startDaemonServer({
					lease,
					routes: [{ route: 'bad.route', runtime: makeRuntime() }],
				}),
			);
			expect(error).toMatchObject({
				name: 'RouteNameRejected',
				route: 'bad.route',
				reason: 'invalid',
			});
			expect(existsSync(lease.socketPath)).toBe(false);
		} finally {
			lease.release();
		}
	});

	test('close stops the listener, removes the socket, and is idempotent', async () => {
		const lease = claimTestLease();
		const serverResult = await startDaemonServer({
			lease,
			routes: [{ route: 'demo', runtime: makeRuntime() }],
		});

		try {
			const server = expectOk(serverResult);
			expect(existsSync(server.socketPath)).toBe(true);

			await server.close();
			await server.close();
			expect(existsSync(server.socketPath)).toBe(false);
		} finally {
			if (serverResult.error === null) await serverResult.data.close();
			lease.release();
		}
	});

	test('run dispatches to a real action handler over the socket', async () => {
		const lease = claimTestLease();
		const runtime = makeRuntime({
			echo: defineQuery({ handler: () => 'hello' }),
		});
		const serverResult = await startDaemonServer({
			lease,
			routes: [{ route: 'demo', runtime }],
		});

		try {
			const server = expectOk(serverResult);
			const data = expectOk(
				await daemonClient(server.socketPath).run({
					actionPath: 'demo.echo',
					input: null,
					waitMs: 25,
				}),
			);
			expect(data).toBe('hello');
		} finally {
			if (serverResult.error === null) await serverResult.data.close();
			lease.release();
		}
	});
});
