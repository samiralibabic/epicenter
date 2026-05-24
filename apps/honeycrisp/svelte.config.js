import staticAdapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		adapter: staticAdapter({
			fallback: 'index.html',
		}),
		alias: {
			$routes: './src/routes',
			'$platform/auth': './src/lib/platform/auth/auth.ts',
		},
	},
	preprocess: vitePreprocess(),
};

export default config;
