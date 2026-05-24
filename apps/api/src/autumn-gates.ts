/**
 * Cloud-only Hono middleware that wraps `@epicenter/server` sub-apps with
 * Autumn-backed billing.
 *
 * Three gates layered over library handlers:
 *
 *   ensurePlanId        After auth, before AI: caches the active plan on
 *                       `c.var.planId` so other middleware can read it.
 *
 *   autumnAiGate        Around `/api/ai/chat`. Reads the chat body to
 *                       resolve credits, rejects free-tier callers on
 *                       expensive models, deducts credits atomically via
 *                       `autumn.check({ sendEvent: true })`, refunds on
 *                       4xx/5xx responses.
 *
 *   autumnStorageGate   Around `/api/.../assets`. Pre-flights POST uploads
 *                       against storage balance, tracks usage on 201
 *                       responses, refunds bytes on 204 DELETE responses
 *                       (size carried back via `x-deleted-size-bytes`).
 *
 * The library is billing-agnostic; everything here is cloud-specific.
 */

import type { Env as ServerEnv } from '@epicenter/server';
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { createAutumn } from './autumn.js';
import { FEATURE_IDS, PLAN_IDS } from './billing-plans.js';
import { MODEL_CREDITS } from './model-costs.js';

/**
 * Cloud `Env` extends the library's with the `planId` variable populated
 * by `ensurePlanId` and read by `autumnAiGate`.
 */
export type Env = {
	Bindings: ServerEnv['Bindings'];
	Variables: ServerEnv['Variables'] & { planId: string | undefined };
};

/** Free tier accepts only the cheapest models (1-2 credits). */
const FREE_TIER_MAX_CREDITS = 2;

/**
 * Populate `c.var.planId` from the user's active Autumn subscription. Mount
 * after the auth middleware so `c.var.user` is available.
 */
export const ensurePlanId = createMiddleware<Env>(async (c, next) => {
	const autumn = createAutumn(c.env);
	const customer = await autumn.customers.getOrCreate({
		customerId: c.var.user.id,
		email: c.var.user.email ?? undefined,
		expand: ['subscriptions.plan'],
	});
	const mainSub = customer.subscriptions?.find(
		(s: { addOn?: boolean }) => !s.addOn,
	);
	c.set('planId', mainSub?.planId ?? PLAN_IDS.free);
	await next();
});

type AiChatBody = {
	data?: { model?: string; provider?: string };
	apiKey?: string;
};

/**
 * Plan + credit gate around `/api/ai/chat`. BYOK callers (passing `apiKey`
 * in the body) bypass billing entirely.
 */
export const autumnAiGate = createMiddleware<Env>(async (c, next) => {
	const body = (await c.req.json().catch(() => ({}))) as AiChatBody;

	// BYOK: caller-provided key, no billing.
	if (body.apiKey) {
		return next();
	}

	const model = body.data?.model;
	const credits = model
		? MODEL_CREDITS[model as keyof typeof MODEL_CREDITS]
		: undefined;
	if (credits === undefined) {
		return c.json({ name: 'unknown_model', model }, 400);
	}

	if (c.var.planId === PLAN_IDS.free && credits > FREE_TIER_MAX_CREDITS) {
		return c.json({ name: 'model_requires_paid_plan', model, credits }, 403);
	}

	const autumn = createAutumn(c.env);
	const { allowed, balance } = await autumn.check({
		customerId: c.var.user.id,
		featureId: FEATURE_IDS.aiUsage,
		requiredBalance: credits,
		sendEvent: true,
		withPreview: true,
		properties: { model, provider: body.data?.provider },
	});

	if (!allowed) {
		return c.json({ name: 'insufficient_credits', balance }, 402);
	}

	await next();

	// Refund on error responses. Successful streams keep the deducted credits.
	if (c.res.status >= 400) {
		c.var.afterResponse.push(
			autumn.track({
				customerId: c.var.user.id,
				featureId: FEATURE_IDS.aiUsage,
				value: -credits,
			}),
		);
	}
});

/**
 * Storage quota gate around `/api/.../assets`. Pre-checks uploads against
 * the user's remaining storage, tracks usage on success, refunds on
 * delete.
 */
export const autumnStorageGate = createMiddleware<Env>(async (c, next) => {
	const method = c.req.method;

	if (method === 'POST') {
		const parsed = await c.req.parseBody({ all: false }).catch(() => null);
		const file = parsed?.file;
		if (!(file instanceof File)) {
			// Library will return 400; nothing to gate.
			return next();
		}

		const autumn = createAutumn(c.env);
		await autumn.customers.getOrCreate({
			customerId: c.var.user.id,
			email: c.var.user.email ?? undefined,
		});

		const { allowed } = await autumn.check({
			customerId: c.var.user.id,
			featureId: FEATURE_IDS.storageBytes,
			requiredBalance: file.size,
		});
		if (!allowed) {
			return c.json({ name: 'storage_limit_exceeded' }, 402);
		}

		await next();

		if (c.res.status === 201) {
			c.var.afterResponse.push(
				autumn.track({
					customerId: c.var.user.id,
					featureId: FEATURE_IDS.storageBytes,
					value: file.size,
				}),
			);
		}
		return;
	}

	if (method === 'DELETE') {
		await next();
		if (c.res.status !== 204) return;
		const sizeHeader = c.res.headers.get('x-deleted-size-bytes');
		const size = sizeHeader ? Number.parseInt(sizeHeader, 10) : null;
		if (size == null || Number.isNaN(size)) return;
		const autumn = createAutumn(c.env);
		c.var.afterResponse.push(
			autumn.track({
				customerId: c.var.user.id,
				featureId: FEATURE_IDS.storageBytes,
				value: -size,
			}),
		);
		return;
	}

	// GET, OPTIONS, etc. pass through.
	return next();
});

/** Type helper for sub-app factories that need cloud's Env. */
export type CloudContext = Context<Env>;
