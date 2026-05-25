# Never-Touch and Pause List

Codebase-specific facts that the collapse pass must respect. These strings, shapes, and packages outlive any individual session; changing them silently breaks on-disk data, sync, or downstream consumers.

## Durable strings: never change without explicit product decision

These appear in encrypted blobs, on-disk paths, sync wire format, or schemas other apps validate against. They are part of the durable vocabulary of Epicenter.

### HKDF info labels

```
"owner:{label}"        // packages/encryption/src/derivation.ts
"workspace:{workspaceId}"  // packages/encryption/src/derivation.ts
```

Used by the encryption package to derive per-owner keyrings and then per-workspace keys. Changing either label rotates every derived key in every deployment.

History: the first label was `"subject:{subject}"` before commit `af31c870b` (Owner partition collapse) and `926ef1b37` (HKDF prefix rename). Do not revive that vocabulary.

### IndexedDB and BroadcastChannel key

```
"epicenter/{server}/owners/{ownerId}/{ydocGuid}"
```

Used by the browser-side workspace runtime (`packages/workspace/src/document/local-yjs-key.ts`). Forward slashes, includes the API origin host as `{server}` so two team deployments on the same browser profile don't collide, and partition segment is `owners/{ownerId}/` to match the server's URL and R2 shape. Changing the format detaches every existing IndexedDB store from its consumer.

### Durable Object name format and URL shape

```
"owners/{ownerId}/rooms/{roomId}"
```

Used by the sync hub to address rooms (`packages/server/src/owner.ts`, `doName()`). Same shape on the wire: `/api/owners/:ownerId/rooms/:roomId`. Changing the format breaks the routing contract between client and hub.

In personal mode `ownerId` is the signed-in user's id; in team mode it is the literal `TEAM_OWNER_ID` (`'team'`). The path is uniform across modes.

### EncryptedBlob format bytes

- `blob[0] = 1` (format version)
- `blob[1] = key version`

Both bytes are part of the on-disk and on-wire encryption envelope. Bumping them is a migration, not a refactor.

### Public arktype schemas

Other apps validate inputs against these by name and shape. Renaming a field or changing a brand silently invalidates their parsers.

- `PersistedAuth` (`packages/auth/src/auth-types.ts`)
- `ApiSessionResponse` (`packages/auth/src/auth-types.ts`)
- `Keyring` (`packages/encryption/src/keys.ts`, formerly `SubjectKeyring` before `af31c870b`)
- `RootKeyring` (`packages/encryption/src/secrets.ts`)
- `OwnerId`, `UserId`, `TEAM_OWNER_ID` (`packages/auth/src/ids.ts`)

`OwnershipMode` is intentionally NOT in this list: it was moved to
`packages/server/src/types.ts` in `eb85a0d9b` and dropped its arktype
validator (it's a plain `'personal' | 'team'` literal now). It is
server-internal deployment config, not a wire-validated schema.

### Identity strings inside documents

- Y.Doc guid values (workspace identity for sync and persistence)
- Sync room names
- Child document GUIDs (deterministic per row, used by materializers and editors)

## Pause and ask before

The collapse pass should stop and surface to the user (not silently proceed) when about to:

- Change any string from the list above
- Delete a public exported name that has zero in-repo callers but plausible external CLI or SDK consumers (the `@epicenter/cli` binary and the `@epicenter/workspace` published API are the load-bearing examples)
- Collapse two files where one's JSDoc documents a non-obvious invariant (the JSDoc is the documentation of a contract; losing it loses the contract)
- Merge packages or move exports across package boundaries
- Change a function signature that crosses a published package boundary
- Collapse a `defineErrors` factory call to an inline `{ name, message, ...fields }` object, even for a single-variant log-only error. The factory call is the idiomatic shape; see `define-errors`, `error-handling`, and `logging` skills. Single-variant `defineErrors` is fine: the variant tag carries idiom consistency, forward-compat, self-documenting call sites, and a centralized message template that prevents drift across multiple log sites.

## Scope tiers

Default collapse-pass targets, narrowest to widest:

1. `packages/auth`
2. `packages/auth-svelte`
3. `packages/encryption`
4. `packages/workspace`
5. `packages/svelte-utils`
6. `packages/cli`
7. `apps/api`

Out of scope without an explicit pass declaration:

- First-party apps: `apps/whispering`, `apps/tab-manager`, `apps/fuji`, `apps/honeycrisp`, `apps/opensidian`, `apps/zhongwen`. These are owned by separate waves and have their own architecture tests.
- `specs/`, `docs/articles/`, migration history (`*-legacy-*.md`, archived ADRs)
