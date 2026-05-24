/**
 * Error-emission tests for the `run --peer` path.
 *
 * Covers every `DispatchError` variant. Capture `console.error` and assert
 * line-by-line. Dispatch errors are constructed via
 * `DispatchError.X({...}).error` so they match the wire shape exactly.
 */

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { DispatchError } from '@epicenter/workspace';
import { emitRemoteCallError } from './run';

function captureErrors() {
	const lines: string[] = [];
	const spy = spyOn(console, 'error').mockImplementation(
		(...args: unknown[]) => {
			lines.push(args.map((a) => String(a)).join(' '));
		},
	);
	return {
		lines,
		restore: () => spy.mockRestore(),
	};
}

describe('emitRemoteCallError', () => {
	let cap: ReturnType<typeof captureErrors>;
	afterEach(() => cap?.restore());

	// The daemon owns the dispatch deadline (`AbortSignal.timeout(waitMs)`), so
	// a `Cancelled` dispatch error always means the `--wait` timeout. The abort
	// reason never survives the daemon's JSON response, so it is not inspected.
	test('Cancelled prints the timeout label', () => {
		cap = captureErrors();
		emitRemoteCallError(
			'macbook-pro',
			DispatchError.Cancelled({ reason: 'ignored' }).error,
		);
		expect(cap.lines).toEqual(['error: timeout calling macbook-pro']);
	});

	test('ActionNotFound labels with peer id', () => {
		cap = captureErrors();
		emitRemoteCallError(
			'macbook-pro',
			DispatchError.ActionNotFound({ action: 'tabs_close_all' }).error,
		);
		expect(cap.lines).toEqual([
			'error: ActionNotFound "tabs_close_all" on macbook-pro',
		]);
	});

	test('ActionFailed surfaces underlying cause', () => {
		cap = captureErrors();
		emitRemoteCallError(
			'macbook-pro',
			DispatchError.ActionFailed({
				action: 'tabs_close',
				cause: 'handler boom',
			}).error,
		);
		expect(cap.lines).toEqual([
			'error: "tabs_close" failed on macbook-pro: handler boom',
		]);
	});

	test('RecipientOffline labels the peer as gone', () => {
		cap = captureErrors();
		emitRemoteCallError(
			'macbook-pro',
			DispatchError.RecipientOffline({ to: 'macbook-pro' }).error,
		);
		expect(cap.lines).toEqual([
			'error: peer macbook-pro went offline before responding',
		]);
	});

	test('NetworkFailed surfaces the transport cause', () => {
		cap = captureErrors();
		emitRemoteCallError(
			'macbook-pro',
			DispatchError.NetworkFailed({ cause: 'connection refused' }).error,
		);
		expect(cap.lines).toEqual([
			'error: dispatch to macbook-pro failed: connection refused',
		]);
	});
});
