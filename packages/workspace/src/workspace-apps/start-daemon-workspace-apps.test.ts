/**
 * Startup tests for `startDaemonWorkspaceApps`.
 *
 * Pin three contracts:
 * - happy path opens every configured daemon route in parallel and returns the
 *   started routes
 * - if any sibling `open(ctx)` rejects, all successfully opened runtimes are
 *   asyncDispose'd before the structured error propagates
 * - invalid route names fail before any route opens
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AuthClient } from '@epicenter/auth';
import { expectErr, expectOk } from 'wellcrafted/testing';
import type {
	DaemonWorkspaceContext,
	DaemonWorkspaceDefinition,
} from '../daemon/define-workspace.js';
import type { DaemonRuntime } from '../daemon/types.js';

import { startDaemonWorkspaceApps } from './start-daemon-workspace-apps.js';

let projectDir: string;

beforeEach(() => {
	projectDir = mkdtempSync(join(tmpdir(), 'workspace-apps-start-'));
});

afterEach(() => {
	rmSync(projectDir, { recursive: true, force: true });
});

function disposeMarkerPath(route: string): string {
	return join(projectDir, `${route}.disposed`);
}

function stubAuthClient(): AuthClient {
	return {
		state: {
			status: 'signed-in',
			owner: { kind: 'personal', userId: 'test-user' },
			keyring: [] as never,
		},
		openWebSocket: () => Promise.resolve({} as WebSocket),
		onStateChange: () => () => {},
	} as unknown as AuthClient;
}

function testRuntime(
	onDispose: () => void | Promise<void> = () => {},
): DaemonRuntime {
	return {
		collaboration: {} as DaemonRuntime['collaboration'],
		async [Symbol.asyncDispose]() {
			await onDispose();
		},
	};
}

describe('startDaemonWorkspaceApps', () => {
	test('opens every configured daemon route and returns the started routes', async () => {
		const routes: Record<string, DaemonWorkspaceDefinition> = {
			alpha: {
				async open(ctx: DaemonWorkspaceContext) {
					expect(ctx.route).toBe('alpha');
					return testRuntime();
				},
			},
			beta: {
				async open(ctx: DaemonWorkspaceContext) {
					expect(ctx.route).toBe('beta');
					return testRuntime();
				},
			},
		};

		const result = await startDaemonWorkspaceApps({
			projectDir,
			auth: stubAuthClient(),
			routes,
		});
		const data = expectOk(result);
		const routeNames = data
			.map((entry) => entry.route)
			.slice()
			.sort();
		expect(routeNames).toEqual(['alpha', 'beta']);
	});

	test('disposes successfully opened runtimes when a sibling open fails', async () => {
		const goodMarker = disposeMarkerPath('good');
		const routes: Record<string, DaemonWorkspaceDefinition> = {
			good: {
				async open() {
					return testRuntime(() => writeFileSync(goodMarker, 'disposed'));
				},
			},
			bad: {
				async open() {
					throw new Error('boom');
				},
			},
		};

		const result = await startDaemonWorkspaceApps({
			projectDir,
			auth: stubAuthClient(),
			routes,
		});
		const error = expectErr(result);
		expect(error.name).toBe('WorkspaceOpenFailed');
		expect(error).toMatchObject({ route: 'bad' });

		expect(await Bun.file(goodMarker).exists()).toBe(true);
	});

	test('rejects invalid route names before opening routes', async () => {
		const marker = disposeMarkerPath('invalid');
		const routes = Object.create(null) as Record<
			string,
			DaemonWorkspaceDefinition
		>;
		routes.__proto__ = {
			async open() {
				writeFileSync(marker, 'opened');
				return testRuntime();
			},
		};

		const result = await startDaemonWorkspaceApps({
			projectDir,
			auth: stubAuthClient(),
			routes,
		});
		const error = expectErr(result);
		expect(error).toMatchObject({
			name: 'WorkspaceRouteRejected',
			route: '__proto__',
			reason: 'invalid',
		});
		expect(await Bun.file(marker).exists()).toBe(false);
	});

	test('returns an empty result when the config declares no routes', async () => {
		const result = await startDaemonWorkspaceApps({
			projectDir,
			auth: stubAuthClient(),
			routes: {},
		});
		const data = expectOk(result);
		expect(data).toEqual([]);
	});

	test('refuses to open routes when machine auth is signed out', async () => {
		const routes = {
			alpha: {
				async open() {
					throw new Error('must not open');
				},
			},
		} satisfies Record<string, DaemonWorkspaceDefinition>;

		const result = await startDaemonWorkspaceApps({
			projectDir,
			auth: { state: { status: 'signed-out' } } as AuthClient,
			routes,
		});
		const error = expectErr(result);
		expect(error.name).toBe('WorkspaceAuthSignedOut');
	});
});
