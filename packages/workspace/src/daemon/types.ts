/**
 * Daemon-side runtime types.
 *
 * `DaemonRuntime` is the contract every opened daemon extension returns:
 * async dispose plus the hosted `Collaboration<TActions>` that owns identity,
 * actions, sync, and the live-device surface.
 *
 * `DaemonServedRoute` is the narrowed route handler contract for the socket
 * app. `StartedDaemonRoute` is the lifecycle-owning route shape opened from a
 * configured daemon extension.
 */

import type { Result } from 'wellcrafted/result';
import type { DispatchError, DispatchRequest } from '../document/dispatch.js';
import type { SyncStatus } from '../document/internal/sync-supervisor.js';
import type { Collaboration } from '../document/open-collaboration.js';
import type { PresenceDevice } from '../document/presence-protocol.js';
import type { ActionRegistry } from '../shared/actions.js';
import type { MaybePromise } from '../shared/types.js';

/**
 * Collaboration fields the daemon socket app reads while serving `/peers`,
 * `/list`, and `/run`.
 */
type DaemonServedCollaboration<
	TActions extends ActionRegistry = ActionRegistry,
> = {
	actions: TActions;
	devices: {
		list(): PresenceDevice[];
	};
	status: SyncStatus;
	dispatch(req: DispatchRequest): Promise<Result<unknown, DispatchError>>;
};

/**
 * One routed runtime as served by the daemon socket app.
 *
 * Full started routes can pass through structurally, but route handlers do not
 * depend on lifecycle fields such as async disposal.
 */
export type DaemonServedRoute<
	TActions extends ActionRegistry = ActionRegistry,
> = {
	route: string;
	runtime: {
		collaboration: DaemonServedCollaboration<TActions>;
	};
};

/**
 * Fields the daemon looks at on each started runtime.
 */
export type DaemonRuntime<TActions extends ActionRegistry = ActionRegistry> = {
	/** Called by the daemon at exit. */
	[Symbol.asyncDispose](): MaybePromise<void>;

	/**
	 * The hosted collaboration. Identity, action registry, sync status, and
	 * the live-device surface for cross-route dispatch all live here.
	 */
	readonly collaboration: Collaboration<TActions>;
};

/** One configured daemon runtime hosted by the daemon. */
export type StartedDaemonRoute = {
	route: string;
	runtime: DaemonRuntime;
};
