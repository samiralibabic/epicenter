/**
 * Project config loading tests.
 *
 * Verifies that `epicenter.config.ts` is discovered, imported, and runtime
 * validated before daemon startup consumes route maps.
 *
 * Key behaviors:
 * - missing configs return a typed not-found error
 * - daemon route maps load from the default export
 * - stale route-array and route-owned identity shapes are rejected
 * - malformed or missing default exports include the config path in failures
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { loadProjectConfig } from './load-project-config.js';

let projectDir: string;

beforeEach(() => {
	projectDir = mkdtempSync(join(tmpdir(), 'load-project-config-'));
});

afterEach(() => {
	rmSync(projectDir, { recursive: true, force: true });
});

function writeConfig(source: string): void {
	writeFileSync(join(projectDir, 'epicenter.config.ts'), source);
}

describe('loadProjectConfig', () => {
	test('returns a typed not-found error when the config is missing', async () => {
		const { data, error } = await loadProjectConfig(projectDir);
		expect(data).toBeNull();
		if (error === null) throw new Error('Expected ProjectConfigNotFound');
		expect(error).toMatchObject({
			name: 'ProjectConfigNotFound',
			projectConfigPath: join(projectDir, 'epicenter.config.ts'),
		});
	});

	test('loads an empty config', async () => {
		writeConfig('export default {};\n');

		const { data, error } = await loadProjectConfig(projectDir);
		if (error !== null) throw new Error(error.message);
		expect(data).toEqual({});
	});

	test('loads daemon route maps from the config default export', async () => {
		writeConfig(
			'export default { daemon: { routes: { demo: { open() {} } } } };\n',
		);

		const { data, error } = await loadProjectConfig(projectDir);
		if (error !== null) throw new Error(error.message);
		expect(data.daemon?.routes?.demo?.open).toBeFunction();
	});

	test('wraps a defineWorkspace default export under a single derived route', async () => {
		// Direct workspace definition (the shape `defineWorkspace` returns):
		// the loader wraps it as `{ daemon: { routes: { <basename>: def } } }`,
		// keying the route by the project directory's basename so the CLI
		// addresses it under the name the developer typed.
		writeConfig('export default { open() {} };\n');

		const { data, error } = await loadProjectConfig(projectDir);
		if (error !== null) throw new Error(error.message);

		const routes = data.daemon?.routes;
		expect(routes).toBeDefined();
		const routeNames = Object.keys(routes ?? {});
		expect(routeNames).toEqual([basename(projectDir)]);
		expect(routes?.[routeNames[0]!]?.open).toBeFunction();
	});

	test('throws with the config path when the default export is invalid', async () => {
		writeConfig(
			'export default { daemon: { routes: { demo: { open: 1 } } } };\n',
		);

		await expect(loadProjectConfig(projectDir)).rejects.toThrow(
			`loadProjectConfig: ${join(projectDir, 'epicenter.config.ts')} is invalid`,
		);
	});

	test('throws when a daemon route definition is missing open()', async () => {
		writeConfig('export default { daemon: { routes: { demo: {} } } };\n');

		await expect(loadProjectConfig(projectDir)).rejects.toThrow(
			`loadProjectConfig: ${join(projectDir, 'epicenter.config.ts')} is invalid`,
		);
	});

	test('throws when the config uses the old top-level routes array', async () => {
		writeConfig("export default { routes: [{ route: 'demo', open() {} }] };\n");

		await expect(loadProjectConfig(projectDir)).rejects.toThrow(
			`loadProjectConfig: ${join(projectDir, 'epicenter.config.ts')} is invalid`,
		);
	});

	test('throws when daemon routes are still an array', async () => {
		writeConfig('export default { daemon: { routes: [{ open() {} }] } };\n');

		await expect(loadProjectConfig(projectDir)).rejects.toThrow(
			`loadProjectConfig: ${join(projectDir, 'epicenter.config.ts')} is invalid`,
		);
	});

	test('throws when a daemon definition includes its own route', async () => {
		writeConfig(
			"export default { daemon: { routes: { demo: { route: 'demo', open() {} } } } };\n",
		);

		await expect(loadProjectConfig(projectDir)).rejects.toThrow(
			`loadProjectConfig: ${join(projectDir, 'epicenter.config.ts')} is invalid`,
		);
	});

	test('throws with the config path when the default export is missing', async () => {
		writeConfig('export const config = {};\n');

		await expect(loadProjectConfig(projectDir)).rejects.toThrow(
			`loadProjectConfig: ${join(projectDir, 'epicenter.config.ts')} must default-export`,
		);
	});

	test('throws with the config path when the config has bad syntax', async () => {
		writeConfig('export default {;\n');

		await expect(loadProjectConfig(projectDir)).rejects.toThrow(
			`loadProjectConfig: failed to load ${join(projectDir, 'epicenter.config.ts')}`,
		);
	});
});
