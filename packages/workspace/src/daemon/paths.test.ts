import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dirHash, socketPathFor } from './paths.js';

describe('daemon/paths', () => {
	const originalRuntimeDir = process.env.EPICENTER_RUNTIME_DIR;

	afterEach(() => {
		if (originalRuntimeDir === undefined) {
			delete process.env.EPICENTER_RUNTIME_DIR;
		} else {
			process.env.EPICENTER_RUNTIME_DIR = originalRuntimeDir;
		}
	});

	test('dirHash of a relative path equals the hash of its realpath', () => {
		// `tmpdir()` may resolve through a symlink (e.g. /tmp -> /private/tmp on
		// macOS); dirHash should normalize via realpathSync so equivalent inputs
		// hash identically.
		const symlinked = tmpdir();
		const real = realpathSync(symlinked);
		expect(dirHash(symlinked)).toBe(dirHash(real));
	});

	test('socketPathFor stays under the configured safe Unix socket limit', () => {
		const dir = realpathSync(tmpdir());
		expect(Buffer.byteLength(socketPathFor(dir))).toBeLessThanOrEqual(95);
	});

	test('socketPathFor rejects unsafe socket paths', () => {
		// Override the runtime dir with a pathologically long path so the
		// resolved socket path overflows the guard. Production callers never
		// see paths this long, but the guard is load-bearing so we exercise it.
		const longRuntimeDir = mkdtempSync(
			join(
				tmpdir(),
				'epicenter-runtime-path-that-is-way-too-long-for-sockets-',
			),
		);
		process.env.EPICENTER_RUNTIME_DIR = longRuntimeDir;
		try {
			expect(() => socketPathFor(tmpdir())).toThrow(
				/exceeds safe Unix socket limit/,
			);
		} finally {
			rmSync(longRuntimeDir, { recursive: true, force: true });
		}
	});
});
