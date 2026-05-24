/**
 * Compose a content-doc `Y.Doc` GUID in the canonical 4-part dotted form:
 *
 *   `${workspaceId}.${collection}.${rowId}.${field}`
 *
 * | Segment       | Owner           | Example             |
 * |---------------|-----------------|---------------------|
 * | `workspaceId` | caller          | `epicenter-fuji`    |
 * | `collection`  | package/app     | `entries`, `files`  |
 * | `rowId`       | caller          | `entry_01H…`        |
 * | `field`       | package/app     | `content`, `body`   |
 *
 * Using this helper (instead of inline template literals) enforces the shape
 * at compile time and leaves one place to evolve if the convention changes.
 */
export const docGuid = ({
	workspaceId,
	collection,
	rowId,
	field,
}: {
	workspaceId: string;
	collection: string;
	rowId: string;
	field: string;
}) => `${workspaceId}.${collection}.${rowId}.${field}`;
