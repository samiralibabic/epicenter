/**
 * Presence wire protocol: the single text frame the relay pushes to
 * announce which installs are connected.
 *
 * The relay owns presence (its `connections` map is the source of truth)
 * and broadcasts the FULL list on every connection change. The client
 * stores the latest list verbatim: there is no delta protocol and no
 * client-side reassembly, the frame IS the state.
 *
 * Shared by the relay (`apps/api/src/room.ts`, the sender) and the client
 * (`open-collaboration.ts`, the reader) via the `./document/presence`
 * package export. Pure types, zero runtime, zero imports.
 */

/**
 * Full set of currently-connected installs, pushed by the relay on every
 * connection change (`presence`). `installs` always excludes the
 * receiver's own installationId: the relay computes the list per-recipient
 * so the client never has to filter self.
 */
export type PresenceFrame = {
	type: 'presence';
	installs: string[];
};
