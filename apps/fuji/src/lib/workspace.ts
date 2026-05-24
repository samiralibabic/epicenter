/**
 * Fuji workspace schema: id, branded types, tables, actions, and per-row
 * derived guids. Pure data. No Y.Doc, no encryption, no openers.
 *
 * Distribution: `apps/fuji/package.json` exports this file as the
 * `@epicenter/fuji` package root. Browser code, daemon code, and tests all
 * import from here. The table shapes here are the wire contract for sync;
 * forking a column shape breaks sync compatibility with peers running the
 * canonical schema.
 *
 * Composition lives elsewhere:
 *  - `apps/fuji/src/lib/browser.ts`  → `openFujiBrowser({ signedIn, installationId })`
 *  - `apps/fuji/daemon.ts`           → `openFujiDaemon(ctx)`
 *  - `examples/fuji/epicenter.config.ts` → canonical project layout composition
 */

import {
	DateTimeString,
	defineActions,
	defineMutation,
	defineQuery,
	defineTable,
	docGuid,
	generateId,
	type InferTableRow,
	type Tables,
} from '@epicenter/workspace';
import { type } from 'arktype';
import Type from 'typebox';
import type { Brand } from 'wellcrafted/brand';

export const FUJI_ID = 'epicenter.fuji';

export type EntryId = string & Brand<'EntryId'>;
export const EntryId = type('string').pipe((s): EntryId => s as EntryId);

const entryBase = type({
	id: EntryId,
	title: 'string',
	subtitle: 'string',
	type: 'string[]',
	tags: 'string[]',
	pinned: 'boolean',
	'deletedAt?': DateTimeString.or('undefined'),
	date: DateTimeString,
	createdAt: DateTimeString,
	updatedAt: DateTimeString,
});

const entriesTable = defineTable(
	entryBase.merge({
		_v: '1',
	}),
	entryBase.merge({
		rating: 'number',
		_v: '2',
	}),
).migrate((row) => {
	switch (row._v) {
		case 1:
			return { ...row, rating: 0, _v: 2 };
		case 2:
			return row;
	}
});

export type Entry = InferTableRow<typeof entriesTable>;

export const fujiTables = { entries: entriesTable };
export type FujiTables = Tables<typeof fujiTables>;

/**
 * Deterministic guid of an entry's rich-text content sub-doc.
 *
 * Browser editors, daemon materializers, and wipe paths reach this same
 * function so every layer points at the same Y.Doc identity.
 */
export function entryContentDocGuid(entryId: EntryId): string {
	return docGuid({
		workspaceId: FUJI_ID,
		collection: 'entries',
		rowId: entryId,
		field: 'content',
	});
}

export function createFujiActions(tables: FujiTables) {
	return defineActions({
		entries_get: defineQuery({
			title: 'Get Entry',
			description: 'Read one entry by ID from the daemon workspace.',
			input: Type.Object({
				id: Type.String({ description: 'Entry ID to read' }),
			}),
			handler: ({ id }) => {
				return tables.entries.get(id);
			},
		}),
		entries_get_all_valid: defineQuery({
			title: 'List Valid Entries',
			description: 'Read all valid entries from the daemon workspace.',
			input: Type.Object({}),
			handler: () => {
				return tables.entries.getAllValid();
			},
		}),
		entries_count: defineQuery({
			title: 'Count Entries',
			description: 'Count entries in the daemon workspace.',
			input: Type.Object({}),
			handler: () => {
				return tables.entries.count();
			},
		}),
		entries_has: defineQuery({
			title: 'Has Entry',
			description: 'Check whether an entry exists in the daemon workspace.',
			input: Type.Object({
				id: Type.String({ description: 'Entry ID to check' }),
			}),
			handler: ({ id }) => {
				return tables.entries.has(id);
			},
		}),
		entries_create: defineMutation({
			title: 'Create Entry',
			description:
				'Create a new CMS entry with optional title, subtitle, type, tags, and rating.',
			input: Type.Object({
				title: Type.Optional(Type.String({ description: 'Entry title' })),
				subtitle: Type.Optional(
					Type.String({ description: 'Subtitle for blog listings' }),
				),
				type: Type.Optional(
					Type.Array(Type.String(), {
						description: 'Type classifications',
					}),
				),
				tags: Type.Optional(
					Type.Array(Type.String(), { description: 'Freeform tags' }),
				),
				rating: Type.Optional(
					Type.Number({ description: 'Rating from 0-5 (0 = unrated)' }),
				),
			}),
			handler: ({ title, subtitle, type: entryType, tags, rating }) => {
				const id = generateId<EntryId>();
				const now = DateTimeString.now();
				tables.entries.set({
					id,
					title: title ?? '',
					subtitle: subtitle ?? '',
					type: entryType ?? [],
					tags: tags ?? [],
					pinned: false,
					rating: rating ?? 0,
					deletedAt: undefined,
					date: now,
					createdAt: now,
					updatedAt: now,
					_v: 2 as const,
				});
				return { id };
			},
		}),
		entries_upsert: defineMutation({
			title: 'Upsert Entry',
			description: 'Insert or replace a full entry row.',
			input: Type.Object({
				id: Type.String({ description: 'Entry ID' }),
				title: Type.String({ description: 'Entry title' }),
				subtitle: Type.String({ description: 'Subtitle for blog listings' }),
				type: Type.Array(Type.String(), {
					description: 'Type classifications',
				}),
				tags: Type.Array(Type.String(), { description: 'Freeform tags' }),
				pinned: Type.Boolean({ description: 'Whether the entry is pinned' }),
				rating: Type.Number({ description: 'Rating from 0 to 5' }),
				deletedAt: Type.Optional(
					Type.Unsafe<DateTimeString>({
						type: 'string',
						description: 'Soft deletion timestamp',
					}),
				),
				date: Type.Unsafe<DateTimeString>({
					type: 'string',
					description: 'User-defined date for the entry',
				}),
				createdAt: Type.Unsafe<DateTimeString>({
					type: 'string',
					description: 'Creation timestamp',
				}),
				updatedAt: Type.Unsafe<DateTimeString>({
					type: 'string',
					description: 'Last update timestamp',
				}),
				_v: Type.Literal(2),
			}),
			handler: (row) => {
				const parsed = tables.entries.parse(row.id, row);
				if (parsed.error) throw parsed.error;
				tables.entries.set(parsed.data);
				return { id: parsed.data.id };
			},
		}),
		entries_update: defineMutation({
			title: 'Update Entry',
			description:
				'Update entry metadata fields. Automatically bumps updatedAt.',
			input: Type.Object({
				id: Type.String({ description: 'Entry ID to update' }),
				title: Type.Optional(Type.String({ description: 'Entry title' })),
				subtitle: Type.Optional(
					Type.String({ description: 'Subtitle for blog listings' }),
				),
				type: Type.Optional(
					Type.Array(Type.String(), {
						description: 'Type classifications',
					}),
				),
				tags: Type.Optional(
					Type.Array(Type.String(), { description: 'Freeform tags' }),
				),
				rating: Type.Optional(
					Type.Number({ description: 'Rating from 0-5 (0 = unrated)' }),
				),
				date: Type.Optional(
					Type.Unsafe<DateTimeString>({
						type: 'string',
						description: 'User-defined date for the entry',
					}),
				),
			}),
			handler: ({ id, ...fields }) => {
				return tables.entries.update(id, {
					...fields,
					updatedAt: DateTimeString.now(),
				});
			},
		}),
		entries_delete: defineMutation({
			title: 'Delete Entry',
			description: 'Soft-delete an entry by setting deletedAt to now.',
			input: Type.Object({
				id: Type.String({ description: 'Entry ID to soft-delete' }),
			}),
			handler: ({ id }) => {
				return tables.entries.update(id, {
					deletedAt: DateTimeString.now(),
					updatedAt: DateTimeString.now(),
				});
			},
		}),
		entries_restore: defineMutation({
			title: 'Restore Entry',
			description: 'Restore a soft-deleted entry by clearing deletedAt.',
			input: Type.Object({
				id: Type.String({ description: 'Entry ID to restore' }),
			}),
			handler: ({ id }) => {
				return tables.entries.update(id, {
					deletedAt: undefined,
					updatedAt: DateTimeString.now(),
				});
			},
		}),
		entries_bulk_create: defineMutation({
			title: 'Bulk Create Entries',
			description: 'Create multiple entries at once from title + date pairs.',
			input: Type.Object({
				entries: Type.Array(
					Type.Object({
						title: Type.String({ description: 'Entry title' }),
						date: Type.String({
							description: 'ISO date string in workspace DateTimeString format',
						}),
					}),
				),
			}),
			handler: async ({ entries: items }) => {
				const now = DateTimeString.now();
				const rows = items.map(({ title, date }) => ({
					id: generateId<EntryId>(),
					title,
					subtitle: '',
					type: [] as string[],
					tags: [] as string[],
					pinned: false,
					rating: 0,
					deletedAt: undefined,
					date: date as DateTimeString,
					createdAt: now,
					updatedAt: now,
					_v: 2 as const,
				}));
				await tables.entries.bulkSet(rows);
				return { count: rows.length };
			},
		}),
	});
}

export type FujiActions = ReturnType<typeof createFujiActions>;
