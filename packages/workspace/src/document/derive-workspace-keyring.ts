import {
	base64ToBytes,
	deriveWorkspaceKey,
	type Keyring,
	type WorkspaceKeyring,
} from '@epicenter/encryption';

/**
 * Derive the per-workspace keyring from the authenticated owner keyring.
 *
 * `Keyring` is server-issued owner-scoped material. Workspace encryption does
 * not use it directly; each entry is narrowed with the workspace id so the
 * same owner gets independent keys for different Y.Doc roots.
 *
 * This is also the single point where transport keyring entries are decoded,
 * so the post-schema invariants are asserted here: no duplicate `version`
 * (a silent overwrite would orphan blobs encrypted under the losing entry)
 * and 32-byte decoded length (HKDF accepts any IKM, so a wrong length would
 * succeed without diagnostic).
 */
export function deriveWorkspaceKeyring(
	keyring: Keyring,
	workspaceId: string,
): WorkspaceKeyring {
	const workspaceKeyring: WorkspaceKeyring = new Map();
	for (const { version, keyBytesBase64 } of keyring) {
		if (workspaceKeyring.has(version)) {
			throw new Error(`Keyring has duplicate version: ${version}`);
		}
		const keyBytes = base64ToBytes(keyBytesBase64);
		if (keyBytes.length !== 32) {
			throw new Error(
				`Keyring version ${version}: expected 32 decoded bytes, got ${keyBytes.length}`,
			);
		}
		workspaceKeyring.set(version, deriveWorkspaceKey(keyBytes, workspaceId));
	}
	return workspaceKeyring;
}
