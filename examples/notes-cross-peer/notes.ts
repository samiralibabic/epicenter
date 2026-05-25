/**
 * Shared workspace shape for the two-peer cross-peer sync repro.
 *
 * Each peer's `daemon.ts` calls `openNotes(ctx-derived-args)` so both peers
 * agree on the workspace id, the table schema, and the action set; the only
 * thing that differs between peers is the `deviceId` (the daemon ctx
 * default is `${route}-daemon`, but cross-peer sync requires distinct
 * deviceIds for the same workspace, so each peer hard-codes its own).
 */

import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import type { OwnerId } from '@epicenter/constants/identity';
import {
	attachTables,
	column,
	defineMutation,
	defineQuery,
	defineTable,
	type OnReconnectSignal,
	type OpenWebSocketFn,
	openCollaboration,
	roomWsUrl,
} from '@epicenter/workspace';
import Type from 'typebox';
import * as Y from 'yjs';

const WORKSPACE_ID = 'epicenter.notes-repro';

const Note = defineTable({
	id: column.string(),
	body: column.string(),
});

export function openNotes({
	deviceId,
	ownerId,
	openWebSocket,
	onReconnectSignal,
}: {
	deviceId: string;
	ownerId: OwnerId;
	openWebSocket: OpenWebSocketFn;
	onReconnectSignal: OnReconnectSignal;
}) {
	const ydoc = new Y.Doc({ guid: WORKSPACE_ID });
	const tables = attachTables(ydoc, { notes: Note });

	const actions = {
		notes: {
			list: defineQuery({
				description: 'List all notes',
				handler: () => tables.notes.getAllValid(),
			}),
			add: defineMutation({
				description: 'Add a note',
				input: Type.Object({ body: Type.String() }),
				handler: ({ body }) =>
					tables.notes.set({ id: crypto.randomUUID(), body }),
			}),
		},
	};

	const collaboration = openCollaboration(ydoc, {
		url: roomWsUrl({
			baseURL: EPICENTER_API_URL,
			ownerId,
			guid: ydoc.guid,
			deviceId,
		}),
		openWebSocket,
		onReconnectSignal,
		actions,
	});

	return {
		workspaceId: ydoc.guid,
		actions,
		collaboration,
		whenReady: collaboration.whenConnected,
		async [Symbol.asyncDispose]() {
			ydoc.destroy();
			await collaboration.whenDisposed;
		},
	};
}
