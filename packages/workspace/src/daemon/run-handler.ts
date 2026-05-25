/**
 * Daemon-side dispatch for the `/run` route. The Hono handler in `app.ts`
 * forwards to `executeRun` here.
 *
 * `epicenter run` is a shell shortcut for one daemon runtime primitive:
 *
 *   request.peerTarget === undefined  ->  invokeAction(...)
 *   request.peerTarget === <deviceId>  ->  collab.dispatch({ to, action, input, signal })
 *
 * The dispatch endpoint is HTTP-backed and addresses devices by
 * `deviceId` directly; the relay routes to the most-recently-connected
 * socket for that device. If the relay has no live socket for the target,
 * the dispatch resolves with `RecipientOffline`, which the `/run` route
 * surfaces as `PeerNotFound`; any other dispatch error is forwarded under
 * `RemoteCallFailed`.
 *
 * Power-user automation (loops, fan-out across peers, conditional dispatch)
 * lives in vault-style TypeScript scripts that load the workspace library
 * directly. The CLI deliberately does not grow flags that shadow scripting.
 *
 * `executeRun` returns a domain `RunResponse` that the route serializes
 * verbatim. Unexpected exceptions bubble to Hono's non-2xx response path
 * and surface as `HandlerCrashed` on the client side.
 */

import { Ok } from 'wellcrafted/result';
import type { SyncStatus } from '../document/internal/sync-supervisor.js';
import { invokeAction } from '../shared/actions.js';
import { joinDaemonActionPath, parseDaemonActionPath } from './action-path.js';
import type { RunRequest } from './app.js';
import {
	RunError,
	type RunResponse,
	type RunSyncStatus,
} from './run-errors.js';
import type { DaemonServedRoute } from './types.js';

export async function executeRun(
	routes: readonly DaemonServedRoute[],
	{ actionPath, input: actionInput, peerTarget, waitMs }: RunRequest,
): Promise<RunResponse> {
	const { routeName, localPath } = parseDaemonActionPath(actionPath);
	const routeRuntime = routes.find(
		(candidate) => candidate.route === routeName,
	);
	if (!routeRuntime) {
		const available = routes.map((candidate) => candidate.route);
		return RunError.UsageError({
			message: `No daemon route "${routeName}". Available: ${available.join(', ')}`,
			suggestions: available.map((name) => `  ${name}`),
		});
	}

	const action = routeRuntime.runtime.collaboration.actions[localPath];
	if (!action) {
		const descendants = daemonActionSuggestionLines(routeRuntime, localPath);
		if (descendants.length > 0) {
			return RunError.UsageError({
				message: `"${actionPath}" is not a runnable action.`,
				suggestions: descendants,
			});
		}
		return RunError.UsageError({
			message: `"${actionPath}" is not defined.`,
			suggestions: daemonActionNearestSiblingLines(routeRuntime, localPath),
		});
	}

	if (peerTarget !== undefined) {
		return invokeRemote({
			actionInput,
			localPath,
			peerTarget,
			routeRuntime,
			waitMs,
		});
	}

	const result = await invokeAction(action, actionInput);
	if (result.error !== null) {
		return RunError.RuntimeError({ cause: result.error });
	}
	return Ok(result.data);
}

async function invokeRemote({
	actionInput,
	localPath,
	peerTarget,
	routeRuntime,
	waitMs,
}: {
	actionInput: unknown;
	localPath: string;
	peerTarget: string;
	routeRuntime: DaemonServedRoute;
	waitMs: number;
}): Promise<RunResponse> {
	const { runtime } = routeRuntime;

	const result = await runtime.collaboration.dispatch({
		to: peerTarget,
		action: localPath,
		input: actionInput,
		signal: AbortSignal.timeout(waitMs),
	});

	if (result.error !== null) {
		const syncStatus = toRunSyncStatus(runtime.collaboration.status);
		// Translate the full `DispatchError` union into the `RunError`
		// taxonomy. `RecipientOffline` is promoted to its own variant because
		// the renderer maps it to a distinct exit code (3): "you addressed a
		// device that isn't connected" stays separate from a call that
		// reached the peer and failed. The relay owns reachability and sits
		// in the dispatch path, so no client-side presence pre-check is
		// needed (or correct). The other four variants collapse into
		// `RemoteCallFailed` (exit code 2); the `satisfies never` default
		// forces this mapping to be revisited if `DispatchError` grows.
		switch (result.error.name) {
			case 'RecipientOffline':
				return RunError.PeerNotFound({ peerTarget, waitMs, syncStatus });
			case 'ActionNotFound':
			case 'ActionFailed':
			case 'Cancelled':
			case 'NetworkFailed':
				return RunError.RemoteCallFailed({
					cause: result.error,
					peerTarget,
					syncStatus,
				});
			default:
				return result.error satisfies never;
		}
	}
	return Ok(result.data);
}

function toRunSyncStatus(status: SyncStatus): RunSyncStatus {
	switch (status.phase) {
		case 'offline':
			return { phase: 'offline' };
		case 'connected':
			return { phase: 'connected' };
		case 'connecting':
			return {
				phase: 'connecting',
				retries: status.retries,
				lastErrorType: status.lastError?.type,
			};
		case 'failed':
			return {
				phase: 'failed',
				reason: status.reason,
			};
		default:
			return status satisfies never;
	}
}

function daemonActionSuggestionLines(
	routeRuntime: DaemonServedRoute,
	prefix: string,
): string[] {
	return Object.entries(routeRuntime.runtime.collaboration.actions)
		.filter(([path]) => !prefix || path.startsWith(prefix))
		.map(
			([path, action]) =>
				`  ${joinDaemonActionPath(routeRuntime.route, path)}  (${action.type})`,
		);
}

function daemonActionNearestSiblingLines(
	routeRuntime: DaemonServedRoute,
	missedPath: string,
): string[] {
	const parts = missedPath.split('_');
	while (parts.length > 0) {
		parts.pop();
		const prefix = parts.join('_');
		const alts = daemonActionSuggestionLines(routeRuntime, prefix);
		if (alts.length > 0) return alts;
	}
	return [];
}
