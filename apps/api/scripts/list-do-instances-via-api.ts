/**
 * Authoritative DO instance enumeration via the Cloudflare REST API.
 *
 * The cleanup-pre-owner-collapse.ts companion script queries our
 * `durable_object_instance` table, which is best-effort telemetry: an
 * `upsert` is fired from `routes/rooms.ts` on every room access with
 * `.catch(log.warn)`. DOs created before that tracking shipped or that
 * silently failed to upsert are invisible there.
 *
 * Cloudflare's REST API is the source of truth. This script:
 *   1. Lists every DO instance in the ROOM namespace
 *   2. Counts the DB rows in durable_object_instance
 *   3. Reports the delta: CF count - DB count = untracked DOs
 *
 * Wiping is NOT in this script. The CF API has no per-instance DELETE
 * endpoint for DOs; instances can only be removed from inside a Worker
 * that has the binding (the `/__wipe` admin-route template in
 * cleanup-pre-owner-collapse.ts), or via a `deleted_classes` migration
 * in wrangler.jsonc that nukes every DO in the class.
 *
 * Required env (any of the listed names is accepted):
 *   CF_API_TOKEN | CLOUDFLARE_API_TOKEN | CLOUDFLARE_ZONE_TOKEN
 *       A Cloudflare API token. MUST have at minimum:
 *         Account -> Workers Scripts -> Read
 *       The existing CLOUDFLARE_ZONE_TOKEN in Infisical is named for
 *       DNS Zone work; if it lacks Workers Scripts:Read this script
 *       will return a 403 with a clear next-step message.
 *
 *   CF_ACCOUNT_ID | CLOUDFLARE_ACCOUNT_ID
 *       The Cloudflare account that owns the api worker. Find this at
 *       https://dash.cloudflare.com -> account home page, right side
 *       sidebar "Account ID".
 *
 *   DATABASE_URL  Postgres connection string for the api DB.
 *
 * Usage:
 *   cd apps/api
 *
 *   # `infisical run --` execs the command directly without a shell, so
 *   # `VAR=value bun ...` does NOT work. Export to your shell first
 *   # (infisical forwards parent env to the child):
 *   export CF_ACCOUNT_ID=<your account id>
 *   infisical run --env=prod --path=/ops --path=/api -- \
 *     bun run scripts/list-do-instances-via-api.ts
 *
 *   # Or use `env` to set the variable for the script process:
 *   infisical run --env=prod --path=/ops --path=/api -- \
 *     env CF_ACCOUNT_ID=<your account id> \
 *       bun run scripts/list-do-instances-via-api.ts
 *
 *   # If CLOUDFLARE_ZONE_TOKEN lacks Workers Scripts:Read, create a
 *   # new scoped token at https://dash.cloudflare.com/profile/api-tokens
 *   # (Account -> Workers Scripts -> Read; Account resources: this
 *   # account only) and pass it the same way as CF_ACCOUNT_ID:
 *   export CF_API_TOKEN=cfat_...
 */

import { Client } from 'pg';

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

// Every DO class the api worker can write to. The wrangler.jsonc binding
// is `ROOM` -> class `Room`. Earlier deployments declared `WorkspaceRoom`
// and `DocumentRoom`; those classes were dropped by the v2 migration in
// wrangler.jsonc (`deleted_classes`), which cleaned 130+ pre-collapse
// orphans in one deploy. If a future migration ever adds a new DO class
// the script should enumerate, add it here.
const ROOM_CLASS_NAMES = ['Room'] as const;

type CfNamespace = {
	id: string;
	name?: string | null;
	script?: string | null;
	class?: string | null;
};

type CfDoInstance = {
	id: string;
	hasStoredData?: boolean;
};

type CfPagedResponse<T> = {
	result: T[];
	result_info?: { cursor?: string; per_page?: number; count?: number };
	success: boolean;
	errors?: Array<{ code: number; message: string }>;
	messages?: unknown;
};

async function cfFetch<T>(
	url: string,
	token: string,
): Promise<CfPagedResponse<T>> {
	const res = await fetch(url, {
		headers: {
			Authorization: `Bearer ${token}`,
			'content-type': 'application/json',
		},
	});
	const body = (await res.json()) as CfPagedResponse<T>;
	if (!res.ok || !body.success) {
		const errors = (body.errors ?? [])
			.map((e) => `[${e.code}] ${e.message}`)
			.join('; ');
		const hint =
			res.status === 401 || res.status === 403
				? `\n\nThis usually means the API token lacks Workers Scripts:Read on this account. Create a scoped token at https://dash.cloudflare.com/profile/api-tokens (Account -> Workers Scripts -> Read; Account resources: this account) and pass it as CF_API_TOKEN.`
				: '';
		throw new Error(
			`CF API ${res.status} on ${url}: ${errors || 'unknown error'}${hint}`,
		);
	}
	return body;
}

async function findRoomNamespaces(
	accountId: string,
	token: string,
): Promise<Array<{ className: string; id: string }>> {
	const url = `${CF_API_BASE}/accounts/${accountId}/workers/durable_objects/namespaces`;
	const body = await cfFetch<CfNamespace>(url, token);
	const matches = body.result
		.filter(
			(ns): ns is CfNamespace & { class: string } =>
				typeof ns.class === 'string' &&
				(ROOM_CLASS_NAMES as readonly string[]).includes(ns.class),
		)
		.map((ns) => ({ className: ns.class, id: ns.id }));
	if (matches.length === 0) {
		const known = body.result
			.map((ns) => `${ns.class ?? '?'} (${ns.id})`)
			.join(', ');
		throw new Error(
			`No DO namespace found matching any of [${ROOM_CLASS_NAMES.join(', ')}]. Visible namespaces: ${known}`,
		);
	}
	return matches;
}

async function countDoInstances(
	accountId: string,
	namespaceId: string,
	token: string,
): Promise<{ total: number; withStoredData: number; sampleIds: string[] }> {
	let cursor: string | undefined;
	let total = 0;
	let withStoredData = 0;
	const sampleIds: string[] = [];
	do {
		const base = `${CF_API_BASE}/accounts/${accountId}/workers/durable_objects/namespaces/${namespaceId}/objects`;
		const url = cursor ? `${base}?cursor=${encodeURIComponent(cursor)}` : base;
		const body = await cfFetch<CfDoInstance>(url, token);
		for (const obj of body.result) {
			total += 1;
			if (obj.hasStoredData) withStoredData += 1;
			if (sampleIds.length < 5) sampleIds.push(obj.id);
		}
		cursor = body.result_info?.cursor || undefined;
	} while (cursor);
	return { total, withStoredData, sampleIds };
}

async function countDoRowsInDb(databaseUrl: string): Promise<number> {
	const client = new Client({ connectionString: databaseUrl });
	await client.connect();
	try {
		const { rows } = await client.query<{ count: string }>(
			'SELECT COUNT(*)::text AS count FROM durable_object_instance',
		);
		return Number(rows[0]?.count ?? '0');
	} finally {
		await client.end();
	}
}

async function main() {
	const apiToken =
		process.env.CF_API_TOKEN ??
		process.env.CLOUDFLARE_API_TOKEN ??
		process.env.CLOUDFLARE_ZONE_TOKEN;
	const accountId =
		process.env.CF_ACCOUNT_ID ?? process.env.CLOUDFLARE_ACCOUNT_ID;
	const databaseUrl = process.env.DATABASE_URL;

	const missing: string[] = [];
	if (!apiToken)
		missing.push(
			'CF_API_TOKEN (or CLOUDFLARE_API_TOKEN, CLOUDFLARE_ZONE_TOKEN)',
		);
	if (!accountId) missing.push('CF_ACCOUNT_ID (or CLOUDFLARE_ACCOUNT_ID)');
	if (!databaseUrl) missing.push('DATABASE_URL');
	if (!apiToken || !accountId || !databaseUrl) {
		console.error(`Missing required env: ${missing.join(', ')}.

Try:
  export CF_ACCOUNT_ID=<your account id>
  infisical run --env=prod --path=/ops --path=/api -- \\
    bun run scripts/list-do-instances-via-api.ts

\`infisical run --\` execs the command without a shell, so
\`CF_ACCOUNT_ID=... bun ...\` parses as the command name. Export to
your shell first (infisical forwards parent env to the child).`);
		process.exit(1);
	}

	console.log('=== Authoritative DO enumeration via Cloudflare REST API ===');
	const namespaces = await findRoomNamespaces(accountId, apiToken);
	let totalCfInstances = 0;
	let totalWithStoredData = 0;
	for (const ns of namespaces) {
		const cf = await countDoInstances(accountId, ns.id, apiToken);
		console.log(`${ns.className} (namespace_id ${ns.id})`);
		console.log(`  CF instances:         ${cf.total}`);
		console.log(`    with stored data:   ${cf.withStoredData}`);
		console.log(`    ephemeral (no data):${cf.total - cf.withStoredData}`);
		if (cf.sampleIds.length > 0) {
			console.log(
				`    sample ids:         ${cf.sampleIds.join(', ')}${cf.total > cf.sampleIds.length ? ' ...' : ''}`,
			);
		}
		totalCfInstances += cf.total;
		totalWithStoredData += cf.withStoredData;
	}
	console.log('');
	console.log(
		`Total CF instances:     ${totalCfInstances} (with stored data: ${totalWithStoredData})`,
	);

	const dbCount = await countDoRowsInDb(databaseUrl);
	console.log(`DB tracked rows:        ${dbCount}`);

	const delta = totalCfInstances - dbCount;
	console.log('');
	if (delta === 0) {
		console.log('AUTHORITATIVE: CF count matches DB count. No untracked DOs.');
	} else if (delta > 0) {
		console.log(
			`AUTHORITATIVE: CF has ${delta} more DO(s) than the DB tracks.`,
		);
		console.log(`
This means ${delta} DO instance(s) exist on Cloudflare without a row in
durable_object_instance. Possible causes:
  - DOs created before the upsert tracking shipped
  - upsert silently failed for those access events
  - some non-routes/rooms.ts code path created DOs (none today)

Since CF only returns hex IDs (names are one-way hashed), recovering
the original names is not possible from the API alone. To wipe these
untracked DOs you have two options:

  (a) Nuclear: change apps/api/wrangler.jsonc migrations to add
      { "tag": "vN",   "deleted_classes": [${ROOM_CLASS_NAMES.map((c) => JSON.stringify(c)).join(', ')}] },
      { "tag": "vN+1", "new_sqlite_classes": [${ROOM_CLASS_NAMES.map((c) => JSON.stringify(c)).join(', ')}] }
      then deploy. Every DO in those classes is destroyed; live
      workspaces repopulate on first access from cloud sync (lossy
      if any client is offline with stale ydoc state).

  (b) One-shot Worker route that iterates by hex id from the same
      CF REST API call (made from inside the worker, CF_API_TOKEN
      bound as a secret):
        for (const hexId of allCfIds) {
          const id = c.env.ROOM.idFromString(hexId);
          await c.env.ROOM.get(id).fetch('https://internal/__wipe', { method: 'POST' });
        }
      The DO class must handle '/__wipe' by calling
      ctx.storage.deleteAll(). Remove the route after one run.
`);
	} else {
		console.log(
			`DB has ${-delta} more rows than CF has instances. The DB is over-tracking.\n` +
				`This usually means rows survived a DO storage wipe and were never DELETE'd.\n` +
				`Run: DELETE FROM durable_object_instance WHERE do_name NOT IN (<known live names>);`,
		);
	}
}

await main();
