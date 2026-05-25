# Fuji

Fuji is a local-first CMS where every entry's body is its own CRDT. Write offline, sync later, and collaborate on a single entry without touching the rest of your content. Think of it as a structured journal, knowledge base, or portfolio, whatever you tag and type your entries as.

Part of the [Epicenter](https://github.com/EpicenterHQ/epicenter) monorepo. MIT licensed.

---

## How it works

### Layout

SvelteKit app (static adapter, SSR disabled) with three panels: a sidebar for filtering by type, tags, and search; a main area that toggles between table and timeline views; and an editor panel for rich-text content.

### Data model

Workspace ID: `FUJI_ID` (`epicenter.fuji`). Rich-text content and entry metadata are separate CRDTs. The entries table stays lean: just IDs, titles, tags, timestamps. Each entry's body lives in its own Y.Doc opened by a `createDisposableCache` keyed on the entry id; the child document builder owns the storage guid. Loading a list of 500 entries doesn't mean loading 500 rich-text trees; the editor and the list never contend for the same document.

- `entries` table: `id` (EntryId), `title`, `subtitle`, `type` (string[]), `tags` (string[]), `createdAt`, `updatedAt`, `_v`. Each entry's body is opened on demand from a disposable cache and bound to ProseMirror via `y-prosemirror`.
- KV keys: `selectedEntryId`, `viewMode` (`'table' | 'timeline'`), `sidebarCollapsed`.

### Client wiring

Fuji's root workspace is built once per signed-in session by `createSession`. `openFujiBrowser()` owns the `new Y.Doc(...)` call, composes every Tier 1 primitive inline, and returns the bundle directly. The session module receives a `SignedIn` from `createSession` and passes it into the browser factory. `SignedIn` carries `{ server, owner, keyring, auth }`; `attachEncryption` reads the keyring, `attachLocalStorage` reads the server + owner (for the IDB database name) and the keyring, and `openCollaboration` takes `auth.openWebSocket` and `auth.onStateChange` directly so it can open sockets and reconnect without per-app glue.

```ts
import { openFujiBrowser } from '$lib/browser';
import { createSession } from '@epicenter/svelte';
import { createDeviceId } from '@epicenter/workspace';
import { auth } from '$lib/auth';

export const session = createSession({
  auth,
  build: (signedIn) =>
    openFujiBrowser({
      signedIn,
      deviceId: createDeviceId({ storage: localStorage }),
    }),
});
```

Inside `openFujiBrowser`, the composition is fully visible top-to-bottom:

```ts
export function openFujiBrowser({
  signedIn,
  deviceId,
}: {
  signedIn: SignedIn;
  deviceId: string;
}) {
  const ydoc = new Y.Doc({ guid: FUJI_ID, gc: true });
  const encryption = attachEncryption(ydoc, { keyring: signedIn.keyring });
  const tables = encryption.attachTables(fujiTables);
  const kv = encryption.attachKv({});
  const actions = createFujiActions(tables);

  const idb = attachLocalStorage(ydoc, {
    server: signedIn.server,
    owner: signedIn.owner,
    keyring: signedIn.keyring,
  });
  const collaboration = openCollaboration(ydoc, {
    url: roomWsUrl({
      baseURL: signedIn.auth.baseURL,
      owner: signedIn.owner,
      guid: ydoc.guid,
      deviceId,
    }),
    openWebSocket: signedIn.auth.openWebSocket,
    onReconnectSignal: signedIn.auth.onStateChange,
    waitFor: idb.whenLoaded,
    actions,
  });
  // ... per-entry child docs, wipe(), dispose
  return { ydoc, tables, kv, actions, idb, collaboration, /* ... */ };
}
```

The browser bundle exposes concrete resources like `idb`, `collaboration`, and child document collections. Auth state flows through `session.current`; when present, it carries the Fuji bundle, and pages reach it via the module-level `requireFuji()` exported from `$lib/session` (throws if called without an authenticated session). Local cleanup runs through `bundle.wipe()`, which destroys the live Y.Docs and then calls `wipeLocalStorage({ server: signedIn.server, owner: signedIn.owner })` to drop every encrypted IDB database for that owner. It is a separate explicit action, not part of sign-out.

For a sibling example of the same pattern (plus a Tauri-side materializer), see `apps/whispering/src/lib/whispering/client.ts`.

### Editor

ProseMirror with `y-prosemirror` binds directly to the entry's `Y.Text`. Edits are conflict-free by default; two sessions editing the same entry merge automatically.

### Keyboard shortcuts

- `Cmd+N`: new entry
- `Escape`: deselect current entry

---

## Development

Prerequisites: [Bun](https://bun.sh).

```bash
git clone https://github.com/EpicenterHQ/epicenter.git
cd epicenter
bun install
cd apps/fuji
bun dev
```

This starts the app dev server on port 5174. Auth and sync expect the local API on `localhost:8787`; start it from the repo root with `bun run dev:api`.

Fuji's daemon route is registered from the project root. It is not discovered from `.epicenter/` or the `workspaces/` folder. A project that wants the Fuji route needs an `epicenter.config.ts` like this:

```ts
import { defineConfig } from '@epicenter/workspace';
import fuji from './workspaces/fuji/daemon.ts';

export default defineConfig({
	daemon: {
		routes: {
			fuji,
		},
	},
});
```

The `fuji` key is the route identity. The imported daemon module defines Fuji's runtime and can live anywhere; `workspaces/fuji/daemon.ts` is just the layout used in this example.

`epicenter daemon up -C <project>` starts every route in `daemon.routes` inside one daemon process. It creates `.epicenter/` for generated project data when it is missing, but sockets and daemon logs live in platform user paths instead of inside the project.

---

## Tech stack

- [SvelteKit](https://kit.svelte.dev): UI framework (static adapter, SSR disabled)
- [ProseMirror](https://prosemirror.net) + [y-prosemirror](https://github.com/yjs/y-prosemirror): collaborative rich-text editing
- [TanStack Svelte Table](https://tanstack.com/table): entry list table view
- [Yjs](https://yjs.dev): CRDT engine
- [Tailwind CSS](https://tailwindcss.com): styling
- `@epicenter/workspace`: CRDT-backed tables, versioning, documents
- `@epicenter/auth-svelte`: Svelte 5 wrapper around `@epicenter/auth`
- `@epicenter/svelte`: workspace gate and reactive table/KV bindings
- `@epicenter/ui`: shadcn-svelte component library

---

## License

MIT
