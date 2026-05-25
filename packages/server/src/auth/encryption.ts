import { env } from 'cloudflare:workers';
import type { OwnerId } from '@epicenter/constants/identity';
import {
	deriveKeyring as deriveKeyringFromRoot,
	type Keyring,
	parseRootKeyring,
	type RootKeyring,
} from '@epicenter/encryption';

let rootKeyring: RootKeyring;
try {
	rootKeyring = parseRootKeyring(env.ENCRYPTION_SECRETS);
} catch (error) {
	throw new Error(
		`ENCRYPTION_SECRETS is missing or malformed. Expected format: "2:base64Secret2,1:base64Secret1" (comma-separated version:secret pairs). Generate a secret with: openssl rand -base64 32\n\nValidation error:\n${error instanceof Error ? error.message : String(error)}`,
	);
}

/**
 * Derive the workspace `Keyring` attached to Epicenter auth-session responses.
 *
 * The HKDF label IS the `ownerId`. The signature requires `OwnerId` (not bare
 * `string`) so the contract "owner partition equals keyring partition" lives
 * in the type. This wrapper just owns env access and fail-fast worker
 * startup; `@epicenter/encryption` owns parsing and HKDF derivation, keeping
 * workspace encryption separate from Better Auth's cookie and token secrets.
 */
export async function deriveKeyring(ownerId: OwnerId): Promise<Keyring> {
	return deriveKeyringFromRoot({
		rootKeyring,
		label: ownerId,
	});
}
