import { bigint, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Per-row partition key. Equals the signed-in user's id in personal mode and
 * the literal `TEAM_OWNER_ID` (`'team'`) in team mode. No foreign key to
 * `user.id`: in team mode `owner_id` is not a user, so the FK would fail.
 * Account-delete cleanup runs in the auth `before(delete)` hook and naturally
 * no-ops in team mode (`owner_id !== user.id`).
 */
export const durableObjectInstance = pgTable(
	'durable_object_instance',
	{
		ownerId: text('owner_id').notNull(),
		resourceName: text('resource_name').notNull(),
		doName: text('do_name').primaryKey(),
		storageBytes: bigint('storage_bytes', { mode: 'number' }),
		createdAt: timestamp('created_at').defaultNow().notNull(),
		lastAccessedAt: timestamp('last_accessed_at').defaultNow().notNull(),
		storageMeasuredAt: timestamp('storage_measured_at'),
	},
	(table) => [index('doi_owner_id_idx').on(table.ownerId)],
);

export const asset = pgTable(
	'asset',
	{
		id: text('id').primaryKey(),
		ownerId: text('owner_id').notNull(),
		contentType: text('content_type').notNull(),
		sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
		originalName: text('original_name').notNull(),
		/**
		 * Visibility flag. `'private'` requires the read handler to verify
		 * an authenticated session and that the actor matches the owner;
		 * `'public'` lets anyone with the URL fetch the bytes. Flipping
		 * this is the publish / unpublish primitive. The R2 object is
		 * never duplicated; the flag IS the visibility decision.
		 */
		visibility: text('visibility', { enum: ['private', 'public'] })
			.notNull()
			.default('private'),
		uploadedAt: timestamp('uploaded_at').defaultNow().notNull(),
	},
	(table) => [
		index('asset_owner_id_idx').on(table.ownerId),
		index('asset_visibility_idx').on(table.visibility),
	],
);
