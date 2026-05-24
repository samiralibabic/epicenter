/**
 * Sync Transport URL Tests
 *
 * Verifies cloud sync URL construction for the single `/rooms/:room` route.
 *
 * Key behaviors:
 * - The room id is `encodeURIComponent`-encoded.
 * - Trailing slashes on `apiUrl` are stripped.
 * - `http` origins become `ws`; `https` origins become `wss`.
 */

import { describe, expect, test } from 'bun:test';
import { roomWsUrl } from './transport.js';

describe('roomWsUrl', () => {
	test('encodes the room id and strips trailing slashes', () => {
		expect(roomWsUrl('https://api.example.com/', 'a/b?c#d')).toBe(
			'wss://api.example.com/rooms/a%2Fb%3Fc%23d',
		);
	});

	test('converts http origins to ws and https origins to wss', () => {
		expect(roomWsUrl('http://localhost:8787', 'epicenter.fuji')).toBe(
			'ws://localhost:8787/rooms/epicenter.fuji',
		);
	});
});
