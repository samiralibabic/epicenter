import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dirHash, socketPathFor } from './paths.js';

describe('daemon/paths', () => {
	const originalXdg = process.env.XDG_RUNTIME_DIR;

	afterEach(() => {
		if (originalXdg === undefined) {
			delete process.env.XDG_RUNTIME_DIR;
		} else {
			process.env.XDG_RUNTIME_DIR = originalXdg;
		}
	});

	test('dirHash is deterministic for the same absolute path', () => {
		const abs = realpathSync(tmpdir());
		expect(dirHash(abs)).toBe(dirHash(abs));
	});

	test('dirHash of a relative path equals the hash of its realpath', () => {
		// `tmpdir()` may resolve through a symlink (e.g. /tmp → /private/tmp on
		// macOS); dirHash should normalize via realpathSync so equivalent inputs
		// hash identically.
		const symlinked = tmpdir();
		const real = realpathSync(symlinked);
		expect(dirHash(symlinked)).toBe(dirHash(real));
	});

	test('socketPathFor stays under the configured safe Unix socket limit', () => {
		delete process.env.XDG_RUNTIME_DIR;
		const dir = realpathSync(tmpdir());
		expect(Buffer.byteLength(socketPathFor(dir))).toBeLessThanOrEqual(95);
	});

	test('socketPathFor rejects unsafe socket paths', () => {
		const longRuntimeDir = mkdtempSync(
			join(tmpdir(), 'epicenter-runtime-path-that-is-too-long-for-sockets-'),
		);
		process.env.XDG_RUNTIME_DIR = longRuntimeDir;
		try {
			expect(() => socketPathFor(tmpdir())).toThrow(
				/exceeds safe Unix socket limit/,
			);
		} finally {
			rmSync(longRuntimeDir, { recursive: true, force: true });
		}
	});
});
