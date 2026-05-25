/**
 * TanStack Query bindings for billing data.
 *
 * Wraps `billingApi` with a centralized key namespace so an invalidate
 * on `billingKeys.all` clears every billing view in one call.
 */

import type { EventsQuery, UsageQuery } from '@epicenter/billing/contracts';
import { defineMutation, defineQuery } from '$lib/query/client';
import { billingApi } from './api';

export const billingKeys = {
	all: ['billing'] as const,
	overview: ['billing', 'overview'] as const,
	usage: (params: UsageQuery) => ['billing', 'usage', params] as const,
	events: (params: EventsQuery) => ['billing', 'events', params] as const,
	plans: ['billing', 'plans'] as const,
	models: ['billing', 'models'] as const,
};

export const billing = {
	overview: defineQuery({
		queryKey: billingKeys.overview,
		queryFn: () => billingApi.overview(),
	}),

	usage(params: UsageQuery = {}) {
		return defineQuery({
			queryKey: billingKeys.usage(params),
			queryFn: () => billingApi.usage(params),
		});
	},

	events(params: EventsQuery = {}) {
		return defineQuery({
			queryKey: billingKeys.events(params),
			queryFn: () => billingApi.events(params),
		});
	},

	plans: defineQuery({
		queryKey: billingKeys.plans,
		queryFn: () => billingApi.plans(),
	}),

	models: defineQuery({
		queryKey: billingKeys.models,
		queryFn: () => billingApi.models(),
	}),

	topUp: defineMutation({
		mutationKey: [...billingKeys.all, 'top-up'] as const,
		mutationFn: (successUrl?: string) =>
			billingApi.checkoutTopUp({ successUrl }),
	}),

	previewPlanChange: defineMutation({
		mutationKey: [...billingKeys.all, 'preview'] as const,
		mutationFn: (params: { planId: string }) =>
			billingApi.previewPlanChange(params),
	}),

	checkoutPlan: defineMutation({
		mutationKey: [...billingKeys.all, 'checkout-plan'] as const,
		mutationFn: (params: { planId: string; successUrl?: string }) =>
			billingApi.checkoutPlan(params),
	}),
};
