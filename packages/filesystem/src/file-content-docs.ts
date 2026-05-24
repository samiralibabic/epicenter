import { docGuid } from '@epicenter/workspace';
import type { FileId } from './ids.js';

export function fileContentDocGuid({
	workspaceId,
	fileId,
}: {
	workspaceId: string;
	fileId: FileId;
}): string {
	return docGuid({
		workspaceId,
		collection: 'files',
		rowId: fileId,
		field: 'content',
	});
}
