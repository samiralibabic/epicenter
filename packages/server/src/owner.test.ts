/**
 * Owner derivations: every durable string for both modes.
 *
 * The point of these tests is to pin the wire formats. If any of these
 * strings change, every existing DO, R2 object, and locally-encrypted
 * blob keyed on the old shape becomes orphaned. They are contracts.
 *
 * Personal mode and team mode share the same shape; in personal mode
 * `ownerId` is the signed-in user's id, in team mode it is the literal
 * `'team'`.
 */

import { describe, expect, test } from 'bun:test';
import { asOwnerId, TEAM_OWNER_ID } from '@epicenter/constants/identity';
import { assetKey, doName } from './owner.js';

const personal = asOwnerId('abc');
const team = TEAM_OWNER_ID;

describe('doName', () => {
	test('personal partitions DO names under the user', () => {
		expect(doName(personal, 'r123')).toBe('owners/abc/rooms/r123');
	});
	test('team partitions DO names under the literal team owner', () => {
		expect(doName(team, 'r123')).toBe('owners/team/rooms/r123');
	});
});

describe('assetKey', () => {
	test('personal puts assets under the user partition', () => {
		expect(assetKey(personal, 'x1y2z3')).toBe('owners/abc/assets/x1y2z3');
	});
	test('team puts assets under the team partition', () => {
		expect(assetKey(team, 'x1y2z3')).toBe('owners/team/assets/x1y2z3');
	});
});
