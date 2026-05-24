#!/usr/bin/env bun
/**
 * Reconcile Cloudflare zone settings, DNSSEC, and email DNS across every
 * zone we own. Idempotent: reads current values, diffs, PATCHes only what
 * differs. Safe to re-run any time.
 *
 *   bun run cf:plan   preview; exits 2 if drift detected (CI signal)
 *   bun run cf:apply  write changes
 *
 * Token: CLOUDFLARE_ZONE_TOKEN with scopes Zone:Read, Zone Settings:Edit,
 * DNS:Edit on all zones in the account. Create at
 * https://dash.cloudflare.com/profile/api-tokens.
 *
 * Adding a zone: add the domain to `ZONES` below. Zones marked `lockdown`
 * get SPF `-all` + DMARC `p=reject` so they cannot be used to spoof mail;
 * zones marked `managed-externally` (today only epicenter.so via Google
 * Workspace) have their email DNS left alone.
 */

import { APPS } from '@epicenter/constants/apps';

const ZONES = [
	{ name: 'epicenter.so', email: 'managed-externally' }, // Google Workspace
	{ name: 'epicenter.sh', email: 'lockdown' },
	{ name: 'epicenter.audio', email: 'lockdown' },
	{ name: 'epicenter.build', email: 'lockdown' },
	{ name: 'epicenter.chat', email: 'lockdown' },
	{ name: 'epicenter.email', email: 'lockdown' },
	{ name: 'epicenter.md', email: 'lockdown' },
	{ name: 'epicenter.social', email: 'lockdown' },
	{ name: 'getepicenter.com', email: 'lockdown' },
	{ name: 'getwhispering.com', email: 'lockdown' },
	{ name: 'opensidian.com', email: 'lockdown' },
	{ name: 'whispering.studio', email: 'lockdown' },
] as const;

const ZONE_BASELINE = {
	always_use_https: 'on',
	automatic_https_rewrites: 'on',
	ssl: 'strict',
	min_tls_version: '1.2',
	security_header: {
		strict_transport_security: {
			enabled: true,
			max_age: 15_552_000, // 180 days; revisit preload after 6-12 months stable
			include_subdomains: true,
			preload: false,
			nosniff: true,
		},
	},
} as const;

function emailLockdownRecords(zone: string) {
	return [
		{ type: 'TXT', name: zone, content: 'v=spf1 -all', ttl: 3600 },
		{
			type: 'TXT',
			name: `_dmarc.${zone}`,
			content:
				'v=DMARC1; p=reject; rua=mailto:postmaster@epicenter.so; aspf=s; adkim=s',
			ttl: 3600,
		},
	];
}

const CF_API = 'https://api.cloudflare.com/client/v4';
const token = process.env.CLOUDFLARE_ZONE_TOKEN;

if (!token) {
	console.error(
		'CLOUDFLARE_ZONE_TOKEN is not set. Create one at https://dash.cloudflare.com/profile/api-tokens',
	);
	console.error(
		'Required scopes: Zone:Read, Zone Settings:Edit, DNS:Edit (all zones).',
	);
	process.exit(1);
}

async function cf<T>(method: string, path: string, body?: unknown): Promise<T> {
	const res = await fetch(`${CF_API}${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const json = (await res.json()) as {
		success: boolean;
		result: T;
		errors?: Array<{ code: number; message: string }>;
	};
	if (!res.ok || !json.success) {
		const errs = json.errors?.map((e) => `[${e.code}] ${e.message}`).join('; ');
		throw new Error(
			`Cloudflare ${method} ${path} failed (${res.status}): ${errs ?? 'unknown error'}`,
		);
	}
	return json.result;
}

// Cross-check: every APPS URL must live on a declared zone. Adding an app on
// a new domain without first declaring its zone fails the script loudly here
// instead of silently leaving that zone unmanaged.
const orphans: string[] = [];
for (const [id, app] of Object.entries(APPS)) {
	for (const url of app.urls) {
		const host = new URL(url).hostname;
		const onZone = ZONES.some(
			(z) => host === z.name || host.endsWith(`.${z.name}`),
		);
		if (!onZone) orphans.push(`APPS.${id}: ${url}`);
	}
}
if (orphans.length > 0) {
	console.error(
		`URLs in APPS are not on any declared zone:\n  ${orphans.join('\n  ')}`,
	);
	console.error('Add the zone to ZONES in scripts/cf/apply.ts or fix the URL.');
	process.exit(1);
}

const isPlan = process.argv.includes('--plan');
const tag = isPlan ? '[plan]' : '[apply]';
let drift = 0;
const dsRecords: Array<{ zone: string; ds: string }> = [];

console.log(
	`${tag} Cloudflare baseline reconciliation across ${ZONES.length} zones`,
);

for (const zone of ZONES) {
	console.log(`\n==> ${zone.name} (email: ${zone.email})`);

	const [match] = await cf<Array<{ id: string }>>(
		'GET',
		`/zones?name=${encodeURIComponent(zone.name)}`,
	);
	if (!match) {
		console.error('    SKIP: zone not found. Add to Cloudflare account first.');
		drift++;
		continue;
	}
	const zoneId = match.id;

	for (const [id, want] of Object.entries(ZONE_BASELINE)) {
		const got = await cf<{ value: unknown }>(
			'GET',
			`/zones/${zoneId}/settings/${id}`,
		);
		if (deepEqual(got.value, want)) {
			console.log(`    ok      ${id}`);
			continue;
		}
		drift++;
		console.log(
			`    diff    ${id}: ${shortJson(got.value)} -> ${shortJson(want)}`,
		);
		if (!isPlan) {
			await cf('PATCH', `/zones/${zoneId}/settings/${id}`, { value: want });
			console.log(`    applied ${id}`);
		}
	}

	const dnssec = await cf<{ status: string; ds?: string }>(
		'GET',
		`/zones/${zoneId}/dnssec`,
	);
	if (dnssec.status !== 'active') {
		drift++;
		console.log(`    diff    dnssec: ${dnssec.status} -> active`);
		if (!isPlan) {
			const updated = await cf<{ status: string; ds?: string }>(
				'PATCH',
				`/zones/${zoneId}/dnssec`,
				{ status: 'active' },
			);
			console.log('    applied dnssec');
			if (updated.ds) {
				dsRecords.push({ zone: zone.name, ds: updated.ds });
			} else {
				console.log(
					`    note    dnssec is "${updated.status}"; DS record not yet returned. Re-run cf:plan once status flips to "active" to print the DS for the registrar.`,
				);
			}
		}
	} else {
		console.log('    ok      dnssec');
		if (dnssec.ds) dsRecords.push({ zone: zone.name, ds: dnssec.ds });
	}

	if (zone.email !== 'lockdown') {
		console.log('    skip    email DNS (managed externally)');
		continue;
	}
	for (const want of emailLockdownRecords(zone.name)) {
		const existing = await cf<Array<{ id: string; content: string }>>(
			'GET',
			`/zones/${zoneId}/dns_records?type=TXT&name=${encodeURIComponent(want.name)}`,
		);
		const isSpf = want.content.startsWith('v=spf1');
		const label = isSpf ? 'spf' : 'dmarc';
		const prefix = isSpf ? 'v=spf1' : 'v=DMARC1';
		const candidates = existing.filter((r) => r.content.startsWith(prefix));
		if (candidates.length > 1) {
			// SPF or DMARC duplicates cause receivers to reject the domain. The
			// script reconciles the first match; you must delete the rest by hand.
			console.log(
				`    warn    ${candidates.length} ${label} records on ${want.name}; mail receivers will reject this zone. Delete duplicates in the Cloudflare dashboard.`,
			);
		}
		const match = candidates[0];
		if (match?.content === want.content) {
			console.log(`    ok      txt ${label} ${want.name}`);
			continue;
		}
		drift++;
		if (match) {
			console.log(
				`    diff    txt ${label} ${want.name}:\n              from: ${match.content}\n              to:   ${want.content}`,
			);
			if (!isPlan) {
				await cf('PUT', `/zones/${zoneId}/dns_records/${match.id}`, want);
				console.log(`    applied txt ${label} ${want.name}`);
			}
		} else {
			console.log(`    create  txt ${label} ${want.name}: ${want.content}`);
			if (!isPlan) {
				await cf('POST', `/zones/${zoneId}/dns_records`, want);
				console.log(`    applied txt ${label} ${want.name}`);
			}
		}
	}
}

console.log(`\n${tag} done. ${drift} drift item(s).`);

if (dsRecords.length > 0) {
	console.log(
		'\nDS records (paste at registrar for any zone NOT registered at Cloudflare):',
	);
	for (const { zone, ds } of dsRecords) console.log(`  ${zone}: ${ds}`);
}

if (isPlan && drift > 0) process.exit(2);

function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (
		typeof a !== typeof b ||
		typeof a !== 'object' ||
		a === null ||
		b === null
	) {
		return false;
	}
	const ak = Object.keys(a as object);
	const bk = Object.keys(b as object);
	if (ak.length !== bk.length) return false;
	return ak.every((k) =>
		deepEqual(
			(a as Record<string, unknown>)[k],
			(b as Record<string, unknown>)[k],
		),
	);
}

function shortJson(v: unknown): string {
	const s = JSON.stringify(v);
	return s.length > 80 ? `${s.slice(0, 77)}...` : s;
}
