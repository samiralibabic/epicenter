import { API_ROUTES } from '@epicenter/constants/api-routes';
import type { OwnerId } from '@epicenter/constants/identity';
import type { DeviceId } from './device-id.js';

/**
 * Options for {@link roomWsUrl}: the full base URL of the API host, the
 * workspace `ownerId` (which selects the partitioned URL path), the room
 * `guid`, and the per-client `deviceId` query value.
 */
export type RoomWsUrlOptions = {
	baseURL: string;
	ownerId: OwnerId;
	guid: string;
	deviceId: DeviceId;
};

/**
 * Build the WebSocket URL for a hosted room.
 *
 * Single URL form: `wss://<baseURL>/api/owners/<ownerId>/rooms/<guid>?deviceId=<id>`
 *
 * In personal mode `ownerId` equals the signed-in user's id; in team mode it
 * is the literal `'team'`. The URL shape is uniform across both modes.
 *
 * The path itself comes from `API_ROUTES.room.url(...)` so server route
 * declarations and client URL construction can never drift. This wrapper
 * adds the `?deviceId=` query and rewrites the `http(s)` scheme to `ws(s)`.
 */
export function roomWsUrl(options: RoomWsUrlOptions): string {
	const httpUrl = API_ROUTES.room.url(
		options.baseURL,
		options.ownerId,
		options.guid,
	);
	const search = `?deviceId=${encodeURIComponent(options.deviceId)}`;
	return `${httpUrl}${search}`
		.replace(/^https:/, 'wss:')
		.replace(/^http:/, 'ws:');
}
