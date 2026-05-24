/**
 * Tests for the live-device dispatch module.
 *
 * Covers the two pure pieces of dispatch:
 *
 *   - `runInboundDispatch`: recipient-side text-frame handler that runs
 *     the local action registry and emits a `dispatch_response`.
 *   - `interpretDispatchResult`: caller-side validation of relay
 *     `dispatch_result.result` payloads.
 *
 * The relay's `dispatch_request` / `dispatch_result` round trip is covered
 * in `apps/api/src/room.test.ts`. The caller-side transport in
 * `openCollaboration.dispatch` (pending map, response ceiling, abort,
 * disconnect sweep) is not yet unit-tested.
 */

import { describe, expect, test } from 'bun:test';
import Type from 'typebox';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { defineMutation, defineQuery } from '../shared/actions.js';
import {
	type ActionInput,
	type ActionOutput,
	DispatchError,
	interpretDispatchResult,
	runInboundDispatch,
	typedDispatch,
} from './dispatch.js';

// ════════════════════════════════════════════════════════════════════════════
// runInboundDispatch (recipient side)
// ════════════════════════════════════════════════════════════════════════════

describe('runInboundDispatch', () => {
	test('happy path: runs action and Ok-wraps the result', async () => {
		const actions = {
			noop_ping: defineQuery({ handler: () => 'pong' }),
		};
		const inbound = JSON.stringify({
			type: 'dispatch_inbound',
			id: 'i7',
			action: 'noop_ping',
			input: undefined,
		});

		const response = await runInboundDispatch({ rawFrame: inbound, actions });

		expect(response).not.toBeNull();
		const parsed = JSON.parse(response!);
		expect(parsed.type).toBe('dispatch_response');
		expect(parsed.id).toBe('i7');
		expect(parsed.result.data).toBe('pong');
	});

	test('unknown action: ActionNotFound response', async () => {
		const inbound = JSON.stringify({
			type: 'dispatch_inbound',
			id: 'i8',
			action: 'missing_action',
			input: undefined,
		});

		const response = await runInboundDispatch({
			rawFrame: inbound,
			actions: {},
		});

		const parsed = JSON.parse(response!);
		expect(parsed.result.error.name).toBe('ActionNotFound');
		expect(parsed.result.error.action).toBe('missing_action');
	});

	test('handler throws: ActionFailed with serialized cause string', async () => {
		const actions = {
			boom: defineMutation({
				handler: () => {
					throw new Error('handler exploded');
				},
			}),
		};
		const inbound = JSON.stringify({
			type: 'dispatch_inbound',
			id: 'i9',
			action: 'boom',
			input: undefined,
		});

		const response = await runInboundDispatch({ rawFrame: inbound, actions });
		const parsed = JSON.parse(response!);
		expect(parsed.result.error.name).toBe('ActionFailed');
		expect(parsed.result.error.action).toBe('boom');
		expect(typeof parsed.result.error.cause).toBe('string');
		expect(parsed.result.error.cause).toBe('handler exploded');
	});

	test('handler returns Err: ActionFailed with cause', async () => {
		const actions = {
			fail_err: defineMutation({
				handler: () => Err(new Error('domain error')),
			}),
		};
		const inbound = JSON.stringify({
			type: 'dispatch_inbound',
			id: 'i10',
			action: 'fail_err',
			input: undefined,
		});

		const response = await runInboundDispatch({ rawFrame: inbound, actions });
		const parsed = JSON.parse(response!);
		expect(parsed.result.error.name).toBe('ActionFailed');
		expect(parsed.result.error.cause).toBe('domain error');
	});

	test('malformed frame: returns null (do not tear down the socket)', async () => {
		expect(
			await runInboundDispatch({ rawFrame: '{not json', actions: {} }),
		).toBeNull();
		expect(
			await runInboundDispatch({
				rawFrame: JSON.stringify({ type: 'not_dispatch' }),
				actions: {},
			}),
		).toBeNull();
	});

	test('handler returns Ok directly: preserved as-is', async () => {
		const actions = {
			already_ok: defineQuery({ handler: () => Ok({ shape: 'preserved' }) }),
		};
		const inbound = JSON.stringify({
			type: 'dispatch_inbound',
			id: 'i11',
			action: 'already_ok',
			input: undefined,
		});
		const response = await runInboundDispatch({ rawFrame: inbound, actions });
		const parsed = JSON.parse(response!);
		expect(parsed.result.data).toEqual({ shape: 'preserved' });
	});
});

// ════════════════════════════════════════════════════════════════════════════
// interpretDispatchResult (caller side)
// ════════════════════════════════════════════════════════════════════════════

describe('interpretDispatchResult', () => {
	test('Ok body: unwraps the success payload', () => {
		const result = interpretDispatchResult(Ok({ closed: 2 }));
		const data = expectOk(result) as { closed: number };
		expect(data.closed).toBe(2);
	});

	test('Ok(null) body: success carrying null, not an error', () => {
		expect(expectOk(interpretDispatchResult(Ok(null)))).toBeNull();
	});

	test('body is not a Result: NetworkFailed', () => {
		const error = expectErr(interpretDispatchResult({ unexpected: true }));
		expect(error.name).toBe('NetworkFailed');
	});

	test('RecipientOffline: decoded from the Err body', () => {
		const error = expectErr(
			interpretDispatchResult(Err({ name: 'RecipientOffline', to: 'R_phone' })),
		);
		expect(error.name).toBe('RecipientOffline');
	});

	test('ActionNotFound: decoded with the action key', () => {
		const error = expectErr(
			interpretDispatchResult(
				Err({ name: 'ActionNotFound', action: 'tabs_close' }),
			),
		);
		expect(error.name).toBe('ActionNotFound');
		if (error.name !== 'ActionNotFound') throw new Error('unreachable');
		expect(error.action).toBe('tabs_close');
	});

	test('ActionFailed: decoded with the action key and cause', () => {
		const error = expectErr(
			interpretDispatchResult(
				Err({ name: 'ActionFailed', action: 'tabs_close', cause: 'boom' }),
			),
		);
		expect(error.name).toBe('ActionFailed');
		if (error.name !== 'ActionFailed') throw new Error('unreachable');
		expect(error.cause).toBe('boom');
	});

	test('unrecognized wire error: NetworkFailed', () => {
		const error = expectErr(interpretDispatchResult(Err({ name: 'Bogus' })));
		expect(error.name).toBe('NetworkFailed');
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Error factory hygiene
// ════════════════════════════════════════════════════════════════════════════

describe('DispatchError variant factory', () => {
	test('RecipientOffline includes the target id in the message', () => {
		const { error } = DispatchError.RecipientOffline({ to: 'R_phone' });
		expect(error).toMatchObject({ name: 'RecipientOffline', to: 'R_phone' });
		expect(error?.message).toBe('Recipient "R_phone" is offline');
	});
	test('ActionFailed carries a string cause for safe JSON round-trip', () => {
		const { error } = DispatchError.ActionFailed({
			action: 'tabs_close',
			cause: 'boom',
		});
		expect(typeof error?.cause).toBe('string');
	});
});

// ════════════════════════════════════════════════════════════════════════════
// typedDispatch (typed overlay)
// ════════════════════════════════════════════════════════════════════════════

describe('typedDispatch', () => {
	test('delegates to the wrapped dispatch with the same arguments', async () => {
		let captured: unknown = null;
		const fakeDispatch = async (req: unknown) => {
			captured = req;
			return Ok({ closedCount: 2 });
		};
		const actions = {
			tabs_close: defineMutation({
				input: Type.Object({ tabIds: Type.Array(Type.Number()) }),
				handler: ({ tabIds }) => ({ closedCount: tabIds.length }),
			}),
		};
		type Actions = typeof actions;

		const tabManager = typedDispatch<Actions>(fakeDispatch);
		const result = await tabManager({
			to: 'R_phone',
			action: 'tabs_close',
			input: { tabIds: [1, 2] },
		});

		expect(captured).toEqual({
			to: 'R_phone',
			action: 'tabs_close',
			input: { tabIds: [1, 2] },
		});
		const data = expectOk(result);
		expect(data.closedCount).toBe(2);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Type-level tests for ActionInput / ActionOutput
// ════════════════════════════════════════════════════════════════════════════

// `bun test` runs these as runtime no-ops; they exist for the TypeScript
// compiler to enforce the type-level claims via assignability.

type Equals<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
		? true
		: false;

const _typeTests = () => {
	const noInput = defineQuery({ handler: () => 'pong' });
	const withInput = defineMutation({
		input: Type.Object({ tabIds: Type.Array(Type.Number()) }),
		handler: ({ tabIds }) => ({ closedCount: tabIds.length }),
	});
	const asyncRaw = defineQuery({ handler: async () => 42 });
	const syncResult = defineMutation({
		handler: () => Ok('done') as Result<'done', { name: 'AppError' }>,
	});
	const asyncResult = defineQuery({
		handler: async () =>
			Ok({ a: 1 }) as Result<{ a: number }, { name: 'AppError' }>,
	});

	// ActionInput
	const _i1: Equals<ActionInput<typeof noInput>, { input?: never }> = true;
	const _i2: Equals<
		ActionInput<typeof withInput>,
		{ input: { tabIds: number[] } }
	> = true;

	// ActionOutput: peels Promise and Result down to T.
	const _o1: Equals<ActionOutput<typeof noInput>, string> = true;
	const _o2: Equals<
		ActionOutput<typeof withInput>,
		{ closedCount: number }
	> = true;
	const _o3: Equals<ActionOutput<typeof asyncRaw>, number> = true;
	const _o4: Equals<ActionOutput<typeof syncResult>, 'done'> = true;
	const _o5: Equals<ActionOutput<typeof asyncResult>, { a: number }> = true;

	// Call-site shape via the typed overlay.
	const dx = typedDispatch<{
		ping: typeof noInput;
		tabs_close: typeof withInput;
	}>(async () => Ok(undefined));

	// No-input action: `input` field is forbidden.
	void dx({ to: 'x', action: 'ping' });
	// @ts-expect-error -- `input` not allowed on no-input action.
	void dx({ to: 'x', action: 'ping', input: 'nope' });

	// With-input action: `input` field is required and typed.
	void dx({ to: 'x', action: 'tabs_close', input: { tabIds: [1, 2] } });
	// @ts-expect-error -- missing required input.
	void dx({ to: 'x', action: 'tabs_close' });

	// Discourage `_typeTests` from being flagged as unused; the function is
	// only evaluated by the TypeScript compiler.
	return { _i1, _i2, _o1, _o2, _o3, _o4, _o5 };
};
void _typeTests;
