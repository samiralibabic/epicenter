# Epicenter Yjs GC Sync Room Decision

**TL;DR**: Use `gc: true` for the default Epicenter sync room. Keep one sync engine. Add `gc: false` only for an explicit version-history feature where users can browse or restore historical states.

> `gc: false` is not a storage optimization. It is a promise to keep deleted content around because history itself is the feature.

Epicenter used to have two sync room shapes:

```txt
WorkspaceRoom
  gc: true
  structured workspace state
  tables, KV, settings, app metadata

DocumentRoom
  gc: false
  document content
  snapshot RPCs
  version-history potential
```

That looked clean on paper. Workspaces were compact. Documents could eventually support version snapshots. The problem is that the distinction only matters if the product actually exposes document version history. Without that feature, `DocumentRoom` is mostly the same room with a more expensive GC setting and a few snapshot RPCs waiting for a use case.

## One Sentence Summaries

`gc: true`: keep the current collaborative document small by letting Yjs discard deleted content that no longer matters.

`gc: false`: keep deleted content forever so Yjs snapshots can reconstruct older document states.

Full binary checkpoint: save the whole current Yjs state as a self-contained restore point.

Yjs snapshot: save a tiny marker that only works if the origin document still retains the operation history it points into.

Epicenter default: one sync room, `gc: true`, full binary checkpoints only when restore points are needed.

Epicenter exception: `gc: false` only for content that has a named version-history surface.

## The Real Choice

There are two different jobs hiding behind the word "snapshot."

```txt
Full checkpoint:
  each version is bigger
  each version stands alone
  live doc stays small
  old deleted content is not retained unless captured in that checkpoint

Yjs snapshot:
  each version marker is tiny
  the live/origin doc grows forever
  all deleted content must stay around
  restores can reconstruct exact historical states
```

Those are not two implementations of the same feature. They are different promises.

A full checkpoint says: "I can restore the document to this saved state." It does not promise that every edit between checkpoints is available. It works with `gc: true`, so the live document can keep compacting tombstones and deleted content.

A Yjs snapshot says: "I can reconstruct this exact historical state from the origin document's retained history." That only works if the origin document was created with `gc: false`. The snapshot marker is tiny because the content is not inside the snapshot. The content lives in the ever-growing origin document.

## Why `gc: false` Costs More

Yjs garbage collection controls whether deleted structs can be compacted. With `gc: true`, deleted content can collapse into lightweight GC structs. With `gc: false`, Yjs preserves the deleted content because a future snapshot might need it.

That tradeoff is reasonable when users can actually use the history. It is waste when they cannot.

```typescript
const compactDoc = new Y.Doc({ gc: true });
const checkpoint = Y.encodeStateAsUpdate(compactDoc);

const historyDoc = new Y.Doc({ gc: false });
const snapshot = Y.snapshot(historyDoc);
const restored = Y.createDocFromSnapshot(historyDoc, snapshot);
```

The checkpoint is larger than the snapshot marker, but it is self-contained. The snapshot marker is small, but it depends on the origin document retaining all the old content.

## Endpoint Distinction Is Not Room Distinction

It can still make sense to keep both endpoint families:

```txt
/workspaces/:id
  app state, tables, KV, settings, metadata

/documents/:id
  user-created content, files, notes, rich text, code
```

That is a product distinction. It does not require two sync engines.

The sync engine can stay boring:

```txt
attachSync(doc, { url })
  -> opens the URL
  -> authenticates through auth.openWebSocket
  -> exchanges Yjs updates
  -> persists the room
```

`attachSync` should not make callers choose "workspace sync" versus "document sync" unless the wire protocol changes. The URL names the resource. The server decides storage policy.

## The Epicenter Rule

Default every room to `gc: true`.

Use full binary checkpoints when the product needs coarse restore points:

```typescript
function createCheckpoint(doc: Y.Doc): Uint8Array {
	return Y.encodeStateAsUpdate(doc);
}

function restoreCheckpoint(checkpoint: Uint8Array): Y.Doc {
	const doc = new Y.Doc({ gc: true });
	Y.applyUpdate(doc, checkpoint);
	return doc;
}
```

Use `gc: false` only when all of these are true:

```txt
The resource is user-authored content.
The UI exposes version history, historical preview, or restore.
The team accepts that the live document grows with edit history.
The retention policy is named.
The storage and sync costs are measured.
```

If those conditions are not true, `gc: false` is premature.

## What We Should Collapse

Collapse duplicate room implementations:

```txt
Before:
  WorkspaceRoom extends BaseSyncRoom with gc: true
  DocumentRoom extends BaseSyncRoom with gc: false and snapshot RPCs

After:
  SyncRoom extends BaseSyncRoom with gc: true
  /workspaces/:id and /documents/:id both route to the same sync behavior
```

Keep endpoint names if they describe different resources. Remove separate GC behavior until a resource opts into history.

The future version-history path can be explicit:

```txt
/documents/:id
  normal collaborative document
  gc: true

/documents/:id/history
  only available for documents created with history enabled
  backed by gc: false or by retained binary checkpoints
```

That keeps the default system simple and leaves room for real history later.

## Decision

For Epicenter now: use `gc: true` everywhere in the server sync room. Remove snapshot RPCs unless a shipped feature calls them. Keep `/workspaces` and `/documents` only as product-level resource namespaces.

For Epicenter later: add history as an opt-in resource policy, not as a second default sync path.

The clean sentence:

```txt
One sync engine, many resource URLs, history only when history is the product.
```
