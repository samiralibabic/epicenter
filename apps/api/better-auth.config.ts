/**
 * CLI-only config for Better Auth schema tools.
 *
 * This file exists solely for `@better-auth/cli generate` to introspect the auth
 * config and emit the correct Drizzle schema. It is never used at runtime: the
 * Cloudflare Worker uses `createAuth()` in `src/auth/create-auth.ts` instead.
 *
 * Both configs spread `BASE_AUTH_CONFIG` and call `authPlugins(...)` so the
 * CLI and runtime always agree on which tables exist.
 *
 * Run via:
 *   bun run auth:generate
 *
 * Env strategy:
 *   - `BETTER_AUTH_SECRET` is required in `process.env`, injected by
 *     `infisical run --env=prod` when invoked via `bun run auth:generate`.
 *   - `DATABASE_URL` is read from `process.env` if set (the `:remote` path)
 *     and otherwise falls back to the local Postgres URL parsed from
 *     `wrangler.jsonc` by `env.ts`.
 */

import { APPS } from '@epicenter/constants/apps';
import { type } from 'arktype';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { LOCAL_DATABASE_URL } from './env';
import { BASE_AUTH_CONFIG } from './src/auth/base-config';
import { authPlugins } from './src/auth/plugins';
import * as schema from './src/db/schema';

const env = type({
	BETTER_AUTH_SECRET: 'string',
	'DATABASE_URL?': 'string',
}).assert(process.env);

const client = new pg.Client({
	connectionString: env.DATABASE_URL ?? LOCAL_DATABASE_URL,
});
await client.connect();
const db = drizzle(client);
const baseURL = `http://localhost:${APPS.API.port}`;

export const auth = betterAuth({
	...BASE_AUTH_CONFIG,
	/**
	 * The CLI always runs locally, so we hardcode the dev URL. The value doesn't
	 * affect schema generation. It only prevents `oauthProvider` from crashing on
	 * `new URL('')` during plugin init. The runtime config derives baseURL from the request.
	 */
	baseURL,
	database: drizzleAdapter(db, { provider: 'pg', schema }),
	secret: env.BETTER_AUTH_SECRET,
	plugins: authPlugins(baseURL),
});
