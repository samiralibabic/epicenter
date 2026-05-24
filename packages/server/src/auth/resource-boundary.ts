import { oauthProviderResourceClient } from '@better-auth/oauth-provider/resource-client';
import { AuthUser } from '@epicenter/auth';
import type { User } from 'better-auth';
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Context } from 'hono';
import { Ok, type Result } from 'wellcrafted/result';
import * as schema from '../db/schema';
import { OAuthError } from './oauth-error.js';
import { createOAuthIssuerURL, createOAuthJwksURL } from './oauth-metadata.js';

type VerifyOAuthAccessToken = ReturnType<
	ReturnType<typeof oauthProviderResourceClient>['getActions']
>['verifyAccessToken'];

type ResolverDeps = {
	authorization: string | null;
	audience: string;
	issuer: string;
	jwksUrl: string;
	verifyOAuthAccessToken: VerifyOAuthAccessToken;
	findUserById(userId: string): Promise<User | null>;
};

type RequestOAuthEnv = {
	Bindings: object | undefined;
	Variables: {
		authBaseURL: string;
		db: NodePgDatabase<typeof schema>;
	};
};

/**
 * Extract the token from an HTTP `Authorization: Bearer <token>` header value.
 * Case-insensitive on the scheme; trims surrounding whitespace; returns null
 * for missing, empty, or non-bearer inputs.
 *
 * Shared with `single-credential.ts` so well-formedness and authorization
 * agree on what counts as a bearer.
 */
export function parseBearer(value: string | null): string | null {
	if (!value) return null;
	const match = value.match(/^Bearer\s+(.+)$/i);
	return match?.[1]?.trim() || null;
}

/**
 * Cheap resolver for the protected-resource boundary (`/ai/*`,
 * `/rooms/*`, `/api/billing/*`, `/api/assets/*`).
 * Skips subject keyring derivation; only the calling user is needed once
 * the token proves issuer, audience, signature, expiration, and subject.
 *
 * Add custom OAuth scopes back only when two valid clients need different
 * API powers. Until then, the API audience is the bearer boundary and product
 * middleware owns route-specific policy.
 */
export async function resolveBearerUser(
	deps: ResolverDeps,
): Promise<Result<AuthUser, OAuthError>> {
	const accessToken = parseBearer(deps.authorization);
	if (!accessToken) return OAuthError.InvalidToken();

	const payload = await deps
		.verifyOAuthAccessToken(accessToken, {
			verifyOptions: { audience: deps.audience, issuer: deps.issuer },
			jwksUrl: deps.jwksUrl,
		})
		.catch(() => null);
	const userId = typeof payload?.sub === 'string' ? payload.sub : null;
	if (!userId) return OAuthError.InvalidToken();

	const user = await deps.findUserById(userId);
	if (!user) return OAuthError.InvalidToken();

	return Ok(AuthUser.assert(user));
}

/**
 * Resolve the OAuth bearer on the current request to the calling user.
 * Shows the resource boundary mapping directly: the API origin is the audience,
 * and the same origin plus `/auth` is the issuer.
 */
export function resolveRequestOAuthUser<E extends RequestOAuthEnv>(
	c: Context<E>,
) {
	const audience = c.var.authBaseURL;
	return resolveBearerUser({
		authorization: c.req.header('authorization') ?? null,
		audience,
		issuer: createOAuthIssuerURL(audience),
		jwksUrl: createOAuthJwksURL(audience),
		verifyOAuthAccessToken:
			oauthProviderResourceClient().getActions().verifyAccessToken,
		findUserById: async (userId) => {
			const [row] = await c.var.db
				.select()
				.from(schema.user)
				.where(eq(schema.user.id, userId))
				.limit(1);
			return row ?? null;
		},
	} satisfies ResolverDeps);
}
