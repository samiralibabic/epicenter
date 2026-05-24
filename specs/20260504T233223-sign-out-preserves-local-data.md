# Sign-out preserves owner-scoped local data

**Date**: 2026-05-04
**Status**: Ready for review
**Author**: AI-assisted, grilled by Braden
**Branch**: not started
**Supersedes**: `specs/20260504T231540-attach-sync-trim-to-supervisor-superseded.md`
**Related, modifies, or deletes scope from**:
- `specs/20260414T143000-safe-sign-out-flow.md`: refused by this spec
- `specs/20260310T235239-sync-status-102.md`: protocol removed by this spec
- `specs/sync-client-simplification.md`: earlier removal of SYNC_STATUS in old `packages/sync-client`
- `specs/20260501T221831-auth-workspace-lifecycle-inversion.md`: the lifecycle binding this spec reshapes
- `specs/20260504T020000-workspace-identity-reset-deterministic-teardown.md`: the deterministic teardown contract this spec narrows to memory teardown plus owner-scoped local persistence

**Stack Map**: `specs/20260512T134603-auth-spec-stack-clean-break-map.md`
**Stack Position**: Runtime policy for account exit and local workspace persistence.

## One-sentence thesis

> **Sign-out destroys the live workspace and reloads; sign-in opens only the local cache scoped to that authenticated owner.**

That sentence replaces the earlier draft sentence. The earlier version said sign-out was a no-op in `bindAuthWorkspaceScope`. That is wrong: a no-op preserves the in-memory keyring and decrypted projections. Sign-out must be a runtime teardown. It must not be a storage wipe.

## What changed after the grill

The original draft had the right smell and the wrong boundary. It correctly noticed that the safe-sign-out gate exists only because sign-out wipes local data. It missed three load-bearing invariants.

1. **Identity mismatch is not durable today.** `appliedUserId` lives only in a closure in `packages/auth-workspace/src/index.ts`. If sign-out stops wiping and the app later boots as a different user, the first identity would apply with `appliedUserId === null`. A persisted owner marker can patch that, but identity-scoped local persistence is cleaner: the app never opens the prior user's cache in the first place.

2. **Sign-out cannot be an auth-workspace no-op.** `attachEncryption` has no `deactivateEncryption()` API. `EncryptedYKeyValueLww` documents encryption as one-way: once keys are applied, destroying the wrapper is the only reset path. A signed-out UI with the old workspace still alive still has decrypted data reachable through tables, KV, Svelte stores, and child document state.

3. **Not all persisted IndexedDB data is ciphertext.** Root encrypted table and KV values are encrypted after keys are applied, but Yjs metadata, row keys, table names, and LWW timestamps are plaintext. More importantly, Fuji, Honeycrisp, Opensidian, and Skills have persisted child documents backed by plaintext rich text or timeline attachments. The earlier claim that "IndexedDB stays as ciphertext" was too broad.

4. **`hasLocalChanges` is weaker than the safe-sign-out story says.** `attach-sync.ts` increments `localVersion` on local updates, but it does not publish `hasLocalChanges: true` when the local update happens. The popover can read stale `hasLocalChanges: false` during the unsynced window it was supposed to protect.

5. **The Bitwarden analogy is lock, not logout.** Official Bitwarden docs distinguish unlock from login: locking deletes decrypted vault data and keys from memory while preserving encrypted local vault data for offline unlock. Logout is a stronger account exit. Epicenter's target behavior is closer to Bitwarden lock plus auth-session removal, not Bitwarden logout.

## Product sentence

The product behavior we want is:

```txt
Signing out makes this running app unable to read workspace data, and sign-in resumes from the local cache scoped to that authenticated owner.
```

The behavior we refuse is:

```txt
Signing out proves every local edit reached the server before it lets the user leave.
```

That refusal deletes the SYNC_STATUS protocol, the safe-sign-out confirmation dialog, and the `hasLocalChanges` field. The safety boundary moves to owner-scoped local persistence, storage encryption, and runtime teardown.

## Asymmetric wins pass

### Refuse the safe-sign-out pre-check

Product sentence:

```txt
Sign-out preserves owner-scoped local persistence and makes the live app forget the workspace.
```

Candidate refusal:

```txt
Before sign-out, ask the sync server whether every local edit has been echoed.
```

Code family it deletes:

```txt
MESSAGE_TYPE.SYNC_STATUS
encodeSyncStatus / decodeSyncStatus
localVersion / ackedVersion / syncStatusTimer
server echo branch
hasLocalChanges on SyncStatus.connected
account-popover confirmation branch
safe-sign-out copy
protocol tests and daemon/CLI status payload branches
```

User loss:

```txt
No "Sign out anyway?" warning when offline edits exist.
```

Decision:

```txt
Refuse it. Sign-out no longer deletes local edits, so the warning protects the old bug.
```

### Refuse live signed-out workspace mode

Product sentence:

```txt
Sign-out makes this running app unable to read workspace data.
```

Candidate refusal:

```txt
After sign-out, keep the app mounted and keep the Y.Doc alive.
```

Code family it deletes:

```txt
deactivateEncryption API
table and KV unreadable states
Svelte store auth gates around every derived collection
child document key clearing
multi-tab memory invalidation protocol
signed-out workspace shell state
```

User loss:

```txt
Sign-out reloads the app instead of leaving the same mounted shell on screen.
```

Decision:

```txt
Refuse live signed-out workspace mode. Reload is the clean boundary. It clears JS memory, keyrings, decrypted projections, pending observers, and child document caches with one invariant.
```

### Refuse per-app preserve flags

Product sentence:

```txt
Only owner-scoped local persistence that is encrypted or deliberately non-sensitive may survive sign-out.
```

Candidate refusal:

```txt
Let each app opt into preserve-on-sign-out even if some of its persisted child docs are plaintext.
```

Code family it deletes:

```txt
per-app sign-out policy flags
shared AccountPopover branching
docs that explain which apps are "safe enough"
manual smoke matrices for mixed privacy semantics
future bug reports where one app preserves plaintext and another wipes
```

User loss:

```txt
Apps with plaintext child persistence cannot adopt preserve-on-sign-out until their persisted data is encrypted or explicitly classified as non-sensitive.
```

Decision:

```txt
Refuse per-app preserve flags. Fix the persistence boundary or keep the old wipe. Do not ship mixed privacy semantics through the shared sign-out component.
```

### Refuse direct `localStorage` inside auth-workspace

Product sentence:

```txt
The auth-workspace binding decides lifecycle transitions; apps provide runtime-specific persistence and reload capabilities.
```

Candidate refusal:

```txt
Have `@epicenter/auth-workspace` import or assume `window.localStorage`.
```

Code family it deletes:

```txt
browser-only package behavior
Chrome extension storage exceptions
test shims for window globals
future Tauri or daemon special cases
```

User loss:

```txt
Each app derives a local workspace scope from the authenticated identity before constructing the workspace.
```

Decision:

```txt
Refuse hidden localStorage. The preferred design does not need a security-critical owner marker at all. If a fallback marker is needed for migration, inject it instead of importing localStorage.
```

### Refuse fixed local persistence keys

Product sentence:

```txt
Sign-in opens only the local cache scoped to the authenticated owner.
```

Candidate refusal:

```txt
Keep IndexedDB and BroadcastChannel keyed only by ydoc.guid, then detect owner mismatch after opening.
```

Code family it deletes:

```txt
ownerStore as security boundary
wipe-before-apply transition
marker tampering edge cases
first-owner vs same-owner branching
wipe failure retry semantics
different-user cache mounting risk
```

User loss:

```txt
Different users on the same browser profile keep separate local caches. Old caches remain until a future "Forget this device" cleanup deletes them.
```

Decision:

```txt
Refuse fixed local persistence keys. Scope local persistence and local broadcast by authenticated owner before constructing the workspace.
```

### Refuse generic storage mode flags

Product sentence:

```txt
The owner that has encryption keys owns encrypted local storage.
```

Candidate refusal:

```txt
Expose one `attachStorage(ydoc, { encrypted: true | false })` helper for all browser persistence.
```

Code family it deletes:

```txt
boolean-mode branching
keyless encrypted-storage failure states
docs explaining when encrypted means "requires coordinator"
tests for plaintext fallback after missing keys
future call sites that pass encrypted: false just to keep old construction order
```

User loss:

```txt
Authenticated apps write two explicit lines: encrypted IndexedDB from the coordinator, BroadcastChannel from the owner-scoped local key.
```

Decision:

```txt
Refuse it. The generic helper saves one call line and creates a second ownership model. `encryption.attachEncryptedIndexedDb(...)` is the cohesive boundary.
```

### Refuse auth-client-owned workspace lifecycle

Product sentence:

```txt
Auth clients expose identity; workspace scope decides how that identity affects Yjs construction and teardown.
```

Candidate refusal:

```txt
Fold `bindAuthWorkspaceScope` into `createCookieAuth()` and `createBearerAuth()` as a method.
```

Code family it deletes:

```txt
auth package imports of workspace lifecycle policy
duplicate cookie/bearer lifecycle methods
auth-client tests that need fake Yjs workspace behavior
runtime-specific reload policy hidden inside auth construction
```

User loss:

```txt
Apps keep one explicit binding call after constructing auth.
```

Decision:

```txt
Refuse the fold. The extra call is useful ceremony: it names the boundary where auth identity starts controlling encrypted workspace lifetime.
```

## Current state

### Sign-out path today

```txt
account-popover.svelte
  read sync.status
  if connected and !hasLocalChanges:
    auth.signOut()
  else:
    confirmationDialog.open(...)
      onConfirm -> auth.signOut()

auth.signOut()
  clears credential
  emits identity null

bindAuthWorkspaceScope
  identity null after applied user
    resetLocalClient()

each app resetLocalClient
  bundle.wipe()
    destroy Y.Doc
    wait for idb/sync disposal
    clear IndexedDB databases
  reload
```

Current `bindAuthWorkspaceScope` callers:

```txt
apps/fuji/src/lib/fuji/client.ts
apps/honeycrisp/src/lib/honeycrisp/client.ts
apps/opensidian/src/lib/opensidian/client.ts
apps/tab-manager/src/lib/tab-manager/client.ts
apps/zhongwen/src/lib/zhongwen/client.ts
```

Current `AccountPopover` consumers:

```txt
apps/fuji/src/lib/components/AppHeader.svelte
apps/honeycrisp/src/lib/components/Sidebar.svelte
apps/opensidian/src/lib/components/editor/TabBar.svelte
apps/tab-manager/src/entrypoints/sidepanel/App.svelte
```

Whispering is not in this path. Current `apps/whispering/src` has no auth client, no `AccountPopover`, no `bindAuthWorkspaceScope`, no `attachSync`, and no sign-out flow. Its `<ConfirmationDialog />` mount is for unrelated destructive UI.

### SYNC_STATUS today

```txt
packages/sync/src/protocol.ts
  MESSAGE_TYPE.SYNC_STATUS = 100
  encodeSyncStatus()
  decodeSyncStatus()

packages/workspace/src/document/attach-sync.ts
  SyncStatus.connected has hasLocalChanges
  local updates increment localVersion
  debounce sends SYNC_STATUS(localVersion)
  echoed SYNC_STATUS updates ackedVersion

apps/api/src/sync-handlers.ts
  SYNC_STATUS is echoed unchanged

packages/svelte-utils/src/account-popover/account-popover.svelte
  reads hasLocalChanges for sign-out gate

packages/workspace/src/daemon/run-errors.ts
packages/workspace/src/daemon/run-handler.ts
packages/cli fixtures and tests
  still carry hasLocalChanges in the daemon/CLI status shape
```

The UI consumer dies with the sign-out gate. The daemon and CLI payload branches are cleanup fallout.

### Persistence today

Root encrypted stores:

```txt
attachEncryption(ydoc)
  workspace id = ydoc.guid
  user key -> deriveWorkspaceKey(userKey, workspaceId)
  table/KV value -> XChaCha20-Poly1305 encrypted blob
```

Plaintext still present in root IndexedDB:

```txt
database name = ydoc.guid
object stores = updates, custom
Yjs shared type names = table:<name>, kv
row or KV keys
LWW timestamps
Yjs structural updates
```

Persisted child docs currently not covered by `attachEncryption`:

```txt
apps/fuji/src/lib/fuji/browser.ts
  entry content child docs use attachIndexedDb plus rich text/timeline state

apps/honeycrisp/src/lib/honeycrisp/browser.ts
  note body child docs use attachIndexedDb plus rich text/timeline state

apps/opensidian/src/lib/opensidian/browser.ts
  file content child docs use attachIndexedDb plus rich text/timeline state

apps/skills/src/lib/skills/browser.ts
  instruction/reference docs use attachIndexedDb plus plaintext document attachments
```

This is a blocker for the original thesis. Preserving local persistence on sign-out is only acceptable for persistence that is encrypted or deliberately classified as non-sensitive.

## Desired lifecycle

The clean break is to construct browser-local workspace persistence only after the app knows the authenticated owner. A signed-out app should not mount the workspace at all.

```txt
SIGNED_OUT:
  auth identity = null
  no workspace runtime
  no IndexedDB provider
  no BroadcastChannel provider
  sign-in UI only

SIGNED_IN_USER_A:
  auth identity = user A
  local scope = user:<userIdA>
  ydoc.guid = epicenter.fuji
  apply user A keys before encrypted local persistence attaches
  IndexedDB key = epicenter:v1:user:<userIdA>:yjs:epicenter.fuji
  BroadcastChannel key = epicenter:v1:user:<userIdA>:yjs:epicenter.fuji
  sync URL = /workspaces/epicenter.fuji
  encryption info = workspace:epicenter.fuji

SIGN_OUT:
  auth identity -> null
  destroy live workspace runtime
  keep owner-scoped local persistence
  reload to signed-out app

SIGNED_IN_USER_B:
  auth identity = user B
  local scope = user:<userIdB>
  apply user B keys before encrypted local persistence attaches
  open a different IndexedDB key
  open a different BroadcastChannel key
```

Different-user sign-in does not need to wipe user A's cache because user A's cache is never opened. Wipe becomes an explicit cleanup feature: "Forget this device" deletes owner-scoped local Yjs caches.

## Local Yjs key

Server Durable Object names already use owner-first hierarchy:

```txt
user:{userId}:workspace:{workspaceId}
user:{userId}:document:{documentId}
```

Do not copy that shape into browser persistence. Durable Objects route product resources. IndexedDB persistence stores Yjs documents. The only local persistence invariant is:

```txt
authenticated owner + ydoc.guid -> local Yjs provider name
```

Use the auth user id directly, then combine it with the Y.Doc guid.

Recommended local key shape:

```txt
epicenter:v1:user:{userId}:yjs:{ydocGuid}
```

Where:

```txt
userId   = identity.user.id, the auth identity's stable opaque user id
ydocGuid = ydoc.guid, for example epicenter.fuji or epicenter.fuji.entries.<entryId>.content
```

This keeps the natural owner -> Yjs document hierarchy. The user id is already the stable auth owner identifier used to partition server-side workspace resources, and IndexedDB names are per-origin (no cross-site visibility), so hashing the id buys nothing functional. The local key is a stable namespace label, not a cryptographic access boundary. Security still comes from not mounting the wrong cache, clearing memory on sign-out, and encrypting persisted values.

If a future deployment wants opaque local labels (e.g., to defend against a malicious extension snooping IDB names within the same origin), wrap `userId` in a one-line hash at the helper boundary; today nothing requires it.

The `v1` earns its keep. It is not a crypto domain-separation label and it is not a schema registry. It is a short storage-era prefix that gives future cleanup code one exact namespace to enumerate when local persistence needs a breaking migration. Without it, the first local-storage rewrite has to infer old database names from app-specific workspace ids. With it, the migration boundary is obvious:

```txt
epicenter:v1:user:*:yjs:*
```

Do not add another version segment unless the local key grammar itself changes. Encryption key versions already live inside encrypted blobs; Yjs document versions live in the CRDT data model.

Do not change `ydoc.guid`. It remains the CRDT identity, sync room name, child document namespace, and HKDF workspace label. The new local keys are storage and local-broadcast names only.

## Proposed API shape

The exact names can change during implementation, but the ownership should not.

```ts
function createLocalYjsKey(userId: string, ydocGuid: string): string;

const localKey = createLocalYjsKey(identity.user.id, ydoc.guid);

attachIndexedDb(ydoc, {
	persistenceKey: localKey,
});

attachBroadcastChannel(ydoc, {
	channelKey: localKey,
});
```

That is the low-level shape. Authenticated apps then choose the storage primitive from the owner that already knows whether keys exist.

```ts
const localKey = createLocalYjsKey(identity.user.id, doc.ydoc.guid);
const idb = doc.encryption.attachEncryptedIndexedDb(doc.ydoc, {
	persistenceKey: localKey,
});
attachBroadcastChannel(doc.ydoc, {
	channelKey: localKey,
	transportOrigin: SYNC_ORIGIN,
});
```

Do not add `attachStorage(ydoc, { encrypted: true | false })`. That turns encryption into a runtime option on a generic storage helper, which is exactly the hybrid API this spec is trying to avoid. The coordinator already owns key application. Its storage method should be just as explicit as `encryption.attachTables()` and `encryption.attachKv()`.

Child documents use the same rule, but the coordinator method receives the child Y.Doc:

```ts
const documentGuid = entryContentDocGuid({ workspaceId: doc.ydoc.guid, entryId });
const ydoc = new Y.Doc({ guid: documentGuid, gc: false });

const childLocalKey = createLocalYjsKey(identity.user.id, ydoc.guid);
const childIdb = doc.encryption.attachEncryptedIndexedDb(ydoc, {
	persistenceKey: childLocalKey,
});
attachBroadcastChannel(ydoc, {
	channelKey: childLocalKey,
	transportOrigin: SYNC_ORIGIN,
});
```

`encryption.attachEncryptedIndexedDb(ydoc)` throws if `applyKeys()` has not fired yet. That is intentional. Encrypted storage cannot hydrate before keys exist, and silent plaintext fallback would be worse than a hard failure. Authenticated browser factories must apply identity keys before attaching encrypted local persistence.

`attachEncryptedIndexedDb` is not a wrapper around upstream `y-indexeddb`. The upstream provider writes raw Yjs updates to an `updates` object store before callers can transform them. The encrypted variant should be a sibling provider with the same attachment contract (`whenLoaded`, `clearLocal`, `whenDisposed`) and an encrypted update log. It may use Yjs V2 updates internally because this is a clean break, not a compatibility shim for old unencrypted databases.

Apps without auth or without sensitive local data keep using `attachIndexedDb` directly. Zhongwen is no longer that example for chat history. Its browser package currently composes local persistence before auth, but the product decision is now that Zhongwen chat history belongs to the signed-in account. That makes Zhongwen a participating authenticated app for this storage path. Encryption still does not belong to every IndexedDB attachment in the codebase; it belongs to authenticated account-owned persistence.

`@epicenter/auth-workspace` should become smaller in this model. It no longer needs to compare durable owners. Its job is to sequence "auth became null, destroy and reload", "auth changed to a different user, reload", and "auth became present, apply keys to an already owner-scoped workspace."

## Design decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Sign-out local disk behavior | Design coherence | Preserve owner-scoped local persistence | Sign-out should not destroy offline work. The app must still drop the live runtime. |
| Sign-out runtime behavior | Evidence | Destroy runtime and reload | Encryption wrappers have no key-clearing API. Destroying the Y.Doc and reloading is the existing hard boundary. |
| Different-user behavior | Evidence | Open a different local cache | Root metadata and child docs can expose prior-user structure or plaintext. The clean boundary is not opening another owner's cache. |
| Owner tracking | Clean break | Avoid owner marker as security boundary | Durable markers patch fixed cache names. Owner-scoped persistence removes the mismatch branch. |
| Owner hash | Asymmetric win | Refuse: use raw user id | The raw user id is already the stable owner identifier used by auth and by server Durable Object partitioning. IndexedDB names are per-origin. Hashing adds a helper, tests, and a "is the hash stable across versions?" worry without functional benefit. If a future threat model needs opacity (malicious extension snooping IDB names), wrap at the helper boundary then. |
| Local key `v1` | Clean break | Keep it | The version segment is a storage-era prefix, not a security label. It gives future cleanup and migration code one exact namespace to enumerate: `epicenter:v1:user:*:yjs:*`. |
| Local BroadcastChannel | Evidence | Scope it with the same local key | IndexedDB isolation alone is incomplete if cross-tab Yjs updates still share `ydoc.guid`. |
| Encrypted local storage surface | Clean break | Add `encryption.attachEncryptedIndexedDb(ydoc, opts)` | The encryption coordinator already owns key application. Storage encryption should hang from that owner and throw when keys have not been applied. |
| Generic storage helper | Asymmetric win | Refuse `attachStorage(ydoc, { encrypted })` | A boolean option would create one method with two ownership models. Authenticated encrypted workspaces use the encryption coordinator; authless or non-sensitive apps use `attachIndexedDb`. |
| Encrypted IndexedDB implementation | Evidence | Build a sibling provider, not a y-indexeddb wrapper | Upstream `y-indexeddb` writes raw updates directly to the `updates` object store. There is no transform hook that can make it encrypted after the fact. |
| SYNC_STATUS | Asymmetric win | Delete it | With sign-out no longer deleting local edits, the only UI consumer disappears. |
| `hasLocalChanges` | Asymmetric win | Delete it from `SyncStatus` and daemon shapes | No current product surface needs it after the gate dies. Reintroduce an explicit save-barrier API later if needed. |
| Plaintext child docs | Evidence | Solve before this spec ships with encrypted local persistence | Fuji, Honeycrisp, Opensidian, and Skills currently persist plaintext child docs. The greenfield fix is storage-level encryption via `encryption.attachEncryptedIndexedDb(childYdoc, { persistenceKey })`, not per-app preserve flags. |
| Reload after sign-out | Clean boundary | Required | Optional reload keeps live signed-out workspace mode alive. Refuse it. |
| "Forget this device" | Product control | Same feature line, not same primitive | Preserve-on-sign-out should not be the only local-data behavior users get. Ship an explicit cleanup path before presenting the new behavior as finished, but keep it as a separate destructive command over owner-scoped caches, not hidden inside sign-out. |
| Bitwarden comparison | Evidence | Use lock as analogy, not logout | Official docs describe lock as deleting decrypted data from memory while keeping local encrypted vault data. |
| `SyncWebSocket` structural type | Asymmetric win | Refuse: use `WebSocket` directly | The implementation reads `WebSocket.OPEN`/`CLOSED`/`CLOSING`/`CONNECTING` as DOM globals plus `/// <reference lib="dom" />`. The structural type is a fiction that pretends portability the impl never delivered. Collapsing it removes ~15 LOC and one mental model. |
| Structured logging on attach-sync | Quality | Add `log.info` on terminal status transitions, `log.warn` on permanent close-code parse | 2 `log.warn` calls in 1130 LOC means production debugging has no breadcrumbs. The `Logger` is already plumbed through; the cost is 4-5 lines. |
| `bindAuthWorkspaceScope` callback shape | Clean break | Two explicit callbacks: `onSignOut`, `onIdentityChanged`. Both required. No defaults. | The two events are semantically different (user-initiated vs different-user-detected). Today both bodies will be `window.location.reload()` because there is no `deactivateEncryption()` API and the bundle-level dispose isn't audited for completeness: reload is the only verifiable cleanup boundary. The callbacks exist as seams for: lifecycle naming at the call site, test injection, platform-specific overrides (Tauri window close, Chrome extension sidepanel), and per-event telemetry. They are NOT about "different reset strategies" today; they are about giving apps a place to express the truth (`reload` for both) without hiding it behind a default. |
| `resetLocalClient` callback name | Clean break | Delete the name. | After this spec, no destructive reset happens on identity transitions. The local IDB is preserved on sign-out and a different IDB opens on identity change. The callback name was honest when it wiped; it lies now. Lifecycle-shaped names (`onSignOut`, `onIdentityChanged`) replace it. |
| Reload-as-cleanup-boundary | Evidence | Document explicitly | This app has table stores, KV projections, child-doc caches, observers, WebSocket providers, and encryption keyrings. Without a dedicated deactivation protocol, in-process sign-out cannot prove every decrypted reference is gone. Reload moves the cleanup boundary above application state enumeration. A future spec can build `attachEncryption(...).deactivate()` plus audited `bundle.dispose()` and let apps opt into in-process teardown; this spec does not. |
| `bindAuthWorkspaceScope` package boundary | Cohesion | Keep it separate from `createCookieAuth` and `createBearerAuth` | Auth clients own credentials and identity observation. Workspace scope owns how identity affects Yjs construction, encryption, and reload. Folding workspace lifecycle into auth factories would make auth clients import app/runtime policy and would duplicate the same lifecycle method across cookie and bearer auth. |
| `createDisposableCache` `gcTime` | Value-add | Keep the option on the primitive, remove explicit default call-site config | The primitive has real non-default callers (`0`, `Infinity`, and test-controlled timers). The app child-doc factories passing `{ gcTime: 5_000 }` are just restating the default. Delete those arguments when touching the factories. |
| `SyncStatus` shape | Type coherence | Keep the discriminated object union | `connected` has no payload after this spec, but `connecting` still carries retries/lastError and `failed` carries reason. A pure string union would delete useful diagnostics or split status into two surfaces. |

## Architecture

### Before

```txt
sign out click
  |
  v
AccountPopover checks hasLocalChanges
  |
  v
auth.signOut()
  |
  v
identity null
  |
  v
bindAuthWorkspaceScope reset()
  |
  v
app wipe()
  |
  +-- destroy runtime
  +-- clear IndexedDB
  +-- reload

Support code:
  SYNC_STATUS protocol
  hasLocalChanges status payload
  confirmation dialog copy
```

### After

```txt
sign out click
  |
  v
auth.signOut()
  |
  v
identity null
  |
  v
destroy owner-scoped workspace runtime
  |
  +-- destroy runtime
  +-- keep local persistence
  +-- reload

same owner signs in later
  |
  v
createLocalYjsKey(identity.user.id, ydoc.guid)
  |
  v
apply encryption keys
  |
  v
open scoped encrypted IndexedDB and scoped BroadcastChannel

different owner signs in later
  |
  v
createLocalYjsKey(newIdentity.user.id, ydoc.guid)
  |
  v
apply encryption keys
  |
  v
open a different encrypted IndexedDB and BroadcastChannel key
```

The new boundary is simple: sign-out destroys memory, and local persistence is owner-scoped before anything mounts.

## Implementation plan

### Phase 0: Verify blockers

- [x] **0.1** Carry forward the current persistence classification from the original audit: Fuji, Honeycrisp, and Opensidian have authenticated plaintext child docs; tab-manager has root Yjs persistence only; Zhongwen's browser package was authless and syncless local persistence; Skills has plaintext child docs but only migrates if it becomes authenticated.
  > **Update**: The Zhongwen classification changed after review. Zhongwen chat history is account-owned and should move to the authenticated encrypted path. Skills remains authless.
- [x] **0.2** Land or update `specs/20260505T004755-attach-encrypted-indexeddb.md` first. Preserve-on-sign-out cannot ship while authenticated apps still write plaintext user-content updates to local child-doc IDBs.
  > **Note**: The primitive is landed. App call sites still move in this spec after construction order is fixed.
- [x] **0.3** Confirm every current app `wipe()` clears all child databases, not only the root document. Fuji, Honeycrisp, and Opensidian manually clear child docs today.
  > **Note**: Fuji, Honeycrisp, Opensidian, and Skills clear child DBs. Tab-manager and Zhongwen have root-only local persistence.
- [x] **0.4** Confirm no app outside `bindAuthWorkspaceScope` wipes local persistence on identity-null transitions.
  > **Note**: The only `resetLocalClient` registrations are Fuji, Honeycrisp, Opensidian, Tab-manager, and Zhongwen. Skills has wipe helpers but no auth binding.
- [x] **0.5** Confirm `attachSync` already drops offline when credentials disappear. Current finding: auth change triggers reconnect, active cycle aborts, and `openWebSocket()` returning null leaves status offline.

### Phase 1: Add scoped local Yjs identity helpers

- [x] **1.1** Add a small key helper in `packages/workspace` or `packages/auth-workspace`: `createLocalYjsKey(userId, ydocGuid)`.
- [x] **1.2** Use one owner-scoped Yjs key shape: `epicenter:v1:user:{userId}:yjs:{ydocGuid}`.
- [x] **1.3** Use the raw `identity.user.id` directly. No hashing, no domain-separation label. The same stable owner id already partitions server-side workspace resources, and IndexedDB names are per-origin.
- [x] **1.4** Add tests proving different users produce different keys and the key shape matches `epicenter:v1:user:<userId>:yjs:<ydocGuid>` exactly.

### Phase 2: Separate Y.Doc identity from local browser keys

- [x] **2.1** Change `attachIndexedDb(ydoc)` to accept optional `{ persistenceKey }`, defaulting to `ydoc.guid`.
  > **Note**: Completed with the encrypted IndexedDB primitive wave because both providers share the same attachment contract.
- [x] **2.2** Ensure both `new IndexeddbPersistence(...)` and `clearLocal()` use the same `persistenceKey`.
- [x] **2.3** Change `attachBroadcastChannel(ydoc)` to accept optional `{ channelKey }`, defaulting to the current `ydoc.guid` behavior.
- [x] **2.4** Document that `persistenceKey` and `channelKey` are local runtime names only. They do not change sync room names, `ydoc.guid`, child document GUIDs, or HKDF workspace labels.
- [x] **2.5** Do not add `attachStorage(ydoc, { encrypted })` or `attachBrowserLocalYjs(ydoc, { encrypted })`. The shared surface is `createLocalYjsKey`; encrypted storage hangs from the encryption coordinator.
- [x] **2.6** Add focused tests for the key plumbing where practical. If y-indexeddb is hard to test directly, test returned `clearLocal()` behavior with a small browser-compatible harness or document the manual verification.
  > **Note**: Added direct tests for `createLocalYjsKey`, `attachBroadcastChannel({ channelKey })`, and encrypted IndexedDB clear/read behavior. Plain `attachIndexedDb({ persistenceKey })` is covered structurally through the shared implementation and will be exercised by app migrations.

### Phase 3: Auth-scope workspace construction

For each current caller:

```txt
apps/fuji/src/lib/fuji/client.ts
apps/honeycrisp/src/lib/honeycrisp/client.ts
apps/opensidian/src/lib/opensidian/client.ts
apps/tab-manager/src/lib/tab-manager/client.ts
apps/zhongwen/src/lib/zhongwen/client.ts
```

- [x] **3.1** Stop constructing browser-local workspaces before auth identity is known for participating apps.
  > **Update**: Fuji, Honeycrisp, Opensidian, and Tab-manager now wait for auth readiness and require an identity before construction. Zhongwen must be moved into this set because its chat history is now account-owned.
- [x] **3.2** On signed-in auth, pass `identity.user.id` and `identity.encryptionKeys` into browser workspace construction.
- [x] **3.3** Apply keys before attaching encrypted local persistence: `doc.encryption.applyKeys(identity.encryptionKeys)`.
- [x] **3.4** Use `doc.encryption.attachEncryptedIndexedDb(doc.ydoc, { persistenceKey: createLocalYjsKey(identity.user.id, doc.ydoc.guid) })` for authenticated root local persistence.
- [x] **3.5** Use `attachBroadcastChannel(doc.ydoc, { channelKey: createLocalYjsKey(identity.user.id, doc.ydoc.guid), transportOrigin })` for authenticated root local broadcast.
- [x] **3.6** Use `doc.encryption.attachEncryptedIndexedDb(childYdoc, { persistenceKey: createLocalYjsKey(identity.user.id, childYdoc.guid) })` for every persisted authenticated child document that contains user content.
- [x] **3.7** Use plain `attachIndexedDb` only for authless or explicitly non-sensitive browser packages.
  > **Update**: Skills remains direct `attachIndexedDb`. Zhongwen no longer qualifies for this exception for chat history.
- [x] **3.8** Keep `ydoc.guid` unchanged for sync URLs and encryption. Root sync still points to `/workspaces/${doc.ydoc.guid}`. Child sync should use `/documents/${ydoc.guid}`.
- [x] **3.9** On sign-out, destroy the current workspace runtime and reload. Do not call `clearLocal()` or `clearDocument()`.
  > **Note**: Terminal auth callbacks now reload without calling any local deletion path.
- [x] **3.10** Keep destructive local deletion only for explicit "Forget this device" or legacy wipe paths.
  > **Note**: Destructive deletion moved behind the confirmed "Forget this device" action.

### Phase 4: Close the plaintext child-doc gap (depends on `attach-encrypted-indexeddb`)

Resolved by the follow-up spec at `specs/20260505T004755-attach-encrypted-indexeddb.md`. That spec adds `encryption.attachEncryptedIndexedDb(targetYdoc, { persistenceKey })` as a method on the existing encryption coordinator. The migration here is a construction-order change plus one storage-call change per root and child doc.

- [x] **4.1** Land the `attach-encrypted-indexeddb` spec first. This sign-out spec depends on it before preserve-on-sign-out can ship.
- [x] **4.2** `apps/fuji/src/lib/fuji/browser.ts`: replace root `attachIndexedDb(doc.ydoc)` with `doc.encryption.attachEncryptedIndexedDb(doc.ydoc, { persistenceKey })`, and replace child entry-content `attachIndexedDb(ydoc)` the same way.
- [x] **4.3** `apps/honeycrisp/src/lib/honeycrisp/browser.ts`: same replacement for root and note-body docs.
- [x] **4.4** `apps/opensidian/src/lib/opensidian/browser.ts`: same replacement for root and file-content docs.
- [x] **4.5** `apps/tab-manager/src/lib/tab-manager/extension.ts`: same replacement for the root workspace doc.
- [x] **4.6** `apps/zhongwen/src/lib/zhongwen/browser.ts`: move chat history to authenticated encrypted local persistence. Require auth identity before construction and apply keys before attaching IndexedDB.
- [x] **4.7** `apps/skills/src/lib/skills/browser.ts`: use encrypted storage only if Skills becomes authenticated. If it stays authless, classify its local persistence separately and do not force this coordinator method into it.
  > **Note**: Skills remains authless and stays on direct `attachIndexedDb`.
- [x] **4.8** Delete explicit `{ gcTime: 5_000 }` arguments from touched child-doc caches. That is the default.
- [ ] **4.9** Add manual smoke for local disk inspection: after sign-out, open IDB devtools and confirm root and child-doc blobs are opaque ciphertext (start with `0x01` version byte).

Do not add an app-level `preserveLocalOnSignOut` flag to bypass this. That creates two privacy products behind one shared UI.

### Phase 5: Collapse the popover

- [x] **5.1** Edit `packages/svelte-utils/src/account-popover/account-popover.svelte`. Replace `handleSignOut` with a direct `auth.signOut()` call and normal error toast.
- [x] **5.2** Remove the `confirmationDialog` import from the account popover.
- [x] **5.3** Remove "safe sign-out" wording from the component JSDoc.
- [x] **5.4** Do not remove root `<ConfirmationDialog />` mounts blindly. Fuji, Whispering, Skills, Tab-manager, Opensidian, and others use confirmation dialogs for unrelated destructive actions.
  > **Note**: Root mounts were left alone.
- [x] **5.5** Remove "Sign out with unsynced changes?", "Sign out anyway", and "Stay signed in" strings.

### Phase 6: Delete SYNC_STATUS and `hasLocalChanges`, clean up `attach-sync.ts`

- [x] **6.1** `packages/workspace/src/document/attach-sync.ts`: remove the `encodeSyncStatus` import, version counters, timer, debounced send, SYNC_STATUS message case, and `hasLocalChanges` from `SyncStatus.connected`.
- [x] **6.2** `packages/sync/src/protocol.ts`: remove `MESSAGE_TYPE.SYNC_STATUS`, `encodeSyncStatus`, `decodeSyncStatus`, and SYNC_STATUS docs.
- [x] **6.3** `packages/sync/src/index.ts`: remove SYNC_STATUS exports.
- [x] **6.4** `apps/api/src/sync-handlers.ts`: remove the SYNC_STATUS echo branch. Keep text `ping` to `pong`; it is unrelated liveness behavior.
- [x] **6.5** Update `packages/workspace/src/daemon/run-errors.ts` and `packages/workspace/src/daemon/run-handler.ts` so connected status has no `hasLocalChanges` payload.
- [x] **6.6** Update CLI tests and fixtures that still construct `{ phase: 'connected', hasLocalChanges: false }`.
- [x] **6.7** Update `packages/workspace/SYNC_ARCHITECTURE.md`, `packages/sync/README.md`, and any docs/articles that describe SYNC_STATUS.
  > **Note**: The two obsolete docs/articles were deleted instead of kept as superseded references because the success criteria require the removed protocol name to disappear from live docs.

#### Phase 6.A: Refuse the `SyncWebSocket` structural type (Cut F)

`attach-sync.ts:181-196` defines a structural type that mirrors a subset of `WebSocket`. The intent was to let non-DOM transports satisfy the interface. The actual implementation reads `WebSocket.OPEN`/`CLOSED`/`CLOSING`/`CONNECTING` as DOM globals at lines 474, 563, 646, 654, 775, 921, 1011, 1040, plus a `/// <reference lib="dom" />` at line 1. The type pretends to be portable; the implementation is browser-only. That mismatch is the smell.

- [x] **6.A.1** Delete the `SyncWebSocket` type from `attach-sync.ts`.
- [x] **6.A.2** Change `SyncAuth.openWebSocket` return type from `SyncWebSocket | null` to `WebSocket | null`.
- [x] **6.A.3** Update `packages/auth/src/create-auth.ts` (`openWebSocket` signature) and any other implementer to return `WebSocket | null` directly.
  > **Note**: `packages/auth/src/create-auth.ts` already returned `WebSocket | null`; attach-sync test doubles now cast their fake transport at the boundary.
- [x] **6.A.4** Mark `specs/20260504T185711-attach-sync-auth-namespace.md` as superseded by this cut, since its rationale ("`WebSocket` is a strict superset of `SyncWebSocket`") is now resolved by collapsing them.

Why this is a clean break and not just a rename: keeping `SyncWebSocket` as an alias for `WebSocket` would preserve the fiction that the abstraction does something. It does not. Delete the name; commit to the dependency that already exists.

#### Phase 6.B: Add structured logging breadcrumbs (Cut H)

The current `attach-sync.ts` has 1130 lines and 2 `log.warn` calls. Production debugging of "why is sync stuck?" is blind.

- [x] **6.B.1** In the supervisor's status-emitter `set` path, emit `log.info` on each terminal transition: `connected`, `failed`, `offline`. Do not log `connecting` (would spam during retry loops).
- [x] **6.B.2** When `parsePermanentFailure` returns non-null, emit `log.warn` with the close code and parsed reason.
- [x] **6.B.3** When the supervisor exits the loop (after master abort), emit `log.info` with the cause: dispose, doc destroyed, or permanent failure.
- [x] **6.B.4** Do not log inside the inner reconnect loop (would spam at backoff intervals). The status transition already covers visibility.
- [x] **6.B.5** Use the file's existing logger source (`createLogger('attachSync')`); do not introduce per-call logger instantiation.

### Phase 7: Rename and split the auth-workspace lifecycle callback (Cut G)

The current `bindAuthWorkspaceScope({ resetLocalClient })` callback fires on both sign-out and identity mismatch and is named for a destructive action that no longer happens. Replace it with two lifecycle-shaped callbacks, both required:

```ts
bindAuthWorkspaceScope({
  auth,
  applyAuthIdentity(session) {
    fuji.encryption.applyKeys(session.encryptionKeys);
  },
  onSignOut() {
    window.location.reload();
  },
  onIdentityChanged() {
    window.location.reload();
  },
});
```

- [x] **7.1** `packages/auth-workspace/src/index.ts`: change `AuthWorkspaceScopeOptions` type. Replace `resetLocalClient: () => Promise<void>` with two required fields: `onSignOut: () => void | Promise<void>` and `onIdentityChanged: () => void | Promise<void>`.
- [x] **7.2** `packages/auth-workspace/src/index.ts`: in `processIdentity`:
  - When `identity === null && appliedUserId !== null` -> `await onSignOut()`. Do NOT call any local-data wipe. The IDB stays.
  - When `identity !== null && appliedUserId !== null && appliedUserId !== userId` -> `await onIdentityChanged()`. Do NOT call any local-data wipe. The new user's scoped IDB will open after reload.
- [x] **7.3** Drain semantics: callbacks fire on terminal transitions and the binding stops processing further identity changes for the current page lifetime (a reload is expected, but the binding shouldn't depend on it actually happening: fields like `isResetting` keep the existing single-shot drain behavior, just renamed).
- [x] **7.4** `packages/auth-workspace/src/index.test.ts`: rewrite tests around the new callbacks. Add a test asserting that NEITHER callback's body is invoked by the binding itself (the binding only fires the callback; the callback decides whether to reload).
- [x] **7.5** Update the 5 callers (`apps/fuji/src/lib/fuji/client.ts`, `apps/honeycrisp/src/lib/honeycrisp/client.ts`, `apps/opensidian/src/lib/opensidian/client.ts`, `apps/tab-manager/src/lib/tab-manager/client.ts`, `apps/zhongwen/src/lib/zhongwen/client.ts`). Body for each callback is `window.location.reload()` for now. Apps may diverge later; today they don't need to.
- [x] **7.6** Delete each app's sign-out-only `wipe()` path if no consumer remains (grep first). Keep or replace low-level local-clear helpers needed by Phase 8's explicit "Forget this device" action.
  > **Note**: Client sign-out paths no longer call `wipe()`. Low-level bundle `wipe()` helpers remain because Phase 8 needs explicit local cleanup.
- [x] **7.7** Update `docs/encryption.md` and `docs/guides/consuming-epicenter-api.md` examples to show the two-callback shape. Explain in prose: both bodies will usually be `window.location.reload()`; the seams exist for naming, tests, platform overrides, and telemetry.

### Phase 8: Add explicit local cleanup

Sign-out no longer deletes local data. That is correct, but users still need an intentional cleanup path.

- [x] **8.1** Add a "Forget this device" action for signed-in authenticated apps. It deletes the current owner's local Yjs caches and then reloads.
- [x] **8.2** Implement cleanup against owner-scoped local keys. Do not call the old workspace-bundle `wipe()` method from sign-out.
  > **Update**: Fuji, Honeycrisp, Opensidian, Tab-manager, and Zhongwen should all use owner-scoped cleanup. The follow-up collapse spec renames `clearLocalYjsDataForUser` to `clearOwnedDocuments` while preserving owner-prefix sweeping.
- [x] **8.3** Use the `epicenter:v1:user:{userId}:yjs:` prefix when enumerating local databases where the runtime supports `indexedDB.databases()`.
- [x] **8.4** Keep a fallback path that clears known root and child document keys for the current workspace when full database enumeration is unavailable.
- [x] **8.5** Put the destructive confirmation on "Forget this device", not on sign-out.
- [x] **8.6** If this action does not land in the same PR, leave a tracked follow-up spec and do not delete the low-level clear helpers it will need.

### Phase 9: Supersede old specs and docs

- [x] **9.1** Mark `specs/20260414T143000-safe-sign-out-flow.md` as superseded by this spec.
- [x] **9.2** Mark `specs/20260310T235239-sync-status-102.md` as superseded by this spec.
- [x] **9.3** Mark `specs/20260504T185711-attach-sync-auth-namespace.md` as superseded (Cut F collapses `SyncWebSocket` into `WebSocket`).
- [x] **9.4** Update docs that say sign-out wipes local data, but only after encrypted local persistence is in place.
- [x] **9.5** Replace Bitwarden logout claims with the more precise lock analogy and link to official Bitwarden unlock vs login docs.

### Phase 10: Verify

- [x] **10.1** Run `bun test packages/auth-workspace/src/index.test.ts`.
- [x] **10.2** Run `bun test packages/sync/src/protocol.test.ts`.
- [x] **10.3** Run `bun test packages/workspace/src/document/attach-sync.test.ts`.
- [x] **10.4** Run daemon and CLI tests touched by `SyncStatus` shape changes.
- [ ] **10.5** Run `bun run typecheck`.
  > **Blocked by existing repo diagnostics**: `bun run typecheck` still fails in `@epicenter/svelte` and `@epicenter/landing` on pre-existing diagnostics such as unresolved `#/utils.js`, `from-table.svelte.ts` using the old table result shape, and `WorkspaceGate` children props. Focused `packages/workspace`, `packages/sync`, and `packages/auth-workspace` typechecks passed.
- [ ] **10.6** Manual smoke per participating app: sign in, edit, sign out, confirm runtime reloads (via `onSignOut`) and local persistence remains under the same owner-scoped key.
- [ ] **10.7** Manual smoke per participating app: sign in as a different user after sign-out and reload, confirm a different local cache opens and the prior user's cache is not mounted.
- [ ] **10.8** Manual smoke for local disk: persisted user content that survives sign-out is encrypted or deliberately non-sensitive.
- [ ] **10.9** Manual smoke: confirm `onSignOut` fires once per user-initiated sign-out and `onIdentityChanged` fires once per different-user transition (not both for the same event).

## Edge cases

### Same user signs out and returns after reload

```txt
auth identity = null
workspace runtime = destroyed by reload
local cache = epicenter:v1:user:<userIdA>:yjs:epicenter.fuji

later:
auth identity = user A
apply keys
local cache = epicenter:v1:user:<userIdA>:yjs:epicenter.fuji
same owner-scoped local cache resumes
```

### Different user signs in after a signed-out reload

```txt
prior local cache = epicenter:v1:user:<userIdA>:yjs:epicenter.fuji
auth identity = user B
apply user B keys
new local cache = epicenter:v1:user:<userIdB>:yjs:epicenter.fuji
```

User A's cache remains on disk but is not opened. It can be removed later by "Forget this device."

### Multi-tab sign-out

Sign-out should broadcast auth null through the existing auth client. Each tab destroys its owner-scoped runtime and reloads. No tab calls `clearLocal()`, so there is no IDB delete race.

### Different user while another tab still has old runtime

The tab that sees the auth change destroys and reloads. Other tabs may have old decrypted state until their auth change or reload fires. This is already a multi-tab runtime problem today. The clean fix is still to reload on terminal transitions. Do not replace reload with a custom invalidation protocol in this spec.

### Offline edits

Offline edits are local Yjs updates. Sign-out preserves owner-scoped local persistence and destroys memory. Same-owner sign-in later reloads the updates from IDB and sync resumes. Different-owner sign-in opens a different cache.

### Key rotation

Same-owner sign-in with a rotated keyring still works for root encrypted stores if the keyring includes the old version. `applyKeys` converges old-version ciphertext to the current version. If old keys are revoked, old local data is undecryptable. That is a key-management outcome, not a sign-out outcome.

## Closed decisions from the grill

1. **What is the child-doc encryption strategy?**
   - Use `encryption.attachEncryptedIndexedDb(targetYdoc, { persistenceKey })` from `specs/20260505T004755-attach-encrypted-indexeddb.md`. Preserve-on-sign-out does not ship for authenticated apps until plaintext local child docs are gone.

2. **How long should orphaned owner caches survive?**
   - Until browser storage pressure or the explicit "Forget this device" action removes them. Automatic pruning is refused for v1 because it creates a silent destructive policy beside a feature whose whole point is preservation.

3. **Should failed runtime teardown block sign-out completion?**
   - **No.** Sign-out already happened at the auth layer. If teardown fails, show an error and reload anyway. The goal is to clear memory. A reload is the recovery path.

4. **Should raw user id ever appear in local keys?**
   - **Yes.** The raw user id is already the stable owner identifier used by auth and server-side workspace partitioning. IndexedDB names are per-origin and not exposed cross-site. The asymmetric-win pass refused the hash: it added a helper, tests, and a stability worry without functional benefit. Reopen this only if a future threat model (e.g., a malicious browser extension reading IDB names within the same origin) makes opacity load-bearing.

5. **Should `hasLocalChanges` come back later as save status?**
   - **Refused permanently.** Yjs is a continuous-sync CRDT; there is no "saved" event in the data model. Apple Notes, Apple Keychain, Bitwarden, Signal, and Obsidian all ship without a "saved/saving…" indicator. A future SYNC_STATUS revival would re-introduce the same wire/UI/state machine cost for a UX surface no peer product considers necessary. If a future product surface genuinely needs an atomic save barrier (rare; usually a sign that the product wants Yjs's eventual semantics replaced with transactional semantics, which is a different system), design that as an explicit invariant with its own primitive. Do not bring back a "I think the server has it" heuristic.

## Success criteria

- [x] Participating apps construct browser-local workspaces only after auth identity is known.
  > **Update**: Fuji, Honeycrisp, Opensidian, and Tab-manager do. Zhongwen is now a participating app for chat history and should be migrated accordingly.
- [x] Local IndexedDB keys are owner-scoped with owner-first hierarchy.
- [x] Local BroadcastChannel keys are owner-scoped with the same local hierarchy.
- [x] Authenticated apps use `encryption.attachEncryptedIndexedDb(..., { persistenceKey })` for root and user-content child docs before preserve-on-sign-out ships.
- [x] Sign-out destroys runtime and reloads, not a storage wipe and not a no-op.
- [ ] A signed-out app reload has no live Y.Doc, encryption keyring, decrypted table projection, child document cache, or sync socket from the prior user.
- [ ] Different-owner sign-in opens a different local cache before applying keys.
- [x] `ydoc.guid` remains the sync room, child GUID namespace, and encryption workspace id.
- [x] No app hides reload inside `resetLocalClient`; the lifecycle binding owns when terminal transitions reload.
- [x] No `MESSAGE_TYPE.SYNC_STATUS`, `encodeSyncStatus`, `decodeSyncStatus`, `localVersion`, `ackedVersion`, `syncStatusTimer`, or `hasLocalChanges` remains in live source, docs, daemon payloads, or CLI fixtures.
- [x] No `SyncWebSocket` type alias remains. `auth.openWebSocket` returns `WebSocket | null`.
- [x] `attach-sync.ts` emits `log.info` on each terminal status transition and `log.warn` on permanent-failure parse.
- [x] `bindAuthWorkspaceScope` accepts two required callbacks: `onSignOut` and `onIdentityChanged`. The old `resetLocalClient` parameter is gone everywhere.
- [x] All 5 app callers pass `window.location.reload()` for both callbacks (or a documented platform-specific override).
- [x] Sign-out does not call any local wipe path.
- [x] An explicit "Forget this device" path exists, or the low-level clear helpers it will need remain and a tracked follow-up spec exists.
- [x] `account-popover.svelte` has no confirmation dialog branch for sign-out.
- [x] Apps with plaintext child docs have encrypted child persistence before preserve-on-sign-out ships.
  > **Note**: Skills remains authless, so it stays outside the authenticated preserve-on-sign-out path.
- [x] `specs/20260414T143000-safe-sign-out-flow.md` and `specs/20260310T235239-sync-status-102.md` are marked superseded.

## References

Code paths verified during the grill:

```txt
packages/auth-workspace/src/index.ts
packages/auth-workspace/src/index.test.ts
packages/svelte-utils/src/account-popover/account-popover.svelte
packages/workspace/src/document/attach-sync.ts
packages/workspace/src/document/attach-encryption.ts
packages/workspace/src/shared/y-keyvalue/y-keyvalue-lww-encrypted.ts
packages/workspace/src/document/attach-indexed-db.ts
packages/workspace/src/document/attach-broadcast-channel.ts
packages/workspace/node_modules/y-indexeddb/src/y-indexeddb.js
packages/workspace/src/cache/disposable-cache.ts
packages/sync/src/protocol.ts
apps/api/src/app.ts
apps/api/src/base-sync-room.ts:141
apps/api/src/sync-handlers.ts
apps/fuji/src/lib/fuji/index.ts
apps/fuji/src/lib/fuji/browser.ts
apps/fuji/src/lib/fuji/client.ts
apps/honeycrisp/src/lib/honeycrisp/browser.ts
apps/tab-manager/src/lib/tab-manager/extension.ts
apps/honeycrisp/src/lib/honeycrisp/client.ts
apps/opensidian/src/lib/opensidian/browser.ts
apps/opensidian/src/lib/opensidian/client.ts
apps/skills/src/lib/skills/browser.ts
apps/tab-manager/src/lib/tab-manager/client.ts
apps/zhongwen/src/lib/zhongwen/browser.ts
apps/zhongwen/src/lib/zhongwen/client.ts
packages/workspace/src/daemon/run-errors.ts
packages/workspace/src/daemon/run-handler.ts
specs/20260505T004755-attach-encrypted-indexeddb.md
```

Requested path note: `apps/epicenter` is not present in this checkout.

External grounding:

- Official Bitwarden docs: `https://bitwarden.com/help/understand-log-in-vs-unlock/`
- Official Bitwarden docs: `https://bitwarden.com/help/unlock-with-pin/`
- DeepWiki on `yjs/y-protocols`: standard protocol families are sync, awareness, and auth. SYNC_STATUS is not standard.
- DeepWiki on Cloudflare Durable Objects: `setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"))` answers matching text messages without waking the Durable Object.
- DeepWiki on Better Auth: `session.user.id` is the stable user identifier; `signOut()` clears the active client session state.
- DeepWiki on WXT: `browser.runtime.reload()` is available for full extension reset, but the current tab-manager sidepanel already uses `window.location.reload()`, so Cut G does not need a special extension reset policy.

## Final one-sentence test

After implementation, this must be true:

> **Sign-out destroys the live workspace and reloads; sign-in opens only the local cache scoped to that authenticated owner.**

If any surviving code path keeps a live signed-out workspace, uses unscoped local IndexedDB or BroadcastChannel names for authenticated workspaces, deletes local persistence on same-owner sign-out, or keeps SYNC_STATUS alive only for the old sign-out warning, the implementation is incomplete.

## Post-implementation review

Files reread:

```txt
packages/workspace/src/document/
  attach-sync.ts
  clear-local-yjs-data.ts
packages/auth-workspace/src/
  index.ts
packages/svelte-utils/src/account-popover/
  account-popover.svelte
apps/fuji/src/lib/fuji/
  browser.ts
apps/honeycrisp/src/lib/honeycrisp/
  browser.ts
apps/opensidian/src/lib/opensidian/
  browser.ts
apps/tab-manager/src/lib/tab-manager/
  extension.ts
specs/
  20260504T233223-sign-out-preserves-local-data.md
```

Review notes:

- No sign-out path calls `wipe()`, `clearLocal()`, or `clearDocument()`. Terminal auth transitions call app-owned reload callbacks.
- Authenticated local storage names use `createLocalYjsKey(userId, ydoc.guid)` for root docs and child docs. Sync room GUIDs remain unchanged.
- The explicit cleanup path uses owner-scoped cleanup, currently named `clearLocalYjsDataForUser` in live code and renamed to `clearOwnedDocuments` by `specs/20260505T020000-collapse-owner-scoping-onto-coordinator.md`. The behavior enumerates `indexedDB.databases()` by owner prefix when available and falls back to known root and child GUIDs.
- `SYNC_STATUS`, `hasLocalChanges`, and `SyncWebSocket` remain only in historical specs, not live source or live docs.
- Manual browser smokes remain open because they require interactive authenticated app sessions and IndexedDB inspection.

Follow-up collapse:

- Implemented by `specs/20260505T020000-collapse-owner-scoping-onto-coordinator.md`.
- Authenticated browser factories now pass `identity.encryptionKeys` into the isomorphic `open*Doc({ encryptionKeys })` factory, then call `encryption.attachIndexedDb(ydoc, { userId })` and `attachBroadcastChannel(ydoc, { userId })`.
- The old public `createLocalYjsKey`, `clearLocalYjsDataForUser`, `persistenceKey`, `channelKey`, `transportOrigin`, and `attachEncryptedIndexedDb` surfaces are gone from live app code.

Verification:

```txt
bun test packages/auth-workspace/src/index.test.ts packages/sync/src/protocol.test.ts packages/workspace/src/document/attach-sync.test.ts packages/workspace/src/document/clear-local-yjs-data.test.ts packages/workspace/src/daemon/run-handler.test.ts packages/workspace/src/daemon/list-route.test.ts packages/cli/src/commands/run-peer-errors.test.ts packages/cli/src/commands/up.test.ts apps/api/src/sync-handlers.test.ts
  pass, 112 tests

bun run --cwd packages/workspace typecheck
  pass

bun run --cwd packages/sync typecheck
  pass

bun run --cwd packages/auth-workspace typecheck
  pass

bun run typecheck
  fails before this change's app surface on existing @epicenter/svelte and @epicenter/landing diagnostics.
```
