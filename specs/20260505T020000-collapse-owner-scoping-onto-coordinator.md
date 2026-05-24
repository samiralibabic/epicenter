# Collapse owner-scoped local persistence onto symmetric primitives

**Date**: 2026-05-05
**Status**: Implemented
**Author**: AI-assisted (Claude), grilled by Braden
**Branch**: not started
**Depends on**:
- `specs/20260504T233223-sign-out-preserves-local-data.md` (parent product behavior)
- `specs/20260505T004755-attach-encrypted-indexeddb.md` (the primitive being renamed)
**Supersedes scope from**: API surface introduced by `8fcf076f3` (scope local yjs keys) and `d67dfe4a4` (forget device cleanup)

## One-sentence thesis

> The encryption coordinator owns encrypted IndexedDB; owner-scoping flows through a single `userId` parameter on the primitives that need it; BroadcastChannel and IndexedDB remain separate honest concerns; full owner-cache cleanup stays explicit and sweeps by owner prefix.

## Current direction after review

This spec no longer adopts `attachLocal`. A repo grep confirms there is no live `attachLocal` implementation today, and this spec should not add one.

```txt
Authenticated local persistence:
  encryption.attachIndexedDb(ydoc, { userId })
  attachBroadcastChannel(ydoc, { userId })

Authless local persistence:
  attachIndexedDb(ydoc)
  attachBroadcastChannel(ydoc)
```

That keeps the names honest. IndexedDB persistence is the encrypted at-rest concern. BroadcastChannel is a local transport concern. They share owner-scoping, but they do not share crypto.

Zhongwen follows the authenticated path. Its chat history is account data, not an authless browser scratchpad. The current code still opens `apps/zhongwen/src/lib/zhongwen/browser.ts` without auth and uses plain local persistence; that is now a migration target, not the desired model.

## Auth-gated opening cascade

Authenticated browser workspaces do not open persisted local data until auth has produced an identity. The app shell may render signed-out routes, loading states, and errors before that point, but the workspace graph is not constructed.

```txt
App module loads
  |
  +-- create auth client
  |
  +-- await auth.whenReady
  |
  +-- if auth.identity === null
  |     |
  |     +-- render signed-out route or state
  |
  +-- if auth.identity exists
        |
        +-- openFuji({ auth, peer })
              |
              +-- read identity = auth.identity
              +-- const userId = identity.user.id
              |
              +-- openFujiDoc({ encryptionKeys: identity.encryptionKeys })
              |     |
              |     +-- new Y.Doc({ guid: FUJI_WORKSPACE_ID })
              |     +-- attach encryption coordinator
              |     +-- attach encrypted tables and KV
              |     +-- encryption.applyKeys(encryptionKeys)
              |     +-- create actions
              |
              +-- encryption.attachIndexedDb(rootYdoc, { userId })
              |     |
              |     +-- local DB name = userId + root guid
              |     +-- decrypt local updates
              |     +-- hydrate root Y.Doc
              |
              +-- attachBroadcastChannel(rootYdoc, { userId })
              +-- attachAwareness(rootYdoc, { peer })
              +-- attachSync(rootDoc, { auth, waitFor: idb.whenLoaded })
              +-- return workspace bundle
```

Child documents open lazily under the same owner:

```txt
User opens child content
  |
  +-- create child Y.Doc with deterministic child guid
  +-- encryption.attachIndexedDb(childYdoc, { userId })
  +-- attachBroadcastChannel(childYdoc, { userId })
  +-- attachSync(childYdoc, { auth, waitFor: childIdb.whenLoaded })
  +-- render child surface
```

`AuthIdentity` is the auth snapshot that carries both halves needed at the browser boundary:

```txt
identity.user.id             -> owner-scoped local storage and BroadcastChannel names
identity.encryptionKeys      -> encryption.applyKeys(...) for encrypted stores
```

`openFujiDoc` should take `encryptionKeys`, not full `identity`. The isomorphic document factory owns encrypted table and KV construction, so it can apply keys during construction when the caller has them. It should not know `userId`: owner-scoped IndexedDB and BroadcastChannel are browser runtime attachments, and they stay in `browser.ts`.

## What this collapses

```txt
DELETED:
  createLocalYjsKey                                       (export removed; helper stays private)
  clearLocalYjsDataForUser public name                    (behavior remains as owner-cache cleanup)

RENAMED (mirrors encryption.attachTable / attachKv pattern):
  encryption.attachEncryptedIndexedDb({ persistenceKey })
    -> encryption.attachIndexedDb({ userId })

PARAMETER SHAPE CHANGED:
  attachIndexedDb(ydoc, { persistenceKey? })
    -> attachIndexedDb(ydoc)                              (plain primitive: single-arg only)
  attachBroadcastChannel(ydoc, { channelKey?, transportOrigin? })
    -> attachBroadcastChannel(ydoc, { userId? })          (transportOrigin hardcoded to SYNC_ORIGIN)

NEW (free function, colocated in attach-indexed-db.ts):
  clearOwnedDocuments({ userId, ydocGuids? })

UNCHANGED:
  encryption.applyKeys(keys)                              (coordinator stays crypto-focused)

App factory signatures:
  openFuji({ auth, identity, peer })  ->  openFuji({ auth, peer })
  openFujiDoc()                       ->  openFujiDoc({ encryptionKeys? })
  openZhongwen()                      ->  openZhongwen({ auth })
```

App call site delta:

```diff
- import { attachBroadcastChannel, clearLocalYjsDataForUser, createLocalYjsKey, ..., SYNC_ORIGIN } from '@epicenter/workspace';
+ import { attachBroadcastChannel, clearOwnedDocuments, ... } from '@epicenter/workspace';

- export function openFuji({ auth, identity, peer }: { auth: AuthClient; identity: AuthIdentity; peer: PeerIdentity }) {
+ export function openFuji({ auth, peer }: { auth: AuthClient; peer: PeerIdentity }) {
+   const identity = auth.identity;
+   if (identity === null) {
+     throw new Error('openFuji requires signed-in auth.identity. Await auth.whenReady first.');
+   }
+   const userId = identity.user.id;
    const doc = openFujiDoc({ encryptionKeys: identity.encryptionKeys });

-   const localKey = createLocalYjsKey(identity.user.id, doc.ydoc.guid);
-   const idb = doc.encryption.attachEncryptedIndexedDb(doc.ydoc, { persistenceKey: localKey });
-   attachBroadcastChannel(doc.ydoc, { channelKey: localKey, transportOrigin: SYNC_ORIGIN });
+   const idb = doc.encryption.attachIndexedDb(doc.ydoc, { userId });
+   attachBroadcastChannel(doc.ydoc, { userId });

    const entryContentDocs = createDisposableCache((entryId) => {
      const ydoc = new Y.Doc({ guid: entryContentDocGuid({...}), gc: false });
      const body = attachRichText(ydoc);
-     const childLocalKey = createLocalYjsKey(identity.user.id, ydoc.guid);
-     const childIdb = doc.encryption.attachEncryptedIndexedDb(ydoc, { persistenceKey: childLocalKey });
-     attachBroadcastChannel(ydoc, { channelKey: childLocalKey, transportOrigin: SYNC_ORIGIN });
+     const childIdb = doc.encryption.attachIndexedDb(ydoc, { userId });
+     attachBroadcastChannel(ydoc, { userId });
      const childSync = attachSync(ydoc, {...});
      onLocalUpdate(ydoc, () => {...});
      return {...};
    });

    async wipe() {
      const childGuids = doc.tables.entries.getAllValid().map((entry) =>
        entryContentDocGuid({ workspaceId: doc.ydoc.guid, entryId: entry.id }),
      );
      entryContentDocs[Symbol.dispose]();
      doc[Symbol.dispose]();
      await Promise.all([idb.whenDisposed, sync.whenDisposed]);
+     await clearOwnedDocuments({
+       userId,
+       ydocGuids: [doc.ydoc.guid, ...childGuids],
+     });
    }
```

## Final API surface

```ts
// Encryption coordinator: crypto only.
encryption.applyKeys(keys: EncryptionKeys): void;
encryption.attachTable(name, def);                                 // unchanged
encryption.attachReadonlyTable(name, def);                         // unchanged
encryption.attachTables(defs);                                     // unchanged
encryption.attachReadonlyTables(defs);                             // unchanged
encryption.attachKv(defs);                                         // unchanged
encryption.attachIndexedDb(ydoc, { userId }): IndexedDbAttachment; // RENAMED + new param

// Plain primitives.
attachIndexedDb(ydoc): IndexedDbAttachment;                        // authless, defaults to ydoc.guid
attachBroadcastChannel(ydoc, opts?: { userId?: string }): void;    // userId opt-in for owner-scoping

// Cleanup of all known and enumerable owner-scoped local documents.
export function clearOwnedDocuments(options: {
  userId: string;
  ydocGuids?: readonly string[];
}): Promise<void> {
  // Composes private createLocalYjsKey(userId, guid), then sweeps by prefix
  // with indexedDB.databases() when the browser exposes it.
}
```

## Asymmetric wins

### 1. Keep owner-cache sweeping, but rename the boundary

```txt
Product sentence:
  "Forget This Device" deletes the current user's local Yjs caches, including
  dormant child documents no mounted table row can enumerate.

Candidate refusal:
  Defensively enumerate `indexedDB.databases()` to catch orphaned IDBs whose
  source row was deleted without their cache being cleared in the same step.

Code family it deletes:
  Almost nothing safely. The helper is small, and deleting it makes Forget
  This Device depend on every app's current table rows being a complete list
  of local child databases.

User loss:
  If we refuse the sweep, deleted-entry child databases can survive the
  destructive cleanup. That violates the user-facing promise.

Decision:
  Keep the behavior. Collapse the old name into `clearOwnedDocuments`, colocate
  it with IndexedDB attachment code, keep `createLocalYjsKey` private, and make
  apps pass semantic inputs only: `userId` plus any known guids. The helper
  sweeps by owner prefix when `indexedDB.databases()` exists and falls back to
  the known guids elsewhere.
```

### 2. Refuse the cross-concern bundle on the encryption coordinator

```txt
Product sentence:
  IndexedDB is encrypted; BroadcastChannel is not. Both are owner-scoped.

Candidate refusal:
  Bundle BroadcastChannel attachment under `encryption.attachLocal()` so it
  shares one method with encrypted IDB.

Code family it deletes:
  The bundled `attachLocal` method
  The implicit coupling between BC and encryption coordinator
  The dishonest name (Local what? It does two unrelated things)

User loss:
  Two attach lines per Y.Doc instead of one bundled line.

Decision:
  Refuse the bundle. BC bytes never persist; they don't encrypt. The shared
  concept is owner-scoping (a userId param), not encryption. Each primitive
  stays honest about what it does. This is also what the repo currently says:
  there is no live `attachLocal` implementation to preserve.
```

### 3. Refuse precomputed-string parameters (`persistenceKey` / `channelKey`)

```txt
Product sentence:
  Owner-scoped storage names are derived from (userId, ydoc.guid) inside the
  primitives that need them.

Candidate refusal:
  Expose the precomputed string `epicenter:v1:user:{userId}:yjs:{ydocGuid}`
  as a parameter that every authenticated call site composes by hand.

Code family it deletes:
  createLocalYjsKey export from @epicenter/workspace
  persistenceKey on attachIndexedDb (and on encryption.attachEncryptedIndexedDb)
  channelKey on attachBroadcastChannel
  ~12 call-site repetitions of the format composition
  The "did the caller pass the same value to both?" reviewer check
  The two-different-names-for-the-same-value smell

User loss:
  Callers can't override the local key shape with a custom string. No use
  case today.

Decision:
  Refuse the precomputed-string shape. Pass `userId`. Primitives compose the
  format internally via a private `createLocalYjsKey`.
```

### 4. Refuse the redundant "Encrypted" prefix on the coordinator method

```txt
Product sentence:
  Encrypted versions of attach* primitives live in the encryption namespace
  and reuse the plain primitive's name.

Candidate refusal:
  Name the encrypted IDB method `attachEncryptedIndexedDb` even though it's
  on the encryption coordinator that already implies encryption.

Code family it deletes:
  Redundant "Encrypted" in the method name
  Asymmetry vs encryption.attachTable / encryption.attachKv (which omit it)
  The cognitive load of "why is THIS one named differently?"

User loss:
  Zero. Renaming costs a few import lines and app call sites.

Decision:
  Refuse the prefix. Rename to encryption.attachIndexedDb. Reads as
  "encryption's attach-indexed-db" vs "plain attach-indexed-db"; same
  pattern as tables and KV.
```

### 5. Refuse the duplicated `identity` parameter

```txt
Product sentence:
  The browser workspace factory takes one auth client and reads identity
  from it.

Candidate refusal:
  Pass both `auth` (live observable for sync) and `identity` (snapshot for
  keys + owner-scoping) as separate parameters, even though the value of
  `identity` is always `auth.identity` at the moment of construction.

Code family it deletes:
  identity parameter on openFuji / openHoneycrisp / openOpensidian / openTabManager / openZhongwen
  "identity: auth.identity" line in client.ts files
  AuthIdentity type import in browser.ts files
  The reviewer check that auth and identity reference the same session

User loss:
  Caller can no longer construct a workspace with one auth client and a
  different session's identity. Not a real use case.

Decision:
  Refuse it. Read `auth.identity` once at construction. Throw if null.
```

### 6. Refuse `transportOrigin` as user-facing API

```txt
Product sentence:
  BroadcastChannel filters echoes from the sync WebSocket transport.

Candidate refusal:
  Expose transportOrigin as a parameter callers must pass `SYNC_ORIGIN` to
  at every authenticated call site.

Code family it deletes:
  transportOrigin?: symbol  parameter on attachBroadcastChannel options
  ~12 import lines of SYNC_ORIGIN across apps
  ~12 call-site repetitions of `transportOrigin: SYNC_ORIGIN`

User loss:
  Callers cannot override the filtered origin. There is one transport
  (WebSocket via attachSync) and there has only ever been one. Custom
  transports do not exist in the codebase.

Decision:
  Refuse the parameter. Hardcode the filter to SYNC_ORIGIN inside
  attach-broadcast-channel. If a custom transport is needed someday, expose
  the override then.
```

## Implementation plan

Phases ordered so each landable wave compiles and tests pass.

### Phase 1: Add new coordinator surface (additive, non-breaking)

- [x] **1.1** In `packages/workspace/src/document/attach-encryption.ts`, add `encryption.attachIndexedDb(ydoc, { userId })`. Body: derive `persistenceKey = createLocalYjsKey(userId, ydoc.guid)` privately; delegate to existing `attachEncryptedIndexedDbProvider`. Register for `applyKeys` rotation (same machinery as today's `attachEncryptedIndexedDb`).
- [x] **1.2** Keep `attachEncryptedIndexedDb` as a deprecated alias delegating to `attachIndexedDb`. Marked `@deprecated`. Phase 3 deletes it.

### Phase 2: Update primitives' parameter shape

- [x] **2.1** In `packages/workspace/src/document/attach-broadcast-channel.ts`, replace `{ channelKey, transportOrigin }` with `{ userId? }`. Compute `channelKey` internally via private `createLocalYjsKey(userId, ydoc.guid)` when `userId` is present, fall back to `ydoc.guid` otherwise. Hardcode the filter to `SYNC_ORIGIN` (import alongside existing `BC_ORIGIN`). Update tests.
- [x] **2.2** In `packages/workspace/src/document/attach-indexed-db.ts`, drop the `persistenceKey?` parameter from plain `attachIndexedDb`. Plain primitive uses `ydoc.guid` only; owner-scoping goes through `encryption.attachIndexedDb`. Keep `attachEncryptedIndexedDbProvider` as the internal implementation.
- [x] **2.3** Add `clearOwnedDocuments({ userId, ydocGuids? })` to `attach-indexed-db.ts`. It composes private owner-scoped keys from known guids, then adds every IndexedDB name with the current owner prefix when `indexedDB.databases()` is available. Export this semantic cleanup helper from the workspace barrel.
- [x] **2.4** Update `attach-broadcast-channel.test.ts` to exercise `{ userId }` instead of `{ channelKey }`. Verify SYNC_ORIGIN filter still works.

### Phase 3: Migrate apps

For each of `apps/fuji`, `apps/honeycrisp`, `apps/opensidian`, `apps/tab-manager`, and `apps/zhongwen`:

- [x] **3.1** `index.ts`: let each isomorphic `open*Doc` factory accept optional `{ encryptionKeys?: EncryptionKeys }` and call `encryption.applyKeys(encryptionKeys)` when provided. Do not pass full `AuthIdentity` into `open*Doc`; it does not own user-scoped local storage.
- [x] **3.2** `browser.ts`: drop `identity` parameter where present; read `auth.identity` inside, throw if null. Pass `{ encryptionKeys: identity.encryptionKeys }` into `open*Doc`. Replace `attachEncryptedIndexedDb` with `encryption.attachIndexedDb`. Replace `{ persistenceKey: localKey }` with `{ userId }`. Replace `{ channelKey: localKey, transportOrigin: SYNC_ORIGIN }` with `{ userId }`. Replace `clearLocalYjsDataForUser({...})` and app-specific root-only wipes with `clearOwnedDocuments({ userId, ydocGuids })`.
- [x] **3.3** `client.ts`: drop `identity: auth.identity` from the open* call.
- [x] **3.4** Imports: drop `createLocalYjsKey`, `clearLocalYjsDataForUser`, `SYNC_ORIGIN`, `AuthIdentity`. Add `clearOwnedDocuments`.
- [x] **3.5** Zhongwen: move browser workspace construction behind auth readiness, require `auth.identity`, pass `identity.encryptionKeys` into `openZhongwenDoc`, and store chat tables through encrypted owner-scoped IndexedDB. The app may still use auth for AI requests, but chat history is account-owned local data.

Land per-app commits. Each compiles independently because Phase 1 kept the deprecated `attachEncryptedIndexedDb` alias.

### Phase 4: Drop the old surface

- [x] **4.1** Delete `attachEncryptedIndexedDb` from `EncryptionAttachment` (and its alias body).
- [x] **4.2** Remove `createLocalYjsKey` export from `packages/workspace/src/index.ts`. Helper file stays at `packages/workspace/src/document/local-yjs-key.ts` (still tested via attach tests).
- [x] **4.3** Delete the old `clearLocalYjsDataForUser` export and name. Keep the owner-prefix sweep behavior under `clearOwnedDocuments`.
- [x] **4.4** Final grep: no live source outside historical specs references `createLocalYjsKey`, `clearLocalYjsDataForUser`, `persistenceKey:`, `channelKey:`, `transportOrigin:`, or `attachEncryptedIndexedDb`.

### Phase 5: Verify

- [x] **5.1** `bun test packages/workspace`
- [x] **5.2** `bun test packages/encryption`
- [x] **5.3** `bun run --cwd packages/workspace typecheck`
- [ ] **5.4** Per app: sign in, edit, sign out, reload. Verify content reappears from encrypted local persistence under the same owner.
- [ ] **5.5** Per app: Forget This Device deletes all known and enumerable IDBs for the current user. Include Zhongwen.
- [ ] **5.6** IDB devtools: blob format still starts with `0x01` version byte (storage encryption unchanged).

### Phase 6: Docs and follow-ups

- [x] **6.1** Update `docs/encryption.md` and `docs/guides/consuming-epicenter-api.md` with the new shape.
- [x] **6.2** Note in `attach-encrypted-indexeddb` and `sign-out-preserves-local-data` specs that this spec collapses their introduced surface.
- [ ] **6.3** Open follow-up: SvelteKit top-level-await problem in app `client.ts` files (out of scope here).

## Edge cases

### Zhongwen

Zhongwen is no longer classified as authless for browser chat history. The product sentence is:

```txt
Zhongwen chat history belongs to the signed-in account.
```

Current code violates that sentence because `apps/zhongwen/src/lib/zhongwen/client.ts` constructs the workspace before auth and `apps/zhongwen/src/lib/zhongwen/browser.ts` uses plain local IndexedDB. The migration should make Zhongwen match the authenticated shape:

```ts
const identity = auth.identity;
if (identity === null) {
  throw new Error('openZhongwen requires signed-in auth.identity. Await auth.whenReady first.');
}

const userId = identity.user.id;
const doc = openZhongwenDoc({ encryptionKeys: identity.encryptionKeys });
const idb = doc.encryption.attachIndexedDb(doc.ydoc, { userId });
attachBroadcastChannel(doc.ydoc, { userId });
```

That does not mean every future Zhongwen feature must be account-owned. It means this chat history path is account-owned. If Zhongwen later wants a no-login scratchpad mode, that should be a separate product mode with a separate local document name and plain `attachIndexedDb(ydoc)`, not the same database silently changing security policy.

### Daemon

`openFujiDoc` gains optional `encryptionKeys`, but the daemon can omit them. The daemon doesn't attach IDB/BC. If it ever needs encrypted local persistence, it can pass keys into `openFujiDoc({ encryptionKeys })` and call `encryption.attachIndexedDb` like the browser path.

### Identity rotation

`bindAuthWorkspaceScope({ applyAuthIdentity })` continues to call `encryption.applyKeys(identity.encryptionKeys)` on every transition. Same dedup and rotation behavior as today.

### Calling `encryption.attachIndexedDb` before `applyKeys`

Throws with the existing message ("encryption coordinator has no keys"). Same precondition as today.

### `clearOwnedDocuments` for unknown guids

`clearDocument` is idempotent on missing databases. `clearOwnedDocuments({ userId, ydocGuids: [randomGuid] })` deletes nothing safely when the guid has no local database.

### BroadcastChannel SYNC_ORIGIN filter when no sync is attached

In local-only apps no update ever has origin === SYNC_ORIGIN, so the filter never fires. Hardcoding the symbol costs nothing.

## Success criteria

- [x] No live source references `createLocalYjsKey`, `clearLocalYjsDataForUser`, `persistenceKey:`, `channelKey:`, `transportOrigin:`, or `attachEncryptedIndexedDb` outside `specs/` and the deprecated alias's deletion commit.
- [x] `EncryptionAttachment` exposes `attachIndexedDb` (not `attachEncryptedIndexedDb`).
- [x] `attachIndexedDb` (plain) takes only `(ydoc)`.
- [x] `attachBroadcastChannel` takes `(ydoc, opts?: { userId? })`. Internal SYNC_ORIGIN filter intact.
- [x] `clearOwnedDocuments({ userId, ydocGuids? })` exported from `@epicenter/workspace`, defined with the IndexedDB attachment code, and still sweeps by owner prefix where the browser supports enumeration.
- [x] `openFuji`, `openHoneycrisp`, `openOpensidian`, `openTabManager`, and browser `openZhongwen` factories take auth-owned inputs and require signed-in identity before encrypted local persistence attaches.
- [x] Isomorphic `open*Doc` factories accept optional `encryptionKeys` and apply them during construction when provided. They do not accept full `AuthIdentity`.
- [x] The old `clearLocalYjsDataForUser` public name is gone.
- [x] Net LOC delta is meaningfully negative across `packages/workspace` and `apps/*` after the stale string-key surfaces are removed.
- [ ] All tests pass; manual smoke per app passes.

## Final one-sentence test

After implementation:

> Authenticated browser factories derive `const userId = auth.identity!.user.id`, pass `identity.encryptionKeys` into `open*Doc({ encryptionKeys })`, then call `encryption.attachIndexedDb(ydoc, { userId })` and `attachBroadcastChannel(ydoc, { userId })` for each Y.Doc; their destructive device cleanup calls `clearOwnedDocuments({ userId, ydocGuids })`; no app file references `createLocalYjsKey`, `persistenceKey`, `channelKey`, `transportOrigin`, `attachEncryptedIndexedDb`, or `clearLocalYjsDataForUser`.

If any of those references survive in live source outside historical specs, the implementation is incomplete.

## Review

**Completed**: 2026-05-05
**Branch**: `feat/encrypted-local-workspace-storage`
**Commit**: `2645a11a1`

### Summary

Authenticated browser workspaces now read `auth.identity` inside the browser factory and throw before local persistence opens when identity is missing.
Owner scoping is internal to `@epicenter/workspace`: encrypted IndexedDB and BroadcastChannel take `{ userId }`, and device cleanup calls `clearOwnedDocuments({ userId, ydocGuids })`.

### Deviations from Spec

- The deprecated alias phase was skipped in the final working tree. The final API removes `attachEncryptedIndexedDb` completely.
- The internal encrypted IndexedDB provider was renamed so the old public method name does not survive in live source.
- The private key helper was renamed from the old public `createLocalYjsKey` name while keeping the same storage key shape.
- Manual browser smoke and IndexedDB devtools checks remain open because they require authenticated interactive sessions.

### Verification

```txt
bun test packages/workspace
  pass

bun test packages/encryption
  pass

bun run --cwd packages/workspace typecheck
  pass

rg "createLocalYjsKey|clearLocalYjsDataForUser|persistenceKey:|channelKey:|transportOrigin:|attachEncryptedIndexedDb" apps packages --glob '*.ts' --glob '*.svelte'
  no matches
```

`bun run typecheck` was attempted after the migration and still fails on existing app and shared UI diagnostics unrelated to this storage API change.

## References

- `specs/20260504T233223-sign-out-preserves-local-data.md`: parent product behavior
- `specs/20260505T004755-attach-encrypted-indexeddb.md`: the primitive being renamed
- `packages/workspace/src/document/attach-encryption.ts`: the coordinator (gains rename, loses old name)
- `packages/workspace/src/document/attach-indexed-db.ts`: gains `clearOwnedDocuments`, loses `persistenceKey?`
- `packages/workspace/src/document/attach-broadcast-channel.ts`: loses `channelKey?` and `transportOrigin?`, hardcodes SYNC_ORIGIN filter
- `packages/workspace/src/document/local-yjs-key.ts`: stays, becomes private (export removed)
- `packages/workspace/src/document/clear-local-yjs-data.ts`: old public name deletion target; owner-prefix sweep behavior remains
- `apps/fuji/src/lib/fuji/browser.ts`: canonical migration target
- `apps/zhongwen/src/lib/zhongwen/browser.ts`: authenticated migration target for account-owned chat history
- Cohesive clean breaks skill: `.claude/skills/cohesive-clean-breaks/SKILL.md`
