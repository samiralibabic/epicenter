/**
 * Sync Transport URL Tests
 *
 * Verifies cloud sync URL construction for the rooms WebSocket endpoint.
 *
 * Key behaviors:
 * - Personal owners route through `/api/users/<userId>/rooms/<guid>`.
 * - Team owners route through `/api/rooms/<guid>`.
 * - `guid` is `encodeURIComponent`-encoded.
 * - Trailing slashes on `baseURL` are stripped.
 * - `http` origins become `ws`; `https` origins become `wss`.
 * - `installationId` is appended as a query parameter.
 */

import { describe, expect, test } from 'bun:test';
import { roomWsUrl } from './transport.js';

describe('roomWsUrl', () => {
	test('personal owners include the userId path partition', () => {
		expect(
			roomWsUrl({
				baseURL: 'https://api.example.com',
				owner: { kind: 'personal', userId: 'alice' },
				guid: 'epicenter.fuji',
				installationId: 'client-1',
			}),
		).toBe(
			'wss://api.example.com/api/users/alice/rooms/epicenter.fuji?installationId=client-1',
		);
	});

	test('team owners route through /api/rooms', () => {
		expect(
			roomWsUrl({
				baseURL: 'https://team.example.com',
				owner: { kind: 'team' },
				guid: 'epicenter.fuji',
				installationId: 'client-1',
			}),
		).toBe(
			'wss://team.example.com/api/rooms/epicenter.fuji?installationId=client-1',
		);
	});

	test('encodes the guid and strips trailing slashes', () => {
		expect(
			roomWsUrl({
				baseURL: 'https://api.example.com/',
				owner: { kind: 'team' },
				guid: 'a/b?c#d',
				installationId: 'client-1',
			}),
		).toBe(
			'wss://api.example.com/api/rooms/a%2Fb%3Fc%23d?installationId=client-1',
		);
	});

	test('converts http origins to ws and https origins to wss', () => {
		expect(
			roomWsUrl({
				baseURL: 'http://localhost:8787',
				owner: { kind: 'team' },
				guid: 'epicenter.fuji',
				installationId: 'client-1',
			}),
		).toBe(
			'ws://localhost:8787/api/rooms/epicenter.fuji?installationId=client-1',
		);
	});
});
