/**
 * Presence wire protocol: the relay-owned device list, plus the one frame the
 * device sends to publish its own manifest.
 *
 * The relay owns presence (its `connections` map is the source of truth) and
 * broadcasts the FULL device list on every membership or manifest change. The
 * client stores the latest list verbatim: there is no delta protocol and no
 * client-side reassembly, the frame IS the state.
 *
 * The wire carries each device's full action manifest so the receiver can
 * render affordances, validate input schemas, or hand the manifest to an AI
 * tool layer with no second round trip. Manifests are opaque to the relay: it
 * stores and forwards them as bytes, never inspects their shape.
 *
 * Shared by the relay (`packages/server/src/room/core.ts`, the sender) and
 * the client (`open-collaboration.ts`, the reader).
 *
 * Schemas are TypeBox: they ARE valid JSON Schema at runtime, double as the
 * source of truth for the TypeScript types via `Static`, and feed
 * `typebox/compile`'s `Compile()` to produce checked-once validators reused
 * at every boundary. No hand-written duck-typing helpers.
 */

import Type, { type Static } from 'typebox';
import { Compile } from 'typebox/compile';
import { ActionMetaSchema } from '../shared/actions.js';

/**
 * Wire schema for an action manifest. `Record<string, ActionMeta>` where each
 * value is the metadata-only projection of a callable `Action`. Reuses
 * `ActionMetaSchema` so the wire stays in lockstep with the local registry.
 */
export const ActionManifestSchema = Type.Record(
	Type.String(),
	ActionMetaSchema,
);

/**
 * One device's entry on the wire.
 *
 * `installationId` routes dispatches; `connectedAt` lets receivers render an
 * "online since" affordance; `actions` is the device's published manifest, or
 * `{}` if the device has not (yet) published one.
 */
export const PresenceDeviceSchema = Type.Object({
	installationId: Type.String(),
	connectedAt: Type.Number(),
	actions: ActionManifestSchema,
});
export type PresenceDevice = Static<typeof PresenceDeviceSchema>;

/**
 * Server -> client: full set of currently-connected devices, pushed on every
 * membership or manifest change. `devices` always excludes the receiver's
 * own install: the relay computes the list per-recipient so the client never
 * has to filter self.
 */
export const PresenceFrameSchema = Type.Object({
	type: Type.Literal('presence'),
	devices: Type.Array(PresenceDeviceSchema),
});
export type PresenceFrame = Static<typeof PresenceFrameSchema>;

/**
 * Client -> server: publish this device's action manifest. The relay stores
 * the manifest against the sending socket's installationId and rebroadcasts
 * presence so peers see the update. Sent once on connect; re-sent if the
 * local action registry changes.
 */
export const PresencePublishFrameSchema = Type.Object({
	type: Type.Literal('presence_publish'),
	actions: ActionManifestSchema,
});
export type PresencePublishFrame = Static<typeof PresencePublishFrameSchema>;

/**
 * Pre-compiled validator for inbound presence frames. Used by the client to
 * narrow untrusted text frames at the receive boundary.
 */
export const checkPresenceFrame = Compile(PresenceFrameSchema);

/**
 * Pre-compiled validator for inbound `presence_publish` frames. Used by the
 * relay to validate device-supplied manifests before storing.
 */
export const checkPresencePublishFrame = Compile(PresencePublishFrameSchema);
