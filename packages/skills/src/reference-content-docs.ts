import { docGuid } from '@epicenter/workspace';

export function referenceContentDocGuid({
	workspaceId,
	referenceId,
}: {
	workspaceId: string;
	referenceId: string;
}): string {
	return docGuid({
		workspaceId,
		collection: 'references',
		rowId: referenceId,
		field: 'content',
	});
}
