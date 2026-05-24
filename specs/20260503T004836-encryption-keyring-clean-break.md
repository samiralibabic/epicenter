# Encryption Keyring Clean Break

**Date**: 2026-05-03
**Status**: Implemented
**Author**: AI-assisted

**Supersedes**: The encryption package portion of `20260503T002441-auth-client-sync-clean-break.md`. That spec moved encryption key schemas into `@epicenter/encryption`; this spec finishes the boundary by moving the shared keyring codec, derivation helpers, and generic encrypted blob primitives there too.

## One-Sentence Test

`@epicenter/encryption` owns encryption key contracts, keyring codecs, key derivation, and generic encrypted blob primitives; `@epicenter/workspace` only owns how those primitives are applied to Yjs document data.

Everything in this spec should serve that sentence. If a parser, byte helper, or encrypted blob primitive still lives under workspace only because workspace was the first consumer, it belongs in `@epicenter/encryption`.

## Overview

Make `@epicenter/encryption` the single source of truth for Epicenter encryption contracts and primitive operations. Keep workspace encryption secrets separate from Better Auth secrets, but use the same `version:secret,version:secret` env grammar that Better Auth uses for rotated secrets.

The result is a clean ownership split:

```txt
Better Auth owns auth secrets.
Epicenter encryption owns workspace encryption secrets.
Workspace owns Yjs integration.
```

## Motivation

### Current State

`apps/api` has a local parser for `ENCRYPTION_SECRETS`:

```ts
// apps/api/src/auth/encryption.ts
const EncryptionKeyring = type('string')
	.pipe.try((value) =>
		value
			.split(',')
			.map((entry) => EncryptionEntryParser.assert(entry))
			.sort((left, right) => right.version - left.version),
	)
	.to([EncryptionEntry, '...', EncryptionEntry.array()]);
```

`packages/encryption` currently owns only the shared auth session key shape and a string helper:

```ts
export const EncryptionKey = type({
	version: 'number.integer > 0',
	userKeyBase64: 'string',
});

export function encryptionKeysFingerprint(keys: EncryptionKeys): string {
	return [...keys]
		.sort((a, b) => a.version - b.version)
		.map((k) => `${k.version}:${k.userKeyBase64}`)
		.join(',');
}
```

`packages/workspace/src/shared/crypto` owns the actual generic encryption machinery:

```ts
export function encryptValue(...)
export function decryptValue(...)
export function deriveWorkspaceKey(...)
export function deriveKeyFromPassword(...)
export function buildEncryptionKeys(...)
export function bytesToBase64(...)
export function base64ToBytes(...)
```

This creates problems:

1. **The package name lies**: `@epicenter/encryption` owns key shapes, but the encryption primitives live under workspace.
2. **The env parser is stranded**: `apps/api` owns `ENCRYPTION_SECRETS` parsing even though it is the canonical workspace encryption keyring format.
3. **The "fingerprint" name is unsafe**: `encryptionKeysFingerprint()` returns a canonical string containing actual key material. It is not a cryptographic fingerprint and should not look safe to log.
4. **The version invariant is late**: encrypted blobs store key version in byte 1, so versions must be `1..255`. The shared schemas currently accept any positive integer.
5. **Docs have drift**: `apps/api/README.md` still says workspace encryption derives from `BETTER_AUTH_SECRET`, while current code derives from `ENCRYPTION_SECRETS`.

### Desired State

`@epicenter/encryption` should expose the whole shared encryption contract:

```ts
import {
	EncryptionKeys,
	deriveUserEncryptionKeys,
	encryptionKeysEqual,
	parseEncryptionSecrets,
} from '@epicenter/encryption';

const secrets = parseEncryptionSecrets(env.ENCRYPTION_SECRETS);
const encryptionKeys = await deriveUserEncryptionKeys({
	secrets,
	userId: user.id,
});
```

`apps/api` should become a thin env and Better Auth integration layer:

```txt
env.ENCRYPTION_SECRETS
  -> parseEncryptionSecrets()
  -> deriveUserEncryptionKeys()
  -> Better Auth customSession()
```

`packages/workspace` should import generic crypto from `@epicenter/encryption`:

```ts
import {
	base64ToBytes,
	deriveWorkspaceKey,
	type EncryptionKeys,
} from '@epicenter/encryption';
```

## Research Findings

### Better Auth Secret Rotation

Better Auth uses `BETTER_AUTH_SECRET` for its own auth cryptography, including cookies, JWE, JWT verification, OAuth state, and related internal signing or encryption work.

Better Auth also supports `BETTER_AUTH_SECRETS` as a rotated secret list using the grammar:

```txt
BETTER_AUTH_SECRETS=2:new-secret,1:old-secret
```

The important finding: Better Auth does not expose or expect an application encryption key fingerprint string. Its `version:secret` grammar is a good env convention, but Better Auth's auth secret lifecycle is separate from Epicenter's workspace encryption lifecycle.

Implication: Epicenter should copy the grammar, not the ownership.

### Existing Epicenter Encryption Model

Active docs and code already point at a separate `ENCRYPTION_SECRETS` env var:

```txt
ENCRYPTION_SECRETS="2:newBase64Secret,1:oldBase64Secret"
```

The encrypted blob format stores the key version in one byte:

```txt
Byte 0: format version
Byte 1: key version
Byte 2..25: nonce
Byte 26..end: ciphertext and tag
```

Implication: secret versions must fit in `1..255`, and that invariant belongs in `@epicenter/encryption`.

## Design Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Package owner | `@epicenter/encryption` | Encryption contracts and primitives are not workspace-owned. Auth, API, and workspace all consume them. |
| Env variable | Keep `ENCRYPTION_SECRETS` | Workspace encryption rotation must not share a lifecycle with auth cookie and token rotation. |
| Env grammar | Reuse `version:secret,version:secret` | Matches Better Auth's rotated secret convention without coupling to Better Auth internals. |
| Current key | Highest version | Matches the encrypted wrapper's current-version behavior and the existing API parser. |
| Version range | `1..255` | Blob byte 1 stores key version. Values outside this range cannot round-trip safely. |
| Duplicate versions | Invalid | A key version must identify exactly one secret. |
| Fingerprint helper | Replace with `encryptionKeysEqual()` | Equality is the caller need. A string containing secret material should not be named fingerprint. |
| Workspace crypto module | Move generic parts to `@epicenter/encryption` | Workspace should only keep Yjs-specific wrappers and attachment logic. |
| Better Auth dependency | None | `@epicenter/encryption` must not import Better Auth. The shared grammar is a convention, not a dependency. |

## Architecture

### Before

```txt
apps/api
  src/auth/encryption.ts
    parse ENCRYPTION_SECRETS
    derive user keys
    local bytesToBase64

packages/encryption
  EncryptionKey
  EncryptionKeys
  encryptionKeysFingerprint

packages/workspace
  shared/crypto
    encryptValue
    decryptValue
    deriveWorkspaceKey
    deriveKeyFromPassword
    bytesToBase64
    base64ToBytes
```

### After

```txt
packages/encryption
  src/keys.ts
    EncryptionKey
    EncryptionKeys
    encryptionKeysEqual

  src/secrets.ts
    EncryptionSecret
    EncryptionSecrets
    parseEncryptionSecrets
    formatEncryptionSecrets

  src/derivation.ts
    deriveUserEncryptionKeys
    deriveWorkspaceKey
    deriveKeyFromPassword
    buildEncryptionKeys

  src/blob.ts
    EncryptedBlob
    encryptValue
    decryptValue
    getKeyVersion
    isEncryptedBlob

  src/bytes.ts
    bytesToBase64
    base64ToBytes

apps/api
  imports @epicenter/encryption
  owns only env access and Better Auth customSession wiring

packages/workspace
  imports @epicenter/encryption
  owns only Yjs application of encryption primitives
```

### Runtime Flow

```txt
ENCRYPTION_SECRETS env
  |
  v
parseEncryptionSecrets()
  |
  v
EncryptionSecrets sorted by version descending
  |
  v
deriveUserEncryptionKeys({ secrets, userId })
  |
  v
Better Auth customSession response
  |
  v
client auth session
  |
  v
workspace.applyEncryptionKeys(session.encryptionKeys)
  |
  v
deriveWorkspaceKey(userKey, workspaceId)
  |
  v
Yjs encrypted wrapper encrypts values with current key version
```

## Proposed Public API

```ts
export const EncryptionKey = type({
	version: 'number.integer >= 1 <= 255',
	userKeyBase64: 'string',
});

export const EncryptionKeys = type([
	EncryptionKey,
	'...',
	EncryptionKey.array(),
]);

export const EncryptionSecret = type({
	version: 'number.integer >= 1 <= 255',
	secret: 'string',
});

export const EncryptionSecrets = type([
	EncryptionSecret,
	'...',
	EncryptionSecret.array(),
]);
```

```ts
export function parseEncryptionSecrets(value: string): EncryptionSecrets;

export function formatEncryptionSecrets(
	secrets: EncryptionSecrets,
): string;

export function encryptionKeysEqual(
	left: EncryptionKeys,
	right: EncryptionKeys,
): boolean;

export function deriveUserEncryptionKeys(input: {
	secrets: EncryptionSecrets;
	userId: string;
}): Promise<EncryptionKeys>;
```

```ts
export function deriveWorkspaceKey(
	userKey: Uint8Array,
	workspaceId: string,
): Uint8Array;

export function buildEncryptionKeys(
	userKey: Uint8Array,
	version?: number,
): EncryptionKeys;

export function bytesToBase64(bytes: Uint8Array): string;
export function base64ToBytes(base64: string): Uint8Array;
```

```ts
export type EncryptedBlob = Uint8Array & Brand<'EncryptedBlob'>;

export function encryptValue(
	plaintext: string,
	key: Uint8Array,
	aad?: Uint8Array,
	keyVersion?: number,
): EncryptedBlob;

export function decryptValue(
	blob: EncryptedBlob,
	key: Uint8Array,
	aad?: Uint8Array,
): string;

export function getKeyVersion(blob: EncryptedBlob): number;
export function isEncryptedBlob(value: unknown): value is EncryptedBlob;
```

## Implementation Plan

### Phase 1: Move Generic Crypto Into `@epicenter/encryption`

- [x] **1.1** Create `packages/encryption/src/keys.ts`, `secrets.ts`, `bytes.ts`, `derivation.ts`, and `blob.ts`.
- [x] **1.2** Move `EncryptionKey` and `EncryptionKeys` into `keys.ts`.
- [x] **1.3** Move `bytesToBase64`, `base64ToBytes`, `deriveWorkspaceKey`, `deriveKeyFromPassword`, `generateSalt`, `buildEncryptionKeys`, `encryptValue`, `decryptValue`, `getKeyVersion`, `isEncryptedBlob`, and `EncryptedBlob` from `packages/workspace/src/shared/crypto/index.ts` into `packages/encryption`.
- [x] **1.4** Add required runtime dependencies to `packages/encryption/package.json`: `@noble/ciphers`, `@noble/hashes`, and `wellcrafted` if the branded type stays.
- [x] **1.5** Update `packages/encryption/src/index.ts` to export the new modules.
- [x] **1.6** Add a `test` script to `packages/encryption/package.json` because the package will own focused crypto tests.

### Phase 2: Add Canonical Secret Keyring Codec

- [x] **2.1** Add `EncryptionSecret` and `EncryptionSecrets` schemas with version range `1..255`.
- [x] **2.2** Implement `parseEncryptionSecrets(value)` using first-colon splitting per entry.
- [x] **2.3** Sort parsed secrets by version descending.
- [x] **2.4** Reject empty strings, missing colons, invalid versions, empty secrets, and duplicate versions.
- [x] **2.5** Implement `formatEncryptionSecrets(secrets)` as the canonical encoder, also sorted by version descending.
- [x] **2.6** Add tests covering valid parse, canonical sort, round trip, duplicate versions, malformed entries, and version bounds.

### Phase 3: Replace API Local Keyring Logic

- [x] **3.1** Replace `apps/api/src/auth/encryption.ts` parser code with imports from `@epicenter/encryption`.
- [x] **3.2** Keep `cloudflare:workers` env access in `apps/api`; do not move env reads into the package.
- [x] **3.3** Keep the module-load fail-fast behavior for malformed `ENCRYPTION_SECRETS`.
- [x] **3.4** Add `@epicenter/encryption` to `apps/api/package.json` dependencies.
- [x] **3.5** Update comments in `apps/api/src/auth/create-auth.ts` only where they mention ownership or derivation source.

### Phase 4: Replace Fingerprint Equality

- [x] **4.1** Replace `encryptionKeysFingerprint()` with `encryptionKeysEqual()`.
- [x] **4.2** Update `packages/auth/src/create-auth.ts` to call `encryptionKeysEqual(left.encryptionKeys, right.encryptionKeys)`.
- [x] **4.3** Update `packages/workspace/src/document/attach-encryption.ts` to use `encryptionKeysEqual()` for same-key dedup, or keep a private `lastKeys` copy and compare structurally.
- [x] **4.4** Remove stale "fingerprint" language from comments and docs.
- [x] **4.5** Do not introduce a public persisted fingerprint string.

### Phase 5: Update Workspace Imports

- [x] **5.1** Update workspace imports from `../shared/crypto/index.js` or `../crypto` to `@epicenter/encryption`.
- [x] **5.2** Delete or reduce `packages/workspace/src/shared/crypto/index.ts` after callers move. If a compatibility export is kept temporarily, it must be private to tests or removed before completion.
- [x] **5.3** Move `packages/workspace/src/shared/crypto/crypto.test.ts` coverage into `packages/encryption/src/*.test.ts`.
- [x] **5.4** Keep Yjs-specific encrypted wrapper tests in workspace.
- [x] **5.5** Remove `@noble/ciphers` and `@noble/hashes` from workspace package dependencies if production workspace code no longer imports them. Keep test-only dependency only if workspace tests still import `randomBytes`.

### Phase 6: Documentation Cleanup

- [x] **6.1** Update `apps/api/README.md` to say workspace encryption derives from `ENCRYPTION_SECRETS`, not `BETTER_AUTH_SECRET`.
- [x] **6.2** Update `docs/encryption.md` only where package ownership or helper names changed.
- [x] **6.3** Update active specs that reference `encryptionKeysFingerprint` or workspace-owned crypto primitives.
- [x] **6.4** Leave historical specs intact unless they are marked active implementation references.

## Edge Cases

### Duplicate Key Version

Input:

```txt
2:alpha,2:bravo
```

Expected behavior: reject it. One key version must map to one secret.

### Version Outside Blob Range

Input:

```txt
256:secret
```

Expected behavior: reject it. The encrypted blob stores key version in byte 1, so version `256` would be truncated if passed to `encryptValue()`.

### Secret Contains Colon

Input:

```txt
1:secret:with:colons
```

Expected behavior: parse as `{ version: 1, secret: 'secret:with:colons' }`. Split on the first colon only.

### Secret Contains Comma

Input:

```txt
1:secret,with,comma
```

Expected behavior: invalid. The env grammar reserves comma as the entry separator. This is acceptable because generated base64 secrets do not contain commas.

### Existing Session Storage

Existing persisted auth sessions already store `encryptionKeys` as JSON. This change does not require a session storage migration because the shape remains:

```ts
Array<{ version: number; userKeyBase64: string }>
```

The only difference is stricter validation for version range.

## Verification

Run focused checks first:

```bash
bun run --filter @epicenter/encryption typecheck
bun run --filter @epicenter/encryption test
bun run --filter @epicenter/auth typecheck
bun run --filter @epicenter/auth test
bun run --filter @epicenter/workspace typecheck
bun run --filter @epicenter/workspace test
bun --cwd apps/api run typecheck
```

Then run the repo-level checks:

```bash
bun typecheck
bun test
```

Search checks:

```bash
rg "encryptionKeysFingerprint|fingerprint" packages/encryption packages/auth packages/workspace apps/api
rg "BETTER_AUTH_SECRET" apps/api/README.md docs/encryption.md
rg "shared/crypto" packages apps
```

Expected results:

- No active code imports `encryptionKeysFingerprint`.
- `BETTER_AUTH_SECRET` remains only for Better Auth docs and config, not workspace encryption docs.
- Workspace does not expose generic crypto as `@epicenter/workspace/shared/crypto`.

## Non-Goals

- Do not merge `ENCRYPTION_SECRETS` into `BETTER_AUTH_SECRET` or `BETTER_AUTH_SECRETS`.
- Do not import Better Auth from `@epicenter/encryption`.
- Do not change the auth session wire shape beyond stricter version validation.
- Do not change the encrypted blob binary format.
- Do not add a separate key-fetch endpoint.
- Do not implement true end-to-end encryption in this spec.

## Open Questions

1. **Should `packages/workspace` keep a temporary `./shared/crypto` export?**
   - Recommendation: no. This is a clean break, and internal callers can move in one pass. Keeping the export invites callers to keep using the wrong owner.

2. **Should `encryptValue()` validate `keyVersion` directly too?**
   - Recommendation: yes. Even with schema validation upstream, this public primitive should reject versions outside `1..255` before writing byte 1.

3. **Should `formatEncryptionSecrets()` preserve input order or canonicalize descending?**
   - Recommendation: canonicalize descending. The highest version is the current key, so the string should make that visually obvious.

## Review

**Completed**: 2026-05-03

### Summary

Implemented the clean package boundary: @epicenter/encryption now owns key contracts, secret parsing and formatting, user and workspace derivation helpers, byte helpers, and generic encrypted blob primitives. Workspace now imports generic crypto from @epicenter/encryption, apps/api keeps env ownership while delegating parsing and derivation, and auth uses encryptionKeysEqual() instead of material-bearing string comparison.

### Deviations from Spec

- Added a standard test script to packages/auth/package.json so the requested filtered auth test command can run.
- The exact command bun --cwd apps/api run typecheck prints Bun run help with the installed Bun version, so verification used the equivalent bun run --cwd apps/api typecheck.
- Repo-wide bun typecheck and bun test still have unrelated existing failures outside this spec. Focused package and API checks passed.

### Follow-up Work

- Fix unrelated repo-wide typecheck failures in apps/landing and packages/svelte-utils.
- Fix unrelated root bun test failures in playground/opensidian-e2e module resolution and packages/cli daemon cleanup expectations.
