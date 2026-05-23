/**
 * Dispatch wire protocol: the text frames and result shape exchanged
 * between the relay (`apps/api/src/room.ts`) and dispatch clients
 * (`dispatch.ts`, `open-collaboration.ts`). Pure types, zero runtime.
 *
 * Frame flow (all four are text frames on the one authenticated WebSocket;
 * `id` is minted by the caller and echoed unchanged by the relay):
 *
 *   caller    -> relay     : `dispatch_request`  (DispatchRequestFrame)
 *   relay     -> recipient : `dispatch_inbound`  (DispatchInboundFrame)
 *   recipient -> relay     : `dispatch_response` (DispatchResponseFrame)
 *   relay     -> caller    : `dispatch_result`   (DispatchResultFrame)
 *
 * Errors carry only their discriminant fields. The human-readable message
 * is not on the wire: the caller rebuilds each error through its local
 * `defineErrors` factory, which owns the message text.
 */

import type { Result } from 'wellcrafted/result';

/** Caller -> relay: route this call to installation `to`, correlated by `id`. */
export type DispatchRequestFrame = {
	type: 'dispatch_request';
	id: string;
	to: string;
	action: string;
	input: unknown;
};

/** Relay -> recipient: run `action` with `input`; reply correlated by `id`. */
export type DispatchInboundFrame = {
	type: 'dispatch_inbound';
	id: string;
	action: string;
	input: unknown;
};

/**
 * Errors a recipient itself produces. `RecipientOffline` is deliberately
 * absent: only the relay can know a recipient is unreachable.
 */
export type ActionResponseError =
	| { name: 'ActionNotFound'; action: string }
	| { name: 'ActionFailed'; action: string; cause: string };

/** Recipient -> relay: the action outcome, correlated by `id`. */
export type DispatchResponseFrame = {
	type: 'dispatch_response';
	id: string;
	result: Result<unknown, ActionResponseError>;
};

/**
 * Relay -> caller: the dispatch outcome, correlated by `id`.
 *
 * `result` is typed `Result<unknown, unknown>`: the relay forwards the
 * recipient's reply opaquely and never inspects the error side (it only
 * produces `RecipientOffline` itself). The caller validates the error
 * against {@link DispatchErrorWire} via `asDispatchWireError`.
 */
export type DispatchResultFrame = {
	type: 'dispatch_result';
	id: string;
	result: Result<unknown, unknown>;
};

/** Every error the dispatch wire can carry: recipient errors plus the relay's own. */
export type DispatchErrorWire =
	| ActionResponseError
	| { name: 'RecipientOffline'; to: string };
