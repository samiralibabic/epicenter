/**
 * Server app factory. Wires per-request lifecycle (pg connection,
 * after-response queue, auth instance, CORS, single-credential
 * normalization, CSRF) and returns a `Hono` instance the deployment
 * mounts every other sub-app on.
 *
 * Reads the deployment's API origin from {@link APPS} so the same code
 * picks the right Better Auth `baseURL` for wrangler dev, localhost, and
 * production without per-deployment branching.
 */

import { APPS, localUrl } from '@epicenter/constants/apps';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Hono } from 'hono';
import pg from 'pg';
import { createAuth } from './auth/create-auth.js';
import { ensureTrustedOAuthClients } from './auth/trusted-oauth-clients.js';
import * as schema from './db/schema/index.js';
import { corsMiddleware } from './middleware/cors.js';
import { requireOriginForCookieMutations } from './middleware/require-origin-for-cookie-mutations.js';
import { singleCredential } from './middleware/single-credential.js';
import { createDurableObjectRooms } from './room/backends/cloudflare/registry.js';
import type { Env } from './types.js';

const PRODUCTION_API_ORIGIN = APPS.API.urls[0];
const LOCAL_API_ORIGIN = localUrl(APPS.API);
// Wrangler dev serves the API custom domain over plain HTTP, so requests it
// makes report `Origin: http://api.epicenter.so`. Production Cloudflare
// upgrades the domain to HTTPS, so a real browser never sends this Origin
// against the deployed worker; it is a dev-loop artifact. Inlined here, the
// only consumer, rather than exported from trusted-origins.
const WRANGLER_DEV_API_ORIGIN = `http://${new URL(PRODUCTION_API_ORIGIN).host}`;

/**
 * Construct the parent `Hono` app every deployment mounts sub-apps onto.
 *
 * Installs four ordered request-scoped middlewares:
 *
 *   1. CORS (skips WS upgrades).
 *   2. Per-request pg connection + after-response queue.
 *   3. Better Auth context (baseURL, trusted OAuth client seed, auth
 *      instance).
 *   4. {@link singleCredential}: reject ambiguous auth and lift WS bearer
 *      subprotocol into `Authorization`.
 *
 * Then mounts the global CSRF gate for cookie-auth mutations on `/api/*`
 * and the rooms registry. The deployment is responsible for exposing a
 * health endpoint on `/`.
 */
export function createServerApp(): Hono<Env> {
	const app = new Hono<Env>();

	// 1. CORS
	app.use('*', corsMiddleware);

	// 2. Per-request pg client + after-response promise list.
	// Uses Client (not Pool) because Hyperdrive IS the connection pool.
	// Handlers push fire-and-forget promises (typically DB writes) onto
	// `afterResponse`; the finally block waits for all of them to settle
	// before closing pg, so writes that outlive the response don't hit a
	// closed client.
	app.use('*', async (c, next) => {
		const client = new pg.Client({
			connectionString: c.env.HYPERDRIVE.connectionString,
		});
		const afterResponse: Promise<unknown>[] = [];
		try {
			await client.connect();
			c.set('db', drizzle(client, { schema }));
			c.set('afterResponse', afterResponse);
			await next();
		} finally {
			c.executionCtx.waitUntil(
				Promise.allSettled(afterResponse).then(() => client.end()),
			);
		}
	});

	// 3. Auth context. baseURL flips to localhost during `wrangler dev`
	// so Better Auth's signed-cookie origin matches the dev host.
	app.use('*', async (c, next) => {
		const origin = new URL(c.req.url).origin;
		const baseURL =
			origin === LOCAL_API_ORIGIN || origin === WRANGLER_DEV_API_ORIGIN
				? LOCAL_API_ORIGIN
				: PRODUCTION_API_ORIGIN;
		await ensureTrustedOAuthClients(c.var.db, baseURL);
		c.set('authBaseURL', baseURL);
		c.set(
			'auth',
			createAuth({
				db: c.var.db,
				env: c.env,
				baseURL,
			}),
		);
		await next();
	});

	// 4. Single credential normalization.
	app.use('*', singleCredential);

	// CSRF gate on every `/api/*` route. Bearer requests are CSRF-immune
	// and skip this check inside the middleware.
	app.use('/api/*', requireOriginForCookieMutations);

	// Rooms registry: bound for any sub-app that reads `c.var.rooms`.
	// The Cloudflare backend wraps `env.ROOM`; a future Bun backend wires
	// its own in-process Rooms here instead.
	app.use('/api/*', async (c, next) => {
		c.set('rooms', createDurableObjectRooms(c.env.ROOM));
		await next();
	});

	return app;
}
