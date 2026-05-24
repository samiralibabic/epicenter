/**
 * Cookie-or-bearer authentication.
 *
 * Resolves `c.var.user` from a Better Auth session cookie if one is
 * present; otherwise falls back to an OAuth bearer for the API audience.
 * Use this on routes served to both first-party browser callers (portal,
 * dashboard, hosted UIs) and external OAuth clients (CLI, Tauri,
 * extension).
 *
 * For routes that are external-clients only (`/api/ai/*`, `/api/.../rooms/*`),
 * prefer {@link requireBearerUser}, which skips the cookie attempt.
 *
 * Ambiguous requests (both credentials present) never reach this
 * middleware; the global `singleCredential` middleware rejects them at
 * the edge.
 */

import { AuthUser } from '@epicenter/auth';
import { createMiddleware } from 'hono/factory';
import { createOAuthUnauthorizedResourceResponse } from '../auth/oauth-resource.js';
import { resolveRequestOAuthUser } from '../auth/resource-boundary.js';
import type { Env } from '../types.js';

export const requireCookieOrBearerUser = createMiddleware<Env>(
	async (c, next) => {
		const session = await c.var.auth.api.getSession({
			headers: c.req.raw.headers,
		});
		if (session) {
			c.set('user', AuthUser.assert(session.user));
			return next();
		}
		const { data: user, error } = await resolveRequestOAuthUser(c);
		if (error) return createOAuthUnauthorizedResourceResponse(c, error);
		c.set('user', user);
		await next();
	},
);

/**
 * Bearer-only authentication. Same as {@link requireCookieOrBearerUser}
 * but skips the cookie path, so the route always reports 401 with a
 * standard OAuth `WWW-Authenticate` header instead of the cookie failure
 * path. Use on protected resource routes that should never see a browser
 * cookie (rooms, AI chat).
 */
export const requireBearerUser = createMiddleware<Env>(async (c, next) => {
	const { data: user, error } = await resolveRequestOAuthUser(c);
	if (error) return createOAuthUnauthorizedResourceResponse(c, error);
	c.set('user', user);
	await next();
});
