import { unlinkSync } from 'node:fs';

import { bestEffortSync } from './best-effort.js';
import { unlinkMetadata } from './metadata.js';
import { socketPathFor } from './paths.js';

/**
 * Best-effort socket-file cleanup. `Bun.serve.stop()` already unlinks on
 * graceful shutdown; this is the manual sweep for orphan-detection paths.
 */
export function unlinkSocketFile(socketPath: string): void {
	bestEffortSync(() => unlinkSync(socketPath));
}

/** Sweep runtime-dir files that identify a daemon for one project. */
export function sweepDaemonRuntimeFiles(projectDir: string): void {
	unlinkSocketFile(socketPathFor(projectDir));
	unlinkMetadata(projectDir);
}
