/**
 * Find pre-Owner-collapse orphans in the durable_object_instance table
 * and report what a one-shot admin route would need to enumerate in R2.
 *
 * The Owner-partition collapse changed every durable identifier from
 *   personal: `users/<userId>/...`
 *   team:     `<resource>/<id>`           (e.g. `rooms/foo`, `assets/bar`)
 * to a single uniform form:
 *   `owners/<ownerId>/...`
 *
 * Plus the HKDF info-prefix moved from `subject:` to `owner:`, so even if
 * old R2 ciphertext were addressable, its workspace keys would no longer
 * decrypt under the new derivation.
 *
 * Net effect: any data written before either change is unreachable AND
 * unreadable. For deployments that had real data, the orphaned rows +
 * objects + Durable Objects need to be enumerated and removed (R2 + DO
 * storage incurs ongoing cost).
 *
 * Greenfield deployments with no prior writes will see 0 DO orphans and
 * the R2 template can be skipped. That is the expected state for the
 * original Epicenter Cloud at this moment in 2026-05.
 *
 * Usage:
 *   cd apps/api
 *   DATABASE_URL=postgres://... bun run scripts/cleanup-pre-owner-collapse.ts
 *   # Or, for prod via Infisical:
 *   infisical run --env=prod --path=/ops -- bun run scripts/cleanup-pre-owner-collapse.ts
 *
 * Why this script is report-only:
 *   - The Postgres rows are safe to delete from the script (with a separate
 *     manual SQL after the operator confirms DO storage is wiped). But the
 *     row delete is one-line SQL and an automated `--apply` would tempt
 *     skipping the storage-wipe step. Better to keep the operator in
 *     control of ordering.
 *   - R2 key listing requires the bucket binding. Wrangler 4.x has no
 *     `r2 object list` CLI; enumeration only works from inside a Worker
 *     that has the binding. Same constraint applies to DO storage wipe
 *     (Cloudflare has no `wrangler do delete <name>`). Both are handled
 *     by adding a one-shot admin route to the Worker, running it once,
 *     and removing the route.
 */

import { Client } from 'pg';

const OWNERS_PREFIX = 'owners/';
const ASSETS_BUCKET_BINDING = 'ASSETS_BUCKET';

type OrphanDoRow = {
	do_name: string;
	storage_bytes: number | null;
	last_accessed_at: Date;
};

async function findOrphanedDoRecords(
	databaseUrl: string,
): Promise<OrphanDoRow[]> {
	const client = new Client({ connectionString: databaseUrl });
	await client.connect();
	try {
		const { rows } = await client.query<OrphanDoRow>(
			`SELECT do_name, storage_bytes, last_accessed_at
			 FROM durable_object_instance
			 WHERE do_name NOT LIKE $1
			 ORDER BY last_accessed_at DESC`,
			[`${OWNERS_PREFIX}%`],
		);
		return rows;
	} finally {
		await client.end();
	}
}

function formatBytes(value: number | null): string {
	return value == null ? '(size unknown)' : `${value} bytes`;
}

async function main() {
	const databaseUrl = process.env['DATABASE_URL'];
	if (!databaseUrl) {
		console.error(
			'DATABASE_URL is required. For prod, wrap with `infisical run --env=prod --path=/ops --`.',
		);
		process.exit(1);
	}

	console.log('=== Durable Object orphans (from durable_object_instance) ===');
	const orphanRows = await findOrphanedDoRecords(databaseUrl);
	if (orphanRows.length === 0) {
		console.log('No orphaned DO records.\n');
	} else {
		console.log(
			`Found ${orphanRows.length} orphaned DO records (do_name not starting with "owners/"):`,
		);
		for (const row of orphanRows) {
			console.log(
				`  ${row.do_name}  (${formatBytes(row.storage_bytes)}, last access ${row.last_accessed_at.toISOString()})`,
			);
		}
		console.log(`
Step 1: wipe DO storage from inside the Worker. Add a one-shot admin
route to apps/api/src/index.ts (auth-gated, removed after one run).

The handler iterates ONLY the orphan names listed below. It does NOT
enumerate the bucket via ROOM.list() or any similar API. Live DOs whose
names start with 'owners/' are not visible to this handler and cannot
be touched by it.

  // Assumes the single \`Room\` DO binding declared in wrangler.jsonc.
  // Adapt the binding name if your deployment has more than one DO class.
  app.post('/__admin/wipe-orphan-do', requireBearerUser, async (c) => {
    const orphanNames = [
${orphanRows.map((row) => `      ${JSON.stringify(row.do_name)},`).join('\n')}
    ];
    for (const name of orphanNames) {
      const id = c.env.ROOM.idFromName(name);
      await c.env.ROOM.get(id).fetch('https://internal/__wipe', { method: 'POST' });
    }
    return c.json({ wiped: orphanNames.length });
  });

The Room DO needs to handle '/__wipe' by calling ctx.storage.deleteAll().

Step 2: drop the database rows AFTER the storage wipe succeeds:

  DELETE FROM durable_object_instance WHERE do_name NOT LIKE 'owners/%';

Step 3: remove the admin route and the /__wipe handler.
`);
	}

	console.log('=== R2 asset orphans (in the ASSETS_BUCKET bucket) ===');
	console.log(`
Wrangler 4.x has no \`r2 object list\` CLI; key enumeration requires the
bucket binding. If the DO orphan section above reported zero rows AND
this deployment never wrote assets pre-collapse, R2 is clean by
construction (every R2 write goes through the same upload route that
also inserts a durable_object_instance row... no, that's not true; R2
uploads are independent. Verify manually below.)

To enumerate (and optionally delete) R2 orphans, add the same kind of
one-shot admin route as Step 1 above:

  app.get('/__admin/list-orphan-r2', requireBearerUser, async (c) => {
    const orphans: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await c.env.${ASSETS_BUCKET_BINDING}.list({ cursor, limit: 1000 });
      for (const obj of page.objects) {
        if (!obj.key.startsWith('${OWNERS_PREFIX}')) orphans.push(obj.key);
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return c.json({ count: orphans.length, keys: orphans });
  });

After reviewing the JSON response, delete in bulk (also from a one-shot
admin route, or use bunx wrangler r2 object delete for individual keys):

  app.post('/__admin/wipe-orphan-r2', requireBearerUser, async (c) => {
    const { keys } = await c.req.json<{ keys: string[] }>();
    await c.env.${ASSETS_BUCKET_BINDING}.delete(keys);
    return c.json({ wiped: keys.length });
  });

Remove both routes after one successful run.

For a quick visual check via dashboard:
  https://dash.cloudflare.com/?to=/:account/r2/default/buckets/epicenter-assets
`);

	if (orphanRows.length === 0) {
		console.log(
			'DO orphans: clean. R2 needs the one-shot route above to confirm.',
		);
	}
}

await main();
