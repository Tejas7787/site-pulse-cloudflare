import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { amountFor, normalizeCurrency, type PlanId } from "../lib/billing/plans";

// ── Phase 7 — real-provider checkout (Stripe, TEST MODE ONLY) ────────────────
// Creates a Stripe Checkout Session through Stripe's REST API and hands the
// browser the hosted payment URL. Activation still never trusts this flow:
// access is granted ONLY by the signature-verified `checkout.session.completed`
// webhook (src/convex/http.ts → internal.billing.applyProviderWebhook).
//
// HARD TEST-MODE ENFORCEMENT: the session is created only when
// STRIPE_SECRET_KEY starts with `sk_test_` — live keys are refused outright,
// so this deployment can never take a real payment even if a live key were
// pasted into the environment. The app origin for return URLs comes from
// CONVEX_SITE_URL (operator-controlled), never from client input.
//
// Razorpay checkout creation is intentionally not wired here: its hosted flow
// needs a client-side widget (checkout.js) with the subscription id. Razorpay
// WEBHOOK verification is fully implemented; creating Razorpay subscriptions
// is the documented manual follow-up. The simulated provider covers the
// payment UX until real credentials exist.
//
// Not unit-tested against the live API (no credentials in this environment);
// the security-relevant logic (key prefix guard, catalog pricing, webhook
// verification) lives in tested pure functions and mutations.

const STRIPE_API = "https://api.stripe.com/v1/checkout/sessions";
/** How long the created checkout session stays payable. */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export const startStripeCheckout = action({
  args: {
    plan: v.union(v.literal("pro"), v.literal("agency")),
    currency: v.string(),
  },
  handler: async (ctx, args): Promise<
    | { ok: true; url: string }
    | { ok: false; reason: "unauthenticated" | "not_configured" | "provider_error" | "invalid_input" }
  > => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return { ok: false, reason: "unauthenticated" };

    const currency = normalizeCurrency(args.currency);
    if (currency === null) return { ok: false, reason: "invalid_input" };
    const amount = amountFor(args.plan as PlanId, currency);
    if (amount <= 0) return { ok: false, reason: "invalid_input" };

    const secret = process.env.STRIPE_SECRET_KEY ?? "";
    const siteUrl = process.env.CONVEX_SITE_URL ?? "";
    // Refuse to run without test-mode credentials or a known app origin.
    // Live (sk_live_) keys fail this check on purpose.
    if (!secret.startsWith("sk_test_") || !/^https?:\/\//.test(siteUrl)) {
      return { ok: false, reason: "not_configured" };
    }

    const body = new URLSearchParams();
    body.set("mode", "subscription");
    body.set("client_reference_id", userId);
    body.set("line_items[0][price_data][currency]", currency.toLowerCase());
    body.set("line_items[0][price_data][unit_amount]", String(amount));
    body.set("line_items[0][price_data][recurring][interval]", "month");
    body.set(
      "line_items[0][price_data][product_data][name]",
      `SitePulse ${args.plan === "pro" ? "Pro" : "Agency"} (${currency})`,
    );
    body.set("line_items[0][quantity]", "1");
    const base = siteUrl.replace(/\/+$/, "");
    body.set("success_url", `${base}/pricing?checkout=success`);
    body.set("cancel_url", `${base}/pricing?checkout=canceled`);
    body.set("metadata[userId]", userId);
    body.set("metadata[plan]", args.plan);

    let session: { id?: string; url?: string };
    try {
      const response = await fetch(STRIPE_API, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      });
      if (!response.ok) return { ok: false, reason: "provider_error" };
      session = (await response.json()) as { id?: string; url?: string };
    } catch {
      // Network failure: fail closed, no subscription state is touched.
      return { ok: false, reason: "provider_error" };
    }
    if (!session.id || !session.url) return { ok: false, reason: "provider_error" };

    // Record the pending checkout server-side so the signed webhook can link
    // the session back to this user (the webhook re-verifies amount/currency).
    await ctx.runMutation(internal.billing.insertProviderCheckout, {
      userId,
      plan: args.plan,
      currency,
      amount,
      provider: "stripe",
      providerCheckoutId: session.id,
      ttlMs: SESSION_TTL_MS,
    });
    return { ok: true, url: session.url };
  },
});

/** Exposed for the pricing page: is a real provider checkout available? */
export const billingMode = action({
  args: {},
  handler: async (): Promise<{ stripe: boolean; razorpay: boolean }> => ({
    stripe: (process.env.STRIPE_SECRET_KEY ?? "").startsWith("sk_test_"),
    razorpay: (process.env.RAZORPAY_KEY_ID ?? "").startsWith("rzp_test_"),
  }),
});

// ── Phase 9B — real-provider checkout (Razorpay, TEST MODE ONLY) ────────────
// Razorpay's subscription flow has no fully hosted redirect page like Stripe
// Checkout: the documented integration creates the SUBSCRIPTION server-side
// and the browser opens Razorpay's hosted Checkout widget with the returned
// `subscription_id` (checkout.js — the payment UI itself is Razorpay-hosted,
// so no card data ever touches this deployment).
//
// HARD TEST-MODE ENFORCEMENT (same as Stripe): the subscription is created
// only when RAZORPAY_KEY_ID starts with `rzp_test_` — live keys are refused
// outright. The amount ALWAYS comes from the server-side catalog. Activation
// never trusts this flow: the signed `subscription.charged` / `payment.captured`
// webhook (src/convex/http.ts → internal.billing.applyProviderWebhook) is the
// only path that activates access, and it re-checks amount/currency against
// the stored checkout row created here.

const RAZORPAY_API = "https://api.razorpay.com/v1/subscriptions";
/** Monthly cycles the subscription is created for (a year; cancel anytime —
 * cancellation flows back through the signed webhook / dashboard). */
const RAZORPAY_TOTAL_COUNT = 12;
/** How long the pending checkout row stays linkable for the webhook. */
const RAZORPAY_CHECKOUT_TTL_MS = SESSION_TTL_MS;

export const startRazorpayCheckout = action({
  args: {
    plan: v.union(v.literal("pro"), v.literal("agency")),
    currency: v.string(),
  },
  handler: async (ctx, args): Promise<
    | { ok: true; subscriptionId: string; keyId: string; amount: number; currency: "INR" | "USD" }
    | { ok: false; reason: "unauthenticated" | "not_configured" | "provider_error" | "invalid_input" }
  > => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return { ok: false, reason: "unauthenticated" };

    const currency = normalizeCurrency(args.currency);
    if (currency === null) return { ok: false, reason: "invalid_input" };
    const amount = amountFor(args.plan as PlanId, currency);
    if (amount <= 0) return { ok: false, reason: "invalid_input" };

    const keyId = process.env.RAZORPAY_KEY_ID ?? "";
    const keySecret = process.env.RAZORPAY_KEY_SECRET ?? "";
    // Refuse without test-mode credentials. Live (rzp_live_) keys fail this
    // check on purpose.
    if (!keyId.startsWith("rzp_test_") || !keySecret) {
      return { ok: false, reason: "not_configured" };
    }

    const body = new URLSearchParams();
    body.set("period", "monthly");
    body.set("interval", "1");
    body.set("total_count", String(RAZORPAY_TOTAL_COUNT));
    body.set("item[amount]", String(amount)); // minor units (paise/cents)
    body.set("item[currency]", currency);
    body.set("item[name]", `SitePulse ${args.plan === "pro" ? "Pro" : "Agency"} (${currency})`);
    body.set("notes[userId]", userId);
    body.set("notes[plan]", args.plan);

    let subscription: { id?: string };
    try {
      const response = await fetch(RAZORPAY_API, {
        method: "POST",
        headers: {
          // HTTP Basic with the API keys — Razorpay's documented scheme. The
          // secret never leaves this server-side call.
          Authorization: `Basic ${btoa(`${keyId}:${keySecret}`)}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      });
      if (!response.ok) return { ok: false, reason: "provider_error" };
      subscription = (await response.json()) as { id?: string };
    } catch {
      // Network failure: fail closed, no subscription state is touched.
      return { ok: false, reason: "provider_error" };
    }
    if (!subscription.id || !/^rzp_sub_[A-Za-z0-9]+$/.test(subscription.id)) {
      return { ok: false, reason: "provider_error" };
    }

    // Record the pending checkout server-side (providerCheckoutId == the
    // subscription id, which is exactly what the first signed
    // `subscription.charged` event links back to in applyProviderWebhook).
    await ctx.runMutation(internal.billing.insertProviderCheckout, {
      userId,
      plan: args.plan,
      currency,
      amount,
      provider: "razorpay",
      providerCheckoutId: subscription.id,
      ttlMs: RAZORPAY_CHECKOUT_TTL_MS,
    });
    // keyId is Razorpay's PUBLIC identifier (it ships in every checkout.js
    // page); only the subscription id and catalog amounts travel back.
    return { ok: true, subscriptionId: subscription.id, keyId, amount, currency };
  },
});
