/**
 * `defineWorkspace`: typed entry contract for a daemon workspace definition.
 *
 * The canonical single-workspace shape default-exports `defineWorkspace({...})`
 * directly from `epicenter.config.ts`; the loader assigns the route name from
 * the project directory's basename. Multi-route monorepo configs assign these
 * definitions to `defineConfig({ daemon: { routes: { ... } } })`.
 *
 * The host calls `open(ctx)` once on `epicenter daemon up`. The returned
 * runtime shape matches `DaemonRuntime` so the socket app does not branch
 * on route origin.
 *
 * See `specs/20260522T220000-workspace-project-layout.md`.
 */

import type { Owner } from '@epicenter/auth';
import type { SubjectKeyring } from '@epicenter/encryption';
import type {
	OnReconnectSignal,
	OpenWebSocketFn,
} from '../document/open-collaboration.js';
import type { MaybePromise, ProjectDir } from '../shared/types.js';
import type { DaemonRuntime } from './types.js';

/**
 * Context handed to `open()` for one daemon route.
 *
 * The host owns auth: it refuses to call `open` when machine auth is
 * signed-out, exposes the keyring lookup (with a late-sign-out guard baked
 * into the closure), and passes the auth-derived function refs through for
 * cloud sync.
 *
 * - `projectDir` is the resolved project root (same value the daemon lease
 *   owns). Disk-writing helpers like `yjsPath` derive every absolute path
 *   from it.
 * - `route` is the config route-map key. Pinned here so routes can share
 *   the same string with logs, materializers, and client ids.
 * - `yDocClientId` is the deterministic Y.Doc CRDT `clientID` for this
 *   daemon (derived from `projectDir` so two daemons in different projects
 *   produce distinct update streams). Pin it on the Y.Doc with
 *   `ydoc.clientID = ctx.yDocClientId` right after construction.
 * - `installationId` is the conventional collaboration WebSocket client id for
 *   the daemon side of this route (`<route>-daemon`). Pass it through
 *   `roomWsUrl` so it shows up in the upgrade URL as `?installationId=...`.
 * - `owner` is the workspace owner snapshotted at startup. The host refuses
 *   to start when auth is signed-out, so this value is stable for the
 *   lifetime of the daemon process; routes use it for partitioned URLs.
 * - `keyring` is the lazy reader for the current subject keyring. Pass it to
 *   `attachEncryption(ydoc, { keyring })`. The host's closure throws when
 *   auth is signed-out, so a late sign-out turns into a thrown error at the
 *   next encrypted-write or registration site rather than silent ciphertext
 *   loss.
 * - `openWebSocket` opens the relay socket for `openCollaboration`. The
 *   host wires it to `auth.openWebSocket`, which carries the bearer
 *   subprotocol.
 * - `onReconnectSignal` subscribes to auth-state transitions that should trigger
 *   a sync reconnect (token refresh, sign-in after sign-out). The host
 *   wires it to `auth.onStateChange`.
 */
export type DaemonWorkspaceContext = {
	projectDir: ProjectDir;
	route: string;
	yDocClientId: number;
	installationId: string;
	owner: Owner;
	keyring: () => SubjectKeyring;
	openWebSocket: OpenWebSocketFn;
	onReconnectSignal: OnReconnectSignal;
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
 * Define a daemon workspace. Pure identity at the value level; the useful
 * work is the type binding so `epicenter.config.ts` files get IntelliSense
 * for the context fields and the runtime return shape.
 */
export function defineWorkspace<TRuntime extends DaemonRuntime>(
	definition: DaemonWorkspaceDefinition<TRuntime>,
): DaemonWorkspaceDefinition<TRuntime> {
	return definition;
}
