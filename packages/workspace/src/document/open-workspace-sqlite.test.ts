/**
 * Smoke test for `openWorkspaceSqlite`: opens the daemon's mirror file
 * read-only and confirms the PRAGMA settings enforce write rejection.
 */

import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ProjectDir } from '../shared/types.js';
import { openWorkspaceSqlite } from './open-workspace-sqlite.js';
import { sqlitePath } from './workspace-paths.js';

let workdir: string;

beforeEach(() => {
	workdir = mkdtempSync(join(tmpdir(), 'open-workspace-sqlite-'));
});

afterEach(() => {
	rmSync(workdir, { recursive: true, force: true });
});

describe('openWorkspaceSqlite', () => {
	test('opens the mirror file read-only and rejects writes', () => {
		const workspaceId = 'epicenter.test';
		const filePath = sqlitePath(workdir, workspaceId);
		mkdirSync(dirname(filePath), { recursive: true });

		const writer = new Database(filePath);
		writer.exec('PRAGMA journal_mode = WAL');
		writer.exec(
			'CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)',
		);
		writer.exec("INSERT INTO notes (body) VALUES ('hello')");
		writer.close();

		const db = openWorkspaceSqlite(workdir as ProjectDir, workspaceId);
		try {
			const row = db.query('SELECT body FROM notes WHERE id = 1').get() as {
				body: string;
			};
			expect(row.body).toBe('hello');
			expect(() =>
				db.exec("INSERT INTO notes (body) VALUES ('nope')"),
			).toThrow();
		} finally {
			db.close();
		}
	});
});
