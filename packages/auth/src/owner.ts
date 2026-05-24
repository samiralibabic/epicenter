import { type } from 'arktype';

/**
 * Who owns the workspace data this request touches.
 *
 * Personal mode: a single user; their userId is the partition key for
 *                local storage and server-side durable identifiers.
 * Team mode:     the deployment itself; there is no partition. Every
 *                signed-in member of the deployment shares one workspace.
 *
 * The same shape flows from the server's `/api/session` response, through
 * the persisted auth cell, into auth state, and through to the workspace
 * daemon. Clients pattern-match on `kind` to render team-aware UI;
 * `ownerId(owner)` produces the stable string key local storage uses to
 * disambiguate owners on the same machine.
 */
export const Owner = type(
	{
		kind: "'personal'",
		userId: 'string',
	},
	'|',
	{
		kind: "'team'",
	},
);

export type Owner = typeof Owner.infer;

/**
 * The set of valid Owner discriminators.
 */
export type OwnerKind = Owner['kind'];

/**
 * Stable string identifier for the owner.
 *
 * Personal: `users/<userId>` (matches the storage partition prefix the
 *            server writes for DO names, R2 keys, and HKDF labels).
 * Team:      the literal `team` (a fixed sentinel so local storage on a
 *            machine connected to two different team servers can be
 *            disambiguated by combining `${origin}/${ownerId}`).
 *
 * Use this anywhere you previously read `localIdentity.subject`. The name
 * change reflects what the value actually carries now: an OWNER identifier,
 * not a Better-Auth subject.
 */
export function ownerId(owner: Owner): string {
	return owner.kind === 'personal' ? `users/${owner.userId}` : 'team';
}
