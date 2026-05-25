/**
 * Sync Transport URL Tests
 *
 * Verifies cloud sync URL construction for the rooms WebSocket endpoint.
 *
 * Key behaviors:
 * - Single URL form: `/api/owners/<ownerId>/rooms/<guid>` in both modes.
 * - `guid` is `encodeURIComponent`-encoded.
 * - Trailing slashes on `baseURL` are stripped.
 * - `http` origins become `ws`; `https` origins become `wss`.
 * - `deviceId` is appended as a query parameter.
 */

import { describe, expect, test } from 'bun:test';
import { asOwnerId, TEAM_OWNER_ID } from '@epicenter/constants/identity';
import { asDeviceId } from './device-id.js';
import { roomWsUrl } from './transport.js';

describe('roomWsUrl', () => {
	test('personal mode owner id partitions the path under /owners/', () => {
		expect(
			roomWsUrl({
				baseURL: 'https://api.example.com',
				ownerId: asOwnerId('alice'),
				guid: 'epicenter.fuji',
				deviceId: asDeviceId('client-1'),
			}),
		).toBe(
			'wss://api.example.com/api/owners/alice/rooms/epicenter.fuji?deviceId=client-1',
		);
	});

	test("team mode uses the literal 'team' owner id under the same /owners/ partition", () => {
		expect(
			roomWsUrl({
				baseURL: 'https://team.example.com',
				ownerId: TEAM_OWNER_ID,
				guid: 'epicenter.fuji',
				deviceId: asDeviceId('client-1'),
			}),
		).toBe(
			'wss://team.example.com/api/owners/team/rooms/epicenter.fuji?deviceId=client-1',
		);
	});

	test('encodes the guid and strips trailing slashes', () => {
		expect(
			roomWsUrl({
				baseURL: 'https://api.example.com/',
				ownerId: TEAM_OWNER_ID,
				guid: 'a/b?c#d',
				deviceId: asDeviceId('client-1'),
			}),
		).toBe(
			'wss://api.example.com/api/owners/team/rooms/a%2Fb%3Fc%23d?deviceId=client-1',
		);
	});

	test('converts http origins to ws and https origins to wss', () => {
		expect(
			roomWsUrl({
				baseURL: 'http://localhost:8787',
				ownerId: TEAM_OWNER_ID,
				guid: 'epicenter.fuji',
				deviceId: asDeviceId('client-1'),
			}),
		).toBe(
			'ws://localhost:8787/api/owners/team/rooms/epicenter.fuji?deviceId=client-1',
		);
	});
});
