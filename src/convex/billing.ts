import { ConvexError, v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  BILLING_PERIOD_MS,
  CHECKOUT_TTL_MS,
  PAST_DUE_GRACE_MS,
  amountFor,
  normalizeCurrency,
  resolveEntitlements,
  type Entitlements,
  type SubscriptionSnapshot,
} from "../lib/billing/plans";

// ── Phase 7: billing & subscriptions (server-side authority) ─────────────────
//
// Trust model: the CLIENT never decides what it paid, in which currency, or
// what it is entitled to.
//  - Checkout rows (plan/currency/amount) are created server-side from the
//    catalog in src/lib/billing/plans.ts.
//  - "Payment success" only ever happens through a provider event:
//    either the simulated provider (this file — flipping a row THIS server
//    created for THIS user) or a signature-verified Stripe/Razorpay webhook
//    (src/convex/http.ts → applyProviderWebhook below). No redirect param,
//    no client-supplied status, no client-supplied amount.
//  - Entitlements are derived exclusively from the subscriptions row.
//
// Lifecycle: active / trialing / past_due / canceled / expired. Time-based
// transitions (period lapse, grace expiry) are applied lazily by the pure
// resolver in src/lib/billing/plans.ts, so no cron is required for correctness.
//
// Test mode only: real provider adapters refuse to run without `sk_test_` /
// `rzp_test_` keys (see billingActions.ts), and webhooks fail closed when no
// webhook secret is configured.

async function requireUser(ctx: QueryCtx | MutationCtx): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) {
    throw new ConvexError({
      code: "unauthenticated",
      message: "Sign in to manage your subscription.",
    });
  }
  return userId;
}

/** The user's subscription row, or null (= Free plan). */
async function ownSubscription(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
): Promise<Doc<"subscriptions"> | null> {
  return await ctx.db
    .query("subscriptions")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();
}

/** Server-side entitlement resolution used by every quota gate below. */
export async function entitlementsOf(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
): Promise<Entitlements> {
  const sub = await ownSubscription(ctx, userId);
  return resolveEntitlements(sub as SubscriptionSnapshot | null, Date.now());
}

/** UTC month bucket ("2026-10") for monthly quotas. */
function monthKey(now: number): string {
  return new Date(now).toISOString().slice(0, 7);
}

/**
 * Consume one unit of a per-account monthly quota (e.g. saved scans).
 * Best-effort counter (races may overshoot by one) — it bounds honest usage,
 * exactly like the rolling-window quotas in ./rateLimit.ts.
 */
export async function consumeMonthlyQuota(
  ctx: MutationCtx,
  args: { userId: Id<"users">; name: string; limit: number; now?: number },
): Promise<{ allowed: boolean; used: number; limit: number }> {
  const now = args.now ?? Date.now();
  const key = `${args.userId}:${monthKey(now)}:${args.name}`;
  const existing = await ctx.db
    .query("billingUsage")
    .withIndex("by_key", (q) => q.eq("key", key))
    .first();
  const used = existing?.count ?? 0;
  if (used >= args.limit) {
    return { allowed: false, used, limit: args.limit };
  }
  if (existing) {
    await ctx.db.patch(existing._id, { count: used + 1, updatedAt: now });
  } else {
    await ctx.db.insert("billingUsage", { key, count: 1, updatedAt: now });
  }
  return { allowed: true, used: used + 1, limit: args.limit };
}

/** Read a monthly quota without consuming it (UI usage displays). */
async function monthlyUsage(
  ctx: QueryCtx,
  userId: Id<"users">,
  name: string,
  now: number,
): Promise<number> {
  const key = `${userId}:${monthKey(now)}:${name}`;
  const row = await ctx.db
    .query("billingUsage")
    .withIndex("by_key", (q) => q.eq("key", key))
    .first();
  return row?.count ?? 0;
}

/** True when a real provider is configured in TEST mode (never live keys). */
export function providerMode(): { stripe: boolean; razorpay: boolean } {
  const stripeKey = process.env.STRIPE_SECRET_KEY ?? "";
  const razorpayKey = process.env.RAZORPAY_KEY_ID ?? "";
  return {
    stripe: stripeKey.startsWith("sk_test_"),
    razorpay: razorpayKey.startsWith("rzp_test_"),
  };
}

/* ── Reads ─────────────────────────────────────────────────────────────────── */

export const getMySubscription = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;
    const now = Date.now();
    const sub = await ownSubscription(ctx, userId);
    const entitlements = resolveEntitlements(sub as SubscriptionSnapshot | null, now);

    const monitors = await ctx.db
      .query("monitors")
      .withIndex("by_owner", (q) => q.eq("ownerId", userId))
      .take(entitlements.limits.monitors + 1);

    const mode = providerMode();
    return {
      subscription:
        sub === null
          ? null
          : {
              plan: sub.plan,
              status: sub.status,
              currency: sub.currency,
              provider: sub.provider,
              amountPerPeriod: sub.amountPerPeriod,
              currentPeriodStart: sub.currentPeriodStart,
              currentPeriodEnd: sub.currentPeriodEnd,
              cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
            },
      entitlements,
      usage: {
        monitors: Math.min(monitors.length, entitlements.limits.monitors),
        savedScansThisMonth: await monthlyUsage(ctx, userId, "saved-scans", now),
      },
      billingMode: { simulated: true as const, ...mode },
    };
  },
});

/**
 * Entitlements for internal callers (server actions such as the Repair
 * Agent's analyzeRepair, which cannot share a QueryCtx helper).
 */
export const internalEntitlements = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const entitlements = await entitlementsOf(ctx, args.userId);
    return {
      plan: entitlements.plan,
      status: entitlements.status,
      paid: entitlements.paid,
      limits: entitlements.limits,
    };
  },
});

/* ── Checkout (simulated provider; real providers live in billingActions) ──── */

export const startCheckout = mutation({
  args: {
    plan: v.union(v.literal("pro"), v.literal("agency")),
    currency: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const currency = normalizeCurrency(args.currency);
    if (currency === null) {
      throw new ConvexError({
        code: "invalid_currency",
        message: "Choose a supported currency: INR or USD.",
      });
    }
    // The amount is ALWAYS the catalog price for this plan+currency. There is
    // deliberately no amount argument anywhere in this flow.
    const amount = amountFor(args.plan, currency);
    if (amount <= 0) {
      throw new ConvexError({
        code: "invalid_plan",
        message: "That plan cannot be purchased.",
      });
    }

    const now = Date.now();
    // Idempotent-ish: reuse an unexpired pending checkout for the same plan
    // and currency instead of minting a new one on every click.
    const recent = await ctx.db
      .query("billingCheckouts")
      .withIndex("by_user_created", (q) => q.eq("userId", userId))
      .order("desc")
      .take(5);
    const reusable = recent.find(
      (c) =>
        c.status === "pending" &&
        c.expiresAt > now &&
        c.plan === args.plan &&
        c.currency === currency,
    );
    if (reusable) {
      return {
        checkoutId: reusable._id,
        plan: reusable.plan,
        currency: reusable.currency,
        amount: reusable.amount,
        expiresAt: reusable.expiresAt,
        provider: reusable.provider,
        mode: "simulated" as const,
      };
    }

    const checkoutId = await ctx.db.insert("billingCheckouts", {
      userId,
      plan: args.plan,
      currency,
      amount,
      provider: "simulated",
      status: "pending",
      createdAt: now,
      expiresAt: now + CHECKOUT_TTL_MS,
    });
    return {
      checkoutId,
      plan: args.plan,
      currency,
      amount,
      expiresAt: now + CHECKOUT_TTL_MS,
      provider: "simulated" as const,
      mode: "simulated" as const,
    };
  },
});

/**
 * The simulated provider's "payment completed" event. This is the ONLY path
 * that activates paid access in simulated mode, and it accepts no payment
 * facts from the caller: plan, currency and amount come from the stored
 * checkout row this server created for this user. Outcome "failed" records a
 * failed payment without touching any subscription (fail closed).
 */
export const completeSimulatedCheckout = mutation({
  args: {
    checkoutId: v.id("billingCheckouts"),
    outcome: v.union(v.literal("succeeded"), v.literal("failed")),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const checkout = await ctx.db.get(args.checkoutId);
    // Cross-user and forged-id protection in one check: a checkout that is
    // not yours behaves exactly like one that does not exist.
    if (checkout === null || checkout.userId !== userId) {
      throw new ConvexError({
        code: "forbidden",
        message: "You cannot complete a checkout that is not yours.",
      });
    }
    if (checkout.status === "succeeded") {
      // Replay-safe: completing an already-completed checkout is a no-op.
      return { ok: true, alreadyProcessed: true as const };
    }
    if (checkout.status !== "pending") {
      throw new ConvexError({
        code: "not_payable",
        message: "This checkout is no longer payable. Start a new one.",
      });
    }

    const now = Date.now();
    if (checkout.expiresAt <= now) {
      await ctx.db.patch(checkout._id, { status: "expired" });
      throw new ConvexError({
        code: "checkout_expired",
        message: "This checkout expired. Start a new one.",
      });
    }

    if (args.outcome === "failed") {
      await ctx.db.patch(checkout._id, {
        status: "failed",
        failureReason: "simulated_payment_failure",
        completedAt: now,
      });
      await ctx.db.insert("billingEvents", {
        provider: "simulated",
        providerEventId: checkout._id,
        type: "checkout_failed",
        dedupeKey: `simulated:${checkout._id}`,
        outcome: "applied",
        detail: "simulated_payment_failure",
        userId,
        createdAt: now,
      });
      return { ok: false as const, reason: "payment_failed" as const };
    }

    // Success: upsert the subscription from the STORED checkout facts only.
    const existing = await ownSubscription(ctx, userId);
    if (existing) {
      await ctx.db.patch(existing._id, {
        plan: checkout.plan,
        status: "active",
        currency: checkout.currency,
        provider: "simulated",
        providerCustomerId: undefined,
        providerSubscriptionId: undefined,
        amountPerPeriod: checkout.amount,
        currentPeriodStart: now,
        currentPeriodEnd: now + BILLING_PERIOD_MS,
        cancelAtPeriodEnd: false,
        pastDueGraceUntil: undefined,
        lastProviderEventAt: undefined,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("subscriptions", {
        userId,
        plan: checkout.plan,
        status: "active",
        currency: checkout.currency,
        provider: "simulated",
        amountPerPeriod: checkout.amount,
        currentPeriodStart: now,
        currentPeriodEnd: now + BILLING_PERIOD_MS,
        cancelAtPeriodEnd: false,
        startedAt: now,
        updatedAt: now,
      });
    }
    await ctx.db.patch(checkout._id, { status: "succeeded", completedAt: now });
    await ctx.db.insert("billingEvents", {
      provider: "simulated",
      providerEventId: checkout._id,
      type: "checkout_completed",
      dedupeKey: `simulated:${checkout._id}`,
      outcome: "applied",
      detail: `${checkout.plan}/${checkout.currency}/${checkout.amount}`,
      userId,
      createdAt: now,
    });
    return {
      ok: true as const,
      plan: checkout.plan,
      currency: checkout.currency,
      currentPeriodEnd: now + BILLING_PERIOD_MS,
    };
  },
});

/**
 * Create a pending checkout row for a REAL provider session (test mode).
 * Called only by the billingActions action AFTER the provider accepted the
 * session — the provider ids are stored so the signed webhook can link back.
 */
export const insertProviderCheckout = internalMutation({
  args: {
    userId: v.id("users"),
    plan: v.union(v.literal("pro"), v.literal("agency")),
    currency: v.union(v.literal("INR"), v.literal("USD")),
    amount: v.number(),
    provider: v.union(v.literal("stripe"), v.literal("razorpay")),
    providerCheckoutId: v.string(),
    ttlMs: v.number(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const expected = amountFor(args.plan, args.currency);
    if (args.amount !== expected) {
      throw new ConvexError({ code: "amount_mismatch", message: "Checkout amount mismatch." });
    }
    return await ctx.db.insert("billingCheckouts", {
      userId: args.userId,
      plan: args.plan,
      currency: args.currency,
      amount: args.amount,
      provider: args.provider,
      status: "pending",
      providerCheckoutId: args.providerCheckoutId,
      createdAt: now,
      expiresAt: now + args.ttlMs,
    });
  },
});

/* ── Cancellation ──────────────────────────────────────────────────────────── */
export const cancelSubscription = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const sub = await ownSubscription(ctx, userId);
    if (sub === null) {
      throw new ConvexError({
        code: "no_subscription",
        message: "You do not have a paid subscription to cancel.",
      });
    }
    if (sub.provider !== "simulated") {
      // Real-provider subscriptions are canceled at the provider; the webhook
      // syncs the state back. Never fake it locally.
      return { ok: false as const, reason: "manage_via_provider" as const };
    }
    if (sub.cancelAtPeriodEnd || sub.status === "canceled") {
      return { ok: true as const, cancelAtPeriodEnd: true as const };
    }
    // Access continues until the paid-through period end (fail-closed lapse
    // afterwards is handled lazily by resolveEntitlements).
    await ctx.db.patch(sub._id, { cancelAtPeriodEnd: true, updatedAt: Date.now() });
    return { ok: true as const, cancelAtPeriodEnd: true as const };
  },
});

export const resumeSubscription = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const sub = await ownSubscription(ctx, userId);
    if (sub === null || sub.provider !== "simulated") {
      return { ok: false as const, reason: "not_resumable" as const };
    }
    await ctx.db.patch(sub._id, { cancelAtPeriodEnd: false, updatedAt: Date.now() });
    return { ok: true as const, cancelAtPeriodEnd: false as const };
  },
});

/* ── Provider webhooks (called ONLY from the signature-verified HTTP routes) ── */

const eventTypeValidator = v.union(
  v.literal("checkout_completed"),
  v.literal("renewal_paid"),
  v.literal("payment_failed"),
  v.literal("subscription_updated"),
  v.literal("subscription_canceled"),
  v.literal("ignored"),
);

/**
 * Apply one ALREADY-VERIFIED provider event (normalized by
 * src/lib/billing/stripe.ts or razorpay.ts in the HTTP layer).
 *
 * Safety: idempotent by dedupe key (replays are logged and ignored),
 * out-of-order-safe via `lastProviderEventAt` (older events are logged as
 * stale and dropped), currency- and amount-checked against the stored
 * checkout/subscription AND the catalog — mismatches are rejected and change
 * nothing. Unknown event types are logged as ignored, never applied.
 */
export const applyProviderWebhook = internalMutation({
  args: {
    provider: v.union(v.literal("stripe"), v.literal("razorpay")),
    eventId: v.string(),
    type: eventTypeValidator,
    rawType: v.string(),
    occurredAt: v.number(),
    amount: v.optional(v.number()),
    currency: v.optional(v.union(v.literal("INR"), v.literal("USD"))),
    providerSubscriptionId: v.optional(v.string()),
    providerCheckoutId: v.optional(v.string()),
    providerStatus: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const dedupeKey = `${args.provider}:${args.eventId}`;

    const seen = await ctx.db
      .query("billingEvents")
      .withIndex("by_dedupe", (q) => q.eq("dedupeKey", dedupeKey))
      .first();
    if (seen) {
      return { outcome: "duplicate" as const };
    }

    const log = async (
      outcome: "applied" | "stale" | "rejected" | "ignored",
      detail: string,
      userId?: Id<"users">,
    ) => {
      await ctx.db.insert("billingEvents", {
        provider: args.provider,
        providerEventId: args.eventId,
        type: args.type,
        dedupeKey,
        outcome,
        detail,
        ...(userId ? { userId } : {}),
        createdAt: now,
      });
    };

    // Locate the subscription this event is about.
    let sub: Doc<"subscriptions"> | null = null;
    if (args.providerSubscriptionId) {
      sub = await ctx.db
        .query("subscriptions")
        .withIndex("by_provider_sub", (q) =>
          q.eq("providerSubscriptionId", args.providerSubscriptionId!),
        )
        .first();
    }
    let checkout: Doc<"billingCheckouts"> | null = null;
    if (!sub && args.providerCheckoutId) {
      checkout = await ctx.db
        .query("billingCheckouts")
        .withIndex("by_provider_checkout", (q) =>
          q.eq("providerCheckoutId", args.providerCheckoutId!),
        )
        .first();
      if (checkout) {
        sub = await ctx.db
          .query("subscriptions")
          .withIndex("by_user", (q) => q.eq("userId", checkout!.userId))
          .first();
      }
    }

    // Out-of-order guard: never let an older event overwrite newer state.
    if (sub && sub.lastProviderEventAt !== undefined && args.occurredAt < sub.lastProviderEventAt) {
      await log("stale", `occurredAt ${args.occurredAt} < ${sub.lastProviderEventAt}`, sub.userId);
      return { outcome: "stale" as const };
    }

    switch (args.type) {
      case "checkout_completed": {
        if (!checkout) {
          await log("rejected", "unknown_checkout");
          return { outcome: "rejected" as const, reason: "unknown_checkout" };
        }
        // Amount AND currency must match the stored checkout and the catalog.
        // Anything else is a forged or misrouted event — reject, change nothing.
        const expected = amountFor(checkout.plan, checkout.currency);
        if (
          args.amount !== undefined &&
          (args.amount !== expected || args.amount !== checkout.amount)
        ) {
          await log("rejected", `amount ${args.amount} != ${expected}`, checkout.userId);
          return { outcome: "rejected" as const, reason: "amount_mismatch" };
        }
        if (args.currency !== undefined && args.currency !== checkout.currency) {
          await log("rejected", `currency ${args.currency} != ${checkout.currency}`, checkout.userId);
          return { outcome: "rejected" as const, reason: "currency_mismatch" };
        }
        const target = sub ?? null;
        if (target && target.userId === checkout.userId) {
          await ctx.db.patch(target._id, {
            status: "active",
            provider: args.provider,
            providerSubscriptionId:
              args.providerSubscriptionId ?? target.providerSubscriptionId,
            currentPeriodStart: now,
            currentPeriodEnd: now + BILLING_PERIOD_MS,
            cancelAtPeriodEnd: false,
            pastDueGraceUntil: undefined,
            lastProviderEventAt: args.occurredAt,
            updatedAt: now,
          });
        } else {
          await ctx.db.insert("subscriptions", {
            userId: checkout.userId,
            plan: checkout.plan,
            status: "active",
            currency: checkout.currency,
            provider: args.provider,
            ...(args.providerSubscriptionId
              ? { providerSubscriptionId: args.providerSubscriptionId }
              : {}),
            amountPerPeriod: checkout.amount,
            currentPeriodStart: now,
            currentPeriodEnd: now + BILLING_PERIOD_MS,
            cancelAtPeriodEnd: false,
            startedAt: now,
            updatedAt: now,
          });
        }
        await ctx.db.patch(checkout._id, { status: "succeeded", completedAt: now });
        await log("applied", "checkout_activated", checkout.userId);
        return { outcome: "applied" as const };
      }

      case "renewal_paid": {
        if (!sub) {
          await log("rejected", "unknown_subscription");
          return { outcome: "rejected" as const, reason: "unknown_subscription" };
        }
        if (args.currency !== undefined && args.currency !== sub.currency) {
          await log("rejected", `currency ${args.currency} != ${sub.currency}`, sub.userId);
          return { outcome: "rejected" as const, reason: "currency_mismatch" };
        }
        if (args.amount !== undefined && args.amount !== sub.amountPerPeriod) {
          await log("rejected", `amount ${args.amount} != ${sub.amountPerPeriod}`, sub.userId);
          return { outcome: "rejected" as const, reason: "amount_mismatch" };
        }
        const base = Math.max(now, sub.currentPeriodEnd);
        await ctx.db.patch(sub._id, {
          status: "active",
          currentPeriodStart: sub.currentPeriodEnd,
          currentPeriodEnd: base + BILLING_PERIOD_MS,
          pastDueGraceUntil: undefined,
          lastProviderEventAt: args.occurredAt,
          updatedAt: now,
        });
        await log("applied", "renewal_extended", sub.userId);
        return { outcome: "applied" as const };
      }

      case "payment_failed": {
        if (!sub) {
          await log("rejected", "unknown_subscription");
          return { outcome: "rejected" as const, reason: "unknown_subscription" };
        }
        const graceUntil = Math.max(now, sub.currentPeriodEnd) + PAST_DUE_GRACE_MS;
        await ctx.db.patch(sub._id, {
          status: "past_due",
          pastDueGraceUntil: graceUntil,
          lastProviderEventAt: args.occurredAt,
          updatedAt: now,
        });
        await log("applied", `past_due grace until ${graceUntil}`, sub.userId);
        return { outcome: "applied" as const };
      }

      case "subscription_updated": {
        if (!sub) {
          await log("rejected", "unknown_subscription");
          return { outcome: "rejected" as const, reason: "unknown_subscription" };
        }
        const status = args.providerStatus;
        if (status === "active" || status === "trialing") {
          await ctx.db.patch(sub._id, {
            status,
            pastDueGraceUntil: undefined,
            lastProviderEventAt: args.occurredAt,
            updatedAt: now,
          });
          await log("applied", `status_${status}`, sub.userId);
          return { outcome: "applied" as const };
        }
        if (status === "past_due") {
          const graceUntil = Math.max(now, sub.currentPeriodEnd) + PAST_DUE_GRACE_MS;
          await ctx.db.patch(sub._id, {
            status: "past_due",
            pastDueGraceUntil: graceUntil,
            lastProviderEventAt: args.occurredAt,
            updatedAt: now,
          });
          await log("applied", "status_past_due", sub.userId);
          return { outcome: "applied" as const };
        }
        if (status === "canceled" || status === "expired") {
          await ctx.db.patch(sub._id, {
            status: "canceled",
            cancelAtPeriodEnd: false,
            lastProviderEventAt: args.occurredAt,
            updatedAt: now,
          });
          await log("applied", `status_${status}`, sub.userId);
          return { outcome: "applied" as const };
        }
        await log("ignored", `unmapped_status ${status ?? "none"}`, sub.userId);
        return { outcome: "ignored" as const };
      }

      case "subscription_canceled": {
        if (!sub) {
          await log("rejected", "unknown_subscription");
          return { outcome: "rejected" as const, reason: "unknown_subscription" };
        }
        // Access remains until the paid-through period end; the resolver
        // drops entitlements to Free afterwards without any cron.
        await ctx.db.patch(sub._id, {
          status: "canceled",
          cancelAtPeriodEnd: false,
          lastProviderEventAt: args.occurredAt,
          updatedAt: now,
        });
        await log("applied", "canceled_at_provider", sub.userId);
        return { outcome: "applied" as const };
      }

      case "ignored":
      default:
        await log("ignored", args.rawType.slice(0, 120));
        return { outcome: "ignored" as const };
    }
  },
});

/** Plan catalog for the pricing page (public, server-owned numbers). */
export const getPlanCatalog = query({
  args: {},
  handler: async () => {
    const mode = providerMode();
    return { billingMode: { simulated: true as const, ...mode } };
  },
});
