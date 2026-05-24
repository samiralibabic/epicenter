/**
 * Guard: the root `@epicenter/workspace` barrel must stay browser-safe.
 *
 * Browser apps (fuji, whispering) import the root entry. If anything reachable
 * from `src/index.ts` (via `export ... from` or `import ... from`) reaches a
 * module that imports `node:*`, `bun:*`, `env-paths`, bare `fs`/`path`/`os`,
 * or references `Bun.` / `process.env`, Vite externalizes those modules for
 * the browser and the app crashes at runtime ("node:os has been externalized
 * for browser compatibility").
 *
 * Node-only helpers belong in `@epicenter/workspace/node`. If this test fails,
 * move the offending export there instead of polyfilling node modules in Vite.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_BARREL = fileURLToPath(new URL('./index.ts', import.meta.url));

const FORBIDDEN_PATTERNS: { pattern: RegExp; label: string }[] = [
	{ pattern: /\bfrom\s+['"]node:/, label: "import from 'node:*'" },
	{ pattern: /\bfrom\s+['"]bun:/, label: "import from 'bun:*'" },
	{ pattern: /\bfrom\s+['"]env-paths['"]/, label: "import from 'env-paths'" },
	{ pattern: /\bfrom\s+['"]fs['"]/, label: "import from 'fs'" },
	{ pattern: /\bfrom\s+['"]path['"]/, label: "import from 'path'" },
	{ pattern: /\bfrom\s+['"]os['"]/, label: "import from 'os'" },
	{
		pattern: /\bfrom\s+['"]child_process['"]/,
		label: "import from 'child_process'",
	},
	{ pattern: /\bBun\s*\./, label: 'reference to Bun.*' },
	{ pattern: /\bprocess\s*\.\s*env\b/, label: 'reference to process.env' },
];

/**
 * Strip `import type` / `export type` lines so type-only references to
 * node-only modules (which TypeScript erases) don't trip the guard.
 */
function stripTypeOnlyImports(src: string): string {
	return src
		.replace(/^\s*import\s+type\s[^;]*;?\s*$/gm, '')
		.replace(/^\s*export\s+type\s[^;]*;?\s*$/gm, '');
}

/**
 * Extract every value-level relative module specifier from a file's `import`
 * and `export ... from` statements. Bare specifiers (e.g. `arktype`) are
 * intentionally skipped: they resolve to external packages and we only need
 * to walk first-party source here.
 */
function extractRelativeSpecifiers(src: string): string[] {
	const cleaned = stripTypeOnlyImports(src);
	const specifiers = new Set<string>();
	const re = /\b(?:import|export)\b[\s\S]*?from\s+['"]([^'"]+)['"]/g;
	for (const match of cleaned.matchAll(re)) {
		const spec = match[1];
		if (spec && spec.startsWith('.')) specifiers.add(spec);
	}
	return [...specifiers];
}

const CANDIDATE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'];
const INDEX_FILES = CANDIDATE_EXTENSIONS.flatMap((ext) => [
	`/index${ext}`,
	`index${ext}`,
]);

function resolveSpecifier(fromFile: string, spec: string): string | null {
	const base = resolve(dirname(fromFile), spec);
	const candidates: string[] = [];
	if (/\.[cm]?[jt]sx?$/.test(base)) {
		candidates.push(base);
		candidates.push(base.replace(/\.js$/, '.ts'));
		candidates.push(base.replace(/\.jsx$/, '.tsx'));
	} else {
		for (const ext of CANDIDATE_EXTENSIONS) candidates.push(`${base}${ext}`);
		for (const idx of INDEX_FILES) candidates.push(`${base}${idx}`);
	}
	for (const candidate of candidates) {
		try {
			readFileSync(candidate, 'utf8');
			return candidate;
		} catch {
			// try next candidate
		}
	}
	return null;
}

function collectReachableFiles(entry: string): Set<string> {
	const visited = new Set<string>();
	const queue = [entry];
	while (queue.length > 0) {
		const file = queue.shift()!;
		if (visited.has(file)) continue;
		visited.add(file);
		const src = readFileSync(file, 'utf8');
		for (const spec of extractRelativeSpecifiers(src)) {
			const resolved = resolveSpecifier(file, spec);
			if (resolved && !visited.has(resolved)) queue.push(resolved);
		}
	}
	return visited;
}

describe('root `@epicenter/workspace` barrel is browser-safe', () => {
	test('no module reachable from src/index.ts imports node:*, bun:*, env-paths, or references Bun./process.env', () => {
		const reachable = collectReachableFiles(ROOT_BARREL);
		const offenders: string[] = [];
		for (const file of reachable) {
			const src = stripTypeOnlyImports(readFileSync(file, 'utf8'));
			for (const { pattern, label } of FORBIDDEN_PATTERNS) {
				if (pattern.test(src)) offenders.push(`${file}: ${label}`);
			}
		}
		expect(offenders).toEqual([]);
	});
});
