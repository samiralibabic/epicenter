import type { DaemonWorkspaceDefinition } from '../daemon/define-workspace.js';

export const PROJECT_CONFIG_FILENAME = 'epicenter.config.ts';
export const DEFAULT_PROJECT_CONFIG_SOURCE = `import { defineWorkspace } from '@epicenter/workspace';

export default defineWorkspace({
	open(ctx) {
		throw new Error('epicenter.config.ts: not yet configured.');
	},
});
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
