/**
 * Pins examples/fuji to the project layout spec.
 *
 * Static checks only: marker presence, gitignore content, seed markdown,
 * package.json shape, config file uses the new path conventions. Daemon
 * behavior is covered by `apps/fuji/architecture.test.ts` and the playground
 * e2e tests; this file catches drift between the committed tree and
 * `specs/20260522T220000-workspace-project-layout.md`.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = import.meta.dir;

describe('examples/fuji follows the project layout spec', () => {
	test('marker file at project root', () => {
		expect(existsSync(join(DIR, 'epicenter.config.ts'))).toBe(true);
	});

	test('seed markdown is committed under entries/', () => {
		expect(existsSync(join(DIR, 'entries/welcome.md'))).toBe(true);
		expect(existsSync(join(DIR, 'entries/hello-fuji.md'))).toBe(true);
	});

	test('.gitignore has the .epicenter/ rule', () => {
		const gitignore = readFileSync(join(DIR, '.gitignore'), 'utf-8');
		expect(gitignore).toMatch(/^\.epicenter\/$/m);
	});

	test('package.json declares the required workspace deps', () => {
		const pkg = JSON.parse(
			readFileSync(join(DIR, 'package.json'), 'utf-8'),
		) as { dependencies?: Record<string, string> };
		expect(pkg.dependencies?.['@epicenter/workspace']).toBeDefined();
		expect(pkg.dependencies?.['@epicenter/fuji']).toBeDefined();
	});

	test('epicenter.config.ts uses the new path conventions', () => {
		const src = readFileSync(join(DIR, 'epicenter.config.ts'), 'utf-8');
		// SQLite mirror lives under .epicenter/ at the project root.
		expect(src).toContain('.epicenter');
		expect(src).toContain('sqlite.db');
		// Markdown materializer roots at the project (table name auto-appended).
		expect(src).toContain('dir: projectDir');
		// Legacy per-workspaceId helpers must not be used here.
		expect(src).not.toContain('markdownPath(');
		expect(src).not.toContain('sqlitePath(');
	});

	test('epicenter.config.ts uses defineWorkspace (single-workspace shape)', () => {
		const src = readFileSync(join(DIR, 'epicenter.config.ts'), 'utf-8');
		// Single-workspace shape: defineWorkspace default-exported directly,
		// not wrapped in defineConfig({ daemon: { routes: { ... } } }).
		expect(src).toContain('defineWorkspace');
		expect(src).toContain('export default defineWorkspace(');
		expect(src).not.toContain('defineConfig(');
		expect(src).not.toContain('daemon.routes');
		expect(src).not.toContain('daemon: { routes');
	});
});
