/**
 * Test-only helpers that contain `ProjectDir` brand casts in one place.
 *
 * Production code mints `ProjectDir` via `findProjectRoot`, which validates
 * that the path contains `epicenter.config.ts`. Tests use `mkdtempSync` for
 * fresh tmpdirs and do not always invoke `findProjectRoot`, so they need an
 * explicit cast. Owning the cast here
 * keeps the brand contract honest at the call site (the cast lives in a
 * function whose name spells out "test").
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectDir } from './types.js';

/**
 * Create a fresh tmp directory and return it as `ProjectDir`. The cast
 * is honest in spirit (tests set up the project marker they need) and
 * contained to this helper.
 *
 * @example
 * ```ts
 * let workdir: ProjectDir;
 * beforeEach(() => { workdir = mintTestProjectDir('fuji-integration-'); });
 * ```
 */
export function mintTestProjectDir(prefix: string): ProjectDir {
	return mkdtempSync(join(tmpdir(), prefix)) as ProjectDir;
}
