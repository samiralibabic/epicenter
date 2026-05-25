/**
 * `/api/session` sub-app.
 *
 * Returns the authenticated user, the `ownerId` the request resolves
 * through, and the per-owner workspace keyring. Clients cache the response
 * so workspace boot, local-storage keying, and Yjs decryption work offline.
 *
 * The keyring is derived from a per-owner HKDF label via the deployment's
 * root keyring (`ENCRYPTION_SECRETS`). The label IS the `ownerId`: personal
 * owners get a per-user keyring (`ownerId === userId`); every member of a
 * team deployment shares one keyring (`ownerId === TEAM_OWNER_ID`).
 *
 * {@link mountSessionApp} wires cookie-or-bearer auth and the ownership
 * boundary so `c.var.user` and `c.var.ownerId` are populated before the
 * handler runs. The handler stays mode-blind. Deployment shape is not on
 * the wire: any consumer that needs to branch derives it from
 * `ownerId === TEAM_OWNER_ID`.
 */

import type { ApiSessionResponse } from '@epicenter/auth';
import { API_ROUTES } from '@epicenter/constants/api-routes';
import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { deriveKeyring } from '../auth/encryption.js';
import { requireCookieOrBearerUser } from '../middleware/require-auth.js';
import { createRequireOwnership } from '../middleware/require-ownership.js';
import type { OwnershipRule } from '../ownership.js';
import type { Env } from '../types.js';

const sessionApp = new Hono<Env>().get(
	API_ROUTES.session.pattern,
	describeRoute({
		description: 'Return the authenticated session projection',
		tags: ['auth'],
	}),
	async (c) => {
		const ownerId = c.var.ownerId;
		const keyring = await deriveKeyring(ownerId);
		return c.json({
			user: { id: c.var.user.id, email: c.var.user.email },
			ownerId,
			keyring,
		} satisfies ApiSessionResponse);
	},
);

/**
 * Mount the session surface on a deployment's server app.
 *
 * Bundles cookie-or-bearer auth (the session endpoint is reachable from
 * both browser apps and API clients), the ownership boundary (no URL
 * `:ownerId` to compare against, but team-mode membership is still
 * enforced and `c.var.ownerId` is populated), and the route mount into
 * one call.
 */
export function mountSessionApp(
	app: Hono<Env>,
	opts: { ownership: OwnershipRule },
): void {
	app.use(
		API_ROUTES.session.pattern,
		requireCookieOrBearerUser,
		createRequireOwnership(opts.ownership),
	);
	app.route('/', sessionApp);
}
