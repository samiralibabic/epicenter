import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { type } from 'arktype';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';

import type { DaemonWorkspaceDefinition } from '../daemon/define-workspace.js';
import type { ProjectDir } from '../shared/types.js';
import {
	DEFAULT_PROJECT_CONFIG_SOURCE,
	type EpicenterConfig,
	PROJECT_CONFIG_FILENAME,
} from './define-config.js';

const EpicenterConfigSchema = type({
	'+': 'reject',
	'daemon?': {
		'+': 'reject',
		'routes?': {
			'[string]': { '+': 'reject', open: 'Function' },
		},
	},
});

export const ProjectConfigError = defineErrors({
	ProjectConfigNotFound: ({
		projectConfigPath,
	}: {
		projectConfigPath: string;
	}) => ({
		message: `Project config not found at ${projectConfigPath}`,
		projectConfigPath,
	}),
});
export type ProjectConfigError = InferErrors<typeof ProjectConfigError>;

export async function loadProjectConfig(
	projectDir: ProjectDir | string,
): Promise<Result<EpicenterConfig, ProjectConfigError>> {
	const projectConfigPath = join(resolve(projectDir), PROJECT_CONFIG_FILENAME);
	if (!existsSync(projectConfigPath)) {
		return ProjectConfigError.ProjectConfigNotFound({ projectConfigPath });
	}

	const module = await importProjectConfig(projectConfigPath);
	if (!('default' in module)) {
		throw new Error(
			`loadProjectConfig: ${projectConfigPath} must default-export defineConfig(...) or defineWorkspace(...).`,
		);
	}

	// `defineWorkspace` shape: the default export IS the daemon workspace
	// definition. Wrap it into the EpicenterConfig shape, deriving the route
	// name from the project directory's basename so route-addressable code
	// (CLI, materializer logs) sees the same identifier the developer typed.
	if (isWorkspaceDefinition(module.default)) {
		const routeName = basename(resolve(projectDir));
		return Ok({
			daemon: { routes: { [routeName]: module.default } },
		});
	}

	const loaded = EpicenterConfigSchema(module.default);
	if (loaded instanceof type.errors) {
		throw new Error(
			`loadProjectConfig: ${projectConfigPath} is invalid: ${loaded.toString()}`,
		);
	}
	if (Array.isArray(loaded.daemon?.routes)) {
		throw new Error(
			`loadProjectConfig: ${projectConfigPath} is invalid: daemon.routes must be an object keyed by route name.`,
		);
	}

	return Ok(loaded as EpicenterConfig);
}

/**
 * Narrow a default-exported value to a `DaemonWorkspaceDefinition`. The
 * structural test is "has an `open` function"; the route-map shape doesn't
 * match (it has `daemon.routes`, not `open`), so the two cases are mutually
 * exclusive.
 */
function isWorkspaceDefinition(
	value: unknown,
): value is DaemonWorkspaceDefinition {
	return (
		typeof value === 'object' &&
		value !== null &&
		'open' in value &&
		typeof (value as { open: unknown }).open === 'function'
	);
}

async function importProjectConfig(
	projectConfigPath: string,
): Promise<{ default?: unknown }> {
	try {
		return (await import(pathToFileURL(projectConfigPath).href)) as {
			default?: unknown;
		};
	} catch (cause) {
		if (isDefaultConfigSelfImportMiss(projectConfigPath, cause)) {
			return { default: {} };
		}
		throw new Error(
			`loadProjectConfig: failed to load ${projectConfigPath}: ${extractErrorMessage(cause)}`,
			{ cause },
		);
	}
}

function isDefaultConfigSelfImportMiss(
	projectConfigPath: string,
	cause: unknown,
): boolean {
	return (
		extractErrorMessage(cause).includes(
			"Cannot find module '@epicenter/workspace'",
		) &&
		readFileSync(projectConfigPath, 'utf8') === DEFAULT_PROJECT_CONFIG_SOURCE
	);
}
