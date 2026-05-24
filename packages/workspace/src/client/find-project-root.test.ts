import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ProjectDir } from '../shared/types.js';
import { findProjectRoot } from './find-project-root.js';

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'find-project-root-'));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function writeProjectConfig(dir: string = root): void {
	writeFileSync(join(dir, 'epicenter.config.ts'), 'export default {};\n');
}

describe('findProjectRoot', () => {
	test('finds a project by epicenter.config.ts', () => {
		writeProjectConfig();

		expect(findProjectRoot(root)).toBe(root as ProjectDir);
	});

	test('walks up from a nested subdirectory', () => {
		writeProjectConfig();
		const nested = join(root, 'a', 'b', 'c');
		mkdirSync(nested, { recursive: true });

		expect(findProjectRoot(nested)).toBe(root as ProjectDir);
	});

	test('ignores workspaces and .epicenter as project markers', () => {
		mkdirSync(join(root, 'workspaces'));
		mkdirSync(join(root, '.epicenter'));

		expect(() => findProjectRoot(root)).toThrow(
			/no epicenter\.config\.ts found/,
		);
	});

	test('throws if no config is found before the filesystem root', () => {
		expect(() => findProjectRoot(root)).toThrow(
			`findProjectRoot: no epicenter.config.ts found walking up from ${root}.`,
		);
	});
});
