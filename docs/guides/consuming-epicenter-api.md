# Consuming the Epicenter API

> **Historical note.** Earlier drafts of this guide described a
> `createWorkspace(definition).withEncryption().withExtension(...)` builder
> chain, and later an owner factory that wrapped the encryption, local
> storage, and per-subject wipe paths behind a single object. Both shapes
> are gone. There is one pattern today: a per-app browser opener that calls
> every `attach*` primitive inline against a `Y.Doc`, plus
> `openCollaboration` for sync, server-owned presence, and HTTP dispatch.
>
> Rather than maintain two versions of the same narrative, this guide also
> points at the canonical sources:
>
> - **Quick Start**: [`packages/workspace/README.md`](../../packages/workspace/README.md)
> - **Multi-device sync**: [`packages/workspace/SYNC_ARCHITECTURE.md`](../../packages/workspace/SYNC_ARCHITECTURE.md)
> - **Production wiring**: `apps/fuji/src/lib/browser.ts` (inline composition with per-row child docs), `apps/fuji/src/lib/session.ts` (session glue), `apps/tab-manager/src/lib/session.svelte.ts` (browser extension auth binding)

## Overview

The hosted hub at `https://api.epicenter.so` handles auth, real-time sync, AI inference, and encryption key derivation. It runs on Cloudflare Workers with Durable Objects. Cloud sync enters through `/api/users/:userId/rooms/:roomId` (personal) or `/api/rooms/:roomId` (team): a cloud doc is owned by the authenticated `owner` and addressed by its `ydoc.guid`, and the server resolves the room from the auth token. Browser apps and the workspace daemon both use this route.

On the client, `@epicenter/workspace` exposes the primitives directly: define your schema with `defineTable` / `defineKv`, build a `Y.Doc`, then call `attachEncryption`, `attachLocalStorage`, and `openCollaboration` inline. Authenticate with `@epicenter/auth` and gate the workspace lifecycle on signed-in identity with `createSession` from `@epicenter/svelte`.

## Minimal cloud workspace shape

This snippet shows a signed-in cloud workspace. The client builds the sync URL with `roomWsUrl({ baseURL, owner, guid, installationId })`; the server resolves the room from the auth token, so the client never names a workspaceId.

The per-app browser opener is the single source of truth for "how this app mounts in a browser." Every `attach*` call is visible top-to-bottom, with no factory hiding the order.

```typescript
import {
	attachEncryption,
	attachLocalStorage,
	createInstallationId,
	defineTable,
	openCollaboration,
	roomWsUrl,
	wipeLocalStorage,
} from '@epicenter/workspace';
import { createSession, type InferSignedIn, type SignedIn } from '@epicenter/svelte';
import * as Y from 'yjs';
import { type } from 'arktype';
import { auth } from './auth';

const MY_APP_ID = 'epicenter.my-app';

const myAppTables = {
	notes: defineTable(
		type({
			id: 'string',
			title: 'string',
			_v: '1',
		}),
	),
};

export function openMyAppBrowser({
	signedIn,
	installationId,
}: {
	signedIn: SignedIn;
	installationId: string;
}) {
	const ydoc = new Y.Doc({ guid: MY_APP_ID, gc: true });
	const encryption = attachEncryption(ydoc, { keyring: signedIn.keyring });
	const tables = encryption.attachTables(myAppTables);
	const kv = encryption.attachKv({});
	const actions = {
		notes_create: async ({ id, title }: { id: string; title: string }) => {
			tables.notes.create({ id, title, _v: 1 });
		},
	};

	const idb = attachLocalStorage(ydoc, {
		server: signedIn.auth.baseURL,
		owner: signedIn.owner,
		keyring: signedIn.keyring,
	});
	const collab = openCollaboration(ydoc, {
		url: roomWsUrl({
			baseURL: signedIn.auth.baseURL,
			owner: signedIn.owner,
			guid: ydoc.guid,
			installationId,
		}),
		openWebSocket: signedIn.auth.openWebSocket,
		onReconnectSignal: signedIn.auth.onStateChange,
		waitFor: idb.whenLoaded,
		actions,
	});

	return {
		ydoc,
		tables,
		kv,
		actions,
		idb,
		collab,
		async wipe() {
			ydoc.destroy();
			await Promise.all([idb.whenDisposed, collab.whenDisposed]);
			await wipeLocalStorage({
				server: signedIn.auth.baseURL,
				owner: signedIn.owner,
			});
		},
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
}

export const session = createSession({
	auth,
	build: (signedIn) => {
		const workspace = openMyAppBrowser({
			signedIn,
			installationId: createInstallationId({ storage: localStorage }),
		});
		return {
			...workspace,
			[Symbol.dispose]() {
				workspace[Symbol.dispose]();
			},
		};
	},
});

export type MyAppSignedIn = InferSignedIn<typeof session>;
```

The `ydoc.guid` is both the local IndexedDB key and the cloud room id. Namespace it to your app, for example `epicenter.my-app`, to avoid collisions when multiple apps share the same IndexedDB origin. The cloud sync route is `/api/users/:userId/rooms/:roomId` (personal) or `/api/rooms/:roomId` (team), taking the room id straight from `ydoc.guid`; the server resolves the DO name `users/${userId}/rooms/${room}` (personal) or `rooms/${room}` (team) from the auth token, with no workspace lookup.

`createSession({ auth, build })` reconciles `auth.state` against the live workspace and hands `build` a `SignedIn` value shaped `{ server, owner, keyring, auth }`. `attachEncryption` reads `keyring` to derive per-table keys; `attachLocalStorage` reads `server` and `owner` to namespace the IndexedDB database under the owner prefix; `openCollaboration` uses `auth.openWebSocket` to attach the bearer token at connection time and `auth.onStateChange` to react to auth changes. Sign-out disposes the workspace, and a same-owner identity refresh keeps the workspace mounted. A different owner from `/api/session` is rejected by auth before the workspace is reused.

`wipeLocalStorage({ server, owner })` is a free function that enumerates `indexedDB.databases()` and deletes every database under the owner's prefix. There is no per-app wipe helper to register; the prefix scan catches every encrypted IDB database the owner created on this profile, including per-row child docs.
