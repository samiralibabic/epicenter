/** @jsxImportSource hono/jsx */

import { CLI_CALLBACK_SCRIPT } from './scripts/cli-callback';

/**
 * Server-rendered OAuth callback page for the CLI's OOB authorization code
 * flow.
 *
 * The CLI launcher prints an `/auth/oauth2/authorize` URL; after the user
 * signs in on the hosted portal, Better Auth redirects to
 * `/auth/cli-callback?code=...&state=...`. This page renders the code in a
 * monospace block with a Copy button so the user can paste it into the
 * terminal where `epicenter auth login` is waiting on stdin.
 *
 * The browser never sees the access token or refresh token; the code is
 * useless without the PKCE verifier held in the CLI process. The response
 * sets `Cache-Control: no-store, no-transform` at the route layer to keep
 * Cloudflare's edge from caching or mutating the rendered code.
 *
 * Query params (set by Better Auth on redirect):
 * - `code`: the one-time authorization code
 * - `state`: opaque state value the CLI generated; informational only here
 * - `error`: present when the authorize step failed (e.g. `access_denied`)
 * - `error_description`: human-readable detail
 */
export function CliCallbackPage({
	code,
	error,
	errorDescription,
}: {
	code?: string;
	/**
	 * Accepted in the route query but not rendered: the CLI checks `state`
	 * locally against the value it generated, not from this page.
	 */
	state?: string;
	error?: string;
	errorDescription?: string;
}) {
	if (error) {
		return (
			<>
				<h1>Sign-in failed</h1>
				<p class="subtitle">The authorization server rejected the request.</p>
				<p>
					Error: <code>{error}</code>
				</p>
				{errorDescription && (
					<p>
						Detail: <code>{errorDescription}</code>
					</p>
				)}
				<p>
					Run <code>epicenter auth login</code> again to retry.
				</p>
			</>
		);
	}

	if (!code) {
		return (
			<>
				<h1>Sign-in failed</h1>
				<p class="subtitle">
					This page expects an authorization code from the sign-in flow.
				</p>
				<p>
					Error: <code>missing_code</code>
				</p>
				<p>
					Start over with <code>epicenter auth login</code>.
				</p>
			</>
		);
	}

	return (
		<>
			<h1>Signed in to Epicenter CLI</h1>
			<p class="subtitle">
				Copy this code and paste it into the terminal where you ran
				<br />
				<code>epicenter auth login</code>.
			</p>

			<pre class="code-block">
				<code id="code">{code}</code>
			</pre>

			<div id="msg" class="msg hidden" />

			<div class="actions">
				<button type="button" class="btn btn-primary" id="copy">
					Copy code
				</button>
			</div>

			<p class="signed-in-info">
				You can close this tab once the code is pasted.
			</p>

			{CLI_CALLBACK_SCRIPT}
		</>
	);
}
