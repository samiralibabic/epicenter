# Destroy The Y.Doc Before Clearing IndexedDB

I thought clearing local data had to happen before `ydoc.destroy()`. The names push you there: destroy sounds like the document is gone, while clear sounds like it still needs the document. `y-indexeddb` works the other way around. Destroy the Y.Doc first, let every provider stop writing, then delete the IndexedDB database by name.

The reset path should look like this:

```ts
try {
	workspace[Symbol.dispose]();
	await workspace.clearLocalData();
} finally {
	window.location.reload();
}
```

The disposer is the app-owned teardown boundary. It closes child document caches, destroys the root `Y.Doc`, and lets every attachment registered on the destroy event shut itself down.

That matters because the IndexedDB provider is one of those attachments.

```ts
export function attachIndexedDb(ydoc: Y.Doc): IndexedDbAttachment {
	const idb = new IndexeddbPersistence(ydoc.guid, ydoc);

	ydoc.once('destroy', async () => {
		await idb.destroy();
	});

	return {
		whenLoaded: idb.whenSynced,
		clearLocal: () => idb.clearData(),
		whenDisposed,
	};
}
```

The important bit is that `clearLocal` is a method on the provider object, not on the live Y.Doc. It can run after the Y.Doc has been destroyed.

## y-indexeddb Is Designed For That Order

The upstream provider registers itself against the Y.Doc:

```js
doc.on('update', this._storeUpdate)
this.destroy = this.destroy.bind(this)
doc.on('destroy', this.destroy)
```

When the document is destroyed, the provider stops listening to updates and closes its database connection:

```js
destroy () {
  if (this._storeTimeoutId) {
    clearTimeout(this._storeTimeoutId)
  }
  this.doc.off('update', this._storeUpdate)
  this.doc.off('destroy', this.destroy)
  this._destroyed = true
  return this._db.then(db => {
    db.close()
  })
}
```

Then `clearData()` does exactly what you want for explicit local cleanup:

```js
clearData () {
  return this.destroy().then(() => {
    idb.deleteDB(this.name)
  })
}
```

That last line is the answer to the ordering question. The delete is keyed by `this.name`, the IndexedDB database name. It does not need the Y.Doc to be loaded, synced, mutable, or even alive as an active provider target.

## Clearing First Leaves Writers Alive

The tempting order is this:

```ts
await workspace.clearLocalData();
workspace[Symbol.dispose]();
```

That order is weaker. The sync provider, broadcast channel, `y-indexeddb`, and child document providers may still be attached while you are deleting storage. Even if the window reloads a moment later, the reset path now depends on a timing assumption: nothing writes back into a database while deletion is in flight.

Destroy first removes that assumption.

```txt
workspace[Symbol.dispose]()
  -> child document caches dispose
  -> root Y.Doc destroys
  -> sync aborts
  -> broadcast channel closes
  -> y-indexeddb closes its DB connection

workspace.clearLocalData()
  -> y-indexeddb deletes by database name
  -> child document databases are deleted by computed names
```

The one subtle part is child document names. Fuji, Honeycrisp, and Opensidian compute those names from root table rows before deleting child document databases. `Y.Doc.destroy()` does not wipe the in-memory CRDT store. It marks the document destroyed and emits destroy events; the table data needed to compute child database names is still readable in the current JS context.

That gives the reset path the property we actually need:

```txt
stop every live writer first
then delete durable data
then reload if the product action needs a fresh runtime
```

## The Bundle Disposer Should Be The Only Teardown Entry Point

Calling `entryContentDocs[Symbol.dispose]()` next to `workspace.ydoc.destroy()` in a client file is a smell. The client is now restating teardown order that the workspace bundle already owns.

This is better:

```ts
workspace[Symbol.dispose]();
await workspace.clearLocalData();
```

It leaves one source of truth. If Fuji adds another child cache, its bundle disposer changes. The explicit local cleanup path does not need to learn a new internal resource name.

The distinction is clean:

```txt
[Symbol.dispose]()
  in-memory teardown
  stop observers, providers, sockets, channels, caches
  keep persisted data unless something else deletes it

clearLocalData()
  durable cleanup
  delete IndexedDB databases by name
  assume live writers have already stopped
```

That is why `destroy()` and `clearLocalData()` are separate calls. Destroying a Y.Doc should not imply deleting local drafts. But when the product decision is "this identity cannot keep this local workspace," the safe sequence is still destroy first, clear second.

The [upstream docs](https://docs.yjs.dev/ecosystem/database-provider/y-indexeddb) say the same thing in API form: `destroy()` closes the provider and stops syncing, and `clearData()` destroys the database and removes the stored document. The [implementation](https://github.com/yjs/y-indexeddb/blob/master/src/y-indexeddb.js) shows the missing piece: `clearData()` calls `destroy()` itself and then deletes by database name.

Once you see that, the order stops feeling risky. The Y.Doc does not need to be alive for IndexedDB deletion. The live providers are the thing you want gone before deletion starts.
