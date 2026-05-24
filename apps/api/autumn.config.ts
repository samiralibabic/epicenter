import { feature, item, plan } from 'atmn';
import {
	ANNUAL_PLANS,
	FEATURE_IDS,
	PLAN_IDS,
	PLANS,
} from './src/billing-plans';

/** Asserts a value is non-null at runtime. Used for plan fields that are null on some tiers. */
function defined<T>(value: T): NonNullable<T> {
	if (value == null)
		throw new Error('Expected defined value in billing plan config');
	return value as NonNullable<T>;
}

// ---------------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------------

export const aiUsage = feature({
	id: FEATURE_IDS.aiUsage,
	name: 'AI Usage',
	type: 'metered',
	consumable: true,
});

export const aiCredits = feature({
	id: FEATURE_IDS.aiCredits,
	name: 'AI Credits',
	type: 'credit_system',
	creditSchema: [{ meteredFeatureId: aiUsage.id, creditCost: 1 }],
});

export const storageBytes = feature({
	id: FEATURE_IDS.storageBytes,
	name: 'Storage',
	type: 'metered',
	consumable: false,
});

// ---------------------------------------------------------------------------
// Plans — Monthly
// ---------------------------------------------------------------------------

const freePlan = PLANS[PLAN_IDS.free];
export const free = plan({
	id: PLAN_IDS.free,
	name: freePlan.name,
	group: freePlan.group,
	autoEnable: freePlan.autoEnable,
	items: [
		item({
			featureId: aiCredits.id,
			included: freePlan.credits.included,
			reset: { interval: freePlan.credits.reset },
		}),
		item({ featureId: storageBytes.id, included: 0 }),
	],
});

const proPlan = PLANS[PLAN_IDS.pro];
export const pro = plan({
	id: PLAN_IDS.pro,
	name: proPlan.name,
	group: proPlan.group,
	price: defined(proPlan.price),
	items: [
		item({
			featureId: aiCredits.id,
			included: proPlan.credits.included,
			price: {
				amount: proPlan.credits.overage.amount,
				billingUnits: proPlan.credits.overage.billingUnits,
				billingMethod: proPlan.credits.overage.billingMethod,
				interval: proPlan.credits.reset,
			},
		}),
		item({
			featureId: storageBytes.id,
			included: 5_000_000_000,
			price: {
				amount: 1,
				billingUnits: 1_000_000_000,
				billingMethod: 'usage_based' as const,
				interval: proPlan.credits.reset,
			},
		}),
	],
});

const ultraPlan = PLANS[PLAN_IDS.ultra];
export const ultra = plan({
	id: PLAN_IDS.ultra,
	name: ultraPlan.name,
	group: ultraPlan.group,
	price: defined(ultraPlan.price),
	freeTrial: { durationLength: 14, durationType: 'day', cardRequired: false },
	autoEnable: true,
	items: [
		item({
			featureId: aiCredits.id,
			included: ultraPlan.credits.included,
			price: {
				amount: ultraPlan.credits.overage.amount,
				billingUnits: ultraPlan.credits.overage.billingUnits,
				billingMethod: ultraPlan.credits.overage.billingMethod,
				interval: ultraPlan.credits.reset,
			},
			rollover: { max: null, expiryDurationType: 'forever' },
		}),
		item({
			featureId: storageBytes.id,
			included: 10_000_000_000,
			price: {
				amount: 0.75,
				billingUnits: 1_000_000_000,
				billingMethod: 'usage_based' as const,
				interval: ultraPlan.credits.reset,
			},
		}),
	],
});

const maxPlan = PLANS[PLAN_IDS.max];
export const max = plan({
	id: PLAN_IDS.max,
	name: maxPlan.name,
	group: maxPlan.group,
	price: defined(maxPlan.price),
	items: [
		item({
			featureId: aiCredits.id,
			included: maxPlan.credits.included,
			price: {
				amount: maxPlan.credits.overage.amount,
				billingUnits: maxPlan.credits.overage.billingUnits,
				billingMethod: maxPlan.credits.overage.billingMethod,
				interval: maxPlan.credits.reset,
			},
			rollover: { max: null, expiryDurationType: 'forever' },
		}),
		item({
			featureId: storageBytes.id,
			included: 50_000_000_000,
			price: {
				amount: 0.5,
				billingUnits: 1_000_000_000,
				billingMethod: 'usage_based' as const,
				interval: maxPlan.credits.reset,
			},
		}),
	],
});

const creditTopUpPlan = PLANS[PLAN_IDS.creditTopUp];
export const creditTopUp = plan({
	id: PLAN_IDS.creditTopUp,
	name: creditTopUpPlan.name,
	addOn: creditTopUpPlan.addOn,
	items: [
		item({
			featureId: aiCredits.id,
			price: {
				amount: defined(creditTopUpPlan.credits.overage).amount,
				billingUnits: defined(creditTopUpPlan.credits.overage).billingUnits,
				billingMethod: defined(creditTopUpPlan.credits.overage).billingMethod,
				interval: 'month',
			},
		}),
	],
});

// ---------------------------------------------------------------------------
// Plans — Annual (~17% discount, credits still reset monthly)
// ---------------------------------------------------------------------------

const proAnnualPlan = ANNUAL_PLANS[PLAN_IDS.proAnnual];
export const proAnnual = plan({
	id: PLAN_IDS.proAnnual,
	name: proAnnualPlan.name,
	group: proAnnualPlan.group,
	price: defined(proAnnualPlan.price),
	items: [
		item({
			featureId: aiCredits.id,
			included: proAnnualPlan.credits.included,
			price: {
				amount: proAnnualPlan.credits.overage.amount,
				billingUnits: proAnnualPlan.credits.overage.billingUnits,
				billingMethod: proAnnualPlan.credits.overage.billingMethod,
				interval: 'month',
			},
		}),
		item({
			featureId: storageBytes.id,
			included: 5_000_000_000,
			price: {
				amount: 1,
				billingUnits: 1_000_000_000,
				billingMethod: 'usage_based' as const,
				interval: 'month',
			},
		}),
	],
});

const ultraAnnualPlan = ANNUAL_PLANS[PLAN_IDS.ultraAnnual];
export const ultraAnnual = plan({
	id: PLAN_IDS.ultraAnnual,
	name: ultraAnnualPlan.name,
	group: ultraAnnualPlan.group,
	price: defined(ultraAnnualPlan.price),
	items: [
		item({
			featureId: aiCredits.id,
			included: ultraAnnualPlan.credits.included,
			price: {
				amount: ultraAnnualPlan.credits.overage.amount,
				billingUnits: ultraAnnualPlan.credits.overage.billingUnits,
				billingMethod: ultraAnnualPlan.credits.overage.billingMethod,
				interval: 'month',
			},
			rollover: { max: null, expiryDurationType: 'forever' },
		}),
		item({
			featureId: storageBytes.id,
			included: 10_000_000_000,
			price: {
				amount: 0.75,
				billingUnits: 1_000_000_000,
				billingMethod: 'usage_based' as const,
				interval: 'month',
			},
		}),
	],
});

const maxAnnualPlan = ANNUAL_PLANS[PLAN_IDS.maxAnnual];
export const maxAnnual = plan({
	id: PLAN_IDS.maxAnnual,
	name: maxAnnualPlan.name,
	group: maxAnnualPlan.group,
	price: defined(maxAnnualPlan.price),
	items: [
		item({
			featureId: aiCredits.id,
			included: maxAnnualPlan.credits.included,
			price: {
				amount: maxAnnualPlan.credits.overage.amount,
				billingUnits: maxAnnualPlan.credits.overage.billingUnits,
				billingMethod: maxAnnualPlan.credits.overage.billingMethod,
				interval: 'month',
			},
			rollover: { max: null, expiryDurationType: 'forever' },
		}),
		item({
			featureId: storageBytes.id,
			included: 50_000_000_000,
			price: {
				amount: 0.5,
				billingUnits: 1_000_000_000,
				billingMethod: 'usage_based' as const,
				interval: 'month',
			},
		}),
	],
});
