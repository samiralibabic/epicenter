import { docGuid } from '@epicenter/workspace';

export function skillInstructionsDocGuid({
	workspaceId,
	skillId,
}: {
	workspaceId: string;
	skillId: string;
}): string {
	return docGuid({
		workspaceId,
		collection: 'skills',
		rowId: skillId,
		field: 'instructions',
	});
}
