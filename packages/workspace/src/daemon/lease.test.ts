/**
 * Daemon Lease Tests
 *
 * Verifies that the SQLite-backed daemon lease is the single ownership
 * primitive for project daemon startup.
 *
 * Key behaviors:
 * - first claimant owns the lease while its transaction stays open
 * - second claimant receives AlreadyRunning while the first lease is held
 * - releasing the first lease allows a later daemon to claim ownership
 * - release is idempotent and acquisition setup failures return LeaseFailed
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expectErr, expectOk } from 'wellcrafted/testing';

import { claimDaemonLease } from './lease.js';

function setup() {
	const oldRuntimeDir = process.env.EPICENTER_RUNTIME_DIR;
	// `/tmp/...` is short on every POSIX platform; needed because socketPathFor
	// enforces a strict path-length guard that macOS's `os.tmpdir()` would
	// blow. `EPICENTER_RUNTIME_DIR` is the workspace test seam read on every
	// `runtimeDir()` call.
	const runtimeRoot = mkdtempSync('/tmp/eps-lease-rt-');
	const workDir = mkdtempSync('/tmp/eps-lease-dir-');
	process.env.EPICENTER_RUNTIME_DIR = runtimeRoot;

	return {
		workDir,
		cleanup() {
			if (oldRuntimeDir === undefined) delete process.env.EPICENTER_RUNTIME_DIR;
			else process.env.EPICENTER_RUNTIME_DIR = oldRuntimeDir;
			rmSync(runtimeRoot, { recursive: true, force: true });
			rmSync(workDir, { recursive: true, force: true });
		},
	};
}

describe('claimDaemonLease', () => {
	test('second claimant receives AlreadyRunning while first lease is held', () => {
		const { workDir, cleanup } = setup();
		const first = claimDaemonLease(workDir);
		try {
			expectOk(first);

			const error = expectErr(claimDaemonLease(workDir));
			expect(error.name).toBe('AlreadyRunning');
		} finally {
			if (first.error === null) first.data.release();
			cleanup();
		}
	});

	test('release allows a later claimant to acquire the lease', () => {
		const { workDir, cleanup } = setup();
		try {
			const first = expectOk(claimDaemonLease(workDir));
			expect(existsSync(first.leasePath)).toBe(true);
			first.release();

			const second = claimDaemonLease(workDir);
			try {
				expectOk(second);
			} finally {
				if (second.error === null) second.data.release();
			}
		} finally {
			cleanup();
		}
	});

	test('release is idempotent and leaves the lease claimable', () => {
		const { workDir, cleanup } = setup();
		try {
			const first = expectOk(claimDaemonLease(workDir));
			first.release();
			expect(() => first.release()).not.toThrow();

			const second = expectOk(claimDaemonLease(workDir));
			second.release();
		} finally {
			cleanup();
		}
	});

	test('runtime directory setup failure returns LeaseFailed', () => {
		const oldRuntimeDir = process.env.EPICENTER_RUNTIME_DIR;
		// Point EPICENTER_RUNTIME_DIR at a regular file. The lease setup runs
		// `mkdirSync(dirname(leasePath), { recursive: true })`; with the file
		// as its parent, mkdir hits ENOTDIR and surfaces as LeaseFailed.
		const runtimeFile = join(
			'/tmp',
			`eps-lease-rt-file-${Date.now()}-${Math.random()
				.toString(36)
				.slice(2, 8)}`,
		);
		const workDir = mkdtempSync('/tmp/eps-lease-dir-');
		writeFileSync(runtimeFile, 'not a directory');
		process.env.EPICENTER_RUNTIME_DIR = `${runtimeFile}/subdir`;

		try {
			const error = expectErr(claimDaemonLease(workDir));
			expect(error.name).toBe('LeaseFailed');
		} finally {
			if (oldRuntimeDir === undefined) delete process.env.EPICENTER_RUNTIME_DIR;
			else process.env.EPICENTER_RUNTIME_DIR = oldRuntimeDir;
			rmSync(runtimeFile, { force: true });
			rmSync(workDir, { recursive: true, force: true });
		}
	});
});
