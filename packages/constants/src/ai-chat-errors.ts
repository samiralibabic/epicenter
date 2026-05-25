import { defineErrors, type InferErrors } from 'wellcrafted/error';

/**
 * Structured error variants for the `/ai/chat` endpoint.
 *
 * Defined once in the shared constants package so both server and client
 * reference the same discriminated union. The server calls the factories
 * at runtime (`AiChatError.Unauthorized()`); the client imports only the
 * `AiChatError` type via `InferErrors` for zero-cost type narrowing.
 *
 * Each variant's `name` field is the discriminant: use `switch (error.name)`
 * for exhaustive handling with full TypeScript narrowing.
 *
 * HTTP status codes live in the sibling `AiChatErrorStatus` map below, not
 * on the factory or in the wire body. The map is `satisfies`-checked
 * against the variant union, so adding a variant without picking a status
 * is a compile error.
 *
 * @example
 * ```ts
 * // Server: runtime usage
 * import {
 *   AiChatError,
 *   AiChatErrorStatus,
 * } from '@epicenter/constants/ai-chat-errors';
 * return c.json(
 *   AiChatError.InsufficientCredits({ balance: 42 }),
 *   AiChatErrorStatus.InsufficientCredits,
 * ); // 402
 *
 * // Client: type-only usage
 * import { AiChatHttpError } from '@epicenter/constants/ai-chat-errors';
 * if (err instanceof AiChatHttpError) {
 *   switch (err.detail.name) {
 *     case 'Unauthorized': // show sign-in
 *     case 'InsufficientCredits': // err.detail.balance
 *   }
 * }
 * ```
 */
export const AiChatError = defineErrors({
	Unauthorized: () => ({ message: 'Unauthorized' }),
	ProviderNotConfigured: ({ provider }: { provider: string }) => ({
		message: `${provider} not configured`,
		provider,
	}),
	UnknownModel: ({ model }: { model: string }) => ({
		message: `Unknown model: ${model}`,
		model,
	}),
	InsufficientCredits: ({ balance }: { balance: unknown }) => ({
		message: 'Insufficient credits',
		balance,
	}),
	ModelRequiresPaidPlan: ({
		model,
		credits,
	}: {
		model: string;
		credits: number;
	}) => ({
		message: `${model} requires a paid plan (costs ${credits} credits)`,
		model,
		credits,
	}),
});

/**
 * Discriminated union of all AI chat error payloads.
 *
 * Reused by both server (runtime) and client (type narrowing).
 * The `name` field discriminates variants in `switch` statements.
 *
 * @example
 * ```ts
 * function handleError(error: AiChatError) {
 *   switch (error.name) {
 *     case 'InsufficientCredits':
 *       console.log(error.balance); // TypeScript knows this exists
 *       break;
 *     case 'ModelRequiresPaidPlan':
 *       console.log(error.model, error.credits); // narrowed
 *       break;
 *   }
 * }
 * ```
 */
export type AiChatError = InferErrors<typeof AiChatError>;

/**
 * HTTP status code for each `AiChatError` variant, looked up by name.
 *
 * Kept as a sibling map (not on the factory, not in the body) so domain
 * errors stay transport-agnostic. `satisfies Record<AiChatError['name'], number>`
 * enforces exhaustiveness: adding a variant to `AiChatError` without a
 * matching status here is a compile error.
 */
export const AiChatErrorStatus = {
	Unauthorized: 401,
	ProviderNotConfigured: 503,
	UnknownModel: 400,
	InsufficientCredits: 402,
	ModelRequiresPaidPlan: 403,
} as const satisfies Record<AiChatError['name'], number>;

/**
 * Error subclass that carries structured error data across TanStack AI's
 * throw boundary.
 *
 * Created by `createAiChatFetch` when the server returns a non-2xx response
 * with a wellcrafted `{ data, error }` JSON envelope. The `Error` propagates
 * unchanged through TanStack AI's `ChatClient` pipeline; `instanceof
 * AiChatHttpError` works in `onError` and when reading `chat.error`.
 *
 * The `detail` property carries the full discriminated union with
 * variant-specific fields. The HTTP status is not on `detail` (it lives in
 * the sibling `AiChatErrorStatus` map); use `switch (err.detail.name)` for
 * exhaustive handling.
 *
 * @example
 * ```ts
 * if (err instanceof AiChatHttpError) {
 *   console.log(err.detail.name);   // "InsufficientCredits"
 *   switch (err.detail.name) {
 *     case 'InsufficientCredits':
 *       console.log(err.detail.balance); // narrowed
 *       break;
 *   }
 * }
 * ```
 */
export class AiChatHttpError extends Error {
	override readonly name = 'AiChatHttpError';

	constructor(readonly detail: AiChatError) {
		super(detail.message);
	}
}
