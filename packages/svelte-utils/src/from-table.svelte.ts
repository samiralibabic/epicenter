import type { BaseRow, Table } from '@epicenter/workspace';
import { SvelteMap } from 'svelte/reactivity';

/**
 * Create a reactive SvelteMap binding to a workspace table.
 *
 * Returns a `SvelteMap<id, Row>` that stays in sync with the underlying
 * Yjs table via granular per-row updates. Only changed rows trigger
 * re-renders—not the entire collection.
 *
 * Read-only—mutations go through `table.set()`, `table.update()`, etc.
 * The observer picks up changes from both local writes and remote CRDT sync.
 *
 * @example
 * ```typescript
 * const entries = fromTable(workspaceClient.tables.entries);
 *
 * // Per-item access (reactive):
 * const entry = entries.get(id);
 *
 * // Iterate (reactive):
 * for (const [id, entry] of entries) { ... }
 *
 * // Array access:
 * const all = [...entries.values()];
 *
 * // Derived state:
 * const filtered = $derived([...entries.values()].filter(e => !e.deletedAt));
 * ```
 */
export function fromTable<TRow extends BaseRow>(
	table: Table<TRow>,
): SvelteMap<string, TRow> & { destroy: () => void } {
	const map = new SvelteMap<string, TRow>();

	// Seed with current valid rows
	for (const row of table.getAllValid()) {
		map.set(row.id, row);
	}

	// Granular updates — only touch changed rows
	const unobserve = table.observe((changedIds) => {
		for (const id of changedIds) {
			const { data: row, error } = table.get(id);
			if (error || row === null) {
				map.delete(id);
				continue;
			}

			map.set(id, row);
		}
	});

	return Object.assign(map, { destroy: unobserve });
}
