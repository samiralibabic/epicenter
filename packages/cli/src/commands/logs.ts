/**
 * `epicenter daemon logs`: print recent log lines for a running daemon.
 *
 * Prints the last 50 lines and exits (mirrors `tail` defaults). To stream a
 * live daemon's log, run `tail -F` against the printed path: the OS already
 * does follow-through-rotation correctly, so the CLI does not reimplement it.
 *
 * Uses the discovered project by default. `-C <dir>` changes the discovery
 * start point.
 *
 * See spec: `20260426T235000-cli-up-long-lived-peer.md` § "Logging".
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { logPathFor } from '@epicenter/workspace/node';
import { cmd } from '../util/cmd.js';
import { projectOption } from '../util/common-options.js';

const DEFAULT_TAIL_LINES = 50;

/**
 * Read the last `n` lines of `path` and return them joined by `\n` with a
 * trailing newline (matching `tail -n` output). Returns the empty string
 * when the file is missing or empty.
 *
 * Implementation note: `readFileSync` is fine here. The log is bounded
 * to the daemon log rotation threshold before rotation, so worst-case memory
 * is small and predictable.
 */
export function tailLines(path: string, n: number): string {
	if (!existsSync(path)) return '';
	const buf = readFileSync(path, 'utf8');
	if (buf.length === 0) return '';
	const lines = buf.split('\n');
	// `split` of "a\nb\n" gives ['a','b',''], so drop the trailing empty if present.
	if (lines[lines.length - 1] === '') lines.pop();
	return `${lines.slice(-n).join('\n')}\n`;
}

export const logsCommand = cmd({
	command: 'logs',
	describe: 'Print recent log lines for a running daemon.',
	builder: {
		C: projectOption,
	},
	handler: (argv) => {
		const logPath = logPathFor(argv.C);

		if (!existsSync(logPath) || statSync(logPath).size === 0) {
			process.stderr.write(`(log file empty or missing: ${logPath})\n`);
			return;
		}

		process.stdout.write(tailLines(logPath, DEFAULT_TAIL_LINES));
		process.stderr.write(`(stream live: tail -F ${logPath})\n`);
	},
});
