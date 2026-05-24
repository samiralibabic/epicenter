/**
 * Unit tests for the `epicenter daemon logs` helper.
 *
 * Covers `tailLines` returning the last N lines of a file (mirrors `tail`).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { tailLines } from './logs';

let originalXdg: string | undefined;
let originalHome: string | undefined;
let runtimeRoot: string;
let homeRoot: string;

beforeEach(() => {
	originalXdg = process.env.XDG_RUNTIME_DIR;
	originalHome = process.env.HOME;
	runtimeRoot = mkdtempSync(join(tmpdir(), 'ep-logs-'));
	process.env.XDG_RUNTIME_DIR = runtimeRoot;
	mkdirSync(join(runtimeRoot, 'epicenter'), { recursive: true });
	homeRoot = mkdtempSync(join(tmpdir(), 'ep-logs-home-'));
	process.env.HOME = homeRoot;
});

afterEach(() => {
	if (originalXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
	else process.env.XDG_RUNTIME_DIR = originalXdg;
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	rmSync(runtimeRoot, { recursive: true, force: true });
	rmSync(homeRoot, { recursive: true, force: true });
});

describe('tailLines', () => {
	test('returns empty string for a missing file', () => {
		expect(tailLines(join(runtimeRoot, 'missing.log'), 10)).toBe('');
	});

	test('returns last N lines with trailing newline', () => {
		const p = join(runtimeRoot, 'a.log');
		writeFileSync(p, 'line1\nline2\nline3\nline4\n');
		expect(tailLines(p, 2)).toBe('line3\nline4\n');
	});
});
