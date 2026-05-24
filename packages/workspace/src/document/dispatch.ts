/**
 * Live-device dispatch over the relay.
 *
 * `runInboundDispatch()` is the recipient-side handler. The supervisor
 * routes text frames here; we look up `action` in the local registry,
 * invoke it, and emit the `dispatch_response` back over the same socket.
 *
 * Liveness is consumed via the server-owned presence channel (see
 * `presence-protocol.ts` and `Collaboration.devices`). This module no
 * longer carries a liveness reader: the relay's `connections` map is the
 * source of truth, and clients learn its contents from the relay's
 * `presence` full-list text frame.
 *
 * Identity and routing in one sentence: the relay maps `installationId`
 * to "most-recently-connected open socket"; multi-tab same-install is
 * handled by positional newest-wins lookup at delivery time.
 *
 * @module
 */

import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { type ActionRegistry, invokeAction } from '../shared/actions.js';
import {
	checkDispatchErrorWire,
	checkDispatchInboundFrame,
	type DispatchErrorWire,
	type DispatchResponseFrame,
} from './dispatch-protocol.js';

// ════════════════════════════════════════════════════════════════════════════
// PUBLIC TYPES
// ════════════════════════════════════════════════════════════════════════════

// `LiveDevice` is now `PresenceDevice` from `./presence-protocol.js`: the
// wire schema is the single source of truth for the type. See that module.

/**
 * Per-call options. Required: `to`, `action`. Optional: `input` (omit
 * for no-argument actions; `JSON.stringify` drops `undefined` keys, so
 * the recipient sees no `input` field on the wire), and `signal` for
 * the dispatch deadline. With no signal, the dispatch settles at the
 * caller-side response ceiling (~90s) if the relay never answers.
 */
export type DispatchRequest = {
	to: string;
	action: string;
	input?: unknown;
	signal?: AbortSignal;
};

/**
 * Fields of one wire-error variant, minus the `name` discriminant.
 *
 * The bridge between the wire contract and the local `defineErrors`
 * factory: `DispatchError`'s wire-crossing constructors take this instead
 * of re-declaring `{ action; cause }` by hand, so a field added to
 * `DispatchErrorWire` flows into the factory param automatically.
 */
type WireErrorFields<N extends DispatchErrorWire['name']> = Omit<
	Extract<DispatchErrorWire, { name: N }>,
	'name'
>;

/**
 * Caller-side dispatch error union. Five variants:
 *
 *   - `RecipientOffline`: relay confirmed no live socket for `to` (or
 *     the recipient's socket closed mid-handler).
 *   - `ActionNotFound`: recipient has no handler for `action`.
 *   - `ActionFailed`: recipient handler threw or returned `Err`. `cause`
 *     is a serialized string (JSON cannot round-trip Error instances).
 *   - `Cancelled`: the caller's `AbortSignal` aborted before the
 *     dispatch result arrived.
 *   - `NetworkFailed`: the socket dispatch did not complete because the
 *     connection was unavailable, dropped, or returned a malformed result.
 *
 * `RecipientOffline`, `ActionNotFound`, `ActionFailed` arrive in
 * `dispatch_result` frames. `Cancelled` and `NetworkFailed` are produced
 * locally by the caller-side collaboration primitive.
 *
 * The three wire-crossing variants derive their constructor params from
 * `DispatchErrorWire` via {@link WireErrorFields}: the wire contract in
 * `dispatch-protocol.ts` is the single source for their field shapes.
 * `Cancelled` and `NetworkFailed` never cross the wire, so they have no
 * wire source and are hand-typed.
 */
export const DispatchError = defineErrors({
	RecipientOffline: (wire: WireErrorFields<'RecipientOffline'>) => ({
		message: `Recipient "${wire.to}" is offline`,
		...wire,
	}),
	ActionNotFound: (wire: WireErrorFields<'ActionNotFound'>) => ({
		message: `Target has no handler for "${wire.action}"`,
		...wire,
	}),
	ActionFailed: (wire: WireErrorFields<'ActionFailed'>) => ({
		message: `Action "${wire.action}" failed`,
		...wire,
	}),
	Cancelled: ({ reason }: { reason: unknown }) => ({
		message: 'Dispatch was cancelled',
		reason,
	}),
	NetworkFailed: ({ cause }: { cause: unknown }) => ({
		message: 'Dispatch did not complete over the relay socket',
		cause,
	}),
});
export type DispatchError = InferErrors<typeof DispatchError>;

/**
 * Project an action's handler parameters into the dispatch request's
 * `input` slot.
 *
 *   - Handler `() => R`           ->  `{ input?: never }` (field forbidden)
 *   - Handler `(i: I) => R`       ->  `{ input: I }`      (field required)
 *
 * Reads from the callable side of the action (`ActionHandler`'s variadic
 * tuple, which is `[input: Static<TInput>] | []`). Designed for object
 * spread into the typed dispatch request so the field is literally absent
 * at the call site when the action takes no argument.
 */
// biome-ignore lint/suspicious/noExplicitAny: structural callable check.
export type ActionInput<A extends (...args: any[]) => unknown> =
	Parameters<A> extends []
		? { input?: never }
		: // biome-ignore lint/suspicious/noExplicitAny: rest spread.
			Parameters<A> extends [infer I, ...any[]]
			? { input: I }
			: { input?: never };

/**
 * Project an action's handler return type into the dispatch success
 * payload, peeling the `Result<T, E>` layer (sync or async) that the wire
 * boundary consumes.
 *
 *   - `() => T`                       ->  `T`
 *   - `() => Promise<T>`              ->  `T`
 *   - `() => Result<T, E>`            ->  `T`
 *   - `() => Promise<Result<T, E>>`   ->  `T`
 *
 * `runInboundDispatch` Ok-wraps raw returns, preserves existing Results,
 * and converts `Err(E)` -> `ActionFailed` over the wire. Successful
 * remote calls always carry the inner `T` in the `data` field, never a
 * doubly-nested `Result<Result<T, E>, DispatchError>`.
 */
// biome-ignore lint/suspicious/noExplicitAny: structural callable for ReturnType.
export type ActionOutput<A extends (...args: any[]) => unknown> =
	Awaited<ReturnType<A>> extends Result<infer T, unknown>
		? T
		: Awaited<ReturnType<A>>;

/**
 * Typed overlay on `dispatch` for a known target registry. Same runtime
 * function, narrower types: action keys are constrained to `keyof
 * TTargetActions`, the `input` field is required/forbidden by the action's
 * schema, and the success branch carries the unwrapped handler return
 * (Result peeled to `T`).
 *
 * Caller-asserted: the relay routes by `installationId` only; it does not
 * prove a given install implements `TTargetActions`.
 */
export type TypedDispatch<TTargetActions extends ActionRegistry> = <
	TAction extends keyof TTargetActions & string,
>(
	req: {
		to: string;
		action: TAction;
		signal?: AbortSignal;
	} & ActionInput<TTargetActions[TAction]>,
) => Promise<Result<ActionOutput<TTargetActions[TAction]>, DispatchError>>;

/**
 * Lift the untyped `dispatch` function into a typed overlay for a known
 * target registry. The runtime call is unchanged; the helper exists to
 * make the caller-side assertion explicit and named instead of buried in
 * a variable annotation.
 *
 * ```ts
 * import { typedDispatch } from '@epicenter/workspace';
 * import type { TabManagerActions } from '@epicenter/tab-manager/actions';
 *
 * const tabManager = typedDispatch<TabManagerActions>(collab.dispatch);
 * await tabManager({
 *   to: tabManagerInstallationId,
 *   action: 'tabs_close',
 *   input: { tabIds: [1, 2] },
 * });
 * ```
 */
export function typedDispatch<TTargetActions extends ActionRegistry>(
	dispatch: (req: DispatchRequest) => Promise<Result<unknown, DispatchError>>,
): TypedDispatch<TTargetActions> {
	return dispatch as TypedDispatch<TTargetActions>;
}

// ════════════════════════════════════════════════════════════════════════════
// CALLER-SIDE DISPATCH
// ════════════════════════════════════════════════════════════════════════════

/**
 * Interpret a relay `dispatch_result.result` payload.
 *
 * The relay forwards recipient replies opaquely and can also produce its
 * own `RecipientOffline` result. This function owns the untrusted boundary:
 * it accepts only wellcrafted `Result` objects and known wire errors.
 */
export function interpretDispatchResult(
	body: unknown,
): Result<unknown, DispatchError> {
	// The dispatch body is a wellcrafted `Result`: `{ data, error }` with
	// one side null. Both the recipient (`Ok`/`Err`) and the relay
	// (`RecipientOffline` via `Err`) produce this shape; anything else is a
	// protocol fault.
	if (
		!body ||
		typeof body !== 'object' ||
		!('data' in body) ||
		!('error' in body)
	) {
		return DispatchError.NetworkFailed({
			cause: new Error('Dispatch result was not a Result'),
		});
	}

	// Discriminate on the error side only: a successful action may return
	// `null`, so `data` cannot distinguish success from failure. `body` is
	// already narrowed to `{ data: unknown; error: unknown }` by the guard
	// above, so this destructure needs no cast.
	const { data, error } = body;
	if (error === null) return Ok(data);

	// Validate the untrusted error against the TypeBox-compiled wire schema.
	// On match, hand the narrowed variant straight to its local factory: each
	// factory reads only its own fields and ignores the extra `name`.
	if (!checkDispatchErrorWire.Check(error)) {
		return DispatchError.NetworkFailed({
			cause: new Error(
				`Dispatch error was not a recognized wire variant: ${JSON.stringify(error)}`,
			),
		});
	}
	switch (error.name) {
		case 'RecipientOffline':
			return DispatchError.RecipientOffline(error);
		case 'ActionNotFound':
			return DispatchError.ActionNotFound(error);
		case 'ActionFailed':
			return DispatchError.ActionFailed(error);
	}
}

// ════════════════════════════════════════════════════════════════════════════
// RECIPIENT-SIDE INBOUND DISPATCH HANDLER
// ════════════════════════════════════════════════════════════════════════════

/**
 * Decode and run an inbound `dispatch_inbound` text frame. Returns the
 * serialized `dispatch_response` to send back over the same socket, or
 * `null` if the frame is malformed or not a `dispatch_inbound` (e.g.
 * the server pushed something we don't recognize; we ignore it rather
 * than tear down the socket from this side).
 */
export async function runInboundDispatch({
	rawFrame,
	actions,
}: {
	rawFrame: string;
	actions: ActionRegistry;
}): Promise<string | null> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawFrame);
	} catch {
		return null;
	}

	if (!checkDispatchInboundFrame.Check(parsed)) return null;

	const { id, action, input } = parsed;

	const handler = actions[action];
	if (!handler) {
		return JSON.stringify({
			type: 'dispatch_response',
			id,
			result: Err({ name: 'ActionNotFound', action }),
		} satisfies DispatchResponseFrame);
	}

	const result = await invokeAction(handler, input);
	if (result.error !== null) {
		return JSON.stringify({
			type: 'dispatch_response',
			id,
			result: Err({
				name: 'ActionFailed',
				action,
				cause: extractCauseString(result.error),
			}),
		} satisfies DispatchResponseFrame);
	}

	return JSON.stringify({
		type: 'dispatch_response',
		id,
		result: Ok(result.data),
	} satisfies DispatchResponseFrame);
}

/**
 * Serialize an arbitrary thrown value into a safe string for the
 * `dispatch_response.result.error.cause` wire field. JSON cannot
 * round-trip `Error` instances, DOMException chains, or circular
 * references, so we collapse to a string the recipient can show or
 * log without surprises.
 */
function extractCauseString(cause: unknown): string {
	if (cause instanceof Error) return cause.message;
	if (typeof cause === 'string') return cause;
	try {
		return JSON.stringify(cause);
	} catch {
		return String(cause);
	}
}
