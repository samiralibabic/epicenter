/**
 * Single source of truth for all Epicenter app URLs and ports.
 *
 * Each app declares its dev port and production URLs. The first URL in
 * `urls` is the canonical production URL (used by Vite prod builds).
 * All URLs are included in CORS and trusted origins.
 *
 * To add an app: add an entry here. TypeScript enforces that every
 * consumer picks it up automatically.
 */

/**
 * Canonical production origin for the Epicenter API. Used by both the `API`
 * entry and the `DASHBOARD` entry (the dashboard SPA is mounted at
 * `/dashboard/*` on the API origin), and as the fallback for
 * {@link EPICENTER_API_URL}.
 */
const PRODUCTION_API_URL = 'https://api.epicenter.so';

export const APPS = {
	API: { port: 8787, urls: [PRODUCTION_API_URL] },
	SH: { port: 5173, urls: ['https://epicenter.sh'] },
	AUDIO: { port: 1420, urls: ['https://whispering.epicenter.so'] },
	FUJI: { port: 5174, urls: ['https://fuji.epicenter.so'] },
	HONEYCRISP: { port: 5175, urls: ['https://honeycrisp.epicenter.so'] },
	OPENSIDIAN: {
		port: 5176,
		urls: ['https://opensidian.com', 'https://opensidian.epicenter.so'],
	},
	ZHONGWEN: { port: 8888, urls: ['https://zhongwen.epicenter.so'] },
	DASHBOARD: { port: 5178, urls: [PRODUCTION_API_URL] },
} as const;

export type AppId = keyof typeof APPS;

/**
 * Local dev URL for an app, derived from its `port`. Single owner for the
 * `http://localhost:<port>` shape: CORS trusted origins, the API runtime's
 * dev classifier, and the OAuth seed all read this.
 */
export function localUrl(app: { port: number }): string {
	return `http://localhost:${app.port}`;
}

/**
 * Default API base URL for Node consumers (CLI, daemon, tests). The constant
 * resolves to `process.env.EPICENTER_API_URL` when set, else
 * {@link PRODUCTION_API_URL}. Browsers and Workers lack `process.env`, so
 * they fall through to the production default automatically.
 */
export const EPICENTER_API_URL =
	(typeof process !== 'undefined' && process.env?.EPICENTER_API_URL) ||
	PRODUCTION_API_URL;
