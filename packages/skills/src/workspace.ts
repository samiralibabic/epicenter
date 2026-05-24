import { attachKv, attachTables } from '@epicenter/workspace';
import * as Y from 'yjs';
import { SKILLS_WORKSPACE_ID } from './constants.js';
import { referencesTable, skillsTable } from './tables.js';

export type OpenSkillsOptions = {
	workspaceId?: string;
	clientID?: number;
};

export function openSkills({
	workspaceId = SKILLS_WORKSPACE_ID,
	clientID,
}: OpenSkillsOptions = {}) {
	const ydoc = new Y.Doc({ guid: workspaceId, gc: true });
	if (clientID !== undefined) ydoc.clientID = clientID;

	const tables = attachTables(ydoc, {
		skills: skillsTable,
		references: referencesTable,
	});
	const kv = attachKv(ydoc, {});

	return {
		get id() {
			return ydoc.guid;
		},
		ydoc,
		tables,
		kv,
		batch: (fn: () => void) => ydoc.transact(fn),
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
}
