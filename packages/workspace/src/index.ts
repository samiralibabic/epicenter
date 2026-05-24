/**
 * Epicenter: YJS-First Collaborative Workspace System
 *
 * `@epicenter/workspace` attaches typed primitives: tables, KV, plain/rich
 * text, timeline, and an action registry to a `Y.Doc`, then wires the
 * result to IndexedDB persistence, end-to-end encryption, and WebSocket
 * sync via `openCollaboration`. `openCollaboration` also consumes the
 * server-owned presence channel and exposes the live-device surface
 * (`devices.list()`) plus socket-backed `dispatch()` for cross-device calls.
 *
 * @example
 * ```typescript
 * import {
 *   attachIndexedDb,
 *   attachRichText,
 *   attachTables,
 *   createDisposableCache,
 *   createInstallationId,
 *   defineTable,
 *   docGuid,
 *   openCollaboration,
 *   roomWsUrl,
 * } from '@epicenter/workspace';
 * import type { AuthClient } from '@epicenter/auth';
 * import { type } from 'arktype';
 * import * as Y from 'yjs';
 *
 * const posts = defineTable(type({ id: 'string', title: 'string', _v: '1' }));
 * declare const auth: AuthClient;
 *
 * const apiUrl = 'https://api.example.com';
 * const installationId = createInstallationId({ storage: localStorage });
 *
 * // A cloud doc is owned by the authenticated subject and addressed by its
 * // Y.Doc guid: `roomWsUrl(apiUrl, ydoc.guid)` resolves to the room
 * // `subject:${userId}:rooms:${ydoc.guid}` server-side.
 * const ydoc = new Y.Doc({ guid: 'notes' });
 * const tables = attachTables(ydoc, { posts });
 * const idb = attachIndexedDb(ydoc);
 * const collaboration = openCollaboration(ydoc, {
 *   url: roomWsUrl(apiUrl, ydoc.guid),
 *   openWebSocket: auth.openWebSocket,
 *   waitFor: idb.whenLoaded,
 *   installationId,
 *   actions: {},
 * });
 *
 * // Content docs build the same URL from their own guid. The local Y.Doc
 * // guid doubles as the cloud room id, so there is no second id system.
 * const noteBodyDocs = createDisposableCache(
 *   (noteId: string) => {
 *     const bodyYdoc = new Y.Doc({
 *       guid: docGuid({
 *         workspaceId: ydoc.guid,
 *         collection: 'posts',
 *         rowId: noteId,
 *         field: 'body',
 *       }),
 *       gc: true,
 *     });
 *     const bodyIdb = attachIndexedDb(bodyYdoc);
 *     const bodySync = openCollaboration(bodyYdoc, {
 *       url: roomWsUrl(apiUrl, bodyYdoc.guid),
 *       openWebSocket: auth.openWebSocket,
 *       waitFor: bodyIdb.whenLoaded,
 *       installationId,
 *       actions: {},
 *     });
 *     return {
 *       ydoc: bodyYdoc,
 *       body: attachRichText(bodyYdoc),
 *       idb: bodyIdb,
 *       sync: bodySync,
 *       [Symbol.dispose]() {
 *         bodyYdoc.destroy();
 *       },
 *     };
 *   },
 *   { gcTime: 5_000 },
 * );
 * ```
 *
 * @packageDocumentation
 */

// ════════════════════════════════════════════════════════════════════════════
// ACTION SYSTEM
// ════════════════════════════════════════════════════════════════════════════

export type { Action, ActionManifest } from './shared/actions';
export {
	defineActions,
	defineMutation,
	defineQuery,
} from './shared/actions';

// ════════════════════════════════════════════════════════════════════════════
// INSTALLATION IDENTITY
// ════════════════════════════════════════════════════════════════════════════

export {
	createInstallationId,
	createInstallationIdAsync,
} from './document/installation-id.js';

// ════════════════════════════════════════════════════════════════════════════
// PROJECT CONFIG (browser-safe surface)
// ════════════════════════════════════════════════════════════════════════════

// Node-only helpers that resolve real paths (`findProjectRoot`,
// `loadProjectConfig`, etc.) import `node:fs`, `node:path`, or `node:os`
// at module top level. They are exported from `@epicenter/workspace/node`;
// keeping them out of this root barrel stops browser bundles (fuji,
// whispering, etc.) from traversing `node:*` modules. Platform paths
// (data, log, cache, config, runtime) live in `@epicenter/constants/node`
// behind `createEpicenterEnv`.
export {
	DEFAULT_PROJECT_CONFIG_SOURCE,
	defineConfig,
	defineWorkspace,
	type EpicenterConfig,
	PROJECT_CONFIG_FILENAME,
} from './config/define-config.js';
export type { ProjectDir } from './shared/types';

// ════════════════════════════════════════════════════════════════════════════
// ID + DATE PRIMITIVES
// ════════════════════════════════════════════════════════════════════════════

export { DateTimeString } from './shared/datetime-string';
export type { Guid, Id } from './shared/id';
export { generateGuid, generateId } from './shared/id';

// ════════════════════════════════════════════════════════════════════════════
// DOCUMENT PRIMITIVES
// ════════════════════════════════════════════════════════════════════════════

export {
	createDisposableCache,
	type DisposableCache,
} from './cache/disposable-cache.js';

export { attachBroadcastChannel } from './document/attach-broadcast-channel.js';
export { attachEncryption } from './document/attach-encryption.js';
export { attachIndexedDb } from './document/attach-indexed-db.js';
export {
	attachKv,
	type InferKvValue,
	type Kv,
	type KvDefinitions,
} from './document/attach-kv.js';
export { attachPlainText } from './document/attach-plain-text.js';
export { attachRichText } from './document/attach-rich-text.js';
export {
	attachTable,
	attachTables,
	type BaseRow,
	type InferTableRow,
	type Table,
	type Tables,
} from './document/attach-table.js';
export { attachTimeline } from './document/attach-timeline/index.js';
export { defineKv } from './document/define-kv.js';
export { defineTable } from './document/define-table.js';
export {
	type ActionInput,
	type ActionOutput,
	DispatchError,
	type DispatchRequest,
	type LiveDevice,
	type TypedDispatch,
	typedDispatch,
} from './document/dispatch.js';
export { docGuid } from './document/doc-guid.js';
export type {
	OpenWebSocket,
	SyncStatus,
} from './document/internal/sync-supervisor.js';
export {
	createLocalOwner,
	type LocalOwner,
} from './document/local-owner.js';
export { onLocalUpdate } from './document/on-local-update.js';
export {
	type Collaboration,
	openCollaboration,
} from './document/open-collaboration.js';
// Transport URL builder.
//
// `roomWsUrl(apiUrl, ydoc.guid)` builds the WebSocket URL for `/rooms/:room`.
// A cloud doc is owned by the authenticated subject; the room id is the
// Y.Doc guid and the server resolves it to `subject:${userId}:rooms:${room}`.
// Both browser apps and the daemon use this one builder.
export { roomWsUrl } from './document/transport.js';
