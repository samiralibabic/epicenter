/**
 * Domain errors and response envelope for the `/run` route.
 *
 * Lives daemon-side because the route owns the wire contract: `executeRun`
 * constructs `RunError` variants in `run-handler.ts`, and the response
 * envelope (`RunResponse`) is what the route serializes to JSON. The CLI
 * command imports both for renderer typing.
 *
 * Remote call failures keep the remote client error intact so the CLI owns
 * every presentation choice for peer disconnects, timeouts, and other
 * wire-level RPC errors.
 */

import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';

import type { DispatchError } from '../document/dispatch.js';
import type {
	SyncError,
	SyncFailedReason,
} from '../document/internal/sync-supervisor.js';

export type RunSyncStatus =
	| { phase: 'offline' }
	| {
			phase: 'connecting';
			retries: number;
			lastErrorType?: SyncError['type'];
	  }
	| { phase: 'connected' }
	| { phase: 'failed'; reason: SyncFailedReason };

/**
 * CLI-specific failures of the `/run` route. Carrying the failure mode
 * in-band lets the renderer set `process.exitCode` from a single switch,
 * even when the result arrived over IPC.
 *
 * - `UsageError`: bad action key / missing sync; renderer exitCode=1.
 * - `RuntimeError`: action returned Err locally; renderer exitCode=2.
 * - `PeerNotFound`: `--peer <target>` did not resolve within `--wait`;
 *   renderer exitCode=3.
 * - `RemoteCallFailed`: peer resolved but the RPC call itself failed
 *   (timeout, peer disconnected mid-call, wire error); renderer exitCode=2.
 */
export const RunError = defineErrors({
	UsageError: ({
		message,
		suggestions,
	}: {
		message: string;
		suggestions?: string[];
	}) => ({ message, suggestions }),
	RuntimeError: ({ cause }: { cause: unknown }) => ({
		message: extractErrorMessage(cause),
		cause,
	}),
	PeerNotFound: ({
		peerTarget,
		waitMs,
		syncStatus,
	}: {
		peerTarget: string;
		waitMs: number;
		syncStatus: RunSyncStatus;
	}) => ({
		message: `no peer matches peer id "${peerTarget}"`,
		peerTarget,
		waitMs,
		syncStatus,
	}),
	RemoteCallFailed: ({
		cause,
		peerTarget,
		syncStatus,
	}: {
		peerTarget: string;
		cause: DispatchError;
		syncStatus: RunSyncStatus;
	}) => ({
		message: `remote call failed: ${cause.name}`,
		cause,
		peerTarget,
		syncStatus,
	}),
});
export type RunError = InferErrors<typeof RunError>;

/**
 * Wire shape of `/run`'s response body. The renderer narrows on
 * `error.name`.
 */
export type RunResponse = Result<unknown, RunError>;
