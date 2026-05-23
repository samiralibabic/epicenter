/**
 * Node-only runtime configuration: every Epicenter env var and platform
 * path users care about, resolved once at module load.
 *
 * Production env vars are set by the shell or CI before the process starts
 * and do not change. Reading them eagerly matches reality and keeps this
 * module a pure value namespace.
 *
 * Volatile per-process state (daemon sockets, metadata, lease) lives at a
 * different lifetime; see `daemonRuntimeDir()` in
 * `@epicenter/workspace/daemon` for that.
 */

import envPaths from 'env-paths';
import { EPICENTER_API_URL as DEFAULT_API_URL } from './apps.js';

const paths = envPaths('epicenter', { suffix: '' });

export const epicenterEnv = {
	apiUrl: process.env.EPICENTER_API_URL ?? DEFAULT_API_URL,
	dataDir: process.env.EPICENTER_DATA_DIR ?? paths.data,
	logDir: process.env.EPICENTER_LOG_DIR ?? paths.log,
} as const;
