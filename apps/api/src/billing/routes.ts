/**
 * `/api/billing/*` routes for the dashboard.
 *
 * Every handler is a one-line delegate to the billing service. The
 * service owns Autumn round-trips and DTO mapping; routes own HTTP
 * shape, body validation, and the Autumn-error translation layer.
 * Auth is bundled into {@link mountBillingApi} so the data plane can't
 * be mounted without it.
 */

import { MODEL_CREDITS, providerOf } from '@epicenter/billing/ai-model-pricing';
import type { ModelCostGuide } from '@epicenter/billing/contracts';
import { API_ROUTES } from '@epicenter/constants/api-routes';
import { BillingError } from '@epicenter/constants/billing-errors';
import type { Env } from '@epicenter/server';
import { sValidator } from '@hono/standard-validator';
import { type } from 'arktype';
import { AutumnError } from 'autumn-js';
import { type Context, Hono, type MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { createBillingService } from './service.js';

const billingRoutes = new Hono<Env>();

// Translate Autumn SDK throws into the repo-wide wellcrafted envelope.
// Non-AutumnError throws (network failures, programming errors) bubble
// to the parent app's default handler for a generic 500. The body of
// an AutumnError is a raw HTTP body string; parse JSON when we can so
// downstream consumers see `{ code, message }`, fall through to raw on
// non-JSON so the upstream text is never silently dropped.
billingRoutes.onError((err, c) => {
	if (!(err instanceof AutumnError)) throw err;

	let code: string | undefined;
	let message: string = err.body;
	try {
		const parsed = JSON.parse(err.body) as unknown;
		if (parsed && typeof parsed === 'object') {
			const record = parsed as { code?: unknown; message?: unknown };
			if (typeof record.code === 'string') code = record.code;
			if (typeof record.message === 'string') message = record.message;
		}
	} catch {
		// non-JSON body; `message` already holds the raw text
	}

	return c.json(
		BillingError.ProviderRequestFailed({
			statusCode: err.statusCode,
			code,
			message,
		}),
		err.statusCode as ContentfulStatusCode,
	);
});

function svc(c: Context<Env>) {
	return createBillingService(c.env, {
		userId: c.var.user.id,
		userEmail: c.var.user.email,
	});
}

const usageQuerySchema = type({
	'range?': "'24h' | '7d' | '30d' | '90d' | 'last_cycle' | undefined",
	'binSize?': "'hour' | 'day' | 'month' | undefined",
	'groupBy?': "'model' | 'provider' | undefined",
	'maxGroups?': 'number | undefined',
});

const eventsQuerySchema = type({
	'limit?': 'number | undefined',
});

const previewPlanSchema = type({ planId: 'string' });

const checkoutPlanSchema = type({
	planId: 'string',
	'successUrl?': 'string | undefined',
});

const checkoutTopUpSchema = type({
	'successUrl?': 'string | undefined',
});

billingRoutes.get('/overview', async (c) => c.json(await svc(c).getOverview()));

billingRoutes.post('/usage', sValidator('json', usageQuerySchema), async (c) =>
	c.json(await svc(c).listUsage(c.req.valid('json'))),
);

billingRoutes.post(
	'/events',
	sValidator('json', eventsQuerySchema),
	async (c) => c.json(await svc(c).listEvents(c.req.valid('json'))),
);

billingRoutes.get('/plans', async (c) => c.json(await svc(c).listPlans()));

billingRoutes.get('/models', (c) => {
	const models = Object.entries(MODEL_CREDITS)
		.filter((entry): entry is [string, number] => entry[1] !== undefined)
		.map(([model, credits]) => ({
			model,
			provider: providerOf(model),
			credits,
		}))
		.sort((a, b) => a.credits - b.credits || a.model.localeCompare(b.model));
	return c.json({ models } satisfies ModelCostGuide);
});

billingRoutes.post(
	'/preview',
	sValidator('json', previewPlanSchema),
	async (c) => c.json(await svc(c).previewPlanChange(c.req.valid('json'))),
);

billingRoutes.post(
	'/checkout/plan',
	sValidator('json', checkoutPlanSchema),
	async (c) => c.json(await svc(c).checkoutPlan(c.req.valid('json'))),
);

billingRoutes.post(
	'/checkout/top-up',
	sValidator('json', checkoutTopUpSchema),
	async (c) => c.json(await svc(c).checkoutTopUp(c.req.valid('json'))),
);

billingRoutes.get('/portal', async (c) => {
	const returnUrl =
		c.req.query('returnUrl') ?? new URL('/dashboard', c.req.url).toString();
	return c.json(await svc(c).openPortal({ returnUrl }));
});

/**
 * Mount the cloud billing data plane on the server app.
 *
 * Bundles auth (the dashboard reaches this with cookie sessions; admin
 * scripts reach it with OAuth bearers) and the route mount into one
 * call. Lives in apps/api, not @epicenter/server, because Autumn is
 * cloud-only deployment policy.
 */
export function mountBillingApi(
	app: Hono<Env>,
	opts: { auth: MiddlewareHandler },
): void {
	app.use(API_ROUTES.billing.prefixPattern, opts.auth);
	app.route('/api/billing', billingRoutes);
}
