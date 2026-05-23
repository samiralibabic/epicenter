/**
 * Protected Resource Boundary Tests
 *
 * Covers the two exported helpers in `resource-boundary.ts`:
 *
 * - `parseBearer`: header parsing used by both the well-formedness layer
 *   (`single-credential`) and the resolvers below.
 * - `resolveBearerUser`: cheap resolver used by `requireOAuthUser` for every
 *   protected app resource (`/ai/*`, `/rooms/*`,
 *   `/api/billing/*`, `/api/assets/*`).
 * HTTP and WebSocket wire-format coverage lives in `oauth-resource.test.ts`.
 */

import { expect, test } from 'bun:test';
import { oauthProvider } from '@better-auth/oauth-provider';
import { oauthProviderResourceClient } from '@better-auth/oauth-provider/resource-client';
import { EPICENTER_OAUTH_SCOPES } from '@epicenter/constants/oauth';
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { jwt } from 'better-auth/plugins';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	createOAuthTestDb,
	isAddressInUse,
	issueOAuthTokens,
	randomOAuthTestPort,
} from '../test-helpers/oauth.js';
import { parseBearer, resolveBearerUser } from './resource-boundary.js';

// ---------------------------------------------------------------------------
// parseBearer
// ---------------------------------------------------------------------------

test('parseBearer extracts the token from a Bearer header', () => {
	expect(parseBearer('Bearer abc.def.ghi')).toBe('abc.def.ghi');
});

test('parseBearer is case-insensitive on the scheme and trims whitespace', () => {
	expect(parseBearer('bearer   abc.def.ghi   ')).toBe('abc.def.ghi');
	expect(parseBearer('BEARER abc.def.ghi')).toBe('abc.def.ghi');
});

test('parseBearer returns null for missing, empty, or non-bearer input', () => {
	expect(parseBearer(null)).toBeNull();
	expect(parseBearer('')).toBeNull();
	expect(parseBearer('Bearer ')).toBeNull();
	expect(parseBearer('Token abc')).toBeNull();
});

// ---------------------------------------------------------------------------
// resolveBearerUser
// ---------------------------------------------------------------------------

test('resolveBearerUser resolves a valid API-audience token to the calling user', async () => {
	const setup = createBoundaryTestServer();
	try {
		const { accessToken } = await issueOAuthTokens(setup, {
			clientName: 'Resource Boundary Test',
			email: 'boundary-test@example.com',
			name: 'Boundary Test',
		});
		const data = expectOk(
			await resolveBearerUser(commonResolverDeps(setup, accessToken)),
		);

		expect(data).toEqual({
			id: expect.any(String),
			email: 'boundary-test@example.com',
		});
	} finally {
		setup.server.stop(true);
	}
});

test('resolveBearerUser rejects tokens issued for the wrong audience as InvalidToken', async () => {
	const setup = createBoundaryTestServer();
	try {
		const { accessToken } = await issueOAuthTokens(setup, {
			clientName: 'Resource Boundary Test',
			email: 'boundary-test@example.com',
			name: 'Boundary Test',
			resource: setup.wrongAudience,
		});
		const error = expectErr(
			await resolveBearerUser(commonResolverDeps(setup, accessToken)),
		);

		expect(error.name).toBe('InvalidToken');
	} finally {
		setup.server.stop(true);
	}
});

test('resolveBearerUser rejects tokens verified against the wrong issuer as InvalidToken', async () => {
	const setup = createBoundaryTestServer();
	try {
		const { accessToken } = await issueOAuthTokens(setup, {
			clientName: 'Resource Boundary Test',
			email: 'boundary-test@example.com',
			name: 'Boundary Test',
		});
		const error = expectErr(
			await resolveBearerUser(
				commonResolverDeps(setup, accessToken, {
					issuer: `${setup.baseURL}/some-other-issuer`,
				}),
			),
		);

		expect(error.name).toBe('InvalidToken');
	} finally {
		setup.server.stop(true);
	}
});

test('resolveBearerUser rejects malformed bearer input before calling the verifier', async () => {
	let verifierCalls = 0;
	const error = expectErr(
		await resolveBearerUser({
			authorization: 'Token not-a-bearer',
			audience: 'http://localhost:8787',
			issuer: 'http://localhost:8787/auth',
			jwksUrl: 'http://localhost:8787/auth/jwks',
			verifyOAuthAccessToken: async () => {
				verifierCalls += 1;
				return null as never;
			},
			findUserById: async () => {
				throw new Error('findUserById should not run');
			},
		}),
	);

	expect(error.name).toBe('InvalidToken');
	expect(verifierCalls).toBe(0);
});

test('resolveBearerUser rejects tokens whose user no longer exists as InvalidToken', async () => {
	const setup = createBoundaryTestServer();
	try {
		const { accessToken } = await issueOAuthTokens(setup, {
			clientName: 'Resource Boundary Test',
			email: 'boundary-test@example.com',
			name: 'Boundary Test',
		});
		setup.db.user = [];

		const error = expectErr(
			await resolveBearerUser(commonResolverDeps(setup, accessToken)),
		);

		expect(error.name).toBe('InvalidToken');
	} finally {
		setup.server.stop(true);
	}
});

// ---------------------------------------------------------------------------
// Shared test plumbing
// ---------------------------------------------------------------------------

function createBoundaryTestServer() {
	const db = createOAuthTestDb();

	for (let attempt = 0; attempt < 200; attempt += 1) {
		const port = randomOAuthTestPort();
		const baseURL = `http://localhost:${port}`;
		const wrongAudience = `${baseURL}/other-resource`;
		const auth = betterAuth({
			database: memoryAdapter(db),
			emailAndPassword: { enabled: true },
			basePath: '/auth',
			baseURL,
			secret: 'test-secret-test-secret-test-secret',
			plugins: [
				jwt(),
				oauthProvider({
					loginPage: '/sign-in',
					consentPage: '/consent',
					requirePKCE: true,
					validAudiences: [baseURL, wrongAudience],
					allowDynamicClientRegistration: false,
					scopes: [...EPICENTER_OAUTH_SCOPES],
					silenceWarnings: { oauthAuthServerConfig: true, openidConfig: true },
				}),
			],
		});

		try {
			const server = Bun.serve({
				port,
				fetch: async (request) => auth.handler(request),
			});

			return { auth, baseURL, db, server, wrongAudience };
		} catch (error) {
			if (isAddressInUse(error)) continue;
			throw error;
		}
	}

	throw new Error('Failed to find an available resource-boundary test port.');
}

function commonResolverDeps(
	setup: ReturnType<typeof createBoundaryTestServer>,
	accessToken: string,
	overrides: { audience?: string; issuer?: string } = {},
) {
	const resource = oauthProviderResourceClient();
	return {
		authorization: `Bearer ${accessToken}`,
		audience: overrides.audience ?? setup.baseURL,
		issuer: overrides.issuer ?? `${setup.baseURL}/auth`,
		jwksUrl: `${setup.baseURL}/auth/jwks`,
		verifyOAuthAccessToken: resource.getActions().verifyAccessToken,
		findUserById: async (userId: string) =>
			setup.db.user?.find((user) => user.id === userId) ?? null,
	};
}
