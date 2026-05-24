/**
 * Typed Hono routes for the billing dashboard SPA.
 *
 * All routes require auth (requireCookieOrBearerUser, applied in app.ts).
 * Data flows from Autumn's API; no custom tables needed.
 *
 * Most routes return Autumn SDK responses verbatim. The dashboard derives
 * its typed fetch client from billing-contract.ts; `/models` is the one
 * route that returns repo-owned data and satisfies its contract type.
 */

import { sValidator } from '@hono/standard-validator';
import { type } from 'arktype';
import { Hono } from 'hono';
import { createAutumn } from './autumn.js';
import type { Env } from './autumn-gates.js';
import type { ModelsResponse } from './billing-contract.js';
import { FEATURE_IDS, PLAN_IDS } from './billing-plans.js';
import { MODEL_CREDITS } from './model-costs.js';

const billingRoutes = new Hono<Env>();

// Catch Autumn SDK errors and return proper HTTP status codes instead of 500.
billingRoutes.onError((err, c) => {
	const autumnErr = err as { statusCode?: number; body?: string };
	if (autumnErr.statusCode && autumnErr.body) {
		try {
			const body = JSON.parse(autumnErr.body);
			return c.json(body, autumnErr.statusCode as 400);
		} catch {
			return c.json({ message: autumnErr.body }, autumnErr.statusCode as 400);
		}
	}
	throw err;
});

// ── Balance + subscription info ──────────────────────────────────────────

/**
 * GET /billing/balance
 *
 * Returns customer balance, subscription status, and credit breakdown.
 * The `breakdown` array separates monthly vs rollover vs top-up credits.
 */
billingRoutes.get('/balance', async (c) => {
	const autumn = createAutumn(c.env);
	const customer = await autumn.customers.getOrCreate({
		customerId: c.var.user.id,
		email: c.var.user.email ?? undefined,
		expand: ['subscriptions.plan', 'balances.feature'],
	});
	return c.json(customer);
});

// ── Usage aggregation (powers charts) ────────────────────────────────────

const usageQuerySchema = type({
	'range?': "'24h' | '7d' | '30d' | '90d' | 'last_cycle' | undefined",
	'binSize?': "'hour' | 'day' | 'month' | undefined",
	'groupBy?': "'properties.model' | 'properties.provider' | undefined",
	'maxGroups?': 'number | undefined',
});

/**
 * POST /billing/usage
 *
 * Aggregates usage events by time period and optionally by model/provider.
 * Powers the usage chart in the dashboard Overview tab.
 *
 * @example
 * ```typescript
 * // 30-day usage grouped by model
 * const res = await client.billing.usage.$post({
 *   json: { range: '30d', binSize: 'day', groupBy: 'properties.model' }
 * });
 * ```
 */
billingRoutes.post(
	'/usage',
	sValidator('json', usageQuerySchema),
	async (c) => {
		const autumn = createAutumn(c.env);
		const data = c.req.valid('json');
		const result = await autumn.events.aggregate({
			customerId: c.var.user.id,
			featureId: FEATURE_IDS.aiUsage,
			...data,
		});
		return c.json(result);
	},
);

// ── Event history (powers activity feed) ─────────────────────────────────

const eventsQuerySchema = type({
	'limit?': 'number | undefined',
	'startingAfter?': 'string | undefined',
});

/**
 * POST /billing/events
 *
 * Lists individual usage events with timestamps, model, and credit cost.
 * Powers the Activity tab in the dashboard.
 */
billingRoutes.post(
	'/events',
	sValidator('json', eventsQuerySchema),
	async (c) => {
		const autumn = createAutumn(c.env);
		const data = c.req.valid('json');
		const result = await autumn.events.list({
			customerId: c.var.user.id,
			featureId: FEATURE_IDS.aiUsage,
			...data,
		});
		return c.json(result);
	},
);

// ── Plans list ───────────────────────────────────────────────────────────

/**
 * GET /billing/plans
 *
 * Returns all available plans with customer eligibility info.
 * Used by the plan comparison cards in the dashboard.
 */
billingRoutes.get('/plans', async (c) => {
	const autumn = createAutumn(c.env);
	const plans = await autumn.plans.list({ customerId: c.var.user.id });
	return c.json(plans);
});

// ── Model credits map ────────────────────────────────────────────────────

/**
 * GET /billing/models
 *
 * Returns the MODEL_CREDITS map as JSON.
 * Powers the Model Cost Guide table in the dashboard.
 */
billingRoutes.get('/models', (c) => {
	return c.json({ credits: MODEL_CREDITS } satisfies ModelsResponse);
});

// ── Upgrade preview ──────────────────────────────────────────────────────

const planIdSchema = type({ planId: 'string' });

/**
 * POST /billing/preview
 *
 * Preview what a plan change will cost before committing.
 * Shows prorated amount for upgrades, or schedule info for downgrades.
 */
billingRoutes.post('/preview', sValidator('json', planIdSchema), async (c) => {
	const autumn = createAutumn(c.env);
	const { planId } = c.req.valid('json');
	const preview = await autumn.billing.previewAttach({
		customerId: c.var.user.id,
		planId,
	});
	return c.json(preview);
});

// ── Upgrade / attach plan ────────────────────────────────────────────────

const attachSchema = type({
	planId: 'string',
	'successUrl?': 'string | undefined',
});

/**
 * POST /billing/upgrade
 *
 * Attach a plan to the customer. For upgrades from Pro to Ultra/Max,
 * carries over unused credits via `carryOverBalances`.
 * Returns a `paymentUrl` for Stripe checkout if payment is required.
 */
billingRoutes.post('/upgrade', sValidator('json', attachSchema), async (c) => {
	const autumn = createAutumn(c.env);
	const { planId, successUrl } = c.req.valid('json');

	// Carry over credits when upgrading to Ultra/Max (plans with rollover).
	// NOTE: If a new rollover plan is added, update this set.
	const isRolloverPlan =
		planId === PLAN_IDS.ultra ||
		planId === PLAN_IDS.max ||
		planId === PLAN_IDS.ultraAnnual ||
		planId === PLAN_IDS.maxAnnual;

	const result = await autumn.billing.attach({
		customerId: c.var.user.id,
		planId,
		successUrl,
		...(isRolloverPlan && {
			carryOverBalances: {
				enabled: true,
				featureIds: [FEATURE_IDS.aiCredits],
			},
		}),
	});
	return c.json(result);
});

// ── Top-up ───────────────────────────────────────────────────────────────

/**
 * POST /billing/top-up
 *
 * Purchase a credit top-up ($5 for 500 credits).
 */
billingRoutes.post(
	'/top-up',
	sValidator('json', type({ 'successUrl?': 'string | undefined' })),
	async (c) => {
		const autumn = createAutumn(c.env);
		const { successUrl } = c.req.valid('json');
		const result = await autumn.billing.attach({
			customerId: c.var.user.id,
			planId: PLAN_IDS.creditTopUp,
			successUrl,
		});
		return c.json(result);
	},
);

// ── Stripe portal ────────────────────────────────────────────────────────

/**
 * GET /billing/portal
 *
 * Redirect to Stripe customer portal for payment method management.
 */
billingRoutes.get('/portal', async (c) => {
	const autumn = createAutumn(c.env);
	const result = await autumn.billing.openCustomerPortal({
		customerId: c.var.user.id,
		returnUrl:
			c.req.query('returnUrl') ?? new URL('/dashboard', c.req.url).toString(),
	});
	return c.json(result);
});

export { billingRoutes };
