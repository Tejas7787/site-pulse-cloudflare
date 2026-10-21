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
