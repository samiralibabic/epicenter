# YJS Persistence Guide

> **Historical note.** This guide used to describe a "provider pattern"
> (`setupPersistence`, `@epicenter/workspace/providers/*`, `text()` / `ytext()`
> column builders) that no longer exists in this codebase.
>
> Persistence today is an *attachment*, not a provider. You call
> `attachIndexedDb(ydoc)` in the browser or `attachYjsLog(ydoc, { filePath })`
> on Node/Bun, both inside a `defineDocument(builder)` closure. See
> [`packages/workspace/README.md`](../../packages/workspace/README.md) for the
> Quick Start and [`packages/workspace/SYNC_ARCHITECTURE.md`](../../packages/workspace/SYNC_ARCHITECTURE.md)
> for multi-device sync.

## What is YJS?

YJS is a **CRDT (Conflict-free Replicated Data Type)** library. In Epicenter, YJS is the source of truth for app data. A Cloud Workspace is a product account container; a synced `Y.Doc` is a Sync Doc inside an app namespace. Tables, KV entries, and document content are typed helpers layered over YJS shared types.

## Current sync model

The example below uses cloud sync: the client builds the URL with `roomWsUrl({ baseURL, owner, guid, installationId })` and the server resolves the room from the auth token.

Each app composes its workspace in a single builder:

```typescript
import {
	attachIndexedDb,
	attachTables,
	defineDocument,
	openCollaboration,
	roomWsUrl,
} from '@epicenter/workspace';
import * as Y from 'yjs';

const app = defineDocument((id: string) => {
	const ydoc = new Y.Doc({ guid: id });
	const tables = attachTables(ydoc, appTables);
	const idb = attachIndexedDb(ydoc);                          // local persistence
	const collaboration = openCollaboration(ydoc, {              // sync + presence + dispatch
		url: roomWsUrl({ baseURL: auth.baseURL, owner, guid: ydoc.guid, installationId }),
		openWebSocket: auth.openWebSocket,
		onReconnectSignal: auth.onStateChange,
		waitFor: idb.whenLoaded,                                   // delta-only on reconnect
		actions: {},
	});

	return {
		id,
		ydoc,
		tables,
		idb,
		collaboration,
		[Symbol.dispose]() { ydoc.destroy(); },
	};
});

export const workspace = app.open('epicenter.myapp');
```

Offline and sync behavior:

1. Writes go through the typed helpers into the `Y.Doc`.
2. `attachIndexedDb` (or `attachYjsLog`) mirrors the Y.Doc to local storage.
3. `openCollaboration` waits for `idb.whenLoaded` before opening the WebSocket, so the first remote exchange is a CRDT delta against an already-populated local state, not a full document transfer.
4. When offline, writes accumulate in IndexedDB/SQLite; when back online, Yjs replays them against whatever peers did in the meantime. CRDT merge rules guarantee convergence.

For content documents that only need bytes-on-the-wire, use `openCollaboration` with `actions: {}`. Inbound dispatch frames reply `ActionNotFound`; the byte transport and presence channel are identical.

For the server side that accepts these connections, see the `apps/api/` hub: a Hono app on Cloudflare Workers with Durable Objects. Its [README](../../apps/api/README.md) covers the route family and trust model.
