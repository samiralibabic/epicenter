/**
 * Bind a request handler to a unix socket via `Bun.serve`. Filesystem
 * hardening lives here; route definitions live in `app.ts`.
 *
 * - Parent directory `mkdirSync` (recursive) with mode `0700`.
 * - Socket file `chmod 0600` immediately after `Bun.serve` returns.
 * - `Bun.serve.stop()` auto-unlinks the socket file on graceful shutdown;
 *   `runtime-files.ts` owns manual orphan-sweep helpers.
 *
 * `Bun.serve({ unix })` overwrites an existing socket file without raising
 * `EADDRINUSE`, so a stale socket from a crashed daemon is clobbered on
 * bind. Ownership is decided by the SQLite daemon lease (`lease.ts`), which
 * `startDaemonServer` requires the caller to hold before binding here.
 *
 * Wire format and security model are deliberately internal; see
 * `specs/20260426T235000-cli-up-long-lived-peer.md` § "IPC wire protocol"
 * and § "Security model". The CLI is the only sanctioned client.
 */

import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

type BindUnixSocketOptions = {
	socketPath: string;
	fetch: (
		request: Request,
		server: Bun.Server<undefined>,
	) => Response | Promise<Response>;
};

/**
 * Bind `fetch` to a unix socket at `socketPath`. Returns the Bun listener so
 * the daemon body owns lifecycle. Throws on an unrecoverable bind error;
 * `startDaemonServer` maps that to `StartupError.BindFailed`.
 */
export function bindUnixSocket({
	socketPath,
	fetch,
}: BindUnixSocketOptions): Bun.Server<undefined> {
	mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });

	const server = Bun.serve({
		unix: socketPath,
		fetch,
	});

	chmodSync(socketPath, 0o600);

	return server;
}
