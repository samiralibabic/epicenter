/**
 * Sheet Ordering Tests
 *
 * Verifies fractional indexing helpers for row/column reordering in sheet-mode
 * timeline entries. CSV parsing/serialization tests live in
 * `@epicenter/workspace/src/timeline/sheet.test.ts`.
 *
 * Key behaviors:
 * - Fractional index helpers generate valid, stable order values for reordering.
 */

import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { reorderColumn, reorderRow } from './sheet.js';

function createSheetMaps() {
	const ydoc = new Y.Doc();
	const columns = ydoc.getMap('columns') as Y.Map<Y.Map<string>>;
	const rows = ydoc.getMap('rows') as Y.Map<Y.Map<string>>;
	return { ydoc, columns, rows };
}

describe('fractional indexing', () => {
	test('reorderRow updates order to midpoint between neighbors', () => {
		const { rows } = createSheetMaps();
		const row = new Y.Map<string>();
		row.set('order', '0.5');
		rows.set('row1', row);

		reorderRow(rows, 'row1', 0.25, 0.75);
		const newOrder = Number.parseFloat(row.get('order') ?? '0');
		expect(newOrder).toBeGreaterThan(0.25);
		expect(newOrder).toBeLessThan(0.75);
	});

	test('reorderColumn updates order to midpoint between neighbors', () => {
		const { columns } = createSheetMaps();
		const col = new Y.Map<string>();
		col.set('order', '0.5');
		columns.set('col1', col);

		reorderColumn(columns, 'col1', 0.1, 0.9);
		const newOrder = Number.parseFloat(col.get('order') ?? '0');
		expect(newOrder).toBeGreaterThan(0.1);
		expect(newOrder).toBeLessThan(0.9);
	});
});
