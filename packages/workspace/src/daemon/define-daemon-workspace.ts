/**
 * `defineDaemonWorkspace`: typed entry contract for a daemon route definition.
 * A project config imports these definitions and assigns them to
 * `daemon.routes`; the host calls `open(ctx)` once on `epicenter daemon up`.
 *
 * The returned runtime shape matches `DaemonRuntime` so the socket app does
 * not branch on route origin.
 *
 * See `specs/20260520T120000-code-composed-daemon-route-map.md`.
 */

import type * as Y from 'yjs';
import type { EncryptionAttachment } from '../document/attach-encryption.js';
import type { OpenWebSocket } from '../document/internal/sync-supervisor.js';
import type { MaybePromise, ProjectDir } from '../shared/types.js';
import type { DaemonRuntime } from './types.js';

/**
 * Context handed to `open()` for one daemon route.
 *
 * The host owns auth: it refuses to call `open` when machine auth is
 * signed-out, builds the encryption attacher around the keyring lookup, and
 * passes the WebSocket opener through. Daemon code never touches the auth
 * client directly; it composes a workspace runtime out of the capabilities
 * below and returns it.
 *
 * - `projectDir` is the resolved project root (same value the daemon lease
 *   owns). Disk-writing helpers like `yjsPath` derive every absolute path
 *   from it.
 * - `route` is the config route-map key. Pinned here so routes can share
 *   the same string with logs, materializers, and installation ids.
 * - `clientId` is the deterministic Y.Doc clientID for this daemon (derived
 *   from `projectDir` so two daemons in different projects produce distinct
 *   update streams). Pass it to the workspace opener.
 * - `installationId` is the conventional collaboration installationId for the daemon
 *   side of this route (`<route>-daemon`). Pass it to `openCollaboration`.
 * - `attachEncryption` mirrors `LocalOwner.attachEncryption`: hand it a
 *   `Y.Doc` and get back the encryption attachment. The host bakes the
 *   keyring lookup (including the late-sign-out guard) into the closure so
 *   the daemon never touches auth state.
 * - `openWebSocket` is the auth-bound WebSocket factory for
 *   `openCollaboration`.
 */
export type DaemonWorkspaceContext = {
	projectDir: ProjectDir;
	route: string;
	clientId: number;
	installationId: string;
	attachEncryption: (ydoc: Y.Doc) => EncryptionAttachment;
	openWebSocket: OpenWebSocket;
};

/**
 * The definition shape every configured daemon route exports.
 *
 * `open(ctx)` opens long-lived resources and returns a `DaemonRuntime` that
 * the daemon socket app can serve immediately. The runtime owns its own async
 * dispose; the host calls it during shutdown or after a sibling open fails.
 */
export type DaemonWorkspaceDefinition<
	TRuntime extends DaemonRuntime = DaemonRuntime,
> = {
	open(ctx: DaemonWorkspaceContext): MaybePromise<TRuntime>;
};

/**
 * Define a daemon route. Pure identity at the value level; the
 * useful work is the type binding so route `daemon.ts` files get
 * IntelliSense for the context fields and the runtime return shape.
 */
export function defineDaemonWorkspace<TRuntime extends DaemonRuntime>(
	definition: DaemonWorkspaceDefinition<TRuntime>,
): DaemonWorkspaceDefinition<TRuntime> {
	return definition;
}
