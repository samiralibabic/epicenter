import {
	oauthProviderAuthServerMetadata,
	oauthProviderOpenIdConfigMetadata,
} from '@better-auth/oauth-provider';
import { oauthProviderResourceClient } from '@better-auth/oauth-provider/resource-client';
import { type ApiSessionResponse, AuthUser } from '@epicenter/auth';
import { APPS, localUrl } from '@epicenter/constants/apps';
import { sValidator } from '@hono/standard-validator';
import { type } from 'arktype';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Context } from 'hono';
import { cors } from 'hono/cors';
import { createFactory } from 'hono/factory';
import { secureHeaders } from 'hono/secure-headers';
import { describeRoute } from 'hono-openapi';
import pg from 'pg';
import { aiChatHandlers } from './ai-chat';
import { assetAuthedRoutes, assetPublicRoutes } from './asset-routes';
import { createAuth } from './auth/create-auth';
import { requireOriginForCookieMutations } from './auth/csrf';
import { deriveSubjectKeyring } from './auth/encryption';
import {
	createOAuthIssuerURL,
	OAUTH_AUTHORIZATION_SERVER_METADATA_PATH,
	OAUTH_METADATA_CACHE_CONTROL,
	OAUTH_OPENID_CONFIGURATION_PATH,
	OAUTH_PROTECTED_RESOURCE_METADATA_PATH,
} from './auth/oauth-metadata';
import { createOAuthUnauthorizedResourceResponse } from './auth/oauth-resource';
import { resolveRequestOAuthUser } from './auth/resource-boundary';
import { singleCredential } from './auth/single-credential';
import { ensureTrustedOAuthClients } from './auth/trusted-oauth-clients';
import {
	renderCliCallbackPage,
	renderConsentPage,
	renderSignedInPage,
	renderSignInPage,
} from './auth-pages';
import { createAutumn } from './autumn';
import { billingRoutes } from './billing-routes';
import { MAX_PAYLOAD_BYTES } from './constants';
import * as schema from './db/schema';
import { isWebSocketUpgrade } from './is-websocket-upgrade';
import { createDurableObjectRooms } from './room/backends/cloudflare/registry';
import type { Rooms } from './room/contracts';
import { TRUSTED_ORIGINS, WRANGLER_DEV_API_ORIGIN } from './trusted-origins';

// Re-export so wrangler types generates DurableObjectNamespace<Room>.
export { Room } from './room/backends/cloudflare/durable-object';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Db = NodePgDatabase<typeof schema>;
type Auth = ReturnType<typeof createAuth>;
type OAuthOpenIdConfigAuth = Parameters<
	typeof oauthProviderOpenIdConfigMetadata
>[0];
type OAuthAuthServerConfigAuth = Parameters<
	typeof oauthProviderAuthServerMetadata
>[0];

const PRODUCTION_API_ORIGIN = APPS.API.urls[0];
const LOCAL_API_ORIGIN = localUrl(APPS.API);

/**
 * Create a queue for fire-and-forget promises that run after the HTTP response.
 *
 * Route handlers push promises into the queue via `push()`. The middleware's
 * `finally` block calls `drain()` inside `executionCtx.waitUntil()` to keep
 * the worker alive until all promises settle. Cleanup (e.g. closing the DB
 * connection) is chained by the caller via `.then()`.
 *
 * @example
 * ```typescript
 * const afterResponse = createAfterResponseQueue();
 * c.set('afterResponse', afterResponse);
 * // ... await next() ...
 * c.executionCtx.waitUntil(afterResponse.drain().then(() => client.end()));
 * ```
 */
function createAfterResponseQueue() {
	/**
	 * Tracked promises whose resolution values are intentionally ignored.
	 * `unknown` is the semantic contract for fire-and-forget: we track these
	 * promises to completion via `Promise.allSettled`, but never inspect what
	 * they resolve to.
	 */
	const promises: Promise<unknown>[] = [];
	return {
		/** Enqueue a fire-and-forget promise to run after the response is sent. */
		push(promise: Promise<unknown>) {
			promises.push(promise);
		},
		/** Settle all queued promises. Returns a single promise suitable for `executionCtx.waitUntil()`. */
		drain() {
			return Promise.allSettled(promises);
		},
	};
}

type AfterResponseQueue = ReturnType<typeof createAfterResponseQueue>;

export type Env = {
	Bindings: Cloudflare.Env;
	Variables: {
		db: Db;
		auth: Auth;
		authBaseURL: string;
		user: AuthUser;
		afterResponse: AfterResponseQueue;
		/**
		 * Runtime-specific rooms registry. Set by middleware on `/rooms/*`
		 * so the route handlers stay backend-agnostic (they call
		 * `c.var.rooms.get(name)` instead of touching `c.env.ROOM`).
		 */
		rooms: Rooms;
		/** Current plan ID. Only set by ensureAutumnCustomer middleware on /ai/* routes. */
		planId: string | undefined;
	};
};

// ---------------------------------------------------------------------------
// Factory & App
// ---------------------------------------------------------------------------

const factory = createFactory<Env>({
	initApp: (app) => {
		// CORS: skip WebSocket upgrades (101 response headers are immutable).
		// Trusted origins live in `./trusted-origins.ts`, shared with Better Auth.
		app.use('*', async (c, next) => {
			if (isWebSocketUpgrade(c)) return next();
			return cors({
				origin: (origin) =>
					origin && TRUSTED_ORIGINS.includes(origin) ? origin : undefined,
				credentials: true,
				allowHeaders: ['Content-Type', 'Authorization', 'Upgrade'],
				allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
			})(c, next);
		});

		// Layer 1: Database: per-request pg.Client lifecycle (connect/end).
		// Uses Client (not Pool) because Hyperdrive IS the connection pool.
		app.use('*', async (c, next) => {
			// 1. Create a fresh pg connection and afterResponse queue for this request.
			const client = new pg.Client({
				connectionString: c.env.HYPERDRIVE.connectionString,
			});
			const afterResponse = createAfterResponseQueue();
			try {
				// 2. Connect and expose db + queue to downstream handlers.
				await client.connect();
				c.set('db', drizzle(client, { schema }));
				c.set('afterResponse', afterResponse);

				// 3. Run the route handler. Handlers push fire-and-forget
				//    promises (e.g. upsertDoInstance) into afterResponse.
				await next();
			} finally {
				// 4. The response has already left; Hono streams it during `await next()`.
				//    But the fire-and-forget promises are still in-flight. CF Workers
				//    would kill the isolate as soon as the response finishes, so we use
				//    `waitUntil()` to keep it alive. `drain()` settles every queued
				//    promise via `Promise.allSettled`, then `.then()` closes the pg
				//    connection, guaranteeing the client outlives all its queries.
				c.executionCtx.waitUntil(
					afterResponse.drain().then(() => client.end()),
				);
			}
		});

		// Layer 2: Auth: pure, reads db from context.
		app.use('*', async (c, next) => {
			const origin = new URL(c.req.url).origin;
			const baseURL =
				origin === LOCAL_API_ORIGIN || origin === WRANGLER_DEV_API_ORIGIN
					? LOCAL_API_ORIGIN
					: PRODUCTION_API_ORIGIN;
			await ensureTrustedOAuthClients(c.var.db, baseURL);
			c.set('authBaseURL', baseURL);
			c.set('auth', createAuth({ db: c.var.db, env: c.env, baseURL }));
			await next();
		});

		// Layer 3: Single credential. Reject ambiguous auth and lift WS bearer
		// subprotocols into Authorization. See {@link singleCredential} JSDoc.
		app.use('*', singleCredential);
	},
});

const app = factory.createApp();

// ---------------------------------------------------------------------------
// Auth middlewares
// ---------------------------------------------------------------------------

/**
 * Cookie-or-bearer authentication. Resolves `c.var.user` from a Better Auth
 * session cookie if one is present; otherwise falls back to an OAuth bearer
 * for the API audience. Use this on routes served to both first-party browser
 * callers (portal, dashboard) and external OAuth clients (CLI, Tauri,
 * extension). For routes that are external-clients only (`/ai/*`, `/rooms/*`),
 * use {@link requireOAuthUser} below.
 *
 * Ambiguous requests (both credentials present) never reach this middleware;
 * {@link singleCredential} rejects them at the edge.
 */
const requireCookieOrBearerUser = factory.createMiddleware(async (c, next) => {
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
});

app.use('/api/*', requireOriginForCookieMutations);

// Health
app.get(
	'/',
	describeRoute({
		description: 'Health check',
		tags: ['health'],
	}),
	(c) => c.json({ mode: 'hub', version: '0.1.0', runtime: 'cloudflare' }),
);

// Auth pages: server-rendered Hono JSX
app.get('/sign-in', async (c) => {
	const session = await c.var.auth.api.getSession({
		headers: c.req.raw.headers,
	});
	if (session) {
		const url = new URL(c.req.url);
		// OAuth re-entry: signed params present → continue the authorize flow
		if (url.searchParams.has('sig')) {
			return c.redirect(`/auth/oauth2/authorize${url.search}`);
		}
		// Post-signin redirect (e.g. from /device or /consent)
		const callbackURL = url.searchParams.get('callbackURL');
		if (callbackURL?.startsWith('/')) {
			return c.redirect(callbackURL);
		}
		// Already signed in, no redirect needed, show signed-in confirmation
		return c.html(
			renderSignedInPage({
				displayName: session.user.email,
				email: session.user.email,
			}),
		);
	}
	return c.html(renderSignInPage());
});
app.get(
	'/consent',
	sValidator('query', type({ 'client_id?': 'string', 'scope?': 'string' })),
	async (c) => {
		const session = await c.var.auth.api.getSession({
			headers: c.req.raw.headers,
		});
		if (!session) {
			const consentUrl = `/consent${new URL(c.req.url).search}`;
			return c.redirect(
				`/sign-in?callbackURL=${encodeURIComponent(consentUrl)}`,
			);
		}
		const { client_id: clientId, scope } = c.req.valid('query');
		return c.html(renderConsentPage({ clientId, scope }));
	},
);
// OAuth CLI callback: the OOB authorization-code flow lands here after the
// user signs in on the hosted portal. The page renders the one-time code in
// a monospace block so the user can paste it into the terminal. The code is
// useless without the PKCE verifier held in the CLI process; even so, set
// Cache-Control: no-store, no-transform to keep Cloudflare's edge from
// caching or mutating the value. secureHeaders applies CSP, X-Frame-Options,
// X-Content-Type-Options, Referrer-Policy, and HSTS as a group.
app.get(
	'/auth/cli-callback',
	describeRoute({
		description: 'CLI OAuth out-of-band callback page',
		tags: ['auth', 'oauth'],
	}),
	secureHeaders(),
	(c) => {
		c.header('Cache-Control', 'no-store, no-transform');
		return c.html(
			renderCliCallbackPage({
				code: c.req.query('code'),
				state: c.req.query('state'),
				error: c.req.query('error'),
				errorDescription: c.req.query('error_description'),
			}),
		);
	},
);
// Session projection endpoint: returns the authenticated user record and their
// local workspace identity (subject + per-subject keyring). This is the single
// Epicenter session surface every client (browser apps, browser extension, CLI)
// calls at sign-in and at cold-boot when online to refresh the persisted
// localIdentity cell.
//
// Accepts cookie OR bearer via {@link requireCookieOrBearerUser}. Bearer
// callers prove issuer, audience, signature, expiration, subject, and user
// existence inside `resolveRequestOAuthUser`; cookie callers rely on the
// Better Auth session minted within the parent domain.
app.get(
	'/api/session',
	describeRoute({
		description: 'Return the authenticated session projection',
		tags: ['auth'],
	}),
	requireCookieOrBearerUser,
	async (c) => {
		const user = c.var.user;
		return c.json({
			user,
			localIdentity: {
				subject: user.id,
				keyring: await deriveSubjectKeyring(user.id),
			},
		} satisfies ApiSessionResponse);
	},
);
// OAuth discovery. Register issuer-path routes before the /auth/* catch-all
// because Hono matches routes in registration order.
app.get(
	OAUTH_OPENID_CONFIGURATION_PATH,
	describeRoute({
		description: 'OpenID Connect discovery metadata',
		tags: ['auth', 'oauth'],
	}),
	(c) =>
		oauthProviderOpenIdConfigMetadata(c.var.auth as OAuthOpenIdConfigAuth)(
			c.req.raw,
		),
);
app.get(
	OAUTH_AUTHORIZATION_SERVER_METADATA_PATH,
	describeRoute({
		description: 'OAuth authorization server metadata',
		tags: ['auth', 'oauth'],
	}),
	(c) =>
		oauthProviderAuthServerMetadata(c.var.auth as OAuthAuthServerConfigAuth)(
			c.req.raw,
		),
);
app.get(
	OAUTH_PROTECTED_RESOURCE_METADATA_PATH,
	describeRoute({
		description: 'OAuth protected resource metadata',
		tags: ['auth', 'oauth'],
	}),
	async (c) => {
		const resource = oauthProviderResourceClient();
		const metadata = await resource.getActions().getProtectedResourceMetadata({
			resource: c.var.authBaseURL,
			authorization_servers: [createOAuthIssuerURL(c.var.authBaseURL)],
		});
		c.header('Cache-Control', OAUTH_METADATA_CACHE_CONTROL);
		return c.json(metadata);
	},
);
app.on(
	['GET', 'POST'],
	'/auth/*',
	describeRoute({
		description: 'Better Auth handler',
		tags: ['auth'],
	}),
	(c) => c.var.auth.handler(c.req.raw),
);

// Asset reads: unauthenticated (unguessable URL is the credential).
// Must be mounted before requireOAuthUser so GET requests aren't blocked.
app.route('/api/assets', assetPublicRoutes);

// Require an OAuth access token for protected app resources. Assumes
// {@link singleCredential} has already validated and normalized credentials.
const requireOAuthUser = factory.createMiddleware(async (c, next) => {
	const { data: user, error } = await resolveRequestOAuthUser(c);
	if (error) return createOAuthUnauthorizedResourceResponse(c, error);
	c.set('user', user);
	await next();
});

app.use('/ai/*', requireOAuthUser);
app.use('/rooms/*', requireOAuthUser);

// Inject the runtime-specific Rooms so /rooms/* handlers stay
// backend-agnostic. The Cloudflare registry wraps `env.ROOM`; a future
// Bun backend wires its own in-process Rooms here instead.
app.use('/rooms/*', async (c, next) => {
	c.set('rooms', createDurableObjectRooms(c.env.ROOM));
	await next();
});

app.use('/api/billing/*', requireCookieOrBearerUser);
app.use('/api/assets/*', requireCookieOrBearerUser);

// Ensure Autumn customer exists and stash planId for model gating.
// Runs after requireOAuthUser for AI routes so c.var.user is available.
app.use('/ai/*', async (c, next) => {
	const autumn = createAutumn(c.env);
	const customer = await autumn.customers.getOrCreate({
		customerId: c.var.user.id,
		email: c.var.user.email ?? undefined,
		expand: ['subscriptions.plan'],
	});
	const mainSub = customer.subscriptions?.find(
		(s: { addOn?: boolean }) => !s.addOn,
	);
	c.set('planId', mainSub?.planId ?? 'free');
	await next();
});

// Billing: redirect legacy page to dashboard SPA
app.get('/billing', (c) => c.redirect('/dashboard'));

// Dashboard SPA: static assets served by Workers Static Assets (wrangler.jsonc).
// Both `/dashboard` and `/dashboard/*` serve index.html so the SvelteKit
// router takes over on SPA routes that have no matching static file.
app.on('GET', ['/dashboard', '/dashboard/*'], async (c) => {
	const assets = c.env.ASSETS;
	if (!assets) return c.notFound();
	const indexUrl = new URL('/dashboard/index.html', c.req.url);
	return assets.fetch(new Request(indexUrl.toString(), c.req.raw));
});

// Billing API routes: typed JSON routes consumed by the dashboard SPA via hc<AppType>
app.route('/api/billing', billingRoutes);

// Asset routes: upload + delete (authed, mounted after requireOAuthUser)
app.route('/api/assets', assetAuthedRoutes);

// AI chat
app.post(
	'/ai/chat',
	describeRoute({
		description: 'Stream AI chat completions via SSE',
		tags: ['ai'],
	}),
	...aiChatHandlers,
);

// ---------------------------------------------------------------------------
// Room routes: one Room DO per named Y.Doc (gc: true)
// ---------------------------------------------------------------------------

/**
 * Resolve a route room for the authenticated subject.
 *
 * The route owns the subject boundary, so the Room DO receives the internal
 * Durable Object name and never needs to know about auth state.
 */
function resolveSubjectRoom(c: Context<Env>) {
	const roomId = c.req.param('room');
	if (roomId == null) {
		throw new Error('Room route is missing required room parameter');
	}
	return {
		roomName: `subject:${c.var.user.id}:rooms:${roomId}`,
		roomId,
	};
}

/**
 * Wrap a Uint8Array in a Response with a fresh ArrayBuffer copy.
 *
 * Yjs encoders return Uint8Array views that may share a larger internal
 * backing buffer. The copy isolates exactly the bytes that should be sent.
 */
function binaryResponse(data: Uint8Array): Response {
	const body = new ArrayBuffer(data.byteLength);
	new Uint8Array(body).set(data);
	return new Response(body, {
		headers: { 'content-type': 'application/octet-stream' },
	});
}

/**
 * Fire-and-forget upsert for DO instance tracking.
 *
 * Records that a user accessed a DO, optionally updating storage bytes.
 * Uses INSERT ON CONFLICT so the first access creates the row and
 * subsequent accesses update `lastAccessedAt` (and `storageBytes` when
 * provided). Errors are caught and logged, this is best-effort telemetry,
 * not billing authority.
 */
function upsertDoInstance(
	db: Db,
	params: {
		userId: string;
		resourceName: string;
		doName: string;
		storageBytes?: number;
	},
) {
	const now = new Date();
	return db
		.insert(schema.durableObjectInstance)
		.values({
			userId: params.userId,
			resourceName: params.resourceName,
			doName: params.doName,
			storageBytes: params.storageBytes ?? null,
			lastAccessedAt: now,
			storageMeasuredAt: params.storageBytes != null ? now : null,
		})
		.onConflictDoUpdate({
			target: schema.durableObjectInstance.doName,
			set: {
				lastAccessedAt: now,
				...(params.storageBytes != null && {
					storageBytes: params.storageBytes,
					storageMeasuredAt: now,
				}),
			},
		})
		.catch((e) => console.error('[do-tracking] upsert failed:', e));
}

// `/rooms/:room` is the single cloud sync path. A cloud doc is owned by the
// authenticated subject and addressed by its Y.Doc guid; the route resolves
// the DO name `subject:{user.id}:rooms:{room}`. Browser apps and the
// workspace daemon both build their URL with `roomWsUrl(api, ydoc.guid)`.
app.get(
	'/rooms/:room',
	describeRoute({
		description: 'Get room doc or upgrade to WebSocket',
		tags: ['rooms'],
	}),
	async (c) => {
		const { roomName, roomId } = resolveSubjectRoom(c);
		const room = c.var.rooms.get(roomName);

		if (isWebSocketUpgrade(c)) {
			c.var.afterResponse.push(
				upsertDoInstance(c.var.db, {
					userId: c.var.user.id,
					resourceName: roomId,
					doName: roomName,
				}),
			);
			return room.handleUpgrade(c.req.raw);
		}

		const { data, storageBytes } = await room.getDoc();
		c.var.afterResponse.push(
			upsertDoInstance(c.var.db, {
				userId: c.var.user.id,
				resourceName: roomId,
				doName: roomName,
				storageBytes,
			}),
		);
		return binaryResponse(data);
	},
);

app.post(
	'/rooms/:room',
	describeRoute({
		description: 'Sync room doc',
		tags: ['rooms'],
	}),
	async (c) => {
		const { roomName, roomId } = resolveSubjectRoom(c);
		const body = new Uint8Array(await c.req.raw.arrayBuffer());
		if (body.byteLength > MAX_PAYLOAD_BYTES) {
			return new Response('Payload too large', { status: 413 });
		}

		const room = c.var.rooms.get(roomName);
		const { data: synced, error } = await room.sync(body);
		if (error) {
			return new Response('Malformed sync body', { status: 400 });
		}
		const { diff, storageBytes } = synced;

		c.var.afterResponse.push(
			upsertDoInstance(c.var.db, {
				userId: c.var.user.id,
				resourceName: roomId,
				doName: roomName,
				storageBytes,
			}),
		);

		return diff ? binaryResponse(diff) : new Response(null, { status: 204 });
	},
);

/** App type for hc<AppType> in the dashboard. */
export type AppType = typeof app;

export default app;
