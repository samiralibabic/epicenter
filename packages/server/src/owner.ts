/**
 * Server-only derived identifiers built from an `OwnerId`.
 *
 * `OwnerId` itself lives in `@epicenter/auth` because it flows through
 * `/api/session`, the persisted auth cell, and every client (browser,
 * extension, CLI, daemon). What lives here are the durable strings only
 * a server cares about: Durable Object names, R2 object keys, and the
 * partition path segment they all share.
 *
 * Personal mode and team mode share the exact same path shape. The
 * partition segment is always `owners/<ownerId>`. In personal mode
 * `ownerId` is the signed-in user's id; in team mode it is the literal
 * string `'team'`. The path is honest in both modes: every durable
 * identifier the server writes is rooted at `owners/<ownerId>`.
 *
 * Every durable string follows the rule:
 *   `owners/<ownerId>/<resource type>/<id>`
 *
 * One shape, one helper per resource type, no ternary.
 */

import type { OwnerId } from '@epicenter/constants/identity';

/** Durable Object name template, single form. */
export type RoomDoName = `owners/${string}/rooms/${string}`;

/** R2 object key template, single form. */
export type AssetR2Key = `owners/${string}/assets/${string}`;

/** Durable name of a room's Cloudflare Durable Object. */
export function doName(ownerId: OwnerId, roomId: string): RoomDoName {
	return `owners/${ownerId}/rooms/${roomId}`;
}

/** Durable key of an asset's R2 object. */
export function assetKey(ownerId: OwnerId, assetId: string): AssetR2Key {
	return `owners/${ownerId}/assets/${assetId}`;
}
