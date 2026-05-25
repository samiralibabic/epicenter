/**
 * Typed fetch client for the `/api/billing/*` surface.
 *
 * Responses come back as Epicenter DTOs from
 * `@epicenter/billing/contracts`; the dashboard never imports
 * `autumn-js` or sees its wire shapes. Each method returns
 * `Result<T, BillingApiError>` so consumers destructure
 * `{ data, error }` instead of try/catch.
 *
 * Uses `auth.fetch` so the first-party auth cookie rides along on
 * every request. Same-origin deployment; no CORS config needed.
 */

import type {
	BillingEventsPage,
	BillingOverview,
	BillingPlansView,
	CheckoutResult,
	EventsQuery,
	ModelCostGuide,
	PlanChangePreview,
	PortalSession,
	UsageQuery,
	UsageSeries,
} from '@epicenter/billing/contracts';
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import { type Result, tryAsync } from 'wellcrafted/result';
import { auth } from '$platform/auth';

/** Tagged error for the billing API boundary. Covers network failures
 *  (fetch throws) and non-OK HTTP responses (the status guard throws). */
export const BillingApiError = defineErrors({
	RequestFailed: ({
		endpoint,
		cause,
	}: {
		endpoint: string;
		cause: unknown;
	}) => ({
		message: `Request to ${endpoint} failed: ${extractErrorMessage(cause)}`,
		endpoint,
		cause,
	}),
});
export type BillingApiError = import('wellcrafted/error').InferErrors<
	typeof BillingApiError
>;

async function get<TResponse>(
	endpoint: string,
): Promise<Result<TResponse, BillingApiError>> {
	return tryAsync({
		try: async () => {
			const res = await auth.fetch(endpoint);
			if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
			return (await res.json()) as TResponse;
		},
		catch: (cause) => BillingApiError.RequestFailed({ endpoint, cause }),
	});
}

async function post<TBody, TResponse>(
	endpoint: string,
	body: TBody,
): Promise<Result<TResponse, BillingApiError>> {
	return tryAsync({
		try: async () => {
			const res = await auth.fetch(endpoint, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			});
			if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
			return (await res.json()) as TResponse;
		},
		catch: (cause) => BillingApiError.RequestFailed({ endpoint, cause }),
	});
}

export const billingApi = {
	overview: () => get<BillingOverview>('/api/billing/overview'),

	usage: (params: UsageQuery) =>
		post<UsageQuery, UsageSeries>('/api/billing/usage', params),

	events: (params: EventsQuery = {}) =>
		post<EventsQuery, BillingEventsPage>('/api/billing/events', params),

	plans: () => get<BillingPlansView>('/api/billing/plans'),

	models: () => get<ModelCostGuide>('/api/billing/models'),

	previewPlanChange: (params: { planId: string }) =>
		post<{ planId: string }, PlanChangePreview>('/api/billing/preview', params),

	checkoutPlan: (params: { planId: string; successUrl?: string }) =>
		post<typeof params, CheckoutResult>('/api/billing/checkout/plan', params),

	checkoutTopUp: (params: { successUrl?: string } = {}) =>
		post<typeof params, CheckoutResult>('/api/billing/checkout/top-up', params),

	portal: () => get<PortalSession>('/api/billing/portal'),
};
