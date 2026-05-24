/**
 * Personal-mode safety gate.
 *
 * Personal routes carry the authenticated user's id in the URL
 * (`/api/users/:userId/...`) so handlers can compute the partition prefix
 * without a DB lookup. The userId is not a credential, but a malicious
 * caller with their own session could otherwise reach
 * `/api/users/alice/...` while signed in as Bob.
 *
 * This middleware reads `c.req.param('userId')`, compares it to
 * `c.var.user.id`, and rejects mismatches with 403. Mount it AFTER the
 * auth middleware so `c.var.user` is populated.
 */

import { createMiddleware } from 'hono/factory';
import type { Env } from '../types.js';

export const requireUrlUserIdMatchesAuth = createMiddleware<Env>(
	async (c, next) => {
		const urlUserId = c.req.param('userId');
		if (!urlUserId || urlUserId !== c.var.user.id) {
			return c.json({ name: 'forbidden_user_mismatch' }, 403);
		}
		await next();
	},
);
