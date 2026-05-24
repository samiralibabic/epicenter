/**
 * Rooms sub-app: one Cloudflare Durable Object per named Y.Doc.
 *
 * Personal mode URL shape: `/users/:userId/rooms/:roomId` (with the
 * safety middleware enforcing `:userId === c.var.user.id`).
 * Team mode URL shape:     `/rooms/:roomId`.
 *
 * The Durable Object name is the owner-partitioned identifier produced by
 * {@link doName}; nothing here interpolates strings inline. The DO itself
 * is owner-blind: every connection is identified by the
 * `(userId, installationId)` pair stamped onto its WebSocket attachment.
 *
 * Each HTTP/WS access pushes a fire-and-forget upsert into
 * `c.var.afterResponse` so the platform-level `durableObjectInstance`
 * table tracks who accessed which DO, and when. The userId column
 * captures the actor regardless of mode (provenance), not the data owner.
 */

import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { MAX_PAYLOAD_BYTES } from '../constants.js';
import * as schema from '../db/schema/index.js';
import { isWebSocketUpgrade } from '../is-websocket-upgrade.js';
import { doName, type Owner } from '../owner.js';
import type { Env, ServerOptions } from '../types.js';

type Db = NodePgDatabase<typeof schema>;

/**
 * Wrap a Uint8Array in a Response with a fresh ArrayBuffer copy. Yjs
 * encoders return views over a larger internal buffer; the copy isolates
 * exactly the bytes that should be sent.
 */
function binaryResponse(data: Uint8Array): Response {
	const body = new ArrayBuffer(data.byteLength);
	new Uint8Array(body).set(data);
	return new Response(body, {
		headers: { 'content-type': 'application/octet-stream' },
	});
}

/**
 * Fire-and-forget upsert into the platform DO instance table. Records
 * that the actor accessed the DO and, when available, the post-access
 * storage size. Errors are logged and dropped: this is telemetry, not
 * billing authority.
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
		.catch(() => undefined);
}

/**
 * Build the rooms sub-app for the given deployment mode. The URL pattern
 * is the only thing that differs across modes; the handler body uses
 * `doName(owner, roomId)` so backend identifiers stay uniform.
 */
export function createRoomsApp(opts: ServerOptions): Hono<Env> {
	const app = new Hono<Env>();

	const isPersonal = opts.ownerKind === 'personal';
	const pattern = isPersonal
		? '/users/:userId/rooms/:roomId{[a-z0-9]{15}}'
		: '/rooms/:roomId{[a-z0-9]{15}}';

	// Authentication is layered on by the deployment (cloud uses bearer-only;
	// future deployments may differ). Personal mode also expects the
	// `requireUrlUserIdMatchesAuth` middleware to gate `:userId` against the
	// resolved session.

	app.get(
		pattern,
		describeRoute({
			description: 'Get room doc or upgrade to WebSocket',
			tags: ['rooms'],
		}),
		async (c) => {
			const roomId = c.req.param('roomId')!;
			const owner: Owner = isPersonal
				? { kind: 'personal', userId: c.var.user.id }
				: { kind: 'team' };
			const name = doName(owner, roomId);
			const room = c.var.rooms.get(name);

			if (isWebSocketUpgrade(c)) {
				// Stamp userId from auth onto the URL so the DO can attach it
				// to the connection without trusting client-supplied data.
				const url = new URL(c.req.url);
				url.searchParams.set('userId', c.var.user.id);
				const stamped = new Request(url.toString(), c.req.raw);

				c.var.afterResponse.push(
					upsertDoInstance(c.var.db, {
						userId: c.var.user.id,
						resourceName: roomId,
						doName: name,
					}),
				);
				return room.handleUpgrade(stamped);
			}

			const { data, storageBytes } = await room.getDoc();
			c.var.afterResponse.push(
				upsertDoInstance(c.var.db, {
					userId: c.var.user.id,
					resourceName: roomId,
					doName: name,
					storageBytes,
				}),
			);
			return binaryResponse(data);
		},
	);

	app.post(
		pattern,
		describeRoute({
			description: 'Sync room doc',
			tags: ['rooms'],
		}),
		async (c) => {
			const roomId = c.req.param('roomId')!;
			const owner: Owner = isPersonal
				? { kind: 'personal', userId: c.var.user.id }
				: { kind: 'team' };
			const name = doName(owner, roomId);

			const body = new Uint8Array(await c.req.raw.arrayBuffer());
			if (body.byteLength > MAX_PAYLOAD_BYTES) {
				return new Response('Payload too large', { status: 413 });
			}

			const room = c.var.rooms.get(name);
			const { data: synced, error } = await room.sync(body);
			if (error) {
				return new Response('Malformed sync body', { status: 400 });
			}
			const { diff, storageBytes } = synced;

			c.var.afterResponse.push(
				upsertDoInstance(c.var.db, {
					userId: c.var.user.id,
					resourceName: roomId,
					doName: name,
					storageBytes,
				}),
			);

			return diff ? binaryResponse(diff) : new Response(null, { status: 204 });
		},
	);

	return app;
}
