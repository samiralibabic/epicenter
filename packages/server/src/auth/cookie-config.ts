import type { BetterAuthOptions } from 'better-auth';

/**
 * Choose Better Auth cookie transport settings for the current API origin.
 *
 * Use this from the auth server factory, not from client code. Localhost must
 * use host-only, non-secure Lax cookies so the Vite auth proxy can work during
 * development. Deployed API origins must use secure cross-subdomain cookies so
 * browser sign-in survives redirects while keeping app clients on bearer tokens
 * for resource access.
 */
export function createCookieAdvancedConfig(baseURL: string) {
	const { hostname } = new URL(baseURL);
	if (
		hostname === 'localhost' ||
		hostname === '127.0.0.1' ||
		hostname === '[::1]'
	) {
		return {
			useSecureCookies: false,
			defaultCookieAttributes: {
				sameSite: 'lax',
				secure: false,
			},
		} satisfies NonNullable<BetterAuthOptions['advanced']>;
	}

	return {
		useSecureCookies: true,
		crossSubDomainCookies: {
			enabled: true,
			domain: '.epicenter.so',
		},
		defaultCookieAttributes: {
			sameSite: 'none',
			secure: true,
		},
	} satisfies NonNullable<BetterAuthOptions['advanced']>;
}
