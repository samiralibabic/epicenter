/**
 * defineTable Tests
 *
 * Verifies single-schema and variadic multi-version table definitions, including schema migration.
 * These tests ensure table contracts remain stable for runtime validation and for typed documents.
 *
 * Key behaviors:
 * - Table schemas validate expected row shapes across versions.
 * - Migration functions upgrade legacy rows to the latest schema.
 */

import { describe, expect, test } from 'bun:test';
import { defineTable } from './define-table.js';

describe('defineTable', () => {
	test('requires at least one schema argument', () => {
		expect(() => {
			// @ts-expect-error no arguments provided
			defineTable();
		}).toThrow();
	});
});
