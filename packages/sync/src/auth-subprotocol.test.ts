/**
 * WebSocket Auth Subprotocol Tests
 *
 * Verifies the shared bearer subprotocol helpers used by auth clients and API
 * middleware.
 *
 * Key behaviors:
 * - Bearer prefix comes from the shared constants package
 * - Subprotocol headers parse into their comma-separated token list
 */

import { expect, test } from 'bun:test';
import { BEARER_SUBPROTOCOL_PREFIX as SHARED_PREFIX } from '@epicenter/constants/auth';
import {
	BEARER_SUBPROTOCOL_PREFIX,
	MAIN_SUBPROTOCOL,
	parseSubprotocols,
} from './auth-subprotocol.js';

test('bearer prefix re-exports the shared auth constant', () => {
	expect(BEARER_SUBPROTOCOL_PREFIX).toBe(SHARED_PREFIX);
});

test('parseSubprotocols splits a comma-separated subprotocol header', () => {
	const header = `${MAIN_SUBPROTOCOL}, ${BEARER_SUBPROTOCOL_PREFIX}token-1`;

	expect(parseSubprotocols(header)).toEqual([
		MAIN_SUBPROTOCOL,
		`${BEARER_SUBPROTOCOL_PREFIX}token-1`,
	]);
});
