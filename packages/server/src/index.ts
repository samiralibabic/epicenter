/**
 * @epicenter/server
 *
 * Shared Hono server for Epicenter cloud and self-hosted team
 * deployments. Personal mode partitions data by user; team mode uses
 * one shared owner partition. The full design lives in
 * `specs/20260522T230000-server-package-split.md`.
 *
 * Deployments construct the server app, choose an `OwnershipRule`, then
 * mount each reusable surface with the matching `mount*` primitive. Each
 * primitive owns its auth + ownership wiring; the deployment passes only
 * the rule and any deployment policies (e.g. cloud billing middleware).
 * Sub-apps declare full URLs (including the `/api` prefix where
 * applicable). See `apps/api/src/index.ts` for the cloud composition.
 */

// Auth middleware. `authApp` is mounted directly; the AI surface accepts
// `requireBearerUser` via `mountAiApp({ auth })`. Most owner-partitioned
// surfaces wire auth inside their mount primitive and never need these.
export {
	requireBearerUser,
	requireCookieOrBearerUser,
} from './middleware/require-auth.js';
// Ownership composition: the deployment constructs the rule once via
// `personal()` or `team({ isMember })` and threads it into every mount
// primitive that needs the partition. See ./ownership.ts for the design
// note.
export {
	type IsMember,
	type OwnershipRule,
	personal,
	team,
} from './ownership.js';
// Re-export the Cloudflare Durable Object class so each deployment's
// wrangler.jsonc can resolve `class_name: "Room"` against this entrypoint.
export { Room } from './room/backends/cloudflare/durable-object.js';
export { mountAiApp } from './routes/ai.js';
export { mountAssetsApp } from './routes/assets.js';
// Reusable surfaces. Each `mount*` bundles auth + ownership + the route
// mount, accepting only the deployment-controlled knobs (ownership rule,
// optional policies). The bare `authApp` is mounted directly because it
// has no deployment knobs.
export { authApp } from './routes/auth.js';
export { mountRoomsApp } from './routes/rooms.js';
export { mountSessionApp } from './routes/session.js';
// Parent app. Wires per-request lifecycle (pg, after-response queue,
// auth context, CORS, single-credential normalization, CSRF, rooms
// registry). Mount every surface on this app via the `mount*` primitives.
export { createServerApp } from './server-app.js';

// Public Hono context type the deployment composes around library
// middleware.
export type { Env } from './types.js';
