// ── Stripe adapter (test-mode) ───────────────────────────────────────────────
// Pure module: verifies Stripe's `Stripe-Signature` header (HMAC-SHA256 over
// "<timestamp>.<payload>") and normalizes events into the provider-neutral
// shape the billing backend applies. No I/O, no secrets stored — the secret
// is only ever passed in by the caller (the HTTP route reads it from the
// environment at request time).
//
// SECURITY: verification is mandatory and fail-closed. A payload that does
// not authenticate, carries a stale timestamp, or does not parse is REJECTED
// here and never reaches the entitlement logic.

import { normalizeCurrency, type Currency } from "./plans";

/** Provider-neutral event, produced only by the verifiers below. */
export interface NormalizedBillingEvent {
  provider: "stripe" | "razorpay";
  providerEventId: string;
  /** Normalized kind the backend maps to a subscription transition. */
  type:
    | "checkout_completed"
    | "renewal_paid"
    | "payment_failed"
    | "subscription_updated"
    | "subscription_canceled"
    | "ignored";
  /** The provider's own event name (audit log only). */
  rawType: string;
  occurredAt: number; // ms
  /** Minor units (paise/cents), when the event carries an amount. */
  amount: number | null;
  currency: Currency | null;
  providerSubscriptionId: string | null;
  providerCheckoutId: string | null;
  /** Provider status string for subscription lifecycle events, if any. */
  providerStatus: string | null;
  /**
   * Stripe's test/live marker (`event.livemode`). TRUE means the event came
   * from a LIVE Stripe account and must never be applied by this test-mode
   * deployment — the HTTP route refuses it. Absent/false (every test-mode
   * event, including CLI-forwarded ones) means the event may proceed.
   * Razorpay has no equivalent flag and never sets this field.
   */
  livemode?: boolean;
}

/** Stripe sends up to 5 signatures; take the first v1 value. */
function firstV1(values: string[]): string | null {
  for (const value of values) {
    const trimmed = value.trim();
    if (/^[0-9a-f]{64}$/i.test(trimmed)) return trimmed.toLowerCase();
  }
  return null;
}

/** Constant-time hex comparison (Web Crypto has no timingSafeEqual). */
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

export const STRIPE_SIGNATURE_TOLERANCE_SEC = 300;

/**
 * Verify a Stripe webhook signature. `header` is the raw `Stripe-Signature`
 * header value ("t=<unix>,v1=<hex>[,v1=…]"). Returns true only for a
 * signature that matches the secret AND a timestamp inside the tolerance.
 */
export async function verifyStripeSignature(
  payload: string,
  header: string | null,
  secret: string,
  nowMs: number,
  toleranceSec: number = STRIPE_SIGNATURE_TOLERANCE_SEC,
): Promise<boolean> {
  if (!header || !secret) return false;
  const parts = header.split(",").map((p) => p.trim());
  let timestamp: string | null = null;
  const v1Values: string[] = [];
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (key === "t") timestamp = value;
    else if (key === "v1") v1Values.push(value);
  }
  if (!timestamp || !/^\d{1,15}$/.test(timestamp)) return false;
  const expected = firstV1(v1Values);
  if (!expected) return false;

  const ageSec = Math.abs(Math.floor(nowMs / 1000) - Number(timestamp));
  if (!Number.isFinite(ageSec) || ageSec > toleranceSec) return false;

  const computed = await hmacSha256Hex(secret, `${timestamp}.${payload}`);
  return timingSafeEqualHex(computed, expected);
}

interface StripeObject {
  id?: string;
  object?: string;
  amount_total?: number;
  amount_paid?: number;
  amount_due?: number;
  currency?: string;
  subscription?: string | null;
  status?: string;
  created?: number;
}

interface StripeEvent {
  id?: string;
  type?: string;
  created?: number;
  livemode?: boolean;
  data?: { object?: StripeObject };
}

/**
 * Parse an ALREADY-VERIFIED Stripe event payload into the normalized shape.
 * Unknown event types normalize to `ignored` (logged, never applied).
 */
export function normalizeStripeEvent(
  payload: string,
): { ok: true; event: NormalizedBillingEvent } | { ok: false; reason: string } {
  let event: StripeEvent;
  try {
    event = JSON.parse(payload) as StripeEvent;
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
  if (typeof event?.id !== "string" || event.id.length === 0 || event.id.length > 255) {
    return { ok: false, reason: "missing_event_id" };
  }
  if (typeof event.type !== "string") {
    return { ok: false, reason: "missing_type" };
  }
  const obj = event.data?.object ?? {};
  const currency = normalizeCurrency(obj.currency ?? "");
  const occurredAt =
    typeof event.created === "number" && event.created > 0
      ? event.created * 1000
      : Date.now();

  const base = {
    provider: "stripe" as const,
    providerEventId: event.id,
    rawType: event.type,
    occurredAt,
    currency,
    // Only an explicit `livemode: true` marks a live event; a missing flag
    // is treated as not-live so test-mode behavior is fully preserved.
    livemode: event.livemode === true,
    providerStatus: typeof obj.status === "string" ? obj.status : null,
    providerCheckoutId: null,
    providerSubscriptionId:
      typeof obj.subscription === "string" ? obj.subscription : null,
  };

  switch (event.type) {
    case "checkout.session.completed":
      return {
        ok: true,
        event: {
          ...base,
          type: "checkout_completed",
          amount: typeof obj.amount_total === "number" ? obj.amount_total : null,
          providerCheckoutId: typeof obj.id === "string" ? obj.id : null,
        },
      };
    case "invoice.paid":
      return {
        ok: true,
        event: {
          ...base,
          type: "renewal_paid",
          amount: typeof obj.amount_paid === "number" ? obj.amount_paid : null,
        },
      };
    case "invoice.payment_failed":
      return {
        ok: true,
        event: {
          ...base,
          type: "payment_failed",
          amount: typeof obj.amount_due === "number" ? obj.amount_due : null,
        },
      };
    case "customer.subscription.updated":
      return {
        ok: true,
        event: {
          ...base,
          type: "subscription_updated",
          amount: null,
          providerCheckoutId: typeof obj.id === "string" ? obj.id : null,
        },
      };
    case "customer.subscription.deleted":
      return {
        ok: true,
        event: {
          ...base,
          type: "subscription_canceled",
          amount: null,
          providerCheckoutId: typeof obj.id === "string" ? obj.id : null,
        },
      };
    default:
      return {
        ok: true,
        event: { ...base, type: "ignored", amount: null },
      };
  }
}
