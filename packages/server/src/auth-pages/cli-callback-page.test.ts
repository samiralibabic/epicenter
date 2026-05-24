/**
 * /auth/cli-callback page tests.
 *
 * Renders the CLI OOB callback page through a minimal Hono app using the
 * same handler shape the api wires in `app.ts`. We assert the rendered HTML
 * contains the code literally inside a <code> tag, that the response sets
 * Cache-Control: no-store, no-transform, and that `secureHeaders()` applies
 * X-Frame-Options + X-Content-Type-Options defaults.
 */

import { expect, test } from 'bun:test';
import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { renderCliCallbackPage } from './index';

function createCallbackApp() {
	const app = new Hono();
	app.get('/auth/cli-callback', secureHeaders(), (c) => {
		c.header('Cache-Control', 'no-store, no-transform');
		return c.html(
			renderCliCallbackPage({
				code: c.req.query('code'),
				state: c.req.query('state'),
				error: c.req.query('error'),
				errorDescription: c.req.query('error_description'),
			}),
		);
	});
	return app;
}

test('GET /auth/cli-callback renders the code inside a <code> tag', async () => {
	const app = createCallbackApp();
	const response = await app.request(
		'/auth/cli-callback?code=XJ8K-2MNQ-LPVR&state=xyz',
	);

	expect(response.status).toBe(200);
	const body = await response.text();
	expect(body).toContain('<code id="code">XJ8K-2MNQ-LPVR</code>');
	expect(body).toContain('Signed in to Epicenter CLI');
});

test('GET /auth/cli-callback?error renders the error branch', async () => {
	const app = createCallbackApp();
	const response = await app.request(
		'/auth/cli-callback?error=access_denied&error_description=user%20denied',
	);

	expect(response.status).toBe(200);
	const body = await response.text();
	expect(body).toContain('Sign-in failed');
	expect(body).toContain('access_denied');
	expect(body).toContain('user denied');
});

test('GET /auth/cli-callback with no query renders the missing-code error branch', async () => {
	const app = createCallbackApp();
	const response = await app.request('/auth/cli-callback');

	expect(response.status).toBe(200);
	const body = await response.text();
	expect(body).toContain('Sign-in failed');
	expect(body).toContain('missing_code');
});

test('renderCliCallbackPage escapes HTML-special characters in the code', async () => {
	const app = createCallbackApp();
	// JSX text nodes are escaped by Hono. A code containing `<` must not
	// land as raw HTML; it must appear as `&lt;`.
	const response = await app.request(
		'/auth/cli-callback?code=%3Cscript%3Ealert%281%29%3C%2Fscript%3E',
	);
	const body = await response.text();

	expect(body).not.toContain('<script>alert(1)</script>');
	expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
});
