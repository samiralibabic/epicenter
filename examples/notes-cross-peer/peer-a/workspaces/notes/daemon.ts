/**
 * Peer-A daemon for the cross-peer sync repro. Uses a hard-coded `installationId`
 * so peer-A is distinguishable from peer-B in the same workspace.
 */

import { defineDaemonWorkspace } from '@epicenter/workspace/daemon';
import { openNotes } from '../../../notes';

export default defineDaemonWorkspace({
	open: ({ openWebSocket }) =>
		openNotes({
			installationId: 'notes-repro-peer-a',
			openWebSocket,
		}),
});
