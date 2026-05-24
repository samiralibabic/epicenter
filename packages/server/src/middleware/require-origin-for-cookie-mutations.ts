import { createMiddleware } from 'hono/factory';
import { parseBearer } from '../auth/resource-boundary.js';
import { TRUSTED_ORIGINS } from '../trusted-origins.js';

/**
 * CSRF guard for state-changing cookie-auth requests on `/api/*`. Cookies ride
 * on cross-site requests automatically, so a malicious page can otherwise
 * forge POST/PUT/DELETE/PATCH calls. Bearer requests are CSRF-immune (the
 * attacker page cannot read the bearer to construct the Authorization header),
 * so they skip the check.
 *
 * Cookie-auth state-changers must carry an `Origin` header in
 * {@link TRUSTED_ORIGINS}. The CORS layer in `app.ts` already restricts
 * `Origin` to the same allow-list for credentialed cross-origin requests; this
 * guard defends the missing-`Origin` case (e.g. an HTML form POST that is a
 * "simple request" per the CORS spec and would not be preflighted).
 */
export const requireOriginForCookieMutations = createMiddleware(
	async (c, next) => {
		const method = c.req.method;
		if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
			return next();
		}
		if (parseBearer(c.req.header('authorization') ?? null)) return next();
		const origin = c.req.header('origin');
		if (!origin || !TRUSTED_ORIGINS.includes(origin)) {
			return c.json({ name: 'forbidden_origin' }, 403);
		}
		await next();
	},
);
