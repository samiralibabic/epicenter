import { relations } from 'drizzle-orm';
import { bigint, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { user } from './auth';

export const durableObjectInstance = pgTable(
	'durable_object_instance',
	{
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		resourceName: text('resource_name').notNull(),
		doName: text('do_name').primaryKey(),
		storageBytes: bigint('storage_bytes', { mode: 'number' }),
		createdAt: timestamp('created_at').defaultNow().notNull(),
		lastAccessedAt: timestamp('last_accessed_at').defaultNow().notNull(),
		storageMeasuredAt: timestamp('storage_measured_at'),
	},
	(table) => [index('doi_user_id_idx').on(table.userId)],
);

export const asset = pgTable(
	'asset',
	{
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		contentType: text('content_type').notNull(),
		sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
		originalName: text('original_name').notNull(),
		uploadedAt: timestamp('uploaded_at').defaultNow().notNull(),
	},
	(table) => [index('asset_user_id_idx').on(table.userId)],
);

export const userAppRelations = relations(user, ({ many }) => ({
	durableObjectInstances: many(durableObjectInstance),
	assets: many(asset),
}));

export const durableObjectInstanceRelations = relations(
	durableObjectInstance,
	({ one }) => ({
		user: one(user, {
			fields: [durableObjectInstance.userId],
			references: [user.id],
		}),
	}),
);

export const assetRelations = relations(asset, ({ one }) => ({
	user: one(user, {
		fields: [asset.userId],
		references: [user.id],
	}),
}));
