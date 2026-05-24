import { describe, expect, test } from 'bun:test';
import { createOwnedYjsKey, getOwnedYjsPrefix } from './local-yjs-key.js';

const SERVER = 'api.epicenter.so';
const ALICE = { kind: 'personal', userId: 'user-a' } as const;
const BOB = { kind: 'personal', userId: 'user-b' } as const;
const TEAM = { kind: 'team' } as const;

describe('getOwnedYjsPrefix', () => {
	test('personal includes the users/<userId> partition', () => {
		expect(getOwnedYjsPrefix(SERVER, ALICE)).toBe(
			'epicenter/api.epicenter.so/users/user-a/',
		);
	});
	test('team drops the owner partition; server origin disambiguates', () => {
		expect(getOwnedYjsPrefix(SERVER, TEAM)).toBe('epicenter/api.epicenter.so/');
	});
});

describe('createOwnedYjsKey', () => {
	test('appends the ydoc guid to the owner prefix', () => {
		expect(createOwnedYjsKey(SERVER, ALICE, 'epicenter.fuji')).toBe(
			'epicenter/api.epicenter.so/users/user-a/epicenter.fuji',
		);
		expect(createOwnedYjsKey(SERVER, TEAM, 'epicenter.fuji')).toBe(
			'epicenter/api.epicenter.so/epicenter.fuji',
		);
	});
	test('different owners on the same server produce different keys', () => {
		expect(createOwnedYjsKey(SERVER, ALICE, 'epicenter.fuji')).not.toBe(
			createOwnedYjsKey(SERVER, BOB, 'epicenter.fuji'),
		);
	});
	test('different ydoc guids produce different keys for the same owner', () => {
		expect(createOwnedYjsKey(SERVER, ALICE, 'epicenter.fuji')).not.toBe(
			createOwnedYjsKey(SERVER, ALICE, 'epicenter.honeycrisp'),
		);
	});
	test('different servers produce different keys for the same team', () => {
		expect(createOwnedYjsKey('team-a.example', TEAM, 'd')).not.toBe(
			createOwnedYjsKey('team-b.example', TEAM, 'd'),
		);
	});
});
