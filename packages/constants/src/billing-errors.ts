import { defineErrors, type InferErrors } from 'wellcrafted/error';

/**
 * Structured error variants for the `/api/billing/*` surface.
 *
 * Every Autumn SDK call in the billing dashboard routes can throw an
 * `AutumnError` carrying an upstream HTTP status and JSON body. Rather
 * than forwarding Autumn's wire shape verbatim, the route-level
 * `onError` translates each `AutumnError` into a single variant here so
 * billing errors share the wellcrafted envelope (`{ data: null, error:
 * { name, message, ...fields } }`) used by every other surface in this
 * repo.
 *
 * One variant by design: enumerating Autumn's full error catalog would
 * be speculative type design. Callers that need granularity branch on
 * the `code` field (Autumn's machine-readable string, e.g. `'customer_not_found'`,
 * `'invalid_plan'`) or on `statusCode`.
 *
 * The variant deliberately avoids leaking the vendor name into the wire
 * format: a future swap to direct Stripe integration would not force a
 * client-visible rename.
 *
 * @example
 * ```ts
 * // Server: runtime usage at the billing-routes onError boundary.
 * import { AutumnError } from 'autumn-js';
 * import { BillingError } from '@epicenter/constants/billing-errors';
 *
 * billingRoutes.onError((err, c) => {
 *   if (!(err instanceof AutumnError)) throw err;
 *   const body = tryJsonParse(err.body);
 *   return c.json(
 *     BillingError.ProviderRequestFailed({
 *       statusCode: err.statusCode,
 *       code: body?.code,
 *       message: body?.message ?? err.body,
 *     }),
 *     err.statusCode as ContentfulStatusCode,
 *   );
 * });
 *
 * // Client: type-only narrowing
 * import type { BillingError } from '@epicenter/constants/billing-errors';
 * function handle(error: BillingError) {
 *   switch (error.name) {
 *     case 'ProviderRequestFailed':
 *       if (error.code === 'customer_not_found') ...
 *       if (error.statusCode === 402) ...
 *   }
 * }
 * ```
 */
export const BillingError = defineErrors({
	ProviderRequestFailed: ({
		statusCode,
		code,
		message,
	}: {
		statusCode: number;
		code: string | undefined;
		message: string;
	}) => ({
		message,
		statusCode,
		code,
	}),
});

/**
 * Discriminated union of all billing error payloads.
 *
 * The `name` field discriminates variants in exhaustive `switch`
 * statements with `default: error satisfies never`.
 */
export type BillingError = InferErrors<typeof BillingError>;
