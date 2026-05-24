/**
 * Installation id helper.
 *
 * An installation id is a stable string that identifies one installation of an
 * Epicenter app. Browser tabs in the same app share localStorage and therefore
 * share an installation id; separate browsers, machines, or device classes get
 * distinct installation ids. The id is generated on first call and persisted
 * in the supplied storage; subsequent calls return the persisted value.
 *
 * Installation ids are claimed by the client and only the client knows
 * them. They are passed to `openCollaboration` as the `installationId`
 * config field, stamped onto the WebSocket upgrade URL (the relay binds
 * the id to the socket at upgrade and stores it on the socket attachment
 * for the lifetime of the connection: no round-trip validation), and
 * echoed as the `from` field on every HTTP dispatch.
 */

import { generateGuid } from '../shared/id.js';

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

// Persisted under the legacy "installation.id" key. Do not rename: every
// existing user has this key in storage today; renaming invalidates their
// installation id and shows them up as a new device.
const KEY = 'epicenter.installation.id';

/** Read or lazily generate the installation id from synchronous storage. */
export function createInstallationId({
	storage,
}: {
	storage: SimpleStorage;
}): string {
	const existing = storage.getItem(KEY);
	if (existing) return existing;
	const fresh = generateGuid();
	storage.setItem(KEY, fresh);
	return fresh;
}

/** Read or lazily generate the installation id from async storage. */
export async function createInstallationIdAsync({
	storage,
}: {
	storage: AsyncStorage;
}): Promise<string> {
	const existing = await storage.getItem(KEY);
	if (existing) return existing;
	const fresh = generateGuid();
	await storage.setItem(KEY, fresh);
	return fresh;
}
