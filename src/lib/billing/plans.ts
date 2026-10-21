// ── SitePulse billing: plans, currencies, entitlements ───────────────────────
// Pure module: the single source of truth for what each plan costs and what
// it allows. Shared verbatim by the Convex billing backend, the pricing page
// and the tests — no I/O and no Convex imports (same pattern as
// src/lib/monitoring.ts). Prices are INTENTS in minor units (paise/cents) so
// nothing ever does floating-point money math.
//
// Provisional introductory pricing (Phase 7). Changing a price here changes
// the checkout amount the server charges — the client never sends an amount.

import { MAX_CLIENTS_PER_AGENCY, MAX_MEMBERS_PER_AGENCY } from "../agency";
import { MAX_MONITORS_PER_OWNER } from "../monitoring";

export type PlanId = "free" | "pro" | "agency";
export type Currency = "INR" | "USD";
export type BillingProvider = "simulated" | "stripe" | "razorpay";
export type SubscriptionStatus =
  | "active"
  | "trialing"
  | "past_due"
  | "canceled"
  | "expired";

export const PLAN_IDS: PlanId[] = ["free", "pro", "agency"];
export const CURRENCIES: Currency[] = ["INR", "USD"];

/** Monthly billing period (provisional: calendar-30-day months everywhere). */
export const BILLING_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * Grace window after a failed renewal: a `past_due` subscriber keeps their
 * paid entitlements this long past the period end before everything falls
 * back to Free. Kept short on purpose — billing failures fail closed.
 */
export const PAST_DUE_GRACE_MS = 3 * 24 * 60 * 60 * 1000;
/** How long a simulated checkout stays payable before the user retries. */
export const CHECKOUT_TTL_MS = 30 * 60 * 1000;

export interface PlanLimits {
  /** Uptime monitors owned by the account. */
  monitors: number;
  /** Scan reports the account may SAVE per calendar month. */
  savedScansPerMonth: number;
  /** Active (non-archived) clients per agency workspace. */
  agencyClients: number;
  /** Members per agency workspace (including the owner). */
  teamMembers: number;
  /** GitHub Repair Agent (proposals + pull requests). */
  repairFeatures: boolean;
}

export interface PlanDef {
  id: PlanId;
  name: string;
  tagline: string;
  /** Minor units (paise / cents). 0 = free plan. */
  prices: Record<Currency, number>;
  limits: PlanLimits;
}

/**
 * The catalog. Free's monitor count and the Agency plan's client/member caps
 * deliberately reference the existing Phase 2/6 constants so those ceilings
 * stay single-sourced; Free keeps exactly the features users have today.
 */
export const PLANS: Record<PlanId, PlanDef> = {
  free: {
    id: "free",
    name: "Free",
    tagline: "Everything you need to watch a handful of sites.",
    prices: { INR: 0, USD: 0 },
    limits: {
      monitors: MAX_MONITORS_PER_OWNER, // preserved from Phase 2
      savedScansPerMonth: 120,
      agencyClients: 3,
      teamMembers: 2,
      repairFeatures: false,
    },
  },
  pro: {
    id: "pro",
    name: "Pro",
    tagline: "More sites, more scans, and the GitHub Repair Agent.",
    prices: { INR: 299_00, USD: 5_00 },
    limits: {
      monitors: 25,
      savedScansPerMonth: 1_000,
      agencyClients: 10,
      teamMembers: 5,
      repairFeatures: true,
    },
  },
  agency: {
    id: "agency",
    name: "Agency",
    tagline: "Full workspace limits for teams managing client sites.",
    prices: { INR: 799_00, USD: 12_00 },
    limits: {
      monitors: 100,
      savedScansPerMonth: 5_000,
      agencyClients: MAX_CLIENTS_PER_AGENCY, // Phase 6 ceiling
      teamMembers: MAX_MEMBERS_PER_AGENCY, // Phase 6 ceiling
      repairFeatures: true,
    },
  },
};

/** Price in minor units (paise/cents) for a plan+currency; 0 for free. */
export function amountFor(plan: PlanId, currency: Currency): number {
  return PLANS[plan].prices[currency];
}

/** Display string for a price: ₹299 / $5 (whole units, no decimals needed). */
export function formatPlanPrice(plan: PlanId, currency: Currency): string {
  const minor = PLANS[plan].prices[currency];
  const whole = minor / 100;
  const rounded = Math.round(whole * 100) / 100;
  const prefix = currency === "INR" ? "₹" : "$";
  return minor === 0 ? `${prefix}0` : `${prefix}${rounded}`;
}

/** Normalize an untrusted currency string ("inr", " usd ") or reject it. */
export function normalizeCurrency(raw: unknown): Currency | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toUpperCase();
  return value === "INR" || value === "USD" ? value : null;
}

export function isPlanId(value: unknown): value is PlanId {
  return value === "free" || value === "pro" || value === "agency";
}

/**
 * The subscription as the entitlement resolver sees it (the `subscriptions`
 * table row minus Convex bookkeeping fields).
 */
export interface SubscriptionSnapshot {
  plan: PlanId;
  status: SubscriptionStatus;
  currency: Currency;
  provider: BillingProvider;
  currentPeriodStart: number;
  currentPeriodEnd: number;
  cancelAtPeriodEnd: boolean;
  pastDueGraceUntil?: number;
}

export interface Entitlements {
  /** Effective plan right now: drops to "free" the moment access lapses. */
  plan: PlanId;
  /** Status as it applies right now (time-based expiry applied in memory). */
  status: SubscriptionStatus;
  limits: PlanLimits;
  /** True while the account holds paid entitlements. */
  paid: boolean;
  currency: Currency | null;
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: boolean;
}

/**
 * Resolve what an account is entitled to at `now`, from its subscription
 * snapshot (or null for no subscription at all).
 *
 * Time-based transitions are applied LAZILY and purely — no cron needed:
 *  - past the period end with no observed renewal → access lapses to Free
 *    (the simulated provider does not auto-renew; real providers renew via
 *    signed webhooks which extend the period before this branch triggers);
 *  - `canceled` keeps access until the period end it was paid through;
 *  - `past_due` keeps access only inside its grace window (fail closed).
 */
export function resolveEntitlements(
  sub: SubscriptionSnapshot | null | undefined,
  now: number,
): Entitlements {
  if (!sub || sub.plan === "free") {
    return {
      plan: "free",
      status: sub?.status ?? "active",
      limits: PLANS.free.limits,
      paid: false,
      currency: sub?.currency ?? null,
      currentPeriodEnd: sub?.currentPeriodEnd ?? null,
      cancelAtPeriodEnd: sub?.cancelAtPeriodEnd ?? false,
    };
  }

  const withinPeriod = now < sub.currentPeriodEnd;
  let entitled = false;
  let status: SubscriptionStatus = sub.status;

  if (!withinPeriod) {
    // Period lapsed with no renewal observed (or a cancel that ran out).
    status = "expired";
  } else if (sub.status === "active" || sub.status === "trialing") {
    entitled = true;
  } else if (sub.status === "canceled") {
    // Paid through the period it was canceled inside.
    entitled = true;
  } else if (sub.status === "past_due") {
    // Grace window only; a missing grace timestamp means no grace at all.
    entitled = sub.pastDueGraceUntil !== undefined && now < sub.pastDueGraceUntil;
  }

  const plan = entitled ? sub.plan : "free";
  return {
    plan,
    status: entitled ? status : status,
    limits: PLANS[plan].limits,
    paid: entitled,
    currency: sub.currency,
    currentPeriodEnd: sub.currentPeriodEnd,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
  };
}
