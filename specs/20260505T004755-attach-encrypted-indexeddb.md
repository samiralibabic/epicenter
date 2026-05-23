# `attachEncryptedIndexedDb`: storage-level encryption on the encryption coordinator

**Date**: 2026-05-05
**Status**: Implemented
**Author**: AI-assisted (Claude), grilled by Braden
**Branch**: not started
**Depends on**: `specs/20260504T233223-sign-out-preserves-local-data.md`: the local IDB key shape (`epicenter:v1:user:{userId}:yjs:{ydocGuid}`) and the encryption coordinator pattern this spec extends
**Unblocks**: Phase 4 of the sign-out spec: preserve-on-sign-out for fuji, honeycrisp, opensidian, tab-manager root storage, and Skills only if Skills becomes authenticated

## One-sentence thesis

> **The encryption coordinator owns a storage-level encryption primitive that AEAD-encrypts every Yjs update before IndexedDB write and decrypts on read, scoped per-`ydoc.guid` via the same HKDF derivation the coordinator already uses for cell-level keys.**

## What this spec adds

One method on the existing `attachEncryption` coordinator:

```ts
const encryption = attachEncryption(ydoc);
encryption.attachTables(defs);                        // exists today (cell-level encryption)
encryption.attachKv(defs);                            // exists today (cell-level encryption)
encryption.attachEncryptedIndexedDb(targetYdoc, {
  persistenceKey: createLocalYjsKey(userId, targetYdoc.guid),
});                                                   // NEW (storage-level encryption)
```

`attachEncryptedIndexedDb`:
- Implements an encrypted sibling provider to `attachIndexedDb`.
- AEAD-encrypts each binary Yjs update before write using XChaCha20-Poly1305 (same primitive as `attachEncryption`).
- AEAD-decrypts on read.
- Derives the per-target key via the existing `deriveWorkspaceKey(userKey, targetYdoc.guid)` function.
- Returns the same shape as `attachIndexedDb` (`whenLoaded`, `clearLocal`, `whenDisposed`).

It is a drop-in replacement at the attachment contract level; call sites still provide the owner-scoped `persistenceKey` because the encryption coordinator knows keys, not user ids.

## Threat model

This spec exists to address a threat the cell-level encryption does not.

```
Threat A: honest-but-curious server reads values over the wire.
  Defense: cell-level encryption (attachEncryption.attachTables / .attachKv).
  Status: active for root tables today.

Threat B: local at-rest snooping (malicious browser extension, devtools
  paste-in attack, shared-device access to IDB blobs).
  Defense: storage-level encryption (attachEncryptedIndexedDb).
  Status: not implemented today.

Threat C: zero-knowledge server (server cannot do server-side CRDT merge
  or queries, only relay).
  Defense: would require update-level wire encryption, which breaks
  server-side merge, snapshots, and search.
  Status: out of scope. This codebase chose the trusted-server model.
```

Cell-level and storage-level encryption stack. They protect different things and should not be conflated:

| | Cell-level | Storage-level |
|---|---|---|
| Encrypts | Cell values in `EncryptedYKeyValueLww` stores | Every binary Yjs update written to IDB |
| Plaintext leaks | Yjs structural metadata (table names, row IDs, LWW timestamps), update sizes | Local database name, row count, blob sizes, and write timing remain visible; Yjs content and structure are opaque |
| Required for | Wire safety (server doesn't see values) | At-rest safety (browser-local snooping) |
| Works on | Tables and KV (KV-shaped Yjs types) | Any ydoc; rich text, plain text, structural Y types all included |
| Apps using it | fuji, honeycrisp, opensidian, tab-manager root storage, Skills only if authenticated | Nothing today |

## Why this is the right shape

### Why a method on the encryption coordinator and not a top-level primitive

The encryption coordinator already owns the keyring (per `packages/workspace/src/document/attach-encryption.ts:6`: *"derives a per-workspace HKDF keyring from base64 user keys"*). Adding `attachEncryptedIndexedDb` as a method:

- Reuses the existing user-key source. No new way to pass keys.
- Reuses the existing HKDF derivation function (`deriveWorkspaceKey`). The per-target key is derived from `(userKey, targetYdoc.guid)`: same derivation, different label per child guid.
- Mirrors the existing method shape (`encryption.attachTables`, `encryption.attachKv`). Reads naturally to anyone who has used cell-level encryption.
- Makes the dependency explicit: "this storage is encrypted *by the encryption coordinator*."

A top-level `attachEncryptedIndexedDb(ydoc, { keys })` primitive would force apps to plumb keys separately and would invent a second key-passing pattern alongside the existing coordinator. Refused.

### Why authless data keeps using `attachIndexedDb`

`attachEncryption` requires an auth-derived user key (applied via `applyKeys`). Authless data has no key source and no encryption attachment. It keeps calling `attachIndexedDb(ydoc)` directly. The new primitive is opt-in for account-owned persistence that has an encryption coordinator.

Zhongwen chat history no longer belongs in the authless bucket. Its current browser builder is local-only, but the product decision after review is that chat history belongs to the signed-in account. Zhongwen should migrate to the authenticated encrypted path with the other account-owned browser apps.

### Why storage-level is needed on top of cell-level

- Cell-level encryption operates on `EncryptedYKeyValueLww` cells: KV stores. It does not apply to `Y.XmlFragment` (rich text) or `Y.Text` (plain text). Apps with rich text content (fuji entries, honeycrisp notes, opensidian files, skills instructions) cannot encrypt that content via the cell-level layer no matter how much they try to extend it.
- Cell-level encryption leaks structural metadata even for the data it does cover. A snooper reading `epicenter.fuji` IDB sees that the entries table exists, how many rows it has, and when each was last updated. Storage-level encrypts the entire write stream so even structure is opaque.

Both are real gaps. Storage-level encryption closes them.

## Design decisions

| Decision | Class | Choice | Rationale |
|---|---|---|---|
| API surface | Clean break | Method on `attachEncryption`, not top-level primitive | Reuses coordinator's keyring; mirrors existing `attachTables` / `attachKv` shape; makes dependency explicit. |
| Per-target key derivation | Evidence | Reuse existing `deriveWorkspaceKey(userKey, targetYdoc.guid)` | Same HKDF function we already use for the root. Different label (target's guid) -> different key. No new crypto. |
| Cipher | Evidence | XChaCha20-Poly1305 (AEAD) | Already in `@epicenter/encryption`. Same as cell-level. Random nonce per write. |
| Wire format | Clean break | `[format=1][keyVersion][24 bytes nonce][ciphertext+tag]` | Format byte for future changes. Key version lets old local updates remain readable across key rotation. Nonce per write so identical updates are not detectable. AEAD tag inline. |
| Required-keys ordering | Clean break | Throw if `applyKeys` has not run when `attachEncryptedIndexedDb` is called | Loud failure at construction. The factory in `createDisposableCache` runs lazily; by the time UI opens an entry, auth has fired. If it ever fires too early, the throw is a useful signal, not a silent regression. |
| Migration of existing plaintext IDBs | Asymmetric win | None: sign-out spec changes the IDB key shape, orphaning legacy data | Sign-out spec moves IDB names from `ydoc.guid` to `epicenter:v1:user:{userId}:yjs:{ydocGuid}`. Legacy data is unreachable via the new naming. Resyncing from the server is the recovery path for in-flight users. No legacy reader needed. |
| Key rotation | Attach-time invariant | Encrypted IDB attachments derive their write keyring when they attach | Mirrors the current coordinator shape. Future writes use the highest version from the attached keyring; old blobs stay readable because each blob stores `keyVersion` and the attached keyring keeps historical keys. Same-user rotation needs a reattach to affect an already-open provider. |
| Cross-tab sync | Evidence | Unaffected | BroadcastChannel sends Yjs update bytes between tabs in the same browser. Both tabs have the same keys (same auth). The encryption is at the IDB write layer, not the BC layer. No double-encrypt. |
| Wire sync | Evidence | Unaffected | `attachSync` sends Yjs update bytes over the WebSocket. Server is the trusted-merge layer. Cell-level encryption already covers value privacy on the wire. Storage-level operates only on what hits IDB. |
| Bundling with `attachIndexedDb` API | Clean break | Same return shape (`whenLoaded`, `clearLocal`, `whenDisposed`) | Drop-in replacement at the call site. Apps swap one line in their child-doc factory; nothing else changes. |
| Encryption of root docs too | Greenfield | Required for authenticated preserve-on-sign-out apps | The sign-out spec reconstructs browser workspaces after auth is known, so root encrypted storage can attach after keys. That closes structural metadata leaks on local disk. |
| Relationship to `y-indexeddb` | Evidence | Do not wrap upstream `IndexeddbPersistence` | Upstream writes raw updates to the `updates` object store inside its own listener. There is no public transform hook. Build a sibling provider with the same return contract instead. |

## Architecture

### Layering

```
                    ┌─────────────────────────────────────┐
                    │ Y.Doc                               │
                    │   (in-memory CRDT state)            │
                    └────────────┬────────────────────────┘
                                 │
                                 │ ydoc.on('updateV2', update => ...)
                                 │
        ┌────────────────────────┼────────────────────────┬─────────────────────────┐
        │                        │                        │                         │
        ▼                        ▼                        ▼                         ▼
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────────┐  ┌──────────────────┐
│ attachSync       │  │ attachBroadcast  │  │ attachEncryptedIDB   │  │ attachIndexedDb  │
│   over WebSocket │  │   Channel        │  │   (NEW)              │  │   (today, plain) │
│                  │  │   (cross-tab)    │  │                      │  │                  │
│   wire bytes     │  │   plaintext bc   │  │ encrypt(update)      │  │ write update raw │
│   (cell-level    │  │   between tabs   │  │   -> IDB              │  │   -> IDB          │
│    encrypted     │  │   that share     │  │ decrypt(blob)        │  │                  │
│    if attached)  │  │   the keyring    │  │   -> applyUpdate      │  │                  │
└──────────────────┘  └──────────────────┘  └──────────────────────┘  └──────────────────┘
```

The four attachments are independent. An app picks any subset:
- Authless local-only data: `attachIndexedDb` + `attachBroadcastChannel`
- Authenticated, no at-rest privacy: `attachIndexedDb` + `attachBroadcastChannel` + `attachSync` + `attachEncryption.attachTables`
- Authenticated, full at-rest privacy: same as above but `attachEncryption.attachEncryptedIndexedDb` instead of plain `attachIndexedDb`

### Wire format on disk

```
┌────────────┬────────────┬──────────────────────────────┬─────────────────────────────┐
│ format     │ keyVersion │ nonce                        │ ciphertext + AEAD tag       │
│ (1 byte)   │ (1 byte)   │ (24 bytes, random per-write) │ (N bytes)                   │
└────────────┴────────────┴──────────────────────────────┴─────────────────────────────┘
                                                         │
                                                         └── XChaCha20-Poly1305(
                                                               key=deriveWorkspaceKey(userKey, ydoc.guid),
                                                               plaintext=Y.updateV2 chunk,
                                                               nonce=random
                                                             )
```

Format byte:
- `0x01`: XChaCha20-Poly1305, 1-byte key version, 24-byte nonce, key from `deriveWorkspaceKey(userKey, ydoc.guid)`.
- Reserved for future versions if cipher or KDF changes.

### Call site shape

Today (fuji `apps/fuji/src/lib/fuji/browser.ts:49-89`):

```ts
const entryContentDocs = createDisposableCache(
  (entryId: EntryId) => {
    const ydoc = new Y.Doc({ guid: entryContentDocGuid({...}), gc: false });
    const body = attachRichText(ydoc);
    const childIdb = attachIndexedDb(ydoc);          // <- plaintext on disk
    const childSync = attachSync(ydoc, { url, waitFor: childIdb.whenLoaded, auth });
    ...
  },
  { gcTime: 5_000 },
);
```

After this spec:

```ts
const entryContentDocs = createDisposableCache(
  (entryId: EntryId) => {
    const ydoc = new Y.Doc({ guid: entryContentDocGuid({...}), gc: false });
    const body = attachRichText(ydoc);
    const childIdb = doc.encryption.attachEncryptedIndexedDb(ydoc, {
      persistenceKey: createLocalYjsKey(identity.user.id, ydoc.guid),
    });  // <- encrypted on disk
    const childSync = attachSync(ydoc, { url, waitFor: childIdb.whenLoaded, auth });
    ...
  },
);
```

The storage attachment changes and the explicit default `gcTime` argument disappears. The encryption coordinator (`doc.encryption`) is the same one already used for `attachTables` and `attachKv` on the root.

## Implementation plan

### Phase 1: Add the storage encryption primitive

- [x] **1.1** In `@epicenter/encryption`, add binary helpers: `encryptBytes({ key, keyVersion, plaintext, aad })` and `decryptBytes({ keyring, blob, aad })`. Use XChaCha20-Poly1305 with random 24-byte nonce.
  > **Note**: The helpers live in `packages/encryption/src/blob.ts`, not `crypto.ts`; this matches the existing encrypted blob ownership.
- [x] **1.2** Wire format: `[format=0x01][keyVersion][24-byte nonce][ciphertext+tag]`.
- [x] **1.3** Add unit tests: round-trip, format byte present, key version present, nonce uniqueness across writes, decryption fails with wrong key, decryption fails with tampered ciphertext, old-key blob decrypts when the keyring includes the old version.

### Phase 2: Add `attachEncryptedIndexedDb` to the encryption coordinator

- [x] **2.1** In `packages/workspace/src/document/attach-encryption.ts`, add a method on the returned attachment:
  ```ts
  attachEncryptedIndexedDb(targetYdoc: Y.Doc, opts: { persistenceKey: string }): IndexedDbAttachment
  ```
- [x] **2.2** The method derives a per-target keyring on demand: `deriveWorkspaceKey(userKey, targetYdoc.guid)`. Throw if `applyKeys` has not been called yet on the coordinator.
- [x] **2.3** Register encrypted IDB attachments with the same coordinator machinery used by encrypted table/KV stores so future `applyKeys` calls update the write key.
- [x] **2.4** Implement a sibling provider to `attachIndexedDb`:
  - Open an IndexedDB database named by `opts.persistenceKey`.
  - Read encrypted rows from an `updates` object store, decrypt them, and apply with `Y.applyUpdateV2(targetYdoc, update)`.
  - Listen to `targetYdoc.on('updateV2', ...)` and write encrypted bytes instead of raw updates.
  - Preserve the existing `whenLoaded`, `clearLocal`, `whenDisposed` shape from `attachIndexedDb`.
- [x] **2.5** Do not import or subclass upstream `IndexeddbPersistence` for the encrypted provider. Its raw-write listener is the thing this primitive replaces.
- [x] **2.6** Unit tests:
  - Round-trip: write update, read back, Y.Doc state matches.
  - Throws if called before `applyKeys`.
  - Different `targetYdoc.guid` -> different derived key for the same plaintext.
  - A multi-version keyring writes with the highest key version while old rows remain readable.
  - `clearLocal()` clears the encrypted IDB.
  > **Note**: `attachIndexedDb` also gained an optional `persistenceKey`, preserving the default `ydoc.guid` behavior while sharing the owner-scoped key plumbing needed by the sign-out spec.

### Phase 3: Migrate participating apps

> **Implementation note**: Deferred to `specs/20260504T233223-sign-out-preserves-local-data.md` Phases 3 and 4. The original wording here treated the app call-site migration as a one-line replacement, but the same spec later documents the blocker: current authenticated browser workspaces are constructed before auth identity and `applyKeys()`. Because this primitive intentionally throws before keys are applied, migrating app call sites before the sign-out spec's construction-order change would create a startup failure or require a plaintext fallback. The primitive is landed here; app migration happens after auth-scoped construction.

For each authenticated app with local Yjs persistence:

- [ ] **3.1** `apps/fuji/src/lib/fuji/browser.ts`: root and child entry content docs use `doc.encryption.attachEncryptedIndexedDb(..., { persistenceKey })` instead of `attachIndexedDb(...)`.
- [ ] **3.2** `apps/honeycrisp/src/lib/honeycrisp/browser.ts`: same for root and note bodies.
- [ ] **3.3** `apps/opensidian/src/lib/opensidian/browser.ts`: same for root and file content.
- [ ] **3.4** `apps/tab-manager/src/lib/tab-manager/extension.ts`: same for root workspace storage.
- [ ] **3.5** `apps/zhongwen/src/lib/zhongwen/browser.ts`: migrate chat history to authenticated encrypted local persistence. Require auth identity before construction and apply keys before attaching IndexedDB.
- [ ] **3.6** `apps/skills/src/lib/skills/browser.ts`: only migrate if Skills becomes authenticated and has keys at construction. If it remains authless, keep direct `attachIndexedDb` and classify that persistence in the sign-out spec.
- [x] **3.7** Do not migrate authless packages just to standardize the call site. The coordinator method requires keys by design.
  > **Update**: Authless packages remain on direct `attachIndexedDb`; Zhongwen chat history is not authless.

### Phase 4: Unblock the sign-out spec's Phase 4

- [x] **4.1** Update `specs/20260504T233223-sign-out-preserves-local-data.md` Phase 4 ("Close the plaintext child-doc gap"): the resolution is "use `encryption.attachEncryptedIndexedDb` for child docs in fuji/honeycrisp/opensidian, and in Skills only if Skills becomes authenticated." The blocker disappears.
  > **Note**: The sign-out spec already names this primitive as the Phase 4 resolution. The remaining app call-site work is intentionally executed there after auth-scoped construction.
- [ ] **4.2** Manual smoke for the local-disk verification in the sign-out spec's Phase 10.8: with this spec landed, persisted child content survives sign-out as ciphertext.

### Phase 5: Verify

- [x] **5.1** Run `bun test packages/encryption` (new primitive tests).
- [x] **5.2** Run `bun test packages/workspace/src/document/attach-encryption.test.ts` (extended tests).
- [ ] **5.3** Run `bun run typecheck`.
  > **Note**: Ran `bun run --cwd packages/workspace typecheck` successfully. Full `bun run typecheck` was attempted and failed in pre-existing `@epicenter/svelte` and `@epicenter/landing` diagnostics unrelated to this primitive, including unresolved `#/utils.js` aliases in `packages/ui` Svelte files and existing `from-table.svelte.ts` result-shape errors.
- [ ] **5.4** Manual smoke: open a child doc in fuji, edit it, inspect IDB devtools, confirm content is opaque ciphertext.
  > **Note**: Deferred to the sign-out spec after app call sites move to auth-scoped construction.
- [ ] **5.5** Manual smoke: sign out, inspect IDB devtools, confirm child doc content is still opaque.
  > **Note**: Deferred to the sign-out spec after app call sites move to auth-scoped construction.
- [ ] **5.6** Manual smoke: sign back in as same user, confirm child doc decrypts and content reappears.
  > **Note**: Deferred to the sign-out spec after app call sites move to auth-scoped construction.

## Edge cases

### Calling `attachEncryptedIndexedDb` before `applyKeys`

The coordinator has no user key to derive from. Throws with a clear message:

```
Cannot attach encrypted IndexedDB: encryption coordinator has no keys.
Call encryption.applyKeys(...) before attaching encrypted storage.
```

In practice this should not fire. The factory in `createDisposableCache` runs lazily when UI opens an entry, by which time auth has fired. If it ever does fire, the throw points at the misordering.

### Key rotation while child docs are open

The provider does not observe same-user key rotation after it has attached.

- Future IDB writes use the highest key version from the keyring captured at attach time.
- Existing IDB rows remain readable because each blob stores its key version and `decryptBytes` chooses from that attached keyring.
- To pick up a newer keyring, the owning workspace must reattach or remount the encrypted provider.

If a rotation revokes old keys, old local data becomes undecryptable. Treat that as a destructive security event: clear the affected owner-scoped local cache and resync from the server.

### Reading existing plaintext child IDBs

The sign-out spec changes the IDB key shape from `ydoc.guid` to `epicenter:v1:user:{userId}:yjs:{ydocGuid}`. Existing plaintext IDBs at the old key shape are not read by the new shape: they're orphaned. Sync re-fetches the data from the server.

In-flight users will lose unsynced offline edits during this transition. This is the same one-time cost as the sign-out spec; we don't pay it twice.

If we want to recover that data, a one-time migration could read the old plaintext IDB, encrypt, and write to the new key. Not in scope here. Likely not worth it given the small number of in-flight users at deploy time.

### Storage-level encryption + cell-level encryption together

Both can be active on the same Y.Doc. Cell-level happens during Y.Doc operations (user writes a value -> encrypted at the cell layer). Storage-level happens during IDB writes (Yjs serializes to update bytes -> encrypted at the storage layer).

The result on disk: the IDB blob is the storage-level ciphertext of the storage-level plaintext (which itself contains cell-level ciphertext of values). Two unwraps to read a value. CPU cost is small; XChaCha20 is fast.

No bug from double-encryption. Wire and BC are unaffected because they don't go through IDB.

### A workspace bundle calls `attachEncryptedIndexedDb` before auth construction

Today, `openFuji({ auth, peer })` is called at module load in `client.ts`. The coordinator's `applyKeys` fires later via `bindAuthWorkspaceScope.applyAuthIdentity`. Module-level `attachEncryptedIndexedDb` would throw because keys are not applied yet.

Solution: the sign-out spec restructures authenticated browser construction so it happens after auth identity is known. Browser factories receive `identity.encryptionKeys`, call `doc.encryption.applyKeys(identity.encryptionKeys)`, then attach encrypted local persistence. No deferred encrypted IDB primitive, no keys promise, no plaintext fallback.

## Deferred non-blockers

1. **Should we offer `attachEncryptedSqlite` for parity with `attachSqlite`?**
   - The codebase has `packages/workspace/src/document/attach-sqlite.ts` for materializer-style SQLite mirrors.
   - Storage-level encryption applies the same way.
   - **Decision:** Refuse for this spec. Not blocking sign-out. Add when a concrete consumer needs it.

2. **Do we need a "decrypt or fall through" reader for in-progress migration?**
   - The sign-out spec already orphans existing IDBs by changing the key shape. So the question is moot: there's nothing to fall through to.
   - **Decision:** No. Greenfield migration via the sign-out spec's key change.

3. **Cipher choice: should we expose alternatives (AES-GCM, ChaCha20-Poly1305)?**
   - Today the codebase uses XChaCha20-Poly1305 via `@noble/ciphers`. Same primitive everywhere.
   - **Decision:** Single cipher for v1. Version byte allows future migration if needed.

## Success criteria

- [x] `attachEncryption(...).attachEncryptedIndexedDb(targetYdoc, { persistenceKey })` exists and returns an `IndexedDbAttachment`-shaped result.
- [x] Throws clearly if `applyKeys` has not been called.
- [x] Per-target key derived via `deriveWorkspaceKey(userKey, targetYdoc.guid)`.
- [x] Wire format on disk is `[format=1][keyVersion][24-byte nonce][ciphertext+tag]`. Verified by reading raw IDB.
- [ ] Authenticated affected apps (fuji, honeycrisp, opensidian, tab-manager) use the encrypted variant for root docs; apps with user-content child docs use it for those child docs too.
  > **Note**: Deferred to the sign-out spec after auth-scoped workspace construction is in place.
- [x] Sign-out spec's Phase 4 blocker is resolved; the spec ships preserve-on-sign-out uniformly.
- [ ] Manual smoke confirms child-doc IDB content is opaque after sign-out.
  > **Note**: Deferred to the sign-out spec after app call sites are migrated.
- [ ] Manual smoke confirms same-user sign-in restores child docs cleanly.
  > **Note**: Deferred to the sign-out spec after app call sites are migrated.

## References

- `specs/20260504T233223-sign-out-preserves-local-data.md`: the spec this unblocks
- `packages/workspace/src/document/attach-encryption.ts`: the coordinator this extends
- `packages/workspace/src/document/attach-indexed-db.ts`: the primitive being mirrored
- `packages/workspace/node_modules/y-indexeddb/src/y-indexeddb.js`: upstream raw-write behavior that blocks wrapper-based encryption
- `packages/encryption/src/derivation.ts`: `deriveWorkspaceKey`
- `packages/encryption/src/blob.ts`: current XChaCha20-Poly1305 blob format to mirror for byte helpers
- `apps/fuji/src/lib/fuji/browser.ts`: the canonical child-doc consumer pattern
- DeepWiki on `yjs/y-indexeddb`: the storage contract being mirrored, not wrapped
- DeepWiki on `bitwarden/server`: the encrypted-at-rest model this spec extends to all our persisted Y types

## Final one-sentence test

After implementation, this must be true:

> **Calling `encryption.attachEncryptedIndexedDb(targetYdoc, { persistenceKey })` returns an IndexedDB attachment that AEAD-encrypts every Yjs update with a per-target key derived from the coordinator's user key, throws if no key has been applied, and preserves the `attachIndexedDb` readiness and cleanup contract.**

If any code path lets plaintext Yjs updates reach IDB through this primitive, or accepts a per-attach key parameter that bypasses the coordinator, or writes a wire format other than `[format=1][keyVersion][24-byte nonce][ciphertext+tag]`, the implementation is incomplete.

## Review

**Completed**: 2026-05-05
**Branch**: `feat/lazy-disposers-bundle-owns-wipe`

### Files read

```txt
packages/
|-- encryption/
|   |-- package.json
|   `-- src/
|       |-- blob.ts
|       `-- crypto.test.ts
`-- workspace/
    |-- package.json
    `-- src/document/
        |-- attach-encryption.ts
        |-- attach-encryption.test.ts
        `-- attach-indexed-db.ts
specs/
`-- 20260505T004755-attach-encrypted-indexeddb.md
```

### Summary

The storage-level primitive is implemented on the encryption coordinator. The encrypted provider is a sibling to `attachIndexedDb`, stores encrypted Yjs V2 updates in the `updates` object store, derives per-target keyrings from the coordinator's user keys, and keeps the `whenLoaded`, `clearLocal`, and `whenDisposed` contract.

### Deviations from Spec

- Binary helpers landed in `packages/encryption/src/blob.ts`, not `crypto.ts`, because that file already owns the encrypted blob format.
- App migrations were deferred to `specs/20260504T233223-sign-out-preserves-local-data.md`. The original Phase 3 conflicted with the edge-case section: current app construction happens before `applyKeys()`, and this primitive intentionally throws before keys exist.
- `attachIndexedDb` gained an optional `persistenceKey` while preserving `ydoc.guid` as the default. This is needed by the sign-out spec's owner-scoped local key work.

### Verification

- `bun test packages/encryption`: passed.
- `bun test packages/workspace/src/document/attach-encryption.test.ts`: passed.
- `bun run --cwd packages/workspace typecheck`: passed.
- `bun run typecheck`: attempted, blocked by existing `@epicenter/svelte` and `@epicenter/landing` diagnostics unrelated to this primitive.

### Follow-up Work

- Execute the sign-out spec's construction-order and app migration phases so authenticated apps attach encrypted root and child IndexedDB after auth identity and keys are available.
- Run the browser manual smokes from the sign-out spec after those call sites move.

## Follow-up Collapse

Implemented by `specs/20260505T020000-collapse-owner-scoping-onto-coordinator.md`.
The public coordinator method is now `encryption.attachIndexedDb(ydoc, { userId })`.
Apps no longer pass `persistenceKey` or call `attachEncryptedIndexedDb`; owner-scoped storage names are derived inside `@epicenter/workspace`.
