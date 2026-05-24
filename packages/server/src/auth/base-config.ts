import type { BetterAuthOptions } from 'better-auth';

export const AUTH_BASE_PATH = '/auth';

/** Shared Better Auth config used by both the runtime and the CLI schema tool. */
export const BASE_AUTH_CONFIG = {
	basePath: AUTH_BASE_PATH,
	emailAndPassword: { enabled: true },
	account: {
		accountLinking: {
			enabled: true,
			trustedProviders: ['google', 'email-password'],
		},
	},
} satisfies BetterAuthOptions;
