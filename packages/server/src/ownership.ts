/**
 * Ownership rule: how a request maps to an owner partition.
 *
 * The deployment composes one of two variants and threads it into every
 * library surface that needs the partition (`createRequireOwnership`,
 * `mountRoomsApp`, `mountAssetsApp`, `mountSessionApp`). The variants are
 * constructed via {@link personal} / {@link team} so call sites never type
 * the discriminator string. See
 * `docs/articles/use-functions-to-wrap-discriminated-unions.md`.
 *
 *   personal: every authenticated user owns their own partition (the
 *             partition IS the user's id). No extra check beyond auth.
 *   team:     every authenticated user shares the literal TEAM_OWNER_ID
 *             partition, gated by the deployment-provided `isMember`
 *             predicate. Non-members get 403 NotTeamMember at the
 *             boundary.
 *
 * The membership predicate runs per request (no caching). For email-domain
 * checks this is free; for DB-backed predicates it is one indexed query.
 * Per-request evaluation keeps membership reflecting current state instead
 * of a stale at-sign-up decision.
 */

import {
	asOwnerId,
	type OwnerId,
	TEAM_OWNER_ID,
} from '@epicenter/constants/identity';
import { RequestGuardError } from '@epicenter/constants/request-guard-errors';
import type { Context } from 'hono';
import { Ok, type Result } from 'wellcrafted/result';
import type { Env } from './types.js';

/** Per-request membership predicate. Returns `true` to admit the user. */
export type IsMember = (c: Context<Env>) => Promise<boolean> | boolean;

/**
 * Discriminated union of every ownership shape this library knows how to
 * compose. Constructed via {@link personal} or {@link team}; consumed by
 * {@link resolveOwnerPartition} and any sub-app that mounts ownership-
 * scoped routes.
 */
export type OwnershipRule =
	| { kind: 'personal' }
	| { kind: 'team'; isMember: IsMember };

/** Construct the personal-mode ownership rule. */
export const personal = (): OwnershipRule => ({ kind: 'personal' });

/** Construct the team-mode ownership rule with a membership predicate. */
export const team = (opts: { isMember: IsMember }): OwnershipRule => ({
	kind: 'team',
	isMember: opts.isMember,
});

/**
 * The single switch on `rule.kind` in the codebase. Both the
 * `requireOwnership` middleware and the conditional asset GET delegate
 * here, so the partition decision lives in one place.
 *
 * Returns the owner partition the request maps to. In team mode this
 * function also AUTHORIZES the request: non-members get an `Err` arm
 * carrying `NotTeamMember` before any URL is read. The caller decides
 * whether to compare the partition to a URL `:ownerId` segment (the
 * `requireOwnership` middleware does; the conditional asset GET does
 * not).
 *
 * Personal: always succeeds, returns the user's id branded as `OwnerId`.
 * Team:     runs the predicate; admits with `TEAM_OWNER_ID` or rejects
 *           with `NotTeamMember`.
 */
export async function resolveOwnerPartition(
	rule: OwnershipRule,
	c: Context<Env>,
): Promise<Result<OwnerId, RequestGuardError>> {
	switch (rule.kind) {
		case 'personal':
			return Ok(asOwnerId(c.var.user.id));
		case 'team': {
			const member = await rule.isMember(c);
			if (!member) return RequestGuardError.NotTeamMember();
			return Ok(TEAM_OWNER_ID);
		}
	}
}
