/**
 * Browser-local storage key for owner-scoped Yjs persistence.
 *
 * Mirrors the server's `doName(owner, ...)` shape so the same
 * `(server, owner, doc)` tuple resolves to the same address on the wire
 * and on disk. Two signed-in accounts on the same browser profile, or
 * two team servers signed into the same machine, never collide on
 * IndexedDB names or BroadcastChannel names.
 *
 * Key layout:
 *
 *   epicenter/<server>/users/<userId>/<ydoc.guid>      personal
 *   epicenter/<server>/<ydoc.guid>                     team
 *
 * The server segment is the API origin host (e.g. `api.epicenter.so`).
 * Team mode drops the owner partition because the deployment IS the team
 * and the server origin already disambiguates across deployments.
 */

import type { Owner } from '@epicenter/auth';

const APP = 'epicenter';

/**
 * Prefix every key built for this `(server, owner)` pair starts with.
 *
 * Wipe paths use this to enumerate every database owned by the pair.
 */
export function getOwnedYjsPrefix(server: string, owner: Owner): string {
	const ownerSeg = owner.kind === 'personal' ? `/users/${owner.userId}` : '';
	return `${APP}/${server}${ownerSeg}/`;
}

/**
 * Browser-local persistence and BroadcastChannel key for a Y.Doc.
 *
 * The `server` and `owner` arguments scope local data on shared browser
 * profiles. This key is a local runtime name only; it does not change
 * `ydoc.guid`, sync room names, child document GUIDs, or the encryption
 * workspace labels.
 */
export function createOwnedYjsKey(
	server: string,
	owner: Owner,
	ydocGuid: string,
): string {
	return `${getOwnedYjsPrefix(server, owner)}${ydocGuid}`;
}
