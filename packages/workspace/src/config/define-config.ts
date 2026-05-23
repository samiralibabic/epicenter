import type { DaemonWorkspaceDefinition } from '../daemon/define-daemon-workspace.js';
import type { DaemonRuntime } from '../daemon/types.js';

export const PROJECT_CONFIG_FILENAME = 'epicenter.config.ts';
export const DEFAULT_PROJECT_CONFIG_SOURCE = `import { defineConfig } from '@epicenter/workspace';

export default defineConfig({});
`;

export type EpicenterConfig = {
	daemon?: {
		routes?: Record<string, DaemonWorkspaceDefinition>;
	};
};

/**
 * Define a multi-route project config. Used in monorepo dev configs that
 * register multiple daemon workspaces under one project root.
 *
 * For single-workspace projects (the canonical shape per
 * `specs/20260522T220000-workspace-project-layout.md`), prefer
 * `defineWorkspace` and default-export it directly.
 */
export function defineConfig(config: EpicenterConfig): EpicenterConfig {
	return config;
}

/**
 * Define a single-workspace project. The returned definition is the
 * project's sole daemon workspace; the loader assigns the route name from
 * the project directory's basename so existing route-addressable code paths
 * (CLI, materializer logs) keep working without explicit registration.
 *
 * For monorepo dev configs that register many workspaces under one project,
 * use `defineConfig({ daemon: { routes: { ... } } })` instead.
 *
 * @example
 * ```ts
 * // <project>/epicenter.config.ts
 * import { defineWorkspace } from '@epicenter/workspace';
 *
 * export default defineWorkspace({
 *   async open({ projectDir, route, openWebSocket, installationId }) {
 *     // build the workspace, attach materializers, return infrastructure
 *   },
 * });
 * ```
 */
export function defineWorkspace<TRuntime extends DaemonRuntime>(
	definition: DaemonWorkspaceDefinition<TRuntime>,
): DaemonWorkspaceDefinition<TRuntime> {
	return definition;
}
