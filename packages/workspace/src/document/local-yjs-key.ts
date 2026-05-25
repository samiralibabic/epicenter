/**
 * Browser-local storage key for owner-scoped Yjs persistence.
 *
 * Mirrors the server's `doName(ownerId, ...)` shape so the same
 * `(server, ownerId, doc)` tuple resolves to the same address on the wire
 * and on disk. Two signed-in accounts on the same browser profile, or
 * two team servers signed into the same machine, never collide on
 * IndexedDB names or BroadcastChannel names.
 *
 * Key layout (uniform across personal and team modes):
 *
 *   epicenter/<server>/owners/<ownerId>/<ydoc.guid>
 *
 * The server segment is the API origin host (e.g. `api.epicenter.so`). In
 * personal mode `ownerId` equals the user id; in team mode it is the literal
 * `'team'`.
 */

import type { OwnerId } from '@epicenter/constants/identity';

const APP = 'epicenter';

/**
 * Prefix every key built for this `(server, ownerId)` pair starts with.
 *
 * Wipe paths use this to enumerate every database owned by the pair.
 */
export function getOwnedYjsPrefix(server: string, ownerId: OwnerId): string {
	return `${APP}/${server}/owners/${ownerId}/`;
}

/**
 * Browser-local persistence and BroadcastChannel key for a Y.Doc.
 *
 * The `server` and `ownerId` arguments scope local data on shared browser
 * profiles. This key is a local runtime name only; it does not change
 * `ydoc.guid`, sync room names, child document GUIDs, or the encryption
 * workspace labels.
 */
export function createOwnedYjsKey(
	server: string,
	ownerId: OwnerId,
	ydocGuid: string,
): string {
	return `${getOwnedYjsPrefix(server, ownerId)}${ydocGuid}`;
}
