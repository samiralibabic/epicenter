/**
 * Parse Input Tests
 *
 * These tests verify how CLI JSON input is sourced and parsed across positional
 * values (inline JSON or `@file.json`) and stdin. `parseJsonInput` throws on
 * error (no Result wrapping; see the function's jsdoc for rationale).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseJsonInput } from './parse-input.js';

describe('parseJsonInput', () => {
	let tempDir: string;

	beforeAll(() => {
		tempDir = mkdtempSync(join(tmpdir(), 'parse-input-test-'));
	});

	afterAll(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test('parses inline JSON', () => {
		expect(
			parseJsonInput<{ id: string; name: string }>({
				positional: '{"id":"1","name":"test"}',
			}),
		).toEqual({ id: '1', name: 'test' });
	});

	test('reads @file shorthand', () => {
		const filePath = join(tempDir, 'test.json');
		writeFileSync(filePath, '{"id":"2","value":42}');

		expect(
			parseJsonInput<{ id: string; value: number }>({
				positional: `@${filePath}`,
			}),
		).toEqual({ id: '2', value: 42 });
	});

	test('reads stdin content', () => {
		expect(
			parseJsonInput<{ from: string }>({ stdinContent: '{"from":"stdin"}' }),
		).toEqual({ from: 'stdin' });
	});

	test('throws on invalid JSON', () => {
		expect(() => parseJsonInput({ positional: '{invalid json}' })).toThrow(
			/Invalid JSON/,
		);
	});

	test('throws on missing @file', () => {
		expect(() =>
			parseJsonInput({ positional: '@/nonexistent/path/file.json' }),
		).toThrow(/File not found/);
	});

	test('returns undefined when no input provided', () => {
		expect(parseJsonInput({})).toBeUndefined();
	});

	test('prioritizes positional over stdin', () => {
		expect(
			parseJsonInput<{ source: string }>({
				positional: '{"source":"positional"}',
				stdinContent: '{"source":"stdin"}',
			}),
		).toEqual({ source: 'positional' });
	});
});
