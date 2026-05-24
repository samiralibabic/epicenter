/**
 * Daemon-process path helpers.
 *
 * Per-project runtime: socket and metadata sidecar live under
 * `daemonRuntimeDir()` (OS runtime directory, volatile, may be tmpfs).
 * Persistent logs live under `epicenterEnv.logDir` (env-paths log
 * directory). Every file is keyed by a hash of the daemon's project
 * directory so two daemons on the same machine never collide.
 *
 * For per-workspace data layout (yjs/sqlite/markdown under `<projectDir>/.epicenter/`),
 * see `document/workspace-paths.ts`. Different audience, different rationale.
 *
 * Pure helpers: no side effects, no directory creation. The `daemon up` command
 * owns the `mkdir`/`chmod` work; consumers here are free to call these from
 * anywhere without worrying about filesystem mutation.
 */

import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { epicenterEnv } from '@epicenter/constants/node';

const SAFE_UNIX_SOCKET_PATH_BYTES = 95;

/**
 * Volatile runtime directory for daemon sockets, metadata, and lease files.
 *
 * Reads `XDG_RUNTIME_DIR` (or falls back to `os.tmpdir()`) on every call so
 * the in-process tests in `packages/cli/src/commands/up.test.ts` can give
 * each test its own socket directory by mutating env between cases.
 * Production callers read this once at boot, so per-call evaluation costs
 * nothing.
 */
export function daemonRuntimeDir(): string {
	return join(process.env.XDG_RUNTIME_DIR ?? tmpdir(), 'epicenter');
}

/**
 * Stable hash of an absolute, fs-resolved project directory path.
 *
 * Truncated to 16 hex chars (64 bits) so the resulting socket path stays
 * comfortably under the 104-char Unix-socket limit on macOS. Symlinks are
 * resolved via `realpathSync` so two equivalent paths always hash the same.
 * The dir must exist; every production caller hashes a resolved project
 * directory that daemon discovery or project lookup has already accepted.
 */
export function dirHash(dir: string): string {
	return createHash('sha256')
		.update(realpathSync(dir))
		.digest('hex')
		.slice(0, 16);
}

/** Unix-socket path for the daemon serving `dir`. */
export function socketPathFor(dir: string): string {
	const socketPath = join(daemonRuntimeDir(), `${dirHash(dir)}.sock`);
	if (Buffer.byteLength(socketPath) > SAFE_UNIX_SOCKET_PATH_BYTES) {
		throw new Error(
			`socketPathFor: resolved path is ${Buffer.byteLength(socketPath)} bytes, ` +
				`exceeds safe Unix socket limit (${SAFE_UNIX_SOCKET_PATH_BYTES}). projectDir=${dir}`,
		);
	}
	return socketPath;
}

/** Metadata JSON sidecar for the daemon serving `dir`. */
export function metadataPathFor(dir: string): string {
	return join(daemonRuntimeDir(), `${dirHash(dir)}.meta.json`);
}

/** SQLite lease file for the daemon serving `dir`. */
export function leasePathFor(dir: string): string {
	return join(daemonRuntimeDir(), `${dirHash(dir)}.lease.sqlite`);
}

/**
 * Log file for the daemon serving `dir`.
 *
 * Always lives under the user log directory (persistent), never tmpfs, so
 * the operator can read post-mortem logs after a crash or reboot.
 */
export function logPathFor(dir: string): string {
	return join(epicenterEnv.logDir, `${dirHash(dir)}.log`);
}
