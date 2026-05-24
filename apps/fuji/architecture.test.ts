/**
 * Source-shape lock for the Fuji per-app openers.
 *
 * Static checks only. Asserts that the schema module is pure data + factories
 * with no Y.Doc construction or encryption attach, and that the browser /
 * daemon openers compose from the Tier 1 primitives (`attachEncryption`,
 * `attachLocalStorage`, `openCollaboration`). Behavior tests live in
 * `workspace.test.ts`.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fujiDir = dirname(fileURLToPath(import.meta.url));

const workspaceSource = readFileSync(
	join(fujiDir, 'src/lib/workspace.ts'),
	'utf8',
);
const browserSource = readFileSync(join(fujiDir, 'src/lib/browser.ts'), 'utf8');
const daemonSource = readFileSync(join(fujiDir, 'daemon.ts'), 'utf8');
const packageJson = JSON.parse(
	readFileSync(join(fujiDir, 'package.json'), 'utf8'),
) as { exports: { '.': string; './daemon': string } };

describe('Fuji workspace architecture', () => {
	test('schema module is pure data: no opener, no Y.Doc construction', () => {
		expect(workspaceSource).toContain('export const FUJI_ID');
		expect(workspaceSource).toContain('export const fujiTables');
		expect(workspaceSource).toContain('export function createFujiActions');
		expect(workspaceSource).toContain('export function entryContentDocGuid');
		// No opener / encryption / ydoc in the schema file.
		expect(workspaceSource).not.toContain('openFujiWorkspace');
		expect(workspaceSource).not.toContain('attachFujiWorkspace');
		expect(workspaceSource).not.toContain('new Y.Doc');
		expect(workspaceSource).not.toContain('attachEncryption');
		expect(packageJson.exports['.']).toBe('./src/lib/workspace.ts');
	});

	test('browser opener composes ydoc + attachEncryption + free primitives', () => {
		expect(browserSource).toContain('export function openFujiBrowser');
		expect(browserSource).toContain('new Y.Doc({ guid: FUJI_ID');
		expect(browserSource).toContain('attachEncryption(ydoc, { keyring:');
		expect(browserSource).toContain('attachLocalStorage(ydoc, {');
		expect(browserSource).toContain('server: signedIn.server,');
		expect(browserSource).toContain('owner: signedIn.owner,');
		expect(browserSource).toContain('openCollaboration(ydoc,');
		expect(browserSource).toContain(
			'openWebSocket: signedIn.auth.openWebSocket',
		);
		expect(browserSource).toContain(
			'onReconnectSignal: signedIn.auth.onStateChange',
		);
		expect(browserSource).toContain('wipeLocalStorage({');
		// No LocalOwner / openEncryptedDoc / wipeLocalYjsData carry-over.
		expect(browserSource).not.toContain('LocalOwner');
		expect(browserSource).not.toContain('openEncryptedDoc');
		expect(browserSource).not.toContain('wipeLocalYjsData');
		expect(browserSource).not.toContain('owner.attachLocal');
		expect(browserSource).not.toContain('connectDaemonActions');
		// No more duck-typed `attachLocalStorage(ydoc, signedIn)` shape.
		expect(browserSource).not.toContain('attachLocalStorage(ydoc, signedIn)');
		// No more inline `auth: signedIn.auth` on openCollaboration.
		expect(browserSource).not.toContain('auth: signedIn.auth');
	});

	test('daemon opener composes ydoc + attachEncryption + materializers', () => {
		expect(daemonSource).toContain('export function openFujiDaemon');
		expect(daemonSource).toContain('new Y.Doc({ guid: FUJI_ID');
		expect(daemonSource).toContain('attachEncryption(ydoc, { keyring })');
		expect(daemonSource).toContain('attachDaemonInfrastructure');
		expect(daemonSource).toContain('attachSqliteMaterializer');
		expect(daemonSource).toContain('attachMarkdownMaterializer');
		// Destructured ctx: `yDocClientId` pins the Y.Doc CRDT clientID;
		// `openWebSocket` and `onReconnectSignal` thread through to the daemon
		// infrastructure for cloud sync.
		expect(daemonSource).toContain('ydoc.clientID = yDocClientId');
		expect(daemonSource).toContain('openWebSocket,');
		expect(daemonSource).toContain('onReconnectSignal,');
		expect(daemonSource).not.toContain('openEncryptedDoc');
		expect(daemonSource).not.toContain('openFujiWorkspace');
		// Old shape: `auth,` passed as a single AuthClient is gone.
		expect(daemonSource).not.toContain(' auth,\n');
		expect(packageJson.exports['./daemon']).toBe('./daemon.ts');
	});
});
