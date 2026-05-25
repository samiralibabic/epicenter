/**
 * Assets sub-app: owner-partitioned URL shapes for the asset CRUD surface.
 *
 * Uniform URL shape across modes:
 *   POST   /api/owners/:ownerId/assets              authed upload
 *   GET    /api/owners/:ownerId/assets              authed list
 *   GET    /api/owners/:ownerId/assets/usage        authed usage
 *   PATCH  /api/owners/:ownerId/assets/:assetId     authed metadata update
 *                                                    (visibility flip; future:
 *                                                     rename)
 *   DELETE /api/owners/:ownerId/assets/:assetId     authed delete
 *   GET    /api/owners/:ownerId/assets/:assetId     CONDITIONAL auth
 *
 * The conditional GET is the one shape that's new. The handler looks up
 * the row, branches on `visibility`:
 *   - 'public'  : serve bytes; no auth required.
 *   - 'private' : require an authenticated session whose actor resolves
 *                 to the URL `:ownerId` partition via the deployment's
 *                 `OwnershipRule` (personal: user.id matches; team: user
 *                 passes the membership predicate and URL is the team
 *                 sentinel).
 *
 * Because the conditional GET handles its own auth, deployments mount
 * auth ONLY on the authed patterns (list, usage, byId-PATCH/DELETE). The
 * conditional GET pattern (`/:assetId{21}`) is disjoint from those, so
 * Hono picks the right handler without registration-order tricks.
 * `mountAssetsApp` owns this composition; the deployment passes only the
 * deployment-specific policies.
 *
 * All writes still arrive with `c.var.ownerId` populated by the
 * deployment-mounted `requireOwnership` middleware. The conditional read
 * does NOT have `c.var.ownerId` (no `requireOwnership` upstream); it reads
 * `c.req.param('ownerId')` directly and constrains the DB lookup by it.
 *
 * R2 bucket is private (no public domain, no r2.dev). All reads are
 * proxied through this Worker, which sets security headers and supports
 * ETag/range. The library is billing-agnostic and only enforces the
 * platform-level limit {@link MAX_ASSET_BYTES}.
 */

import { AuthUser } from '@epicenter/auth';
import { API_ROUTES } from '@epicenter/constants/api-routes';
import { AssetError } from '@epicenter/constants/asset-errors';
import { asOwnerId } from '@epicenter/constants/identity';
import { sValidator } from '@hono/standard-validator';
import { type } from 'arktype';
import { and, desc, eq, sql } from 'drizzle-orm';
import { Hono, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { describeRoute } from 'hono-openapi';
import { customAlphabet } from 'nanoid';
import { MAX_ASSET_BYTES } from '../constants.js';
import * as schema from '../db/schema/index.js';
import { requireCookieOrBearerUser } from '../middleware/require-auth.js';
import { createRequireOwnership } from '../middleware/require-ownership.js';
import { assetKey } from '../owner.js';
import { type OwnershipRule, resolveOwnerPartition } from '../ownership.js';
import type { Env } from '../types.js';

/**
 * 21-char alphanumeric ID generator (~108 bits entropy). Used as the
 * unguessable credential portion of public asset URLs. Bumped from 15
 * chars after grounding against Signal/Bitwarden precedent and the
 * historical Slack file-token brute-force incident.
 *
 * Inlined here (rather than re-using `@epicenter/workspace`'s
 * `generateGuid`) to avoid pulling Yjs into the Cloudflare Worker
 * bundle.
 */
const generateAssetId = customAlphabet(
	'abcdefghijklmnopqrstuvwxyz0123456789',
	21,
);

const ALLOWED_MIME_TYPES = new Set([
	'image/png',
	'image/jpeg',
	'image/gif',
	'image/webp',
	'application/pdf',
]);

/**
 * Schema for the PATCH body. Multipart upload (POST) stays on manual
 * `parseBody()` + per-field checks because the `File` instance check
 * and the multi-field validation read more clearly inline than through
 * an arktype `narrow`.
 */
const PatchAssetBody = type({ visibility: "'private' | 'public'" });

function sanitizeFilename(name: string): string {
	return Array.from(name)
		.filter((ch) => {
			const code = ch.charCodeAt(0);
			return code > 0x1f && code !== 0x7f;
		})
		.join('')
		.replaceAll('"', "'")
		.trim()
		.slice(0, 255);
}

function createAssetsApp(opts: { ownership: OwnershipRule }): Hono<Env> {
	const { ownership } = opts;
	return (
		new Hono<Env>()
			// POST upload (authed).
			.post(
				API_ROUTES.assets.list.pattern,
				describeRoute({
					description: 'Upload an asset (image or PDF)',
					tags: ['assets'],
				}),
				bodyLimit({ maxSize: MAX_ASSET_BYTES }),
				async (c) => {
					const body = await c.req.parseBody();
					const file = body.file;
					if (!(file instanceof File)) {
						const err = AssetError.MissingFile();
						return c.json(err, err.error.status);
					}

					// Missing / empty visibility defaults to 'private': the
					// safer side of the publish toggle. An unrecognized value
					// is a client bug; reject explicitly.
					const rawVisibility = body.visibility;
					let visibility: 'private' | 'public';
					if (
						rawVisibility === undefined ||
						rawVisibility === null ||
						rawVisibility === ''
					) {
						visibility = 'private';
					} else if (
						rawVisibility === 'private' ||
						rawVisibility === 'public'
					) {
						visibility = rawVisibility;
					} else {
						const err = AssetError.InvalidVisibility({
							value: String(rawVisibility),
						});
						return c.json(err, err.error.status);
					}

					const sanitizedFilename = sanitizeFilename(file.name);

					if (!ALLOWED_MIME_TYPES.has(file.type)) {
						const err = AssetError.FileTypeNotAllowed({
							contentType: file.type,
							allowed: [...ALLOWED_MIME_TYPES],
						});
						return c.json(err, err.error.status);
					}

					if (file.size > MAX_ASSET_BYTES) {
						const err = AssetError.FileTooLarge({
							size: file.size,
							maxBytes: MAX_ASSET_BYTES,
						});
						return c.json(err, err.error.status);
					}

					const assetId = generateAssetId();
					const r2Key = assetKey(c.var.ownerId, assetId);

					await c.env.ASSETS_BUCKET.put(r2Key, file.stream(), {
						httpMetadata: {
							contentType: file.type,
							contentDisposition: `inline; filename="${sanitizedFilename}"`,
							// No cache-control here. The read handler picks per request
							// based on `row.visibility`; baking a value into R2 would
							// either shadow the read-time decision or go stale on flip.
						},
					});

					try {
						await c.var.db.insert(schema.asset).values({
							id: assetId,
							ownerId: c.var.ownerId,
							contentType: file.type,
							sizeBytes: file.size,
							originalName: sanitizedFilename,
							visibility,
						});
					} catch (dbError) {
						// Compensating delete - don't leave orphaned R2 objects
						await c.env.ASSETS_BUCKET.delete(r2Key).catch(() => undefined);
						throw dbError;
					}

					return c.json(
						{
							id: assetId,
							url: `${c.req.path.replace(/\/$/, '')}/${assetId}`,
							visibility,
							contentType: file.type,
							size: file.size,
							originalName: sanitizedFilename,
						},
						201,
					);
				},
			)
			// GET - List the current owner's assets
			.get(
				API_ROUTES.assets.list.pattern,
				describeRoute({
					description: "List the current owner's assets",
					tags: ['assets'],
				}),
				async (c) => {
					const assets = await c.var.db.query.asset.findMany({
						where: eq(schema.asset.ownerId, c.var.ownerId),
						orderBy: desc(schema.asset.uploadedAt),
						limit: 100,
					});
					return c.json(assets);
				},
			)
			// GET usage - Total storage in bytes
			.get(
				API_ROUTES.assets.usage.pattern,
				describeRoute({
					description: "Get the current owner's total storage usage in bytes",
					tags: ['assets'],
				}),
				async (c) => {
					const result = await c.var.db
						.select({
							total: sql<number>`COALESCE(SUM(${schema.asset.sizeBytes}), 0)`,
						})
						.from(schema.asset)
						.where(eq(schema.asset.ownerId, c.var.ownerId));
					const total = result[0]?.total ?? 0;
					return c.json({ totalBytes: total });
				},
			)
			// PATCH by id - Modify metadata (currently: visibility only)
			.patch(
				API_ROUTES.assets.byId.pattern,
				describeRoute({
					description:
						"Modify an asset's metadata (currently: visibility flip)",
					tags: ['assets'],
				}),
				sValidator('json', PatchAssetBody),
				async (c) => {
					const { assetId } = c.req.param();
					const { visibility } = c.req.valid('json');

					const [updated] = await c.var.db
						.update(schema.asset)
						.set({ visibility })
						.where(
							and(
								eq(schema.asset.id, assetId),
								eq(schema.asset.ownerId, c.var.ownerId),
							),
						)
						.returning({
							id: schema.asset.id,
							visibility: schema.asset.visibility,
						});

					if (!updated) {
						const err = AssetError.NotFound();
						return c.json(err, err.error.status);
					}
					return c.json(updated);
				},
			)
			// DELETE by id (authed).
			.delete(
				API_ROUTES.assets.byId.pattern,
				describeRoute({
					description: 'Delete an asset (owner only)',
					tags: ['assets'],
				}),
				async (c) => {
					const { assetId } = c.req.param();

					const [deleted] = await c.var.db
						.delete(schema.asset)
						.where(
							and(
								eq(schema.asset.id, assetId),
								eq(schema.asset.ownerId, c.var.ownerId),
							),
						)
						.returning({ sizeBytes: schema.asset.sizeBytes });

					if (!deleted) {
						const err = AssetError.NotFound();
						return c.json(err, err.error.status);
					}

					await c.env.ASSETS_BUCKET.delete(assetKey(c.var.ownerId, assetId));
					// Surface deleted byte count via response header so cloud's
					// storage policy can refund without re-reading the row.
					return c.body(null, 204, {
						'x-deleted-size-bytes': String(deleted.sizeBytes),
					});
				},
			)
			// GET by id (CONDITIONAL auth). The deployment must NOT layer
			// auth upstream of THIS pattern. Public assets bypass auth by
			// design; private assets run the auth + ownership check inline.
			// Private-asset auth goes through the same `resolveOwnerPartition`
			// the `requireOwnership` middleware uses, so the partition decision
			// and any team-membership check live in one place. We synthesize
			// `c.var.user` from the fetched session because no upstream auth
			// runs on this path.
			.get(
				API_ROUTES.assets.byId.pattern,
				describeRoute({
					description:
						'Read an asset by ID. Public assets serve without auth; private assets require an authenticated owner.',
					tags: ['assets'],
				}),
				async (c) => {
					const { assetId } = c.req.param();
					const urlOwnerId = asOwnerId(c.req.param('ownerId'));

					const row = await c.var.db.query.asset.findFirst({
						columns: { visibility: true },
						where: and(
							eq(schema.asset.id, assetId),
							eq(schema.asset.ownerId, urlOwnerId),
						),
					});

					if (!row) {
						const err = AssetError.NotFound();
						return c.json(err, err.error.status);
					}

					if (row.visibility === 'private') {
						const session = await c.var.auth.api.getSession({
							headers: c.req.raw.headers,
						});
						if (!session) {
							const err = AssetError.Unauthorized();
							return c.json(err, err.error.status);
						}
						c.set('user', AuthUser.assert(session.user));
						const { data: ownerPartition, error } = await resolveOwnerPartition(
							ownership,
							c,
						);
						if (error || urlOwnerId !== ownerPartition) {
							const err = AssetError.Unauthorized();
							return c.json(err, err.error.status);
						}
					}

					const object = await c.env.ASSETS_BUCKET.get(
						assetKey(urlOwnerId, assetId),
						{
							onlyIf: c.req.raw.headers,
							range: c.req.raw.headers,
						},
					);

					if (object === null) {
						const err = AssetError.NotFound();
						return c.json(err, err.error.status);
					}

					// Cache-Control differs by visibility. Private assets MUST never
					// land in a shared cache (Cloudflare edge, corporate proxy);
					// 'private, no-store' is the conservative answer. Public assets
					// get a short max-age so a publish→unpublish flip becomes visible
					// to new requests within ~60s without an explicit purge. Active
					// purge on PATCH would let us raise max-age; documented as a
					// future optimization in the spec §4.
					const cacheControl =
						row.visibility === 'public'
							? 'public, max-age=60'
							: 'private, no-store';

					// Bodyless object - precondition failed (ETag match -> 304)
					if (!('body' in object)) {
						const headers = new Headers();
						object.writeHttpMetadata(headers);
						headers.set('etag', object.httpEtag);
						headers.set('cache-control', cacheControl);
						headers.set('referrer-policy', 'no-referrer');
						return new Response(null, { status: 304, headers });
					}

					// Build response headers
					const headers = new Headers();
					object.writeHttpMetadata(headers);
					headers.set('etag', object.httpEtag);
					headers.set('cache-control', cacheControl);
					headers.set('accept-ranges', 'bytes');
					headers.set('x-content-type-options', 'nosniff');
					// Capability URL: do not let outgoing sub-resource requests carry
					// the asset URL as a Referer. The unguessable id is the credential;
					// keep it out of third-party logs and analytics.
					headers.set('referrer-policy', 'no-referrer');
					if (object.uploaded) {
						headers.set('last-modified', object.uploaded.toUTCString());
					}

					// Range request -> 206
					const range = object.range;
					if (range) {
						let start: number;
						let end: number;
						if ('suffix' in range) {
							const len = Math.min(range.suffix, object.size);
							start = object.size - len;
							end = object.size - 1;
						} else {
							start = range.offset ?? 0;
							end =
								range.length != null
									? Math.min(start + range.length - 1, object.size - 1)
									: object.size - 1;
						}
						headers.set(
							'content-range',
							`bytes ${start}-${end}/${object.size}`,
						);
						headers.set('content-length', String(end - start + 1));
						return new Response(object.body, { status: 206, headers });
					}

					headers.set('content-length', String(object.size));
					return new Response(object.body, { status: 200, headers });
				},
			)
	);
}

/**
 * Mount the assets surface on a deployment's server app.
 *
 * Bundles auth (cookie-or-bearer, the assets surface is reachable from
 * both browser apps and API clients), the ownership boundary, optional
 * deployment policies (e.g. `trackAssetStorageWithAutumn` for cloud's
 * storage limit), and the route mount into one call.
 *
 * The conditional GET at `/:assetId{21}` is intentionally NOT covered by
 * upstream auth or policies: public reads must bypass auth, and the
 * library handler runs the visibility branch + auth inline. Hono matches
 * the conditional GET first because `createAssetsApp` mounts it before
 * the authed sub-app at the same prefix.
 */
export function mountAssetsApp(
	app: Hono<Env>,
	opts: {
		ownership: OwnershipRule;
		/**
		 * Extra middleware to run after auth + ownership on every authed
		 * asset route. Cloud passes `[trackAssetStorageWithAutumn]`;
		 * self-hosted deployments typically pass nothing.
		 *
		 * Typed loosely (`MiddlewareHandler`, defaulting `E = any`) because
		 * deployments commonly extend the library `Env` with their own
		 * `Variables` (e.g. `planId`) and the resulting handler types are
		 * not directly assignable to `MiddlewareHandler<Env>`. At runtime
		 * the policy executes against the deployment's wider Context, so
		 * it is safe regardless of its declared Env shape.
		 */
		policies?: MiddlewareHandler[];
	},
): void {
	const requireOwnership = createRequireOwnership(opts.ownership);
	const policies = opts.policies ?? [];

	app.use(
		API_ROUTES.assets.list.pattern,
		requireCookieOrBearerUser,
		requireOwnership,
		...policies,
	);
	app.use(
		API_ROUTES.assets.usage.pattern,
		requireCookieOrBearerUser,
		requireOwnership,
		...policies,
	);
	app.on(
		['PATCH', 'DELETE'],
		API_ROUTES.assets.byId.pattern,
		requireCookieOrBearerUser,
		requireOwnership,
		...policies,
	);
	app.route('/', createAssetsApp({ ownership: opts.ownership }));
}
