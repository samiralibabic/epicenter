/**
 * The Owner concept and every durable identifier derived from it.
 *
 * Personal mode and team mode are the same product. Personal mode
 * partitions data by user. Team mode does not partition at all.
 *
 * The partition is one path segment, `users/<userId>`, that prefixes
 * every durable identifier the personal product writes. Team mode does
 * not write that segment because it has nothing to partition. There is
 * no `team/` literal anywhere except in the `Owner` discriminator.
 *
 * Every durable string follows the rule:
 *   `<partition>/<resource type>/<id>`
 * where `<partition>` is omitted when there is no partition.
 */

/**
 * Who owns the data this request touches.
 *
 * Personal: a single user; their userId is the partition key.
 * Team:     the deployment itself; no partition.
 */
export type Owner = { kind: 'personal'; userId: string } | { kind: 'team' };

/** The set of valid `kind` discriminators. */
export type OwnerKind = Owner['kind'];

/**
 * The partition segment that prefixes durable identifiers.
 * Personal owners contribute `users/<userId>`; team owners contribute
 * an empty string so `joinPath` drops the leading segment.
 */
export type OwnerPath = `users/${string}` | '';

/** Durable identifier types, narrowed for IDE clarity. */
export type RoomDoName = `users/${string}/rooms/${string}` | `rooms/${string}`;
export type AssetR2Key =
	| `users/${string}/assets/${string}`
	| `assets/${string}`;
export type KeyringInfo = `users/${string}/keyring` | 'keyring';

/** Compute the partition segment for this Owner. */
export function ownerPath(o: Owner): OwnerPath {
	return o.kind === 'personal' ? `users/${o.userId}` : '';
}

/** Durable name of a room's Cloudflare Durable Object. */
export function doName(o: Owner, roomId: string): RoomDoName {
	return o.kind === 'personal'
		? `users/${o.userId}/rooms/${roomId}`
		: `rooms/${roomId}`;
}

/** Durable key of an asset's R2 object. */
export function assetKey(o: Owner, assetId: string): AssetR2Key {
	return o.kind === 'personal'
		? `users/${o.userId}/assets/${assetId}`
		: `assets/${assetId}`;
}

/** HKDF info label for the workspace keyring this owner controls. */
export function keyringLabel(o: Owner): KeyringInfo {
	return o.kind === 'personal' ? `users/${o.userId}/keyring` : 'keyring';
}
