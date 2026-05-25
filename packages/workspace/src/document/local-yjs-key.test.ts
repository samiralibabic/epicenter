import { describe, expect, test } from 'bun:test';
import { asOwnerId, TEAM_OWNER_ID } from '@epicenter/constants/identity';
import { createOwnedYjsKey, getOwnedYjsPrefix } from './local-yjs-key.js';

const SERVER = 'api.epicenter.so';
const ALICE = asOwnerId('user-a');
const TEAM = TEAM_OWNER_ID;

describe('getOwnedYjsPrefix', () => {
	test('personal mode owner id partitions the prefix under owners/', () => {
		expect(getOwnedYjsPrefix(SERVER, ALICE)).toBe(
			'epicenter/api.epicenter.so/owners/user-a/',
		);
	});
	test("team mode uses the literal 'team' owner id under the same owners/ partition", () => {
		expect(getOwnedYjsPrefix(SERVER, TEAM)).toBe(
			'epicenter/api.epicenter.so/owners/team/',
		);
	});
});

describe('createOwnedYjsKey', () => {
	test('appends the ydoc guid to the owner prefix', () => {
		expect(createOwnedYjsKey(SERVER, ALICE, 'epicenter.fuji')).toBe(
			'epicenter/api.epicenter.so/owners/user-a/epicenter.fuji',
		);
		expect(createOwnedYjsKey(SERVER, TEAM, 'epicenter.fuji')).toBe(
			'epicenter/api.epicenter.so/owners/team/epicenter.fuji',
		);
	});
});
