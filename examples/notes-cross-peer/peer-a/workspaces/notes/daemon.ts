/**
 * Peer-A daemon for the cross-peer sync repro. Uses a hard-coded
 * `deviceId` so peer-A is distinguishable from peer-B in the same
 * workspace.
 */

import { defineWorkspace } from '@epicenter/workspace';
import { openNotes } from '../../../notes';

export default defineWorkspace({
	open: ({ ownerId, openWebSocket, onReconnectSignal }) =>
		openNotes({
			deviceId: 'notes-repro-peer-a',
			ownerId,
			openWebSocket,
			onReconnectSignal,
		}),
});
