/**
 * Billing service.
 *
 * Owns every Autumn round-trip in the cloud worker. Routes and policies
 * call into this service, which returns Epicenter DTOs from
 * `@epicenter/billing/contracts`. Nothing outside this module imports
 * `autumn-js` at runtime.
 *
 * Lifecycle: one service per request. Construct via
 * `createBillingService(env, { userId, userEmail })`. The service does
 * NOT cache the customer across calls; each public method makes the
 * Autumn calls it needs and returns a DTO.
 */

import type { UserId } from '@epicenter/auth';
import { MODEL_CREDITS } from '@epicenter/billing/ai-model-pricing';
import {
	FEATURE_IDS,
	FREE_TIER_MAX_CREDITS_PER_CALL,
	getPlan,
	PLAN_IDS,
	PLANS,
	type PlanId,
	VISIBLE_SUBSCRIPTION_PLAN_IDS,
} from '@epicenter/billing/catalog';
import type {
	BillingEvent,
	BillingEventsPage,
	BillingOverview,
	BillingPlanCard,
	BillingPlansView,
	CheckoutResult,
	EventsQuery,
	PlanChangePreview,
	PortalSession,
	UsageQuery,
	UsageSeries,
} from '@epicenter/billing/contracts';
import { AiChatError } from '@epicenter/constants/ai-chat-errors';
import { AssetError } from '@epicenter/constants/asset-errors';
import { Autumn } from 'autumn-js';
import { Ok, type Result } from 'wellcrafted/result';

// ---------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------

type Identity = {
	userId: UserId;
	/** AuthUser.email is always a string (Better Auth guarantee); no
	 *  null coercion needed at the boundary. */
	userEmail: string;
};

// ---------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------

/**
 * Build a per-request billing service.
 *
 * The Autumn SDK defaults `failOpen: true`, meaning a vendor outage
 * causes `check()` to silently allow the request. That is the wrong
 * default for paid features: if we can't verify entitlement, we must
 * reject. We pass `failOpen: false` so every billing check fails CLOSED.
 */
export function createBillingService(
	env: { AUTUMN_SECRET_KEY: string },
	identity: Identity,
) {
	const autumn = new Autumn({
		secretKey: env.AUTUMN_SECRET_KEY,
		failOpen: false,
	});

	/** Load Autumn customer with subscriptions + balances expanded. */
	async function loadCustomer() {
		return autumn.customers.getOrCreate({
			customerId: identity.userId,
			email: identity.userEmail,
			expand: ['subscriptions.plan', 'balances.feature'],
		});
	}

	// ----- AI guard -----------------------------------------------------

	async function guardAiChat(input: {
		model: string;
		provider: string | undefined;
	}): Promise<Result<{ credits: number }, AiChatError>> {
		const credits = MODEL_CREDITS[input.model as keyof typeof MODEL_CREDITS];
		if (credits === undefined) {
			return AiChatError.UnknownModel({ model: input.model });
		}

		// Resolve the active plan from a single customer fetch.
		const customer = await loadCustomer();
		const mainSub = customer.subscriptions.find((s) => !s.addOn) ?? null;
		const planId = mainSub?.planId ?? PLAN_IDS.free;

		// Free tier rejects models above the per-call ceiling.
		if (planId === PLAN_IDS.free && credits > FREE_TIER_MAX_CREDITS_PER_CALL) {
			return AiChatError.ModelRequiresPaidPlan({
				model: input.model,
				credits,
			});
		}

		// Atomic check + deduct. `sendEvent: true` makes Autumn record the
		// usage as part of the same call, so a second concurrent request
		// cannot read the same balance.
		const { allowed, balance } = await autumn.check({
			customerId: identity.userId,
			featureId: FEATURE_IDS.aiUsage,
			requiredBalance: credits,
			sendEvent: true,
			withPreview: true,
			properties: { model: input.model, provider: input.provider },
		});

		if (!allowed) {
			return AiChatError.InsufficientCredits({ balance });
		}

		return Ok({ credits });
	}

	function refundAiCharge(credits: number): Promise<unknown> {
		return autumn.track({
			customerId: identity.userId,
			featureId: FEATURE_IDS.aiUsage,
			value: -credits,
		});
	}

	// ----- Storage guard ------------------------------------------------

	async function guardAssetUpload(
		fileSize: number,
	): Promise<Result<void, AssetError>> {
		// Seed the customer so the storage balance materializes from the
		// auto-enable free plan before we check it.
		await autumn.customers.getOrCreate({
			customerId: identity.userId,
			email: identity.userEmail,
		});

		const { allowed } = await autumn.check({
			customerId: identity.userId,
			featureId: FEATURE_IDS.storageBytes,
			requiredBalance: fileSize,
		});

		if (!allowed) {
			return AssetError.StorageLimitExceeded({ requestedBytes: fileSize });
		}
		return Ok(undefined);
	}

	function trackAssetUpload(sizeBytes: number): Promise<unknown> {
		return autumn.track({
			customerId: identity.userId,
			featureId: FEATURE_IDS.storageBytes,
			value: sizeBytes,
		});
	}

	function releaseAssetStorage(sizeBytes: number): Promise<unknown> {
		return autumn.track({
			customerId: identity.userId,
			featureId: FEATURE_IDS.storageBytes,
			value: -sizeBytes,
		});
	}

	// ----- Dashboard data plane -----------------------------------------

	async function getOverview(): Promise<BillingOverview> {
		const customer = await loadCustomer();
		const mainSub = customer.subscriptions.find((s) => !s.addOn) ?? null;
		const planId = mainSub?.planId ?? PLAN_IDS.free;
		const catalogPlan = getPlan(planId);
		const planDisplayName =
			mainSub?.plan?.name ?? (catalogPlan ? catalogPlan.displayName : planId);

		const creditsBalance = customer.balances?.[FEATURE_IDS.aiCredits];
		const monthlyEntry = creditsBalance?.breakdown?.find(
			(e) => e.reset?.interval === 'month',
		);
		const rolloverEntry = creditsBalance?.rollovers?.[0];
		const storageBalance = customer.balances?.[FEATURE_IDS.storageBytes];
		const storageIncluded =
			catalogPlan && catalogPlan.kind === 'subscription'
				? catalogPlan.storage.includedBytes
				: 0;

		const trial =
			mainSub?.trialEndsAt != null
				? {
						endsAtMs: mainSub.trialEndsAt,
						daysLeft: Math.max(
							0,
							Math.ceil((mainSub.trialEndsAt - Date.now()) / 86_400_000),
						),
					}
				: null;

		return {
			planDisplayName,
			trial,
			credits: {
				remaining: creditsBalance?.remaining ?? 0,
				granted: creditsBalance?.granted ?? 0,
				monthlyRemaining: monthlyEntry?.remaining ?? 0,
				rolloverRemaining: rolloverEntry?.balance ?? 0,
				nextResetAtMs: creditsBalance?.nextResetAt ?? null,
			},
			storage: {
				usedBytes: storageBalance?.usage ?? 0,
				includedBytes: storageBalance?.granted ?? storageIncluded,
			},
		};
	}

	async function listPlans(): Promise<BillingPlansView> {
		const [customer, autumnPlans] = await Promise.all([
			loadCustomer(),
			autumn.plans.list({ customerId: identity.userId }),
		]);

		const eligibilityByPlanId = new Map(
			(autumnPlans.list ?? []).map(
				(p) => [p.id, p.customerEligibility?.attachAction] as const,
			),
		);

		const mainSub = customer.subscriptions.find((s) => !s.addOn) ?? null;
		const currentPlanId = mainSub?.planId ?? PLAN_IDS.free;

		function renderCard(planId: PlanId): BillingPlanCard {
			const plan = PLANS[planId];
			// VISIBLE_SUBSCRIPTION_PLAN_IDS never contains the top-up plan;
			// this narrow is the type-level proof of that invariant.
			if (plan.kind !== 'subscription') {
				throw new Error(`Plan ${planId} is not a subscription plan`);
			}
			const price = plan.basePrice;
			const displayedPrice = price
				? `$${price.amountUsd.toLocaleString()}/${
						price.interval === 'month' ? 'mo' : 'yr'
					}`
				: 'Free';
			const displayedPricePerMonth =
				price && price.interval === 'year'
					? `$${Math.round(price.amountUsd / 12)}/mo`
					: displayedPrice;

			const displayedCreditsPerCycle = `${plan.credits.grantedPerCycle.toLocaleString()} credits/mo`;
			const displayedOverage = plan.credits.overage
				? `$${formatUsd(plan.credits.overage.priceUsd)}/${plan.credits.overage.billingUnits} overage`
				: null;

			// Annual cards highlight the matching monthly subscription (and
			// vice versa) so the user sees which cycle they are on.
			const isCurrent =
				currentPlanId === planId ||
				(plan.monthlyEquivalentId !== null &&
					plan.monthlyEquivalentId === currentPlanId);

			let cta: BillingPlanCard['cta'];
			if (isCurrent) {
				cta = 'Current';
			} else {
				const action = eligibilityByPlanId.get(planId);
				cta =
					action === 'upgrade'
						? 'Upgrade'
						: action === 'downgrade'
							? 'Downgrade'
							: 'Switch';
			}

			return {
				id: plan.id,
				displayName: plan.displayName.replace(' (Annual)', ''),
				displayedPrice,
				displayedPricePerMonth,
				displayedCreditsPerCycle,
				displayedOverage,
				rollover: plan.rollover,
				isRecommended: plan.isRecommended,
				cta,
				isTrialing: mainSub?.trialEndsAt != null && mainSub.planId === plan.id,
			};
		}

		const topUp = PLANS[PLAN_IDS.creditTopUp];

		return {
			cards: {
				monthly: VISIBLE_SUBSCRIPTION_PLAN_IDS.monthly.map(renderCard),
				annual: VISIBLE_SUBSCRIPTION_PLAN_IDS.annual.map(renderCard),
			},
			topUp: {
				creditsPerPurchase: topUp.creditsPerPurchase,
				priceUsd: topUp.priceUsd,
			},
		};
	}

	async function listUsage(query: UsageQuery): Promise<UsageSeries> {
		const result = await autumn.events.aggregate({
			customerId: identity.userId,
			featureId: FEATURE_IDS.aiUsage,
			range: query.range,
			binSize: query.binSize,
			groupBy:
				query.groupBy === 'model'
					? 'properties.model'
					: query.groupBy === 'provider'
						? 'properties.provider'
						: undefined,
			maxGroups: query.maxGroups,
		});

		const total = result.total?.[FEATURE_IDS.aiUsage];
		return {
			totalCredits: total?.sum ?? 0,
			totalCalls: total?.count ?? 0,
			buckets: (result.list ?? []).map((period) => ({
				periodIso: new Date(period.period).toISOString(),
				groupedCredits: period.groupedValues?.[FEATURE_IDS.aiUsage] ?? {},
			})),
		};
	}

	async function listEvents(query: EventsQuery): Promise<BillingEventsPage> {
		const result = await autumn.events.list({
			customerId: identity.userId,
			featureId: FEATURE_IDS.aiUsage,
			limit: query.limit,
		});

		const events: BillingEvent[] = (result.list ?? []).map((e) => {
			const props = (e.properties ?? {}) as Record<string, unknown>;
			return {
				id: e.id,
				timestampMs: e.timestamp,
				model: typeof props.model === 'string' ? props.model : null,
				provider: typeof props.provider === 'string' ? props.provider : null,
				credits: e.value,
			};
		});

		return { events };
	}

	async function previewPlanChange(input: {
		planId: string;
	}): Promise<PlanChangePreview> {
		const preview = await autumn.billing.previewAttach({
			customerId: identity.userId,
			planId: input.planId,
		});
		// Autumn returns `total` in cents.
		const prorationAmountUsd = (preview.total ?? 0) / 100;
		const displayedSummary =
			prorationAmountUsd > 0
				? `You will be charged $${formatUsd(prorationAmountUsd)} today (prorated).`
				: 'No charge today. Plan changes take effect at the next renewal.';
		return { displayedSummary };
	}

	async function checkoutPlan(input: {
		planId: string;
		successUrl?: string | undefined;
	}): Promise<CheckoutResult> {
		// Rollover plans carry the credit wallet across the upgrade. The
		// catalog answers "is this a rollover plan" so route handlers
		// don't ship hard-coded plan-id lists.
		const target = getPlan(input.planId);
		const carry =
			target && target.kind === 'subscription' && target.rollover
				? { enabled: true, featureIds: [FEATURE_IDS.aiCredits] }
				: undefined;

		const result = await autumn.billing.attach({
			customerId: identity.userId,
			planId: input.planId,
			successUrl: input.successUrl,
			...(carry ? { carryOverBalances: carry } : {}),
		});
		return { checkoutUrl: result.paymentUrl };
	}

	async function checkoutTopUp(input: {
		successUrl?: string | undefined;
	}): Promise<CheckoutResult> {
		const result = await autumn.billing.attach({
			customerId: identity.userId,
			planId: PLAN_IDS.creditTopUp,
			successUrl: input.successUrl,
		});
		return { checkoutUrl: result.paymentUrl };
	}

	async function openPortal(input: {
		returnUrl: string;
	}): Promise<PortalSession> {
		const result = await autumn.billing.openCustomerPortal({
			customerId: identity.userId,
			returnUrl: input.returnUrl,
		});
		return { portalUrl: result.url };
	}

	return {
		guardAiChat,
		refundAiCharge,
		guardAssetUpload,
		trackAssetUpload,
		releaseAssetStorage,
		getOverview,
		listPlans,
		listUsage,
		listEvents,
		previewPlanChange,
		checkoutPlan,
		checkoutTopUp,
		openPortal,
	};
}

function formatUsd(amount: number): string {
	return Number.isInteger(amount) ? `${amount}` : amount.toFixed(2);
}
