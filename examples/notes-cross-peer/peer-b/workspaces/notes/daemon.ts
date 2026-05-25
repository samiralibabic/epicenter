/**
 * Peer-B daemon for the cross-peer sync repro. Uses a hard-coded
 * `deviceId` so peer-B is distinguishable from peer-A in the same
 * workspace.
 */

import { defineWorkspace } from '@epicenter/workspace';
import { openNotes } from '../../../notes';

export default defineWorkspace({
	open: ({ ownerId, openWebSocket, onReconnectSignal }) =>
		openNotes({
			deviceId: 'notes-repro-peer-b',
			ownerId,
			openWebSocket,
			onReconnectSignal,
		}),
});
