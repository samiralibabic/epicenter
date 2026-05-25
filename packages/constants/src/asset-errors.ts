import { defineErrors, type InferErrors } from 'wellcrafted/error';

/**
 * Structured error variants for the `/api/owners/:ownerId/assets` surface.
 *
 * Defined once in the shared constants package so the server runtime and
 * any asset client SDK reference the same discriminated union. The server
 * calls the factories at runtime (`AssetError.NotFound()`); clients
 * import the type via `InferErrors` for zero-cost narrowing.
 *
 * The serialized envelope is `wellcrafted`'s `{ data: null, error: {
 * name, message, ...fields } }`. Receivers branch on `body.error.name`.
 *
 * `StorageLimitExceeded` is emitted by the cloud-only Autumn storage
 * policy (`apps/api/src/billing/policies.ts`). It lives with the asset surface
 * (not in a separate billing namespace) so an asset client handles one
 * error type per call, matching the `AiChatError` precedent that lumps
 * billing-shaped failures with the surface that raises them.
 *
 * Quantitative bounds (`maxBytes`, `allowed`) are passed in by the
 * caller so the wire body carries the value enforced at request time,
 * not a stale module-load capture.
 *
 * Each variant carries its own HTTP `status`, so call sites just forward
 * the baked-in code to `c.json`. No external status mapper required.
 *
 * @example
 * ```ts
 * // Server: runtime usage
 * import { AssetError } from '@epicenter/constants/asset-errors';
 * const err = AssetError.FileTooLarge({ size: file.size, maxBytes: 10_000_000 });
 * return c.json(err, err.error.status); // 413, baked into the variant
 *
 * // Client: type-only narrowing
 * import type { AssetError } from '@epicenter/constants/asset-errors';
 * function handle(error: AssetError) {
 *   switch (error.name) {
 *     case 'FileTooLarge':           // error.size, error.maxBytes
 *     case 'StorageLimitExceeded':   // error.requestedBytes
 *     // ...
 *   }
 * }
 * ```
 */
export const AssetError = defineErrors({
	MissingFile: () => ({
		message: 'Missing file field in multipart body.',
		status: 400 as const,
	}),
	InvalidVisibility: ({ value }: { value: string }) => ({
		message: `Invalid visibility: '${value}'. Expected 'private' or 'public'.`,
		status: 400 as const,
		value,
	}),
	FileTypeNotAllowed: ({
		contentType,
		allowed,
	}: {
		contentType: string;
		allowed: readonly string[];
	}) => ({
		message: `File type not allowed: ${contentType}. Allowed types: ${allowed.join(', ')}.`,
		status: 415 as const,
		contentType,
		allowed,
	}),
	FileTooLarge: ({ size, maxBytes }: { size: number; maxBytes: number }) => ({
		message: `File exceeds ${maxBytes} byte limit (got ${size}).`,
		status: 413 as const,
		size,
		maxBytes,
	}),
	NotFound: () => ({
		message: 'Asset not found.',
		status: 404 as const,
	}),
	Unauthorized: () => ({
		message: 'Authentication required to read this asset.',
		status: 401 as const,
	}),
	StorageLimitExceeded: ({ requestedBytes }: { requestedBytes: number }) => ({
		message: `Upload would exceed your storage quota (${requestedBytes} bytes requested).`,
		status: 402 as const,
		requestedBytes,
	}),
});

/**
 * Discriminated union of all asset error payloads.
 *
 * The `name` field discriminates variants in exhaustive `switch`
 * statements with `default: error satisfies never`.
 */
export type AssetError = InferErrors<typeof AssetError>;
