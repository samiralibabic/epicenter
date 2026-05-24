/**
 * CORS middleware.
 *
 * Skips WebSocket upgrades because the 101 response headers are
 * immutable. Trusted origins come from {@link TRUSTED_ORIGINS} and are
 * shared with Better Auth so CORS and CSRF agree on the allow-list.
 */

import { cors } from 'hono/cors';
import { createMiddleware } from 'hono/factory';
import { isWebSocketUpgrade } from '../is-websocket-upgrade.js';
import { TRUSTED_ORIGINS } from '../trusted-origins.js';
import type { Env } from '../types.js';

export const corsMiddleware = createMiddleware<Env>(async (c, next) => {
	if (isWebSocketUpgrade(c)) return next();
	return cors({
		origin: (origin) =>
			origin && TRUSTED_ORIGINS.includes(origin) ? origin : undefined,
		credentials: true,
		allowHeaders: ['Content-Type', 'Authorization', 'Upgrade'],
		allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
	})(c, next);
});
