/**
 * executeRun peer dispatch tests.
 *
 * Verifies the daemon preserves remote dispatch outcomes in one `/run`
 * envelope before the response crosses the IPC boundary. The relay owns
 * reachability: a `RecipientOffline` dispatch error surfaces as
 * `PeerNotFound`, every other dispatch error as `RemoteCallFailed`. The
 * `collab.dispatch` path is faked here so the test can drive those outcomes
 * without spinning up real Yjs sync.
 */

import { describe, expect, test } from 'bun:test';
import type { Result } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';

import { DispatchError, type DispatchRequest } from '../document/dispatch.js';
import type { SyncStatus } from '../document/internal/sync-supervisor.js';
import type { ActionRegistry } from '../shared/actions.js';
import { defineMutation, defineQuery } from '../shared/actions.js';
import type { RunSyncStatus } from './run-errors.js';
import { executeRun } from './run-handler.js';
import type { DaemonServedRoute } from './types.js';

type FakeDispatch = <TOutput = unknown>(
	req: DispatchRequest,
) => Promise<Result<TOutput, DispatchError>>;

function fakeEntry({
	route = 'demo',
	actions = {
		tabs_list: defineQuery({ handler: () => [] }),
	},
	syncStatus = { phase: 'connected' },
	dispatch = (async () => ({ data: null, error: null })) as FakeDispatch,
}: {
	route?: string;
	actions?: ActionRegistry;
	syncStatus?: SyncStatus;
	dispatch?: FakeDispatch;
} = {}): DaemonServedRoute {
	return {
		route,
		runtime: {
			collaboration: {
				actions,
				status: syncStatus,
				devices: {
					list: () => [],
				},
				dispatch,
			},
		},
	};
}

describe('executeRun peer dispatch', () => {
	test('relay RecipientOffline surfaces as PeerNotFound with sync status', async () => {
		const syncStatus: SyncStatus = {
			phase: 'connecting',
			retries: 2,
			lastError: { type: 'connection' },
		};
		const runSyncStatus = {
			phase: 'connecting',
			retries: 2,
			lastErrorType: 'connection',
		} satisfies RunSyncStatus;
		const entry = fakeEntry({
			syncStatus,
			dispatch: (async () =>
				DispatchError.RecipientOffline({ to: 'ghost' })) as FakeDispatch,
		});

		const result = await executeRun([entry], {
			actionPath: 'demo.tabs_list',
			input: undefined,
			peerTarget: 'ghost',
			waitMs: 25,
		});

		const error = expectErr(result);
		expect(error.name).toBe('PeerNotFound');
		if (error.name !== 'PeerNotFound') {
			throw new Error(`expected PeerNotFound, got ${error.name}`);
		}
		expect(error.peerTarget).toBe('ghost');
		expect(error.syncStatus).toEqual(runSyncStatus);
	});

	test('remote dispatch sends the resolved deviceId and action key', async () => {
		let invokedAction = '';
		let invokedTo = '';
		const entry = fakeEntry({
			dispatch: (async (req) => {
				invokedAction = req.action;
				invokedTo = req.to;
				return { data: [], error: null };
			}) as FakeDispatch,
		});

		const result = await executeRun([entry], {
			actionPath: 'demo.tabs_list',
			input: undefined,
			peerTarget: 'mac',
			waitMs: 25,
		});

		expectOk(result);
		expect(invokedAction).toBe('tabs_list');
		expect(invokedTo).toBe('mac');
	});

	test('non-offline DispatchError surfaces as RemoteCallFailed', async () => {
		const entry = fakeEntry({
			dispatch: (async () =>
				DispatchError.ActionFailed({
					action: 'tabs_list',
					cause: 'boom',
				})) as FakeDispatch,
		});

		const result = await executeRun([entry], {
			actionPath: 'demo.tabs_list',
			input: undefined,
			peerTarget: 'mac',
			waitMs: 25,
		});

		const error = expectErr(result);
		expect(error.name).toBe('RemoteCallFailed');
		if (error.name !== 'RemoteCallFailed') {
			throw new Error('expected RemoteCallFailed');
		}
		expect(error.cause).toMatchObject({ name: 'ActionFailed' });
	});
});

describe('executeRun route-prefixed routing', () => {
	test('invokes action under the selected daemon route', async () => {
		const entry = fakeEntry({
			route: 'notes',
			actions: {
				notes_add: defineMutation({
					handler: () => ({ body: 'hello' }),
				}),
			},
		});

		const result = await executeRun([entry], {
			actionPath: 'notes.notes_add',
			input: { body: 'hello' },
			waitMs: 25,
		});

		const data = expectOk(result);
		expect(data).toEqual({ body: 'hello' });
	});

	test('missing prefix suggests action-root-relative sibling', async () => {
		const entry = fakeEntry({
			route: 'notes',
			actions: {
				notes_add: defineMutation({
					handler: () => ({ body: 'hello' }),
				}),
			},
		});

		const result = await executeRun([entry], {
			actionPath: 'notes.notes',
			input: { body: 'hello' },
			waitMs: 25,
		});

		const error = expectErr(result);
		expect(error.name).toBe('UsageError');
		if (error.name !== 'UsageError') {
			throw new Error('expected UsageError');
		}
		expect(error.suggestions).toEqual(['  notes.notes_add  (mutation)']);
	});

	test('unknown route returns available route suggestions', async () => {
		const result = await executeRun(
			[fakeEntry({}), fakeEntry({ route: 'tasks', actions: {} })],
			{
				actionPath: 'missing.actions_add',
				input: undefined,
				waitMs: 25,
			},
		);

		const error = expectErr(result);
		expect(error.name).toBe('UsageError');
		if (error.name !== 'UsageError') {
			throw new Error('expected UsageError');
		}
		expect(error.message).toBe(
			'No daemon route "missing". Available: demo, tasks',
		);
		expect(error.suggestions).toEqual(['  demo', '  tasks']);
	});
});
