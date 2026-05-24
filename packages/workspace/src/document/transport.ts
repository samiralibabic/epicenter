/**
 * Build the WebSocket URL for a hosted room.
 *
 * Strips trailing slashes from `apiUrl` so callers can pass either
 * `https://api.example.com` or `https://api.example.com/`. `roomId` is
 * `encodeURIComponent`-encoded so ids containing `/`, `?`, or `#`
 * round-trip safely; Hono decodes the `:room` path param at the server.
 * The `http(s)` origin maps to a `ws(s)` URL.
 */
export function roomWsUrl(apiUrl: string, roomId: string): string {
	const base = apiUrl.replace(/\/+$/, '');
	return `${base}/rooms/${encodeURIComponent(roomId)}`
		.replace(/^https:/, 'wss:')
		.replace(/^http:/, 'ws:');
}
