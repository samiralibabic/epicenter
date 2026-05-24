/**
 * Tests for `openCollaboration`.
 *
 * The fake `openWebSocket` resolves immediately with a socket that stays in
 * `CONNECTING` (we never call `onopen`), so the supervisor parks in
 * `attemptConnection`. That means these tests only cover the synchronous
 * setup of `openCollaboration`: the action-key guard and the `Symbol.dispose`
 * sugar. Socket-coupled behavior (presence routing, dispatch result routing,
 * disconnect settling) is intentionally out of scope here and needs a
 * different fake.
 *
 * The fake's `close() -> onclose` is what lets `ydoc.destroy()` unpark the
 * supervisor so the test process exits cleanly.
 */

import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import {
	type ActionRegistry,
	defineMutation,
	defineQuery,
} from '../shared/actions.js';
import { openCollaboration } from './open-collaboration.js';

const url = 'wss://ignored.invalid/api/rooms/test?installationId=self';

/**
 * Minimal fake WebSocket. Stays in CONNECTING (readyState 0) until `close()`
 * is called, at which point it transitions to CLOSED and fires `onclose`.
 * The supervisor assigns `binaryType`, `onopen`, `onerror`, `onmessage` on
 * the way through; those writes land on the plain object and are never read.
 */
function fakeWebSocket(): Promise<WebSocket> {
	const ws = {
		readyState: 0,
		onclose: null as ((e: CloseEvent) => void) | null,
		close() {
			if (ws.readyState === 3) return;
			ws.readyState = 3;
			ws.onclose?.({ code: 1000, reason: '' } as CloseEvent);
		},
	};
	return Promise.resolve(ws as unknown as WebSocket);
}

function setup<TActions extends ActionRegistry = ActionRegistry>(
	actions: TActions = {} as TActions,
) {
	const ydoc = new Y.Doc({ guid: 'open-collab-test' });
	const collaboration = openCollaboration<TActions>(ydoc, {
		url,
		openWebSocket: fakeWebSocket,
		onReconnectSignal: () => () => {},
		actions,
	});
	return { ydoc, collaboration };
}

describe('openCollaboration', () => {
	test('exposes the user actions verbatim', () => {
		const list = defineQuery({ handler: () => [] });
		const { ydoc, collaboration } = setup({ tabs_list: list });
		try {
			expect(collaboration.actions).toEqual({ tabs_list: list });
		} finally {
			ydoc.destroy();
		}
	});

	test('devices.list() returns [] when no remote peers have published liveness', () => {
		const { ydoc, collaboration } = setup({
			tabs_list: defineQuery({ handler: () => [] }),
		});
		try {
			expect(collaboration.devices.list()).toEqual([]);
		} finally {
			ydoc.destroy();
		}
	});

	test('dispose destroys the underlying ydoc', () => {
		const { ydoc, collaboration } = setup();
		let destroyed = 0;
		ydoc.once('destroy', () => destroyed++);
		collaboration[Symbol.dispose]();
		expect(destroyed).toBe(1);
	});
});

describe('action key validation', () => {
	test('rejects invalid action keys at the collaboration boundary', () => {
		expect(() =>
			setup({
				'tabs.close': defineMutation({ handler: () => null }),
			} as unknown as ActionRegistry),
		).toThrow(/Invalid action key "tabs\.close"/);
	});
});
