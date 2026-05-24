import { defineConfig } from 'jsrepo';

export default defineConfig({
	registries: ['@ieedan/shadcn-svelte-extras'],
	/**
	 * Path configuration for jsrepo (shadcn-svelte-extras).
	 *
	 * These are filesystem targets, not import aliases. Keep source imports
	 * relative after installation.
	 */
	paths: {
		component: './src',
		ui: './src',
		lib: './src',
		util: './src/utils',
		hook: './src/hooks',
		hooks: './src/hooks',
	},
});
