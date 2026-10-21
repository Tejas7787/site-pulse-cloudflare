// ── Razorpay adapter (test-mode) ─────────────────────────────────────────────
// Pure module: verifies Razorpay's `X-Razorpay-Signature` (HMAC-SHA256 hex of
// the RAW request body with the webhook secret) and normalizes events into the
// provider-neutral shape shared with the Stripe adapter. Fail-closed, same
// rules: unauthenticated or unparsable payloads never reach the backend.

import { normalizeCurrency } from "./plans";
import type { NormalizedBillingEvent } from "./stripe";

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function hmacSha256Hex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(data),
  );
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Verify a Razorpay webhook signature over the raw body. */
export async function verifyRazorpaySignature(
  payload: string,
  header: string | null,
  secret: string,
): Promise<boolean> {
  if (!header || !secret) return false;
  const provided = header.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(provided)) return false;
  const computed = await hmacSha256Hex(secret, payload);
  return timingSafeEqualHex(computed, provided);
}

interface RazorpayEntity {
  id?: string;
  amount?: number; // paise (or paisa for subscriptions' charges)
  currency?: string;
  subscription_id?: string;
  status?: string;
  created_at?: number;
  current_end?: number;
}

interface RazorpayEvent {
  id?: string;
  event?: string;
  created_at?: number;
  payload?: {
    payment?: { entity?: RazorpayEntity };
    subscription?: { entity?: RazorpayEntity };
  };
}

/**
 * Parse an ALREADY-VERIFIED Razorpay event into the normalized shape.
 * Amounts on `payment.*` are in paise; `subscription_id` links the charge to
 * the subscription the backend already created at checkout time.
 */
export function normalizeRazorpayEvent(
  payload: string,
): { ok: true; event: NormalizedBillingEvent } | { ok: false; reason: string } {
  let event: RazorpayEvent;
  try {
    event = JSON.parse(payload) as RazorpayEvent;
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
  if (typeof event?.id !== "string" || event.id.length === 0 || event.id.length > 255) {
    return { ok: false, reason: "missing_event_id" };
  }
  if (typeof event.event !== "string") {
    return { ok: false, reason: "missing_type" };
  }

  const payment = event.payload?.payment?.entity;
  const subscription = event.payload?.subscription?.entity;
  const entity = payment ?? subscription ?? {};
  const currency = normalizeCurrency(entity.currency ?? "");
  const occurredAt =
    typeof event.created_at === "number" && event.created_at > 0
      ? event.created_at * 1000
      : Date.now();
  const subscriptionId =
    payment?.subscription_id ?? subscription?.id ?? null;

  const base = {
    provider: "razorpay" as const,
    providerEventId: event.id,
    rawType: event.event,
    occurredAt,
    currency,
    providerSubscriptionId: subscriptionId,
    providerCheckoutId: subscription?.id ?? null,
    providerStatus: typeof entity.status === "string" ? entity.status : null,
  };

  switch (event.event) {
    case "payment.captured":
    case "subscription.charged":
      return {
        ok: true,
        event: {
          ...base,
          type: "renewal_paid",
          amount: typeof payment?.amount === "number" ? payment.amount : null,
        },
      };
    case "payment.failed":
    case "subscription.halted":
      return {
        ok: true,
        event: {
          ...base,
          type: "payment_failed",
          amount: typeof payment?.amount === "number" ? payment.amount : null,
        },
      };
    case "subscription.activated":
    case "subscription.resumed":
      return { ok: true, event: { ...base, type: "subscription_updated", amount: null } };
    case "subscription.cancelled":
    case "subscription.completed":
      return {
        ok: true,
        event: { ...base, type: "subscription_canceled", amount: null },
      };
    default:
      return { ok: true, event: { ...base, type: "ignored", amount: null } };
  }
}
