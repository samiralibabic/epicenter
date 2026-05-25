/**
 * Daemon-process path helpers.
 *
 * Per-project runtime files (socket, metadata sidecar, SQLite lease) live
 * under `runtimeDir()` (a per-user directory at `<dataDir>/run/`).
 * Persistent logs live under the env-paths log directory. Every file is
 * keyed by a hash of the daemon's project directory so two daemons on the
 * same machine never collide.
 *
 * For per-workspace data layout (yjs/sqlite/markdown under the project
 * directory's reserved subdir), see `document/workspace-paths.ts`. Different
 * audience, different rationale.
 *
 * Pure helpers: no side effects, no directory creation. The `daemon up`
 * command owns the `mkdir`/`chmod` work; consumers here are free to call
 * these from anywhere without worrying about filesystem mutation.
 */

import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import envPaths from 'env-paths';

const SAFE_UNIX_SOCKET_PATH_BYTES = 95;

/**
 * env-paths layout for this app. Honors `XDG_DATA_HOME` / `XDG_STATE_HOME`
 * on Linux; uses `~/Library/Application Support/epicenter` and
 * `~/Library/Logs/epicenter` on macOS. Resolved once at module load.
 */
const PATHS = envPaths('epicenter', { suffix: '' });

const DEFAULT_DATA_DIR = process.env.EPICENTER_DATA_DIR ?? PATHS.data;
const DEFAULT_LOG_DIR = process.env.EPICENTER_LOG_DIR ?? PATHS.log;

/**
 * Per-user directory for daemon sockets, metadata, and lease files.
 *
 * Default: `<dataDir>/run/`, mirroring the systemd/Docker `/run/` convention
 * for transient runtime state. The path stays short enough to fit under the
 * ~104-byte Unix-socket kernel limit on macOS, where `os.tmpdir()` (~48
 * bytes for `/var/folders/...`) is too long once the per-project socket
 * suffix is appended.
 *
 * `EPICENTER_RUNTIME_DIR` overrides the default. The env var is a workspace
 * test seam: production users do not set it (the default is correct), but
 * test cases set it to a short `mkdtemp` dir under `/tmp/` to isolate from
 * each other. Read on every call so test mutations between cases take
 * effect without re-importing the module.
 */
export function runtimeDir(): string {
	return process.env.EPICENTER_RUNTIME_DIR ?? join(DEFAULT_DATA_DIR, 'run');
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
	const socketPath = join(runtimeDir(), `${dirHash(dir)}.sock`);
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
	return join(runtimeDir(), `${dirHash(dir)}.meta.json`);
}

/** SQLite lease file for the daemon serving `dir`. */
export function leasePathFor(dir: string): string {
	return join(runtimeDir(), `${dirHash(dir)}.lease.sqlite`);
}

/**
 * Log file for the daemon serving `dir`.
 *
 * Always lives under the user log directory (env-paths default,
 * `~/Library/Logs/epicenter` on macOS, `~/.local/state/epicenter` on
 * Linux), so the operator can read post-mortem logs after a crash or
 * reboot. `EPICENTER_LOG_DIR` overrides; read on every call so tests can
 * isolate.
 */
export function logPathFor(dir: string): string {
	return join(
		process.env.EPICENTER_LOG_DIR ?? DEFAULT_LOG_DIR,
		`${dirHash(dir)}.log`,
	);
}
