/** TanStack Query definitions for billing data. */
import type {
	EventsParams,
	UsageParams,
} from '@epicenter/api/billing-contract';
import { api } from '$lib/api';
import { defineMutation, defineQuery } from '$lib/query/client';

/**
 * Centralized query key objects for billing queries.
 *
 * Using a key object instead of inline string arrays prevents typo-based
 * invalidation bugs and makes refactoring safe: rename a key and TypeScript
 * catches every stale reference.
 *
 * @example
 * ```typescript
 * queryClient.invalidateQueries({ queryKey: billingKeys.all });
 * queryClient.invalidateQueries({ queryKey: billingKeys.balance });
 * ```
 */
export const billingKeys = {
	all: ['billing'] as const,
	balance: ['billing', 'balance'] as const,
	usage: (params: UsageParams) => ['billing', 'usage', params] as const,
	events: (params: EventsParams) => ['billing', 'events', params] as const,
	plans: ['billing', 'plans'] as const,
	models: ['billing', 'models'] as const,
};

export const billing = {
	/** Fetch customer balance, subscription, and credit breakdown. */
	balance: defineQuery({
		queryKey: billingKeys.balance,
		queryFn: () => api.billing.balance(),
	}),

	/** Fetch aggregated usage data for charts. */
	usage(params: UsageParams = {}) {
		return defineQuery({
			queryKey: billingKeys.usage(params),
			queryFn: () => api.billing.usage(params),
		});
	},

	/** Fetch paginated event history for the activity feed. */
	events(params: EventsParams = {}) {
		return defineQuery({
			queryKey: billingKeys.events(params),
			queryFn: () => api.billing.events(params),
		});
	},

	/** Fetch available plans with customer eligibility. */
	plans: defineQuery({
		queryKey: billingKeys.plans,
		queryFn: () => api.billing.plans(),
	}),

	/** Fetch model credits map and plan metadata. */
	models: defineQuery({
		queryKey: billingKeys.models,
		queryFn: () => api.billing.models(),
	}),

	/** Buy 500 credits via Stripe checkout. */
	topUp: defineMutation({
		mutationKey: [...billingKeys.all, 'top-up'] as const,
		mutationFn: (successUrl?: string) => api.billing.topUp(successUrl),
	}),

	/** Preview proration cost before changing plans. */
	previewUpgrade: defineMutation({
		mutationKey: [...billingKeys.all, 'preview'] as const,
		mutationFn: (planId: string) => api.billing.preview(planId),
	}),

	/** Upgrade or switch billing plan via Stripe. */
	upgradePlan: defineMutation({
		mutationKey: [...billingKeys.all, 'upgrade'] as const,
		mutationFn: ({
			planId,
			successUrl,
		}: {
			planId: string;
			successUrl?: string;
		}) => api.billing.upgrade(planId, successUrl),
	}),
};
