/**
 * `epicenter daemon down`: stop a running `daemon up` daemon.
 *
 * Sends `SIGTERM` to the recorded pid and polls until the process exits. The
 * daemon installs a `SIGTERM` handler that runs the same teardown as the
 * `daemon up` Ctrl-C path, so the OS signal is the whole shutdown channel:
 * there is no separate IPC `/shutdown` route. If the daemon has not exited
 * within {@link SHUTDOWN_TIMEOUT_MS} (hung handler), escalate to `SIGKILL`.
 *
 * `--all` enumerates every daemon for the current user and stops them in
 * parallel. No confirmation prompt: daemons are kill-friendly by design.
 *
 * See spec: `20260426T235000-cli-up-long-lived-peer.md` § "Process lifecycle".
 */

import { resolve } from 'node:path';
import {
	type DaemonMetadata,
	enumerateDaemons,
	readMetadata,
	unlinkMetadata,
} from '@epicenter/workspace/node';
import { cmd } from '../util/cmd.js';
import { projectOption } from '../util/common-options.js';
import { isProcessAlive } from '../util/process-alive.js';

const SHUTDOWN_TIMEOUT_MS = 1000;
const POLL_INTERVAL_MS = 50;

type Outcome = { kind: 'stopped' | 'killed'; pid: number };

/**
 * Stop a single daemon by metadata. Sends `SIGTERM`, then polls the pid until
 * it exits. Escalates to `SIGKILL` if the daemon is still alive after
 * {@link SHUTDOWN_TIMEOUT_MS}. Sweeps the metadata sidecar on the exit paths a
 * graceful daemon shutdown would not have reached it itself.
 */
async function shutdownOne(meta: DaemonMetadata): Promise<Outcome> {
	if (!isProcessAlive(meta.pid)) {
		// Already gone; clear the sidecar a crash left behind.
		unlinkMetadata(meta.dir);
		return { kind: 'stopped', pid: meta.pid };
	}

	try {
		process.kill(meta.pid, 'SIGTERM');
	} catch {
		// Raced to exit between the liveness check and the signal.
		unlinkMetadata(meta.dir);
		return { kind: 'stopped', pid: meta.pid };
	}

	const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (!isProcessAlive(meta.pid)) {
			return { kind: 'stopped', pid: meta.pid };
		}
		await new Promise((done) => setTimeout(done, POLL_INTERVAL_MS));
	}

	// The SIGTERM handler hung or ignored the signal; force the exit.
	try {
		process.kill(meta.pid, 'SIGKILL');
	} catch {
		// Exited in the gap between the last poll and the kill.
	}
	unlinkMetadata(meta.dir);
	return { kind: 'killed', pid: meta.pid };
}

export const downCommand = cmd({
	command: 'down',
	describe: 'Stop a running `epicenter daemon up` daemon.',
	builder: {
		C: projectOption,
		all: {
			type: 'boolean',
			default: false,
			description: 'Stop every running daemon for this user.',
		},
	},
	handler: async (argv) => {
		if (argv.all) {
			const outcomes = await Promise.all(
				enumerateDaemons().map((m) => shutdownOne(m)),
			);
			process.stdout.write(
				`stopped ${outcomes.length} daemon${outcomes.length === 1 ? '' : 's'}\n`,
			);
			return;
		}

		const projectDir = resolve(argv.C);
		const meta = readMetadata(projectDir);
		if (!meta) {
			process.stderr.write(`no daemon running for ${projectDir}\n`);
			return;
		}

		const outcome = await shutdownOne(meta);
		if (outcome.kind === 'stopped') {
			process.stdout.write(`stopped (pid=${outcome.pid})\n`);
		} else {
			process.stderr.write(
				`shutdown timed out, sent SIGKILL (pid=${outcome.pid})\n`,
			);
		}
	},
});
