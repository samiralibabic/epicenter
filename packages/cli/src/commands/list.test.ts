/**
 * Unit coverage for the pure helpers in `list.ts`. Renderer text output
 * and CLI argv plumbing are exercised end-to-end via the route tests in
 * `daemon/list-route.test.ts` and the command tests under `test/`; here
 * we lock the small data projection that the renderer reuses.
 */

import { describe, expect, test } from 'bun:test';

import { filterByPath } from './list';

describe('filterByPath', () => {
	const entries = {
		'demo.counter_get': { type: 'query' as const },
		'demo.counter_set': { type: 'mutation' as const },
		'other.thing': { type: 'query' as const },
	};

	test('empty path returns the input unchanged', () => {
		expect(filterByPath(entries, '')).toBe(entries);
	});

	test('exact-leaf path returns just that leaf', () => {
		expect(Object.keys(filterByPath(entries, 'demo.counter_get'))).toEqual([
			'demo.counter_get',
		]);
	});

	test('subtree prefix returns descendants', () => {
		expect(Object.keys(filterByPath(entries, 'demo')).sort()).toEqual([
			'demo.counter_get',
			'demo.counter_set',
		]);
	});

	test('non-matching prefix returns empty', () => {
		expect(filterByPath(entries, 'nope')).toEqual({});
	});
});
