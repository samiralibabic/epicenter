/**
 * Cloudflare bindings the `@epicenter/server` library reads from `c.env`.
 *
 * Each consuming deployment (apps/api for cloud, apps/server-team for
 * self-hosted) merges its own `Cloudflare.Env` via `wrangler types`. This
 * declaration teaches the library compiler that the names it reads are
 * required to exist on `Cloudflare.Env`. Optional cloud-only bindings
 * (Autumn, admin IDs, dashboard ASSETS fetcher) live in apps/api's
 * generated worker-configuration.d.ts and never appear here.
 */
declare global {
	namespace Cloudflare {
		interface Env {
			HYPERDRIVE: Hyperdrive;
			ROOM: DurableObjectNamespace<
				import('./room/backends/cloudflare/durable-object.js').Room
			>;
			ASSETS_BUCKET: R2Bucket;
			SESSION_KV: KVNamespace;
			ENCRYPTION_SECRETS: string;
			BETTER_AUTH_SECRET: string;
			GOOGLE_CLIENT_ID: string;
			GOOGLE_CLIENT_SECRET: string;
			OPENAI_API_KEY: string;
			GEMINI_API_KEY: string;
		}
	}
}

export {};
