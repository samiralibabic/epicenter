/**
 * Wire DTOs for the `/api/billing/*` surface.
 *
 * Both the server and the dashboard derive their typed boundaries from
 * this file. The server's billing service emits these shapes; the
 * dashboard's fetch client consumes them. Neither side imports
 * `autumn-js` directly: every Autumn response is mapped to the Epicenter
 * DTO inside the service so that swapping providers (or sharding billing
 * across more than one provider) is a server-only change.
 *
 * Field naming is Epicenter-shaped, not Autumn-shaped. For example, the
 * checkout result exposes `checkoutUrl` (nullable when no payment is
 * required) rather than Autumn's `paymentUrl`; the portal endpoint
 * returns `{ portalUrl: string }` rather than a vendor envelope.
 */

/** Snapshot of the customer's current plan and credit balance. */
export type BillingOverview = {
	/** Display name of the active plan, resolved server-side from the
	 *  catalog or the Autumn plan name. Free tier when no paid
	 *  subscription exists. Never derived client-side. */
	planDisplayName: string;
	/** Trial details when the subscription is in its free-trial window. */
	trial: {
		endsAtMs: number;
		daysLeft: number;
	} | null;
	/** Credit wallet snapshot. */
	credits: {
		/** Credits available to spend right now. */
		remaining: number;
		/** Credits granted this cycle (includes rollover and top-up). */
		granted: number;
		/** Subset of `remaining` attributable to the current monthly grant. */
		monthlyRemaining: number;
		/** Subset of `remaining` attributable to carried-over rollover. */
		rolloverRemaining: number;
		/** When the monthly grant next resets. Null if never. */
		nextResetAtMs: number | null;
	};
	/** Storage usage snapshot. */
	storage: {
		usedBytes: number;
		includedBytes: number;
	};
};

/** Single plan card rendered on the upgrade UI. */
export type BillingPlanCard = {
	id: string;
	displayName: string;
	/** Price string as displayed on the card (e.g. "$20/mo"). */
	displayedPrice: string;
	/** Price normalized per month for the "annualized monthly" row
	 *  shown on annual cards. Equals `displayedPrice` for monthly. */
	displayedPricePerMonth: string;
	/** "{n} credits/mo" copy resolved server-side. */
	displayedCreditsPerCycle: string;
	/** "$1/100 overage" copy resolved server-side; null when no overage. */
	displayedOverage: string | null;
	rollover: boolean;
	isRecommended: boolean;
	/** Button label / state. `'Current'` means the plan is already active;
	 *  the other three are upgrade-relative verbs from the provider. */
	cta: 'Current' | 'Upgrade' | 'Downgrade' | 'Switch';
	/** True when the active subscription is in a free trial for this plan. */
	isTrialing: boolean;
};

/** Catalog of the current customer's plan options. The active plan is
 *  signalled per-card via `cta === 'Current'`; consumers read the active
 *  plan's display name from `BillingOverview.planDisplayName` (one
 *  source of truth, served by `/overview`). */
export type BillingPlansView = {
	cards: {
		monthly: BillingPlanCard[];
		annual: BillingPlanCard[];
	};
	/** One-off credit top-up offer. The plan id is server-resolved by
	 *  `/checkout/top-up`; the dashboard renders price + grant size. */
	topUp: {
		creditsPerPurchase: number;
		priceUsd: number;
	};
};

/** Time-bucketed usage suitable for a stacked chart. */
export type UsageSeries = {
	/** Total credits consumed over the window. */
	totalCredits: number;
	/** Total number of calls over the window. */
	totalCalls: number;
	/** Ordered series, one entry per time bucket. */
	buckets: Array<{
		/** ISO timestamp for the bucket start. */
		periodIso: string;
		/** Credit usage grouped by the requested key (typically model). */
		groupedCredits: Record<string, number>;
	}>;
};

/** Single billing event (charge or refund) for the activity feed. */
export type BillingEvent = {
	/** Stable id for keyed renders. */
	id: string;
	/** Epoch ms at which the event was recorded. */
	timestampMs: number;
	/** Model that produced the charge; null for refunds without metadata. */
	model: string | null;
	/** Provider that produced the charge; null for refunds without metadata. */
	provider: string | null;
	/** Credits deducted on this event. Negative values are refunds. */
	credits: number;
};

export type BillingEventsPage = {
	events: BillingEvent[];
};

/** Result of an attach operation (subscription change or top-up).
 *  `checkoutUrl` is the Stripe-hosted page URL when payment is
 *  required; null when the change applied without checkout (e.g.
 *  downgrade with credit). */
export type CheckoutResult = {
	checkoutUrl: string | null;
};

/** Preview of the cost of switching to a target plan. */
export type PlanChangePreview = {
	/** Server-rendered single-line summary for the confirm dialog. */
	displayedSummary: string;
};

/** Portal session for managing payment methods and invoices. */
export type PortalSession = {
	portalUrl: string;
};

/** Static cost guide for the dashboard's model table. */
export type ModelCostGuide = {
	models: Array<{
		model: string;
		provider: 'OpenAI' | 'Google' | 'xAI' | 'Unknown';
		credits: number;
	}>;
};

// ---------------------------------------------------------------------
// Request shapes (dashboard -> server)
// ---------------------------------------------------------------------

/** Usage query window. Validated server-side via arktype. */
export type UsageQuery = {
	range?: '24h' | '7d' | '30d' | '90d' | 'last_cycle';
	binSize?: 'hour' | 'day' | 'month';
	groupBy?: 'model' | 'provider';
	maxGroups?: number;
};

export type EventsQuery = {
	limit?: number;
};
