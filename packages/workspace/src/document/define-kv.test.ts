/**
 * defineKv tests.
 *
 * defineKv is `(schema, defaultValue) => ({ schema, defaultValue })`. The
 * only contract worth pinning here is that both fields land on the result
 * unchanged. The validate-or-default behavior of KV stores is covered in
 * `create-kv.test.ts`; arktype's own validate is not in scope.
 */

import { expect, test } from 'bun:test';
import { type } from 'arktype';
import { defineKv } from './define-kv.js';

test('returns { schema, defaultValue } unchanged so consumers can dot-access both', () => {
	const schema = type({ mode: "'light' | 'dark'" });
	const def = defineKv(schema, { mode: 'light' });

	expect(def.schema).toBe(schema);
	expect(def.defaultValue).toEqual({ mode: 'light' });
});
