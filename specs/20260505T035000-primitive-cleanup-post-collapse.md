# Primitive cleanup post owner-scoping collapse

**Date**: 2026-05-05
**Status**: Implemented
**Author**: AI-assisted, grounded against live code, DeepWiki, and local tests
**Branch**: `feat/encrypted-local-workspace-storage`
**Depends on**: `specs/20260505T020000-collapse-owner-scoping-onto-coordinator.md`
**Pairs with**: `specs/20260505T030000-browser-workspace-route-loaders.md`
**Defers**: daemon and browser factory split

## One-sentence thesis

Keep owner scoping where it is a real privacy boundary, split local-only and owner-scoped BroadcastChannel APIs, remove public cleanup ceremony that callers do not need, and rename the destructive IndexedDB cleanup to `wipeOwnerLocalYjsData`.

## Clean-break rule

This spec does not need every intermediate commit to keep every app runnable.
During implementation, it is acceptable for imports to break while the final
surface is being moved. The required final state is stricter:

```txt
one public local-only BroadcastChannel API
one public owner-scoped BroadcastChannel API
no optional security parameter
no compatibility alias for the old hybrid shape
no authenticated app call site using the local-only API
```

Do not preserve the old hybrid owner option as an alias. The
whole point of this cleanup is to make the two modes visible at the call site.

## Corrections from the first draft

The first draft had three bad claims:

1. It said BroadcastChannel owner scoping could be removed. That is wrong.
2. It said no live caller uses authless `attachBroadcastChannel(ydoc)`. That is wrong. `apps/skills` and `apps/whispering` use it for local-only documents.
3. It said no tests use `indexedDB` or `clearDocument` injection on the legacy cleanup API. That was wrong. The cleanup tests used both before this implementation.

Those corrections change the shape of the cleanup. The optional BroadcastChannel parameter is still a smell, but the right fix is not to drop owner scoping. The right fix is to split the two modes into explicit functions.

## Threat model

Yjs updates are not encrypted by Yjs. DeepWiki confirms that Yjs updates are binary CRDT operations, and `y-indexeddb` persists applied incoming updates. The local code confirms the same pattern for encrypted IndexedDB: the provider listens to `updateV2` and writes incoming updates unless the origin is its own attachment.

That means this is unsafe:

```ts
attachBroadcastChannel(ydoc);
```

for an authenticated encrypted workspace that may have two signed-in users on the same browser. A cross-user BroadcastChannel collision can leak plaintext CRDT structure: document keys, row existence, update timing, and Yjs operation shape. The encrypted value payloads may stay opaque, but the structure is still user data.

Owner scoping must stay for authenticated browser workspaces.

## Desired API

Split the hybrid API:

```ts
attachBroadcastChannel(ydoc);
attachOwnedBroadcastChannel(ydoc, { userId });
```

Meaning:

```txt
attachBroadcastChannel
  Local-only or non-authenticated docs.
  Channel key: yjs:{ydoc.guid}

attachOwnedBroadcastChannel
  Authenticated browser workspaces.
  Channel key: yjs:epicenter:v1:user:{userId}:yjs:{ydoc.guid}
```

This keeps local-only apps simple and makes authenticated owner scoping impossible to forget at the call site.

Implementation must share one module-local helper:

```ts
export function attachBroadcastChannel(ydoc: Y.Doc): void {
	attachBroadcastChannelWithKey(ydoc, ydoc.guid);
}

export function attachOwnedBroadcastChannel(
	ydoc: Y.Doc,
	{ userId }: { userId: string },
): void {
	attachBroadcastChannelWithKey(ydoc, createOwnedYjsKey(userId, ydoc.guid));
}

function attachBroadcastChannelWithKey(
	ydoc: Y.Doc,
	channelKey: string,
): void {
	if (typeof BroadcastChannel === 'undefined') return;
	const channel = new BroadcastChannel(`yjs:${channelKey}`);

	const handleUpdate = (update: Uint8Array, origin: unknown) => {
		if (origin === BC_ORIGIN) return;
		if (origin === SYNC_ORIGIN) return;
		channel.postMessage(update);
	};

	ydoc.on('updateV2', handleUpdate);

	channel.onmessage = (event: MessageEvent) => {
		Y.applyUpdateV2(ydoc, new Uint8Array(event.data), BC_ORIGIN);
	};

	ydoc.once('destroy', () => {
		ydoc.off('updateV2', handleUpdate);
		channel.close();
	});
}
```

The public functions name policy. The module-local helper owns mechanics. This
is a plain unexported function in the same file, not a class, not a private
channel, and not a new abstraction boundary. Do not duplicate the
BroadcastChannel event wiring between the two public functions.

## BroadcastChannel availability guard

Keep this guard:

```ts
if (typeof BroadcastChannel === 'undefined') return;
```

`BroadcastChannel` is a browser global. It is not guaranteed in Node.js, SSR,
some test environments, old browsers, or non-browser runtimes. `typeof` is the
safe check because it does not throw when the global name is missing. A direct
comparison like `BroadcastChannel === undefined` can throw before the
comparison runs in runtimes where the global does not exist.

This is why the primitive no-ops rather than failing:

```txt
Browser with BroadcastChannel
  cross-tab local sync is attached

Runtime without BroadcastChannel
  document still works
  IndexedDB or sync attachments can still work
  only same-origin tab fanout is skipped
```

The guard belongs in the shared helper so both public functions have identical
runtime behavior.

## Origin filters

Keep both origin filters:

```ts
const handleUpdate = (update: Uint8Array, origin: unknown) => {
	if (origin === BC_ORIGIN) return;
	if (origin === SYNC_ORIGIN) return;
	channel.postMessage(update);
};
```

Yjs passes an `origin` value through transactions and update events. Providers
use that value as a tag so other providers can tell where an update came from.

`BC_ORIGIN` means "this update came from BroadcastChannel." When tab B receives
an update from tab A, it applies that update with `BC_ORIGIN`. Without the
`BC_ORIGIN` filter, tab B would broadcast the same update again. Other tabs
would receive it and repeat the same loop.

`SYNC_ORIGIN` means "this update came from remote sync." Without this filter,
a remote WebSocket update applied in one tab would be broadcast to every other
tab. Those tabs may already receive the same remote update through their own
sync attachments. Rebroadcasting sync-origin updates creates noisy cross-tab
echoes and can feed remote updates back into local transport paths that do not
own them.

The final flow should be:

```txt
Local edit in tab A
  origin is app/local
  BroadcastChannel sends to tab B

BroadcastChannel receive in tab B
  apply with BC_ORIGIN
  do not broadcast again

Remote sync receive in tab A
  apply with SYNC_ORIGIN
  do not broadcast over BroadcastChannel
```

The filters are not optional polish. They are the loop-prevention contract for
the transport.

## Keep the owner-key helper file

Do not delete `packages/workspace/src/document/local-yjs-key.ts`.

After the API split, the helper is not premature extraction. It names a real shared invariant:

```txt
Owner-scoped browser-local Yjs resources use:
epicenter:v1:user:{userId}:yjs:{ydocGuid}
```

That invariant is shared by:

- encrypted IndexedDB database names
- owner-scoped BroadcastChannel names
- owner-scoped wipe prefix scans

The file can stay small. A tiny file is fine when it owns the string format that prevents cross-user storage and channel collisions.

Optional rename for a later cleanup:

```txt
local-yjs-key.ts -> owner-local-yjs-key.ts
```

This spec does not need that rename.

## Cleanup naming

Rename:

```ts
legacy cleanup API(...)
```

to:

```ts
wipeOwnerLocalYjsData(...)
```

Why this name:

- `wipe` is honest about deletion.
- `owner` matches the `userId` boundary.
- `local` says this is browser-local state, not server sync state.
- `YjsData` narrows the blast radius. The function deletes owner-scoped Yjs IndexedDB databases, not all localStorage or extension storage.

Do not use `wipeOwnerCache`. Unsynced local drafts are not merely cache.

## Desired cleanup API

Public callers should not see IndexedDB test hooks:

```ts
export async function wipeOwnerLocalYjsData({
	userId,
	ydocGuids = [],
}: {
	userId: string;
	ydocGuids?: Iterable<string>;
}): Promise<void> {
	// compose names with createOwnedYjsKey and createOwnedYjsKeyPrefix
}
```

The exported `legacy cleanup options type` type should disappear. No live caller imports it.

The helper types should not be exported:

```ts
type IndexedDbDatabaseInfo = {
	name?: string | null;
};

type IndexedDbFactoryWithDatabases = IDBFactory & {
	databases?: () => Promise<IndexedDbDatabaseInfo[]>;
};
```

Whether these two stay local or become an inline cast is an implementation detail. They should not be public API.

## What to do with test hooks

The current tests pass `indexedDB` and `clearDocument` to observe behavior without touching real IndexedDB. The public function does not need those hooks.

Use one of these implementation shapes:

```ts
export async function wipeOwnerLocalYjsData(input: WipeOwnerLocalYjsDataInput) {
	return wipeOwnerLocalYjsDataWithDependencies(input, {
		indexedDB: globalThis.indexedDB as IndexedDbFactoryWithDatabases | undefined,
		clearDocument,
	});
}

async function wipeOwnerLocalYjsDataWithDependencies(
	input: WipeOwnerLocalYjsDataInput,
	dependencies: {
		indexedDB?: IndexedDbFactoryWithDatabases;
		clearDocument: (name: string) => Promise<void>;
	},
) {
	// tested directly from the same module if needed
}
```

or rewrite tests to use fake IndexedDB and test the public function only.

Do not keep `indexedDB` and `clearDocument` in the exported options type. Test convenience is not a public contract.

## `EncryptedIndexedDbAttachment`

This type currently exposes `activateEncryption`, which is an internal coordinator hook. Public callers receive `IndexedDbAttachment`; they should not see the activation method.

It is not currently re-exported from the root workspace barrel, but it is still
exported from `attach-indexed-db.ts` so `attach-encryption.ts` can import it.
That is an internal coupling leaking through an implementation module.

Preferred cleanup:

```txt
packages/workspace/src/document/internal.ts
  exports InternalEncryptedIndexedDbAttachment

attach-indexed-db.ts
  returns the internal type from attachEncryptedProvider
  exports only IndexedDbAttachment publicly

attach-encryption.ts
  imports the internal type from document/internal.ts
```

If the internal type move creates a circular import, keep the type exported from
`attach-indexed-db.ts` with an `@internal` JSDoc and do not re-export it from
`@epicenter/workspace`.

## `SYNC_ORIGIN` re-export

Drop `SYNC_ORIGIN` from `packages/workspace/src/index.ts` if no live external caller imports it from `@epicenter/workspace`.

Keep `BC_ORIGIN` and `SYNC_ORIGIN` imports inside `attach-broadcast-channel.ts`. The echo filter remains part of the transport implementation.

## Factory option deferral

Do not make `encryptionKeys` required in `openFuji`, `openHoneycrisp`, `openOpensidian`, or `openZhongwen` in this spec.

The live tree shows daemon and script paths that call `open*Doc({ clientID })` without encryption keys. That is a real split:

```txt
browser factory
  has auth identity and encryption keys

daemon or script factory
  has stable clientID
  may be offline or relay-only
```

Changing the option now would force the daemon question into this primitive cleanup. Defer it to a separate daemon/browser factory split spec.

Do not remove `clientID` in this spec for the same reason. It is used by daemon and script paths, not just tests.

## Implementation plan

### Phase 1: BroadcastChannel split

- [x] Add `attachOwnedBroadcastChannel(ydoc, { userId })`.
- [x] Keep `attachBroadcastChannel(ydoc)` for local-only documents.
- [x] Move shared logic into a module-local helper.
- [x] Update JSDoc on both public functions with the security boundary.
- [x] Update tests:
  - local function uses `yjs:{ydoc.guid}`
  - owned function uses `yjs:{createOwnedYjsKey(userId, ydoc.guid)}`
  - `SYNC_ORIGIN` updates are still not rebroadcast

### Phase 2: Authenticated call sites

- [x] Replace authenticated calls with `attachOwnedBroadcastChannel(ydoc, { userId })` in:
  - `apps/fuji/src/lib/fuji/browser.ts`
  - `apps/honeycrisp/src/lib/honeycrisp/browser.ts`
  - `apps/opensidian/src/lib/opensidian/browser.ts`
  - `apps/tab-manager/src/lib/tab-manager/extension.ts`
  - `apps/zhongwen/src/lib/zhongwen/browser.ts`
- [x] Leave local-only calls alone in:
  - `apps/skills/src/lib/skills/browser.ts`
  - `apps/whispering/src/lib/whispering/tauri.ts`

### Phase 3: Rename cleanup

- [x] Rename the legacy cleanup API to `wipeOwnerLocalYjsData`.
- [x] Remove exported legacy cleanup options type.
- [x] Hide or inline `IndexedDbDatabaseInfo` and `IndexedDbFactoryWithDatabases`.
- [x] Remove public `indexedDB` and `clearDocument` dependency hooks.
- [x] Preserve test coverage through module-local dependency injection or fake IndexedDB.
- [x] Update all cleanup callers, including `apps/tab-manager/src/lib/tab-manager/extension.ts`.

### Phase 4: Internal type and docs cleanup

- [x] Stop re-exporting `SYNC_ORIGIN` from `packages/workspace/src/index.ts` if grep confirms no external live imports.
- [x] Move `EncryptedIndexedDbAttachment` to an internal module, or mark it `@internal` if moving it would introduce a cycle.
- [x] Update `packages/workspace/README.md` and `packages/workspace/src/document/README.md` for the BroadcastChannel split and cleanup rename.

### Phase 5: Verify

- [x] Targeted workspace document BroadcastChannel and owner cleanup tests.
- [x] `bun run --cwd packages/workspace typecheck`
- [x] Grep for old names:
  - legacy cleanup symbol
  - legacy cleanup options type
  - old BroadcastChannel owner option
  - sync origin imported from the workspace barrel
- [ ] Smoke authenticated apps: edit, cross-tab sync, sign out, sign in, forget device.
- [ ] Smoke local-only apps: skills and whispering still cross-tab sync locally.

## Resolved decisions and deferrals

1. Use `attachOwnedBroadcastChannel` as the final name. It mirrors owner
   scoping without saying "user" everywhere.

2. Do not rename `local-yjs-key.ts` in this spec. The current name is not
   blocking once the functions are documented.

3. Cleanup tests may use module-local dependency injection or fake IndexedDB. The
   decision is implementation-local. The exported options must not include
   `indexedDB` or `clearDocument`.

4. Defer daemon and script factory option cleanup. `encryptionKeys` and
   `clientID` are tied to browser versus daemon construction, not this primitive
   cleanup.

## Success criteria

- [x] Authenticated workspaces cannot call BroadcastChannel without passing `userId`.
- [x] Local-only workspaces can still call `attachBroadcastChannel(ydoc)`.
- [x] Owner-scoped BroadcastChannel and encrypted IndexedDB use the same key helper.
- [x] The public cleanup function is named `wipeOwnerLocalYjsData`.
- [x] Cleanup test hooks are not part of exported options.
- [x] Legacy cleanup options type is gone.
- [x] `SYNC_ORIGIN` is not re-exported from `@epicenter/workspace` unless a live external caller requires it.
- [x] Workspace docs no longer show authenticated examples using the old hybrid BroadcastChannel owner option.
- [x] Daemon and script factory option questions are explicitly deferred.

## References

- `packages/workspace/src/document/attach-broadcast-channel.ts`
- `packages/workspace/src/document/attach-broadcast-channel.test.ts`
- `packages/workspace/src/document/attach-indexed-db.ts`
- `packages/workspace/src/document/wipe-owner-local-yjs-data.test.ts`
- `packages/workspace/src/document/local-yjs-key.ts`
- `packages/workspace/src/document/attach-encryption.ts`
- `apps/{fuji,honeycrisp,opensidian,zhongwen}/src/lib/{app}/browser.ts`
- `apps/tab-manager/src/lib/tab-manager/extension.ts`
- `apps/skills/src/lib/skills/browser.ts`
- `apps/whispering/src/lib/whispering/tauri.ts`
- `packages/workspace/src/index.ts`

## Review

**Completed**: 2026-05-05
**Branch**: `feat/encrypted-local-workspace-storage`

### Summary

Implemented the primitive cleanup without route loader work. BroadcastChannel now has separate local-only and owner-scoped entry points, authenticated callers use the owner-scoped function, and owner local Yjs deletion is exposed as `wipeOwnerLocalYjsData` without public test hooks.

### Deviations from Spec

- Cleanup tests use fake IndexedDB instead of directly calling a module-local dependency helper.
- Full browser smoke checks remain manual because they require interactive app sessions.

### Follow-up Work

- Run authenticated and local-only browser smoke checks when the app surfaces are already open for QA.
