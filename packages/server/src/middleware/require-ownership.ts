/**
 * Deployment ownership boundary.
 *
 * One middleware that closes the matrix `(rule, URL :ownerId, auth user)`
 * into a resolved owner partition on `c.var.ownerId`:
 *
 *   1. Resolve the owner partition from `(rule, c.var.user)` via
 *      {@link resolveOwnerPartition}. In team mode this also runs the
 *      deployment's membership predicate; non-members get 403
 *      NotTeamMember before any URL is read.
 *   2. If the route declares `:ownerId`, assert the URL segment equals
 *      the resolved partition. Mismatch is 403 OwnerMismatch in both
 *      modes.
 *   3. Routes without `:ownerId` (the session endpoint) skip the URL
 *      check; the partition still resolves and attaches.
 *
 * Mount AFTER the auth middleware so `c.var.user` is populated.
 * Forgetting the mount on a route that reads `c.var.ownerId` surfaces as
 * a typecheck failure on the missing variable.
 */

import { RequestGuardError } from '@epicenter/constants/request-guard-errors';
import { createMiddleware } from 'hono/factory';
import { type OwnershipRule, resolveOwnerPartition } from '../ownership.js';
import type { Env } from '../types.js';

export function createRequireOwnership(rule: OwnershipRule) {
	return createMiddleware<Env>(async (c, next) => {
		const { data: ownerPartition, error } = await resolveOwnerPartition(
			rule,
			c,
		);
		if (error) return c.json({ data: null, error }, error.status);
		const urlOwnerId = c.req.param('ownerId');
		if (urlOwnerId !== undefined && urlOwnerId !== ownerPartition) {
			const err = RequestGuardError.OwnerMismatch();
			return c.json(err, err.error.status);
		}
		c.set('ownerId', ownerPartition);
		await next();
	});
}
