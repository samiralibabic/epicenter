/**
 * Assets sub-app: owner-partitioned URL shapes for the asset CRUD surface.
 *
 * Personal mode mounts:
 *   POST /users/:userId/assets               authed upload
 *   GET  /users/:userId/assets               authed list
 *   GET  /users/:userId/assets/usage         authed usage
 *   DEL  /users/:userId/assets/:assetId      authed delete
 *   GET  /users/:userId/assets/:assetId      public read (capability URL)
 *
 * Team mode mounts the same handlers at `/assets/...` (no partition).
 *
 * Authentication and any billing gating are layered on by the deployment,
 * not by this factory. The library returns bare CRUD; cloud wraps the
 * authed paths with `requireCookieOrBearerUser`, `requireUrlUserIdMatchesAuth`,
 * and `autumnStorageGate`; team wraps with `requireCookieOrBearerUser` alone.
 */

import type { Context } from 'hono';
import { Hono } from 'hono';
import {
	createAssetAuthedRoutes,
	createAssetPublicRoutes,
} from '../asset-routes.js';
import type { Owner } from '../owner.js';
import type { Env, ServerOptions } from '../types.js';

export function createAssetsApp(opts: ServerOptions): Hono<Env> {
	const app = new Hono<Env>();

	if (opts.ownerKind === 'personal') {
		const ownerFor = (c: Context<Env>): Owner => ({
			kind: 'personal',
			userId: c.req.param('userId')!,
		});

		// Public read mounts first so the deployment's auth middleware (applied
		// at the same prefix) does not intercept GETs for the capability URL.
		app.route('/users/:userId/assets', createAssetPublicRoutes(ownerFor));
		app.route('/users/:userId/assets', createAssetAuthedRoutes(ownerFor));
	} else {
		const ownerFor = (): Owner => ({ kind: 'team' });

		app.route('/assets', createAssetPublicRoutes(ownerFor));
		app.route('/assets', createAssetAuthedRoutes(ownerFor));
	}

	return app;
}
