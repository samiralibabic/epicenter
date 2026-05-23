import { oauthProvider } from '@better-auth/oauth-provider';
import {
	buildTrustedOAuthClients,
	EPICENTER_OAUTH_SCOPES,
} from '@epicenter/constants/oauth';
import type { BetterAuthOptions } from 'better-auth';
import { jwt } from 'better-auth/plugins/jwt';

/**
 * Build the Better Auth plugins that define Epicenter's OAuth server boundary.
 *
 * Use this only from the API auth factory, where the request URL is known.
 * `apiBaseURL` plays two roles: it's the OAuth resource audience (clients
 * pass it as `resource`, and we accept tokens minted only for this audience,
 * preventing tokens from one resource server being replayed against another),
 * and it's the deployment input to `buildTrustedOAuthClients` so the
 * trusted-client-id set matches the clients the seeder will install.
 */
export function authPlugins(apiBaseURL: string) {
	const trustedOAuthClientIds = new Set(
		buildTrustedOAuthClients(apiBaseURL).map((client) => client.clientId),
	);
	return [
		// ES256 (P-256 ECDSA) signs the id_token and JWT access tokens. The
		// jose default would be EdDSA (Ed25519); pinning ES256 gives the
		// broadest verifier-library support across browser `jose`, Tauri
		// Rust crates, and mobile platforms. The `id_token_signing_alg_values_supported`
		// claim on `/.well-known/openid-configuration` reflects this.
		jwt({ jwks: { keyPairConfig: { alg: 'ES256' } } }),
		oauthProvider({
			loginPage: '/sign-in',
			consentPage: '/consent',
			requirePKCE: true,
			cachedTrustedClients: trustedOAuthClientIds,
			validAudiences: [apiBaseURL],
			allowDynamicClientRegistration: false,
			scopes: [...EPICENTER_OAUTH_SCOPES],
			// The plugin warns that /.well-known/oauth-authorization-server/auth must exist
			// because basePath is /auth (not /), so it can't auto-mount at the root.
			// We already mount both discovery endpoints manually in app.ts.
			silenceWarnings: { oauthAuthServerConfig: true, openidConfig: true },
		}),
	] satisfies NonNullable<BetterAuthOptions['plugins']>;
}
