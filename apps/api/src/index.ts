/**
 * Epicenter Cloud Worker entry.
 *
 * Composes the `@epicenter/server` library in `personal` ownership mode and
 * layers cloud-only billing, admin, and dashboard surfaces on top. Self-
 * hosted team deployments live in a sibling apps/* folder and compose the
 * same library with `ownerKind: 'team'` and no Autumn middleware.
 *
 * Read top to bottom for the full URL surface of cloud.
 */

import {
	createServer,
	Room,
	requireBearerUser,
	requireCookieOrBearerUser,
	requireUrlUserIdMatchesAuth,
} from '@epicenter/server';
import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import {
	autumnAiGate,
	autumnStorageGate,
	type Env,
	ensurePlanId,
} from './autumn-gates.js';
import { billingRoutes } from './billing-routes.js';

const s = createServer({ ownerKind: 'personal', signUpPolicy: 'open' });

// Cast each library sub-app into cloud's extended Env so the chained
// `.route(...)` calls below typecheck against `Hono<Env>`. The runtime
// shape is identical; cloud just adds `planId` to Variables.
const base = s.base as unknown as Hono<Env>;
const auth = s.auth as unknown as Hono<Env>;
const session = s.session as unknown as Hono<Env>;
const rooms = s.rooms as unknown as Hono<Env>;
const assets = s.assets as unknown as Hono<Env>;
const ai = s.ai as unknown as Hono<Env>;

// Public health endpoint at root.
base.get('/', (c) =>
	c.json({ mode: 'hub', version: '0.1.0', runtime: 'cloudflare' }),
);

// Auth surface (no /api prefix; these render HTML and OAuth metadata).
base.route('/sign-in', auth).route('/consent', auth).route('/auth', auth);

// Session: authed via library middleware, no cloud-specific wrapping.
base.route('/api/session', session);

// Rooms: bearer auth + URL userId safety, then library handler. No billing
// gate for rooms today; bandwidth and DO storage are not metered.
const cloudRooms = new Hono<Env>()
	.use('/users/:userId/rooms/*', requireBearerUser, requireUrlUserIdMatchesAuth)
	.route('/', rooms);
base.route('/api', cloudRooms);

// Assets: cookie-or-bearer (dashboard SPA uses cookies), URL userId safety,
// Autumn storage gate, then library handlers. Public read is registered
// inside the library sub-app and matches before the authed paths because
// of its `{15-char id}` regex.
const cloudAssets = new Hono<Env>()
	.use(
		'/users/:userId/assets',
		requireCookieOrBearerUser,
		requireUrlUserIdMatchesAuth,
		autumnStorageGate,
	)
	.use(
		'/users/:userId/assets/*',
		requireCookieOrBearerUser,
		requireUrlUserIdMatchesAuth,
		autumnStorageGate,
	)
	.route('/', assets);
base.route('/api', cloudAssets);

// AI chat: bearer-only, plan-aware credit gate, then library handler.
const cloudAi = new Hono<Env>()
	.use('*', requireBearerUser, ensurePlanId, autumnAiGate)
	.route('/', ai);
base.route('/api/ai', cloudAi);

// Billing dashboard data plane.
base.use('/api/billing/*', requireCookieOrBearerUser);
base.route('/api/billing', billingRoutes);

// Dashboard SPA: Workers Static Assets binding serves the SvelteKit build.
base.on(
	'GET',
	['/dashboard', '/dashboard/*'],
	describeRoute({
		description: 'Dashboard SPA static fallback',
		tags: ['dashboard'],
	}),
	async (c) => {
		const assetsFetcher = c.env.ASSETS;
		if (!assetsFetcher) return c.notFound();
		const indexUrl = new URL('/dashboard/index.html', c.req.url);
		return assetsFetcher.fetch(new Request(indexUrl.toString(), c.req.raw));
	},
);

// Legacy redirect: /billing -> /dashboard.
base.get('/billing', (c) => c.redirect('/dashboard'));

/** App type for hc<AppType> in the dashboard. */
export type AppType = typeof base;

export default base;
export { Room };
