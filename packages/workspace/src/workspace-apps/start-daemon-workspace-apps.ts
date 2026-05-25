/**
 * Config-routed daemon route startup.
 *
 * `startDaemonWorkspaceApps()` is the daemon entry point: validate the routes
 * from `epicenter.config.ts`, run every `open(ctx)` in parallel, and either
 * return the started runtimes or dispose the successfully opened ones if any
 * sibling failed.
 *
 * The host owns auth lifecycle. It refuses to start when machine auth is
 * signed-out, then builds a per-route `DaemonWorkspaceContext` carrying the
 * lazy `keyring` reader (with a sign-out guard) plus the auth-derived
 * function refs (`openWebSocket`, `onReconnectSignal`) the route forwards
 * into `openCollaboration`.
 */

import { resolve } from 'node:path';
import type { OwnerId } from '@epicenter/constants/identity';
import type { Keyring } from '@epicenter/encryption';
import { Err, Ok, type Result } from 'wellcrafted/result';

import type {
	DaemonWorkspaceContext,
	DaemonWorkspaceDefinition,
} from '../daemon/define-workspace.js';
import type { StartedDaemonRoute } from '../daemon/index.js';
import { validateDaemonRouteNames } from '../daemon/route-validation.js';
import { asDeviceId } from '../document/device-id.js';
import { hashYDocClientId } from '../shared/client-id.js';
import type { ProjectDir } from '../shared/types.js';
import type { WorkspaceAuthClient } from './auth-client.js';
import { WorkspaceAppError } from './errors.js';

export type StartDaemonWorkspaceAppsOptions = {
	projectDir: ProjectDir | string;
	auth: WorkspaceAuthClient;
	routes: Readonly<Record<string, DaemonWorkspaceDefinition>>;
};

/**
 * Bring every configured daemon route online.
 *
 * Opens run in parallel because each route owns its own resources. If any
 * open fails, every successfully opened runtime is disposed before returning
 * the first failure as a structured error.
 */
export async function startDaemonWorkspaceApps(
	options: StartDaemonWorkspaceAppsOptions,
): Promise<Result<StartedDaemonRoute[], WorkspaceAppError>> {
	const { auth, routes } = options;
	const projectDir = resolve(options.projectDir) as ProjectDir;
	if (auth.state.status === 'signed-out') {
		return WorkspaceAppError.WorkspaceAuthSignedOut();
	}

	const routeEntries = Object.entries(routes);
	const routeIssue = validateDaemonRouteNames(
		routeEntries.map(([route]) => route),
	);
	if (routeIssue !== null) {
		return WorkspaceAppError.WorkspaceRouteRejected(routeIssue);
	}

	// Sign-out is guarded above, so `auth.state.ownerId` is stable here. Pin it
	// to each route's context so daemons build URLs without re-reading auth
	// state.
	const ownerId = auth.state.ownerId;

	const settled = await Promise.allSettled(
		routeEntries.map(([route, definition]) =>
			openOneDaemonRoute({ route, definition, projectDir, auth, ownerId }),
		),
	);

	const opened: StartedDaemonRoute[] = [];
	let firstError: WorkspaceAppError | null = null;

	for (const result of settled) {
		if (result.status !== 'fulfilled') {
			if (firstError === null) {
				firstError = WorkspaceAppError.WorkspaceOpenFailed({
					route: '<unknown>',
					cause: result.reason,
				}).error;
			}
			continue;
		}
		const value = result.value;
		if (value.error) {
			if (firstError === null) firstError = value.error;
			continue;
		}
		opened.push(value.data);
	}

	if (firstError !== null) {
		await disposeOpenedRuntimes(opened);
		return Err(firstError);
	}

	return Ok(opened);
}

async function openOneDaemonRoute({
	route,
	definition,
	projectDir,
	auth,
	ownerId,
}: {
	route: string;
	definition: DaemonWorkspaceDefinition;
	projectDir: ProjectDir;
	auth: WorkspaceAuthClient;
	ownerId: OwnerId;
}): Promise<Result<StartedDaemonRoute, WorkspaceAppError>> {
	const ctx: DaemonWorkspaceContext = {
		projectDir,
		route,
		yDocClientId: hashYDocClientId(projectDir),
		deviceId: asDeviceId(`${route}-daemon`),
		ownerId,
		keyring: createDaemonKeyringReader({ auth, route }),
		// `auth.openWebSocket` / `auth.onStateChange` are closure-based on
		// the auth client and do not read `this`, so passing the method
		// reference directly is safe (no `.bind(auth)` needed).
		openWebSocket: auth.openWebSocket,
		onReconnectSignal: auth.onStateChange,
	};
	try {
		const runtime = await definition.open(ctx);
		return Ok({ route, runtime });
	} catch (cause) {
		return WorkspaceAppError.WorkspaceOpenFailed({
			route,
			cause,
		});
	}
}

/**
 * Build the lazy keyring reader the daemon ctx hands to routes. Reads
 * `auth.state` on every call so a late sign-out throws at the next encrypted
 * write or registration site instead of the host having to re-check on every
 * open.
 */
function createDaemonKeyringReader({
	auth,
	route,
}: {
	auth: WorkspaceAuthClient;
	route: string;
}): () => Keyring {
	return () => {
		if (auth.state.status === 'signed-out') {
			throw new Error(`[${route}-daemon] auth signed-out.`);
		}
		return auth.state.keyring;
	};
}

async function disposeOpenedRuntimes(
	runtimes: readonly StartedDaemonRoute[],
): Promise<void> {
	await Promise.allSettled(
		runtimes.map((entry) =>
			Promise.resolve(entry.runtime[Symbol.asyncDispose]()),
		),
	);
}
