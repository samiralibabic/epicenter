import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const apiRoot = resolve(import.meta.dir, '..');
const dashboardBuild = resolve(apiRoot, '../dashboard/build/dashboard');
const devVars = resolve(apiRoot, '.dev.vars');

// The dashboard SPA is built into apps/dashboard/build/dashboard/ (SvelteKit
// adapter-static + paths.base='/dashboard'). Wrangler errors if its assets
// directory does not exist, even when the dashboard has not been built yet.
await Bun.$`mkdir -p ${dashboardBuild}`;

// Wrangler ignores CLOUDFLARE_INCLUDE_PROCESS_ENV when a .dev.vars file exists,
// so remove any stale copy before piping secrets through process.env. rm with
// force only swallows ENOENT; real failures (permissions, busy file) propagate.
await rm(devVars, { force: true });

const auth = await Bun.$`infisical --silent user get token --plain`
	.quiet()
	.nothrow();

if (auth.exitCode !== 0 || !auth.stdout.toString().trim()) {
	console.error('Not logged into Infisical.');
	console.error(
		'Running `apps/api` requires Infisical access for dev secrets (API keys, auth secret).',
	);
	console.error('Run `infisical login`, then rerun the same command.');
	console.error(
		'If you do not have Infisical access, see CONTRIBUTING.md for what you can work on without it.',
	);
	process.exit(1);
}

const wrangler =
	await Bun.$`infisical run --silent --env=dev --path=/api -- wrangler dev`
		.cwd(apiRoot)
		.env({ ...Bun.env, CLOUDFLARE_INCLUDE_PROCESS_ENV: 'true' })
		.nothrow();

process.exit(wrangler.exitCode);
