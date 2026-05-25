import type { OAuthError } from '@epicenter/constants/oauth-errors';
import type { Context } from 'hono';
import { isWebSocketUpgrade } from '../is-websocket-upgrade.js';

type CreateWebSocketPair = () => InstanceType<typeof WebSocketPair>;

/**
 * Map an {@link OAuthError} to the protected-resource auth failure response
 * for HTTP and WebSocket-upgrade requests on the same route.
 *
 * The serialized error object (`{ name, message, ...fields }`) is itself the
 * JSON body and the WS close-reason payload; clients reconstruct by branching
 * on `error.name`.
 */
export function createOAuthUnauthorizedResourceResponse(
	c: Context,
	error: OAuthError,
	createWebSocketPair: CreateWebSocketPair = () => new WebSocketPair(),
) {
	const isUpgrade = isWebSocketUpgrade(c);

	// InvalidToken: missing, malformed, unverifiable, or user-not-found.
	if (!isUpgrade) {
		c.header('WWW-Authenticate', 'Bearer error="invalid_token"');
		return c.json(error, error.status);
	}
	const pair = createWebSocketPair();
	const [client, server] = [pair[0], pair[1]];
	server.accept();
	// WebSocket app-close codes are HTTP status + 4000 (so 401 -> 4401).
	server.close(4000 + error.status, JSON.stringify(error));
	return new Response(null, { status: 101, webSocket: client });
}
