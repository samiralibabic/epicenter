/**
 * @epicenter/server
 *
 * Shared Hono server for Epicenter cloud and self-hosted team
 * deployments. Personal mode partitions data by user; team mode does
 * not partition. The full design lives in
 * `specs/20260522T230000-server-package-split.md`.
 */

// Top-level factory.
export { createServer } from './create-server.js';
// Middleware deployments compose around library sub-apps. Auth is mounted by
// the deployment (not the library) so cloud can interleave Autumn gates
// between the auth check and the handler.
export {
	requireBearerUser,
	requireCookieOrBearerUser,
} from './middleware/require-auth.js';
export { requireUrlUserIdMatchesAuth } from './middleware/require-url-user-id-matches-auth.js';
export type {
	AssetR2Key,
	KeyringInfo,
	Owner,
	OwnerKind,
	OwnerPath,
	RoomDoName,
} from './owner.js';
// Owner concept and durable-identifier derivations.
export { assetKey, doName, keyringLabel, ownerPath } from './owner.js';
// Re-export the Cloudflare Durable Object class so each deployment's
// wrangler.jsonc can resolve `class_name: "Room"` against this entrypoint.
export { Room } from './room/backends/cloudflare/durable-object.js';
// Public configuration surface.
export type {
	AfterResponseQueue,
	Connection,
	Env,
	ServerOptions,
	SignUpPolicy,
} from './types.js';
