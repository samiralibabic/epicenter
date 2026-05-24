import { defineErrors, type InferErrors } from 'wellcrafted/error';

/**
 * Failure shapes produced by every OAuth resource-boundary resolver in this
 * package.
 *
 * The serialized error object (`{ name, message, ...fields }`) is itself
 * the wire format consumers see; downstream callers reconstruct by
 * branching on `error.name`.
 */
export const OAuthError = defineErrors({
	InvalidToken: () => ({
		message: 'OAuth access token is missing, malformed, or unverifiable.',
	}),
});
export type OAuthError = InferErrors<typeof OAuthError>;
