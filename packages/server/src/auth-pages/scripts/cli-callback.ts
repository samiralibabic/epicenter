import { raw } from 'hono/html';

/**
 * Client-side script for the CLI OAuth callback page.
 *
 * Wires the "Copy" button to navigator.clipboard.writeText on the rendered
 * authorization code. The code is server-rendered inside a `<code id="code">`
 * tag; this script reads the textContent so we never need to interpolate
 * untrusted text into the script body.
 */
export const CLI_CALLBACK_SCRIPT = raw(`<script>
(() => {
	const copyBtn = document.getElementById('copy');
	const codeEl = document.getElementById('code');
	const msg = document.getElementById('msg');
	if (!copyBtn || !codeEl) return;

	copyBtn.addEventListener('click', async () => {
		const code = codeEl.textContent || '';
		try {
			await navigator.clipboard.writeText(code);
			if (msg) {
				msg.textContent = 'Copied. Paste it into your terminal.';
				msg.className = 'msg ok';
			}
		} catch {
			if (msg) {
				msg.textContent = 'Copy failed. Select and copy the code manually.';
				msg.className = 'msg err';
			}
		}
	});
})();
</script>`);
