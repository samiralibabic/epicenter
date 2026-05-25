/**
 * Device id helper plus the branded `DeviceId` type.
 *
 * A device id is a stable string that identifies one Epicenter app on one
 * persistent storage scope. Browser tabs sharing localStorage share an id;
 * separate browsers, the extension, Tauri windows, and the CLI daemon each
 * get distinct ids because their storage scopes are distinct. The id is
 * generated on first call and persisted in the supplied storage; subsequent
 * calls return the persisted value.
 *
 * "Device" is the user-facing word the presence UI uses (`PresenceDevice`).
 * The id behind it is what the relay routes by and what every consumer reads.
 *
 * Device ids are claimed by the client and only the client knows them. They
 * are passed to `openCollaboration` as the `deviceId` config field, stamped
 * onto the WebSocket upgrade URL (the relay binds the id to the socket at
 * upgrade and stores it on the socket attachment for the lifetime of the
 * connection: no round-trip validation), and echoed as the `from` field on
 * every HTTP dispatch.
 */

import type { Brand } from 'wellcrafted/brand';
import { generateGuid } from '../shared/id.js';

/**
 * Branded string identifying one Epicenter app on one persistent storage
 * scope (one "device" in the user-facing presence vocabulary). Generated
 * by {@link createDeviceId} or
 * {@link createDeviceIdAsync}; brand prevents accidental mixing with
 * unrelated string ids (UserId, OwnerId, room ids, etc.).
 *
 * At trusted call sites that receive a known `string`, brand it with
 * {@link asDeviceId}.
 */
export type DeviceId = string & Brand<'DeviceId'>;

/**
 * Syntactic sugar for `value as DeviceId`. The function body is a single
 * typed cast; the constrained `string` parameter is what earns it over a
 * raw `as` (callers can't accidentally widen to `unknown`). The only place
 * in the codebase where `as DeviceId` should appear.
 */
export const asDeviceId = (value: string): DeviceId => value as DeviceId;

/** Storage primitive that mirrors the synchronous Web Storage shape. */
export type SimpleStorage = {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
};

/** Storage primitive with the async shape (chrome.storage, IndexedDB wrappers). */
export type AsyncStorage = {
	getItem(key: string): Promise<string | null>;
	setItem(key: string, value: string): Promise<void>;
};

const KEY = 'epicenter.device.id';

/** Read or lazily generate the device id from synchronous storage. */
export function createDeviceId({
	storage,
}: {
	storage: SimpleStorage;
}): DeviceId {
	const existing = storage.getItem(KEY);
	if (existing) return asDeviceId(existing);
	const fresh = generateGuid();
	storage.setItem(KEY, fresh);
	return asDeviceId(fresh);
}

/** Read or lazily generate the device id from async storage. */
export async function createDeviceIdAsync({
	storage,
}: {
	storage: AsyncStorage;
}): Promise<DeviceId> {
	const existing = await storage.getItem(KEY);
	if (existing) return asDeviceId(existing);
	const fresh = generateGuid();
	await storage.setItem(KEY, fresh);
	return asDeviceId(fresh);
}
