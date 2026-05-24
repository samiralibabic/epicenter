/**
 * Peer-B daemon for the cross-peer sync repro. Uses a hard-coded
 * `installationId` so peer-B is distinguishable from peer-A in the same
 * workspace.
 */

import { defineWorkspace } from '@epicenter/workspace';
import { openNotes } from '../../../notes';

export default defineWorkspace({
	open: ({ owner, openWebSocket, onReconnectSignal }) =>
		openNotes({
			installationId: 'notes-repro-peer-b',
			owner,
			openWebSocket,
			onReconnectSignal,
		}),
});
