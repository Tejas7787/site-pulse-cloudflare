import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { auth } from "./auth";
import { internal } from "./_generated/api";
import { isValidReturnPath } from "../lib/githubRepair";
import {
  normalizeRazorpayEvent,
  verifyRazorpaySignature,
} from "../lib/billing/razorpay";
import { normalizeStripeEvent, verifyStripeSignature } from "../lib/billing/stripe";

const http = httpRouter();

auth.addHttpRoutes(http);

// ── Phase 5 — GitHub OAuth callback (server-side exchange boundary) ──────────
// The browser lands here from GitHub. The one-time `state` is redeemed first,
// the `code` is exchanged for the access token by an internal action (client
// secret stays on the server; the token never appears in a URL or response),
// and the browser is bounced back into the app on the same-origin path the
// user started from. `?github=connected` / `?github=error:<code>` is the only
// signal the UI reads — no token ever travels back to the client.
http.route({
  path: "/github/callback",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const code = url.searchParams.get("code") ?? "";
    const state = url.searchParams.get("state") ?? "";

    let ok = false;
    let returnPath = "/";
    let errorCode = "missing_parameters";
    if (code && state) {
      try {
        const result = await ctx.runAction(internal.githubActions.exchangeOAuthCode, {
          code,
          state,
        });
        ok = result.ok;
        // Re-validate even though startConnection already did — redirects are
        // never built from anything but a same-origin path.
        returnPath = isValidReturnPath(result.returnPath) ? result.returnPath : "/";
        errorCode = result.error ?? "unknown_error";
      } catch {
        ok = false;
        errorCode = "exchange_failed";
      }
    }

    const base = (process.env.CONVEX_SITE_URL || url.origin).replace(/\/+$/, "");
    const destination = new URL(returnPath, base);
    destination.searchParams.set("github", ok ? "connected" : `error:${errorCode}`);
    return new Response(null, {
      status: 302,
      headers: { Location: destination.toString() },
    });
  }),
});

// ── Phase 7 — billing webhooks (Stripe & Razorpay, test-mode) ───────────────
// Signature-verified ingestion: the provider signs the RAW body, we verify
// against a webhook secret configured in the deployment, and only a
// verified+normalized event is handed to internal.billing.applyProviderWebhook
// (which deduplicates, rejects stale/out-of-order events and re-checks
// amounts/currencies). Fail closed: no secret configured → 503, bad
// signature → 401, neither ever reaches entitlement state.

http.route({
  path: "/billing/webhooks/stripe",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const secret = process.env.STRIPE_WEBHOOK_SECRET ?? "";
    if (!secret) {
      return json(503, { error: "webhook_not_configured" });
    }
    const payload = await request.text();
    const signature = request.headers.get("Stripe-Signature");
    const valid = await verifyStripeSignature(payload, signature, secret, Date.now());
    if (!valid) {
      return json(401, { error: "invalid_signature" });
    }
    const parsed = normalizeStripeEvent(payload);
    if (!parsed.ok) {
      // Signature was valid, but the payload is not a usable event: reject
      // without retry semantics (retrying cannot fix a malformed body).
      return json(400, { error: parsed.reason });
    }
    // TEST-MODE BOUNDARY (Phase 10B): this deployment only ever creates
    // TEST-mode checkouts, so a signed LIVE-mode event (livemode: true) has
    // nothing legitimate to say here and is refused BEFORE it can reach
    // entitlement state. A missing/false flag is accepted (test behavior
    // preserved). Razorpay has no livemode flag — for it, test-mode is
    // enforced by the `rzp_test_` key prefix at checkout creation.
    if (parsed.event.livemode === true) {
      return json(400, { error: "live_mode_event" });
    }
    const result = await ctx.runMutation(internal.billing.applyProviderWebhook, {
      provider: "stripe",
      eventId: parsed.event.providerEventId,
      type: parsed.event.type,
      rawType: parsed.event.rawType,
      occurredAt: parsed.event.occurredAt,
      ...(parsed.event.amount !== null ? { amount: parsed.event.amount } : {}),
      ...(parsed.event.currency !== null ? { currency: parsed.event.currency } : {}),
      ...(parsed.event.providerSubscriptionId !== null
        ? { providerSubscriptionId: parsed.event.providerSubscriptionId }
        : {}),
      ...(parsed.event.providerCheckoutId !== null
        ? { providerCheckoutId: parsed.event.providerCheckoutId }
        : {}),
      ...(parsed.event.providerStatus !== null
        ? { providerStatus: parsed.event.providerStatus }
        : {}),
    });
    return json(200, { received: true, outcome: result.outcome });
  }),
});

http.route({
  path: "/billing/webhooks/razorpay",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET ?? "";
    if (!secret) {
      return json(503, { error: "webhook_not_configured" });
    }
    const payload = await request.text();
    const signature = request.headers.get("X-Razorpay-Signature");
    const valid = await verifyRazorpaySignature(payload, signature, secret);
    if (!valid) {
      return json(401, { error: "invalid_signature" });
    }
    const parsed = normalizeRazorpayEvent(payload);
    if (!parsed.ok) {
      return json(400, { error: parsed.reason });
    }
    const result = await ctx.runMutation(internal.billing.applyProviderWebhook, {
      provider: "razorpay",
      eventId: parsed.event.providerEventId,
      type: parsed.event.type,
      rawType: parsed.event.rawType,
      occurredAt: parsed.event.occurredAt,
      ...(parsed.event.amount !== null ? { amount: parsed.event.amount } : {}),
      ...(parsed.event.currency !== null ? { currency: parsed.event.currency } : {}),
      ...(parsed.event.providerSubscriptionId !== null
        ? { providerSubscriptionId: parsed.event.providerSubscriptionId }
        : {}),
      ...(parsed.event.providerCheckoutId !== null
        ? { providerCheckoutId: parsed.event.providerCheckoutId }
        : {}),
      ...(parsed.event.providerStatus !== null
        ? { providerStatus: parsed.event.providerStatus }
        : {}),
    });
    return json(200, { received: true, outcome: result.outcome });
  }),
});

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export default http;
