import { type } from 'arktype';
import type { Brand } from 'wellcrafted/brand';

/**
 * Workspace partition key. In personal mode equals the signed-in user's
 * id (bytes preserve pre-collapse HKDF labels). In team mode the literal
 * 'team'. Every server path, every R2 key, every local IDB name, and the
 * HKDF derivation label all use this one value.
 *
 * The validator is declared first; the type is derived from it via `.infer`
 * so schema and type stay in lockstep under one PascalCase name. Use
 * {@link OwnerId} directly inside schemas (`ownerId: OwnerId`); at trusted
 * call sites brand a known `string` via {@link asOwnerId}.
 */
export const OwnerId = type('string').as<string & Brand<'OwnerId'>>();
export type OwnerId = typeof OwnerId.infer;
/**
 * Syntactic sugar for `value as OwnerId`. The function body is a single typed
 * cast; the constrained `string` parameter is what earns it over a raw `as`
 * (callers can't accidentally widen to `unknown`). The only place in the
 * codebase where `as OwnerId` appears.
 */
export const asOwnerId = (value: string): OwnerId => value as OwnerId;

/**
 * Owner partition for team deployments.
 *
 * Byte-pinned: this string IS the HKDF derivation label, the `:ownerId` path
 * segment, the R2 key prefix, the Durable Object name prefix, and the local
 * IndexedDB key prefix for every team server. Changing the bytes breaks every
 * existing team deployment's data. Do not edit.
 *
 * Personal-mode deployments never read this; their owner partition is the
 * signed-in user's id.
 */
export const TEAM_OWNER_ID = asOwnerId('team');
