// Phase 7 — billing & subscriptions: authorization, plan limits, forged
// payment success, webhook replay/out-of-order handling, currency mismatch,
// cancellation and payment failures.
//
// Same harness as tests/agency.test.ts: Convex handlers are invoked directly
// through their runtime `_handler` property with a fake ctx whose
// `auth.getUserIdentity()` drives the REAL getAuthUserId (subject
// "<userId>|<sessionId>" — no module mocking, nothing leaks across files).
// Signature verification is tested against real HMAC-SHA256 computed here.

import { describe, expect, test } from "bun:test";
import { ConvexError } from "convex/values";
import type { SubscriptionSnapshot } from "../src/lib/billing/plans";

// Phase 9B: simulated paid-plan activation is now gated by an explicit
// operator kill switch (SITEPULSE_SIMULATED_BILLING, DEFAULT OFF). This
// suite exercises the simulated provider, so it opts in exactly like a
// local/test deployment would. The default-OFF behavior itself is pinned in
// tests/integrationReadiness.test.ts.
process.env.SITEPULSE_SIMULATED_BILLING = "true";

let signedInAs: string | null = null;

const billing = await import("../src/convex/billing");
const monitors = await import("../src/convex/monitors");
const scans = await import("../src/convex/scans");
const agency = await import("../src/convex/agency");
const github = await import("../src/convex/github");
const {
  PLANS,
  amountFor,
  formatPlanPrice,
  normalizeCurrency,
  resolveEntitlements,
  PAST_DUE_GRACE_MS,
} = await import("../src/lib/billing/plans");
const { verifyStripeSignature, normalizeStripeEvent } = await import(
  "../src/lib/billing/stripe"
);
const { verifyRazorpaySignature, normalizeRazorpayEvent } = await import(
  "../src/lib/billing/razorpay"
);
// Phase 11A — saveScan requires a provenance receipt (src/lib/scanReceipt.ts);
// this suite seeds the internal signing key and mints with the shared library.
const { mintScanReceipt } = await import("../src/lib/scanReceipt");
const RECEIPT_KEY = "b7".repeat(32); // 64 hex chars = 32 bytes

type Row = Record<string, unknown> & { _id: string };

/** Minimal in-memory Convex ctx (same shape as tests/agency.test.ts). */
function makeCtx(tables: Record<string, Row[]> = {}) {
  let idSeq = 1;
  const db = {
    async get(id: string) {
      for (const rows of Object.values(tables)) {
        const doc = rows.find((r) => r._id === id);
        if (doc) return doc;
      }
      return null;
    },
    async insert(table: string, doc: Record<string, unknown>) {
      // Pipe-free ids: the real auth subject parsing splits on "|".
      const row = { ...doc, _id: `${table}-i${idSeq}`, _creationTime: idSeq } as Row;
      (tables[table] ??= []).push(row);
      idSeq += 1;
      return row._id as string;
    },
    async patch(id: string, patch: Record<string, unknown>) {
      for (const rows of Object.values(tables)) {
        const doc = rows.find((r) => r._id === id);
        if (doc) {
          for (const [k, val] of Object.entries(patch)) {
            if (val === undefined) delete doc[k];
            else doc[k] = val;
          }
          return;
        }
      }
      throw new Error(`patch: no document ${id}`);
    },
    async delete(id: string) {
      for (const rows of Object.values(tables)) {
        const idx = rows.findIndex((r) => r._id === id);
        if (idx >= 0) {
          rows.splice(idx, 1);
          return;
        }
      }
      throw new Error(`delete: no document ${id}`);
    },
    query(table: string) {
      const filters: Array<[string, unknown]> = [];
      let dir: "asc" | "desc" = "asc";
      const apply = () => {
        let out = [...(tables[table] ?? [])];
        for (const [field, value] of filters) out = out.filter((d) => d[field] === value);
        if (dir === "desc") out.reverse();
        return out;
      };
      const state: Record<string, unknown> = {};
      state.withIndex = (_name: string, cb?: (q: unknown) => unknown) => {
        if (cb) {
          const recorder: Record<string, unknown> = {};
          for (const op of ["eq", "gt", "gte", "lt", "lte"]) {
            recorder[op] = (field: string, value: unknown) => {
              if (op === "eq") filters.push([field, value]);
              return recorder;
            };
          }
          cb(recorder);
        }
        return state;
      };
      state.order = (d: string) => {
        dir = d === "desc" ? "desc" : "asc";
        return state;
      };
      state.take = async (n: number) => apply().slice(0, n);
      state.first = async () => apply()[0] ?? null;
      state.collect = async () => apply();
      state.unique = async () => {
        const rows = apply();
        if (rows.length > 1) throw new Error(`unique(): ${rows.length} rows in ${table}`);
        return rows[0] ?? null;
      };
      return state;
    },
  };
  const ctx = {
    db,
    auth: {
      getUserIdentity: async () =>
        signedInAs === null ? null : { subject: `${signedInAs}|billing-tests` },
    },
  };
  return { ctx, tables };
}

function handler(fn: unknown) {
  return fn as {
    _handler: (ctx: unknown, args: Record<string, unknown>) => Promise<unknown>;
  };
}

async function expectCode(promise: Promise<unknown>, code: string, contains?: string) {
  try {
    await promise;
  } catch (err) {
    const data = (err as ConvexError).data as { code?: string; message?: string };
    expect(data?.code).toBe(code);
    if (contains) expect(data?.message).toContain(contains);
    return;
  }
  throw new Error(`expected rejection with code "${code}"`);
}

/** Some gates still throw plain Errors (pre-Phase-7 modules). */
async function expectPlainError(promise: Promise<unknown>, contains: string) {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(contains);
    return;
  }
  throw new Error(`expected rejection containing: ${contains}`);
}

function asId(id: string) {
  return id as never;
}

/** Two users; optionally give one an active subscription of a plan/currency. */
async function seed(opts: {
  plan?: "pro" | "agency";
  currency?: "INR" | "USD";
  status?: SubscriptionSnapshot["status"];
  periodEnd?: number;
  graceUntil?: number;
  providerSubscriptionId?: string;
} = {}) {
  const w = makeCtx();
  const db = w.ctx.db;
  const userId = await db.insert("users", { email: "owner@x.test" });
  const otherId = await db.insert("users", { email: "other@x.test" });
  if (opts.plan) {
    const now = Date.now();
    await db.insert("subscriptions", {
      userId,
      plan: opts.plan,
      status: opts.status ?? "active",
      currency: opts.currency ?? "INR",
      provider: "simulated",
      ...(opts.providerSubscriptionId ? { providerSubscriptionId: opts.providerSubscriptionId } : {}),
      amountPerPeriod: amountFor(opts.plan, opts.currency ?? "INR"),
      currentPeriodStart: now - 1000,
      currentPeriodEnd: opts.periodEnd ?? now + 30 * 24 * 60 * 60 * 1000,
      cancelAtPeriodEnd: false,
      ...(opts.graceUntil ? { pastDueGraceUntil: opts.graceUntil } : {}),
      startedAt: now,
      updatedAt: now,
    });
  }
  return { ...w, userId: userId as string, otherId: otherId as string };
}

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/* ── Catalog & entitlements (pure) ─────────────────────────────────────────── */

describe("billing — catalog", () => {
  test("provisional introductory prices in minor units, per currency", () => {
    expect(amountFor("free", "INR")).toBe(0);
    expect(amountFor("free", "USD")).toBe(0);
    expect(amountFor("pro", "INR")).toBe(29_900); // ₹299 in paise
    expect(amountFor("pro", "USD")).toBe(500); // $5 in cents
    expect(amountFor("agency", "INR")).toBe(79_900); // ₹799 in paise
    expect(amountFor("agency", "USD")).toBe(1_200); // $12 in cents
    expect(formatPlanPrice("pro", "INR")).toBe("₹299");
    expect(formatPlanPrice("pro", "USD")).toBe("$5");
    expect(formatPlanPrice("agency", "INR")).toBe("₹799");
    expect(formatPlanPrice("agency", "USD")).toBe("$12");
  });

  test("free plan preserves the existing Phase 2 monitor limit", () => {
    expect(PLANS.free.limits.monitors).toBe(10);
    expect(PLANS.agency.limits.agencyClients).toBe(20);
    expect(PLANS.agency.limits.teamMembers).toBe(10);
  });

  test("currency normalization accepts only INR/USD", () => {
    expect(normalizeCurrency("inr")).toBe("INR");
    expect(normalizeCurrency(" usd ")).toBe("USD");
    expect(normalizeCurrency("eur")).toBeNull();
    expect(normalizeCurrency(5)).toBeNull();
  });
});

describe("billing — entitlement resolution", () => {
  const now = 1_700_000_000_000;
  const base: SubscriptionSnapshot = {
    plan: "pro",
    status: "active",
    currency: "INR",
    provider: "simulated",
    currentPeriodStart: now - 1000,
    currentPeriodEnd: now + 1000,
    cancelAtPeriodEnd: false,
  };

  test("no subscription means free entitlements", () => {
    const ent = resolveEntitlements(null, now);
    expect(ent.plan).toBe("free");
    expect(ent.paid).toBe(false);
    expect(ent.limits).toEqual(PLANS.free.limits);
  });

  test("active and trialing are entitled inside the period", () => {
    expect(resolveEntitlements(base, now).paid).toBe(true);
    expect(resolveEntitlements(base, now).plan).toBe("pro");
    expect(resolveEntitlements({ ...base, status: "trialing" }, now).paid).toBe(true);
  });

  test("past_due keeps access only inside its grace window (fail closed)", () => {
    const sub = { ...base, status: "past_due" as const, pastDueGraceUntil: now + 500 };
    expect(resolveEntitlements(sub, now).paid).toBe(true);
    expect(resolveEntitlements(sub, now + 501).paid).toBe(false);
    // No grace timestamp at all → no grace.
    expect(resolveEntitlements({ ...base, status: "past_due" as const }, now).paid).toBe(false);
    expect(PAST_DUE_GRACE_MS).toBeGreaterThan(0);
  });

  test("canceled keeps access until the paid-through period end", () => {
    const sub = { ...base, status: "canceled" as const };
    expect(resolveEntitlements(sub, now).paid).toBe(true);
    expect(resolveEntitlements(sub, now + 2000).paid).toBe(false);
    expect(resolveEntitlements(sub, now + 2000).status).toBe("expired");
  });

  test("an unrenewed period lapses to free (no cron needed)", () => {
    expect(resolveEntitlements(base, base.currentPeriodEnd + 1).plan).toBe("free");
    expect(resolveEntitlements(base, base.currentPeriodEnd + 1).status).toBe("expired");
  });
});

/* ── Webhook signature verification (pure, real HMAC) ──────────────────────── */

describe("billing — provider signature verification", () => {
  test("stripe: valid signature verifies; tampering and staleness fail", async () => {
    const secret = "whsec_test_123";
    const payload = JSON.stringify({ id: "evt_1", type: "invoice.paid" });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await hmacHex(secret, `${timestamp}.${payload}`);
    const header = `t=${timestamp},v1=${signature}`;

    expect(await verifyStripeSignature(payload, header, secret, Date.now())).toBe(true);
    // Tampered payload.
    expect(
      await verifyStripeSignature(payload + " ", header, secret, Date.now()),
    ).toBe(false);
    // Wrong secret.
    expect(
      await verifyStripeSignature(payload, header, "whsec_other", Date.now()),
    ).toBe(false);
    // Stale timestamp (outside 5-minute tolerance).
    const staleSig = await hmacHex(secret, `${timestamp - 3600}.${payload}`);
    expect(
      await verifyStripeSignature(payload, `t=${timestamp - 3600},v1=${staleSig}`, secret, Date.now()),
    ).toBe(false);
    // Missing header/secret → fail closed.
    expect(await verifyStripeSignature(payload, null, secret, Date.now())).toBe(false);
    expect(await verifyStripeSignature(payload, header, "", Date.now())).toBe(false);
  });

  test("razorpay: raw-body HMAC verifies; anything else fails", async () => {
    const secret = "whsec_rzp";
    const payload = JSON.stringify({ id: "evtrzp1", event: "payment.captured" });
    const signature = await hmacHex(secret, payload);
    expect(await verifyRazorpaySignature(payload, signature, secret)).toBe(true);
    expect(await verifyRazorpaySignature(payload + "x", signature, secret)).toBe(false);
    expect(await verifyRazorpaySignature(payload, null, secret)).toBe(false);
  });

  test("event normalization maps to provider-neutral kinds", () => {
    const stripe = normalizeStripeEvent(
      JSON.stringify({
        id: "evt_cs",
        type: "checkout.session.completed",
        created: 1_700_000_000,
        data: {
          object: {
            id: "cs_test_1",
            amount_total: 29_900,
            currency: "inr",
            subscription: "sub_1",
          },
        },
      }),
    );
    expect(stripe.ok).toBe(true);
    if (stripe.ok) {
      expect(stripe.event.type).toBe("checkout_completed");
      expect(stripe.event.amount).toBe(29_900);
      expect(stripe.event.currency).toBe("INR");
      expect(stripe.event.providerCheckoutId).toBe("cs_test_1");
    }

    const unknown = normalizeStripeEvent(JSON.stringify({ id: "evt_x", type: "customer.created" }));
    expect(unknown.ok).toBe(true);
    if (unknown.ok) expect(unknown.event.type).toBe("ignored");

    expect(normalizeStripeEvent("not json").ok).toBe(false);
    expect(normalizeStripeEvent(JSON.stringify({ type: "invoice.paid" })).ok).toBe(false);

    const rzp = normalizeRazorpayEvent(
      JSON.stringify({
        id: "evt_rzp",
        event: "payment.captured",
        created_at: 1_700_000_000,
        payload: { payment: { entity: { id: "pay_1", amount: 29_900, currency: "INR", subscription_id: "sub_rzp" } } },
      }),
    );
    expect(rzp.ok).toBe(true);
    if (rzp.ok) {
      expect(rzp.event.type).toBe("renewal_paid");
      expect(rzp.event.providerSubscriptionId).toBe("sub_rzp");
    }
    const halted = normalizeRazorpayEvent(
      JSON.stringify({ id: "evt_rzp2", event: "subscription.halted", payload: {} }),
    );
    expect(halted.ok).toBe(true);
    if (halted.ok) expect(halted.event.type).toBe("payment_failed");
  });
});

/* ── Billing authorization ─────────────────────────────────────────────────── */

describe("billing — authorization", () => {
  test("signed-out callers can start or complete nothing", async () => {
    const s = await seed();
    signedInAs = null;
    await expectCode(
      handler(billing.startCheckout)._handler(s.ctx, { plan: "pro", currency: "INR" }),
      "unauthenticated",
    );
    await expectCode(
      handler(billing.completeSimulatedCheckout)._handler(s.ctx, {
        checkoutId: "whatever",
        outcome: "succeeded",
      }),
      "unauthenticated",
    );
    expect(await handler(billing.getMySubscription)._handler(s.ctx, {})).toBeNull();
  });

  test("checkout amounts come from the catalog, never the client", async () => {
    const s = await seed();
    signedInAs = s.userId;
    const result = (await handler(billing.startCheckout)._handler(s.ctx, {
      plan: "pro",
      currency: "inr",
    })) as { checkoutId: string; amount: number; currency: string };
    expect(result.amount).toBe(29_900);
    expect(result.currency).toBe("INR");
    const row = (s.tables.billingCheckouts ?? [])[0];
    expect(row.amount).toBe(29_900);
  });

  test("invalid currency is rejected", async () => {
    const s = await seed();
    signedInAs = s.userId;
    await expectCode(
      handler(billing.startCheckout)._handler(s.ctx, { plan: "pro", currency: "EUR" }),
      "invalid_currency",
    );
  });

  test("cancellation only ever touches the caller's own subscription", async () => {
    const s = await seed({ plan: "pro" });
    // A user with no subscription cannot cancel anything…
    signedInAs = s.otherId;
    await expectCode(handler(billing.cancelSubscription)._handler(s.ctx, {}), "no_subscription");
    // …and the active subscription of the other user is untouched.
    const sub = (s.tables.subscriptions ?? [])[0];
    expect(sub.cancelAtPeriodEnd).toBe(false);
    signedInAs = s.userId;
    await handler(billing.cancelSubscription)._handler(s.ctx, {});
    expect(((s.tables.subscriptions ?? [])[0] as Row).cancelAtPeriodEnd).toBe(true);
  });
});

/* ── Forged payment success ────────────────────────────────────────────────── */

describe("billing — forged payment success", () => {
  test("completing another user's checkout is forbidden and changes nothing", async () => {
    const s = await seed();
    signedInAs = s.userId;
    const checkout = (await handler(billing.startCheckout)._handler(s.ctx, {
      plan: "pro",
      currency: "INR",
    })) as { checkoutId: string };

    // Attacker (signed in) submits the victim's checkout id with "succeeded".
    signedInAs = s.otherId;
    await expectCode(
      handler(billing.completeSimulatedCheckout)._handler(s.ctx, {
        checkoutId: asId(checkout.checkoutId),
        outcome: "succeeded",
      }),
      "forbidden",
    );
    // Nothing moved: checkout still pending, no subscription anywhere.
    expect((s.tables.billingCheckouts ?? [])[0].status).toBe("pending");
    expect((s.tables.subscriptions ?? []).length).toBe(0);

    // Unknown ids behave the same (no enumeration).
    await expectCode(
      handler(billing.completeSimulatedCheckout)._handler(s.ctx, {
        checkoutId: asId("billingCheckouts-ghost"),
        outcome: "succeeded",
      }),
      "forbidden",
    );
  });

  test("successful completion activates exactly the stored catalog facts", async () => {
    const s = await seed();
    signedInAs = s.userId;
    const checkout = (await handler(billing.startCheckout)._handler(s.ctx, {
      plan: "agency",
      currency: "USD",
    })) as { checkoutId: string };
    const result = (await handler(billing.completeSimulatedCheckout)._handler(s.ctx, {
      checkoutId: asId(checkout.checkoutId),
      outcome: "succeeded",
    })) as { ok: boolean };
    expect(result.ok).toBe(true);
    const sub = (s.tables.subscriptions ?? [])[0];
    expect(sub.plan).toBe("agency");
    expect(sub.currency).toBe("USD");
    expect(sub.amountPerPeriod).toBe(1_200);
    expect(sub.status).toBe("active");
    expect(sub.provider).toBe("simulated");
  });
});

/* ── Webhook replay & out-of-order events ──────────────────────────────────── */

const STRIPE_EVENT = {
  provider: "stripe",
  eventId: "evt_replay_1",
  type: "checkout_completed",
  rawType: "checkout.session.completed",
  occurredAt: 1_700_000_100_000,
  amount: 29_900,
  currency: "INR",
  providerCheckoutId: "cs_test_42",
};

describe("billing — webhook replay and ordering", () => {
  test("the same provider event is applied once; replays are no-ops", async () => {
    const s = await seed();
    await s.ctx.db.insert("billingCheckouts", {
      userId: s.userId,
      plan: "pro",
      currency: "INR",
      amount: 29_900,
      provider: "stripe",
      status: "pending",
      providerCheckoutId: "cs_test_42",
      createdAt: 1,
      expiresAt: Date.now() + 60_000,
    });

    const first = (await handler(billing.applyProviderWebhook)._handler(s.ctx, STRIPE_EVENT)) as {
      outcome: string;
    };
    expect(first.outcome).toBe("applied");
    const sub = (s.tables.subscriptions ?? [])[0];
    expect(sub.status).toBe("active");
    expect(sub.provider).toBe("stripe");

    // Duplicate delivery (Stripe retries): zero state change.
    const second = (await handler(billing.applyProviderWebhook)._handler(s.ctx, STRIPE_EVENT)) as {
      outcome: string;
    };
    expect(second.outcome).toBe("duplicate");
    expect((s.tables.subscriptions ?? [])[0]).toBe(sub);
    expect((s.tables.billingEvents ?? []).length).toBe(1);
    expect((s.tables.billingCheckouts ?? [])[0].status).toBe("succeeded");
  });

  test("older events never overwrite newer subscription state", async () => {
    const now = Date.now();
    const s = await seed({ plan: "pro", periodEnd: now + 10_000, providerSubscriptionId: "sub_stale" });
    const sub = (s.tables.subscriptions ?? [])[0] as Row;
    await s.ctx.db.patch(sub._id, { lastProviderEventAt: now, currentPeriodEnd: now + 123_456 });

    const stale = (await handler(billing.applyProviderWebhook)._handler(s.ctx, {
      provider: "stripe",
      eventId: "evt_stale_1",
      type: "renewal_paid",
      rawType: "invoice.paid",
      occurredAt: now - 5_000,
      amount: 29_900,
      currency: "INR",
      providerSubscriptionId: "sub_stale",
    })) as { outcome: string };
    expect(stale.outcome).toBe("stale");
    // The period the newer state carried is untouched.
    expect((s.tables.subscriptions ?? [])[0].currentPeriodEnd).toBe(now + 123_456);
  });
});

/* ── Currency & amount mismatch (fail closed) ──────────────────────────────── */

describe("billing — currency mismatch", () => {
  test("a renewal in the wrong currency or amount is rejected, state unchanged", async () => {
    const s = await seed({ plan: "pro", currency: "USD", providerSubscriptionId: "sub_usd" });
    const sub = (s.tables.subscriptions ?? [])[0] as Row;
    const periodEnd = sub.currentPeriodEnd;

    const wrongCurrency = (await handler(billing.applyProviderWebhook)._handler(s.ctx, {
      provider: "stripe",
      eventId: "evt_cur_1",
      type: "renewal_paid",
      rawType: "invoice.paid",
      occurredAt: Date.now(),
      amount: 500,
      currency: "INR",
      providerSubscriptionId: "sub_usd",
    })) as { outcome: string };
    expect(wrongCurrency.outcome).toBe("rejected");
    expect((s.tables.subscriptions ?? [])[0].currentPeriodEnd).toBe(periodEnd);

    const wrongAmount = (await handler(billing.applyProviderWebhook)._handler(s.ctx, {
      provider: "stripe",
      eventId: "evt_amt_1",
      type: "renewal_paid",
      rawType: "invoice.paid",
      occurredAt: Date.now(),
      amount: 1,
      currency: "USD",
      providerSubscriptionId: "sub_usd",
    })) as { outcome: string };
    expect(wrongAmount.outcome).toBe("rejected");
    expect((s.tables.subscriptions ?? [])[0].currentPeriodEnd).toBe(periodEnd);

    // Both rejections are on the audit trail.
    const outcomes = (s.tables.billingEvents ?? []).map((e) => e.outcome);
    expect(outcomes).toEqual(["rejected", "rejected"]);
  });

  test("a forged checkout_completed with wrong amount activates nothing", async () => {
    const s = await seed();
    await s.ctx.db.insert("billingCheckouts", {
      userId: s.userId,
      plan: "pro",
      currency: "INR",
      amount: 29_900,
      provider: "stripe",
      status: "pending",
      providerCheckoutId: "cs_test_forged",
      createdAt: 1,
      expiresAt: Date.now() + 60_000,
    });
    const forged = (await handler(billing.applyProviderWebhook)._handler(s.ctx, {
      provider: "stripe",
      eventId: "evt_forged_1",
      type: "checkout_completed",
      rawType: "checkout.session.completed",
      occurredAt: Date.now(),
      amount: 1, // wrong
      currency: "INR",
      providerCheckoutId: "cs_test_forged",
    })) as { outcome: string };
    expect(forged.outcome).toBe("rejected");
    expect((s.tables.subscriptions ?? []).length).toBe(0);
    expect((s.tables.billingCheckouts ?? [])[0].status).toBe("pending");
  });
});

/* ── Cancellation & payment failures ───────────────────────────────────────── */

describe("billing — cancellation lifecycle", () => {
  test("cancel keeps access until period end, then entitlements lapse", async () => {
    const s = await seed({ plan: "agency" });
    signedInAs = s.userId;
    await handler(billing.cancelSubscription)._handler(s.ctx, {});
    await handler(billing.resumeSubscription)._handler(s.ctx, {});
    expect((s.tables.subscriptions ?? [])[0].cancelAtPeriodEnd).toBe(false);

    await handler(billing.cancelSubscription)._handler(s.ctx, {});
    const live = (await handler(billing.getMySubscription)._handler(s.ctx, {})) as {
      entitlements: { paid: boolean; plan: string };
    };
    expect(live.entitlements.paid).toBe(true); // still inside the paid period
    expect(live.entitlements.plan).toBe("agency");

    // Simulate the period running out: access lapses to Free automatically.
    const sub = (s.tables.subscriptions ?? [])[0] as Row;
    await s.ctx.db.patch(sub._id, { currentPeriodEnd: Date.now() - 1000 });
    const lapsed = (await handler(billing.getMySubscription)._handler(s.ctx, {})) as {
      entitlements: { paid: boolean; plan: string; status: string };
    };
    expect(lapsed.entitlements.paid).toBe(false);
    expect(lapsed.entitlements.plan).toBe("free");
    expect(lapsed.entitlements.status).toBe("expired");
  });

  test("simulated payment failure never activates anything", async () => {
    const s = await seed();
    signedInAs = s.userId;
    const checkout = (await handler(billing.startCheckout)._handler(s.ctx, {
      plan: "pro",
      currency: "INR",
    })) as { checkoutId: string };
    const result = (await handler(billing.completeSimulatedCheckout)._handler(s.ctx, {
      checkoutId: asId(checkout.checkoutId),
      outcome: "failed",
    })) as { ok: boolean; reason: string };
    expect(result.ok).toBe(false);
    expect((s.tables.billingCheckouts ?? [])[0].status).toBe("failed");
    expect((s.tables.subscriptions ?? []).length).toBe(0);

    // A failed checkout cannot be retried into success (fail closed).
    await expectCode(
      handler(billing.completeSimulatedCheckout)._handler(s.ctx, {
        checkoutId: asId(checkout.checkoutId),
        outcome: "succeeded",
      }),
      "not_payable",
    );
  });

  test("a provider payment_failed moves to past_due with a bounded grace", async () => {
    const s = await seed({ plan: "pro", providerSubscriptionId: "sub_fail" });
    const applied = (await handler(billing.applyProviderWebhook)._handler(s.ctx, {
      provider: "stripe",
      eventId: "evt_fail_1",
      type: "payment_failed",
      rawType: "invoice.payment_failed",
      occurredAt: Date.now(),
      amount: 29_900,
      currency: "INR",
      providerSubscriptionId: "sub_fail",
    })) as { outcome: string };
    expect(applied.outcome).toBe("applied");
    const sub = (s.tables.subscriptions ?? [])[0] as Row;
    expect(sub.status).toBe("past_due");
    expect(sub.pastDueGraceUntil).toBeGreaterThan(Date.now());

    // Inside the grace the account keeps its paid plan…
    signedInAs = s.userId;
    const during = (await handler(billing.getMySubscription)._handler(s.ctx, {})) as {
      entitlements: { paid: boolean };
    };
    expect(during.entitlements.paid).toBe(true);

    // …and loses it once the grace passes.
    await s.ctx.db.patch(sub._id, { pastDueGraceUntil: Date.now() - 1 });
    const after = (await handler(billing.getMySubscription)._handler(s.ctx, {})) as {
      entitlements: { paid: boolean; plan: string };
    };
    expect(after.entitlements.paid).toBe(false);
    expect(after.entitlements.plan).toBe("free");
  });
});

/* ── Plan limits enforced at the feature gates ─────────────────────────────── */

describe("billing — plan limits at feature gates", () => {
  async function fillMonitors(s: Awaited<ReturnType<typeof seed>>, ownerId: string, count: number) {
    for (let i = 0; i < count; i += 1) {
      await s.ctx.db.insert("monitors", {
        ownerId,
        name: `m${i}`,
        url: `https://m${i}.test/`,
        intervalMs: 300_000,
        status: "active",
        state: "unknown",
        nextCheckAt: 0,
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        createdAt: 1,
      });
    }
  }

  test("monitor cap follows the plan; free keeps the Phase 2 limit of 10", async () => {
    const s = await seed();
    signedInAs = s.userId;
    await fillMonitors(s, s.userId, 10);
    await expectPlainError(
      handler(monitors.createMonitor)._handler(s.ctx, { url: "https://one-too-many.test/", intervalMs: 900_000 }),
      "Free plan limit: 10 monitors",
    );

    // Upgrading lifts the cap immediately (25 on Pro).
    await s.ctx.db.insert("subscriptions", {
      userId: s.userId,
      plan: "pro",
      status: "active",
      currency: "INR",
      provider: "simulated",
      amountPerPeriod: 29_900,
      currentPeriodStart: Date.now(),
      currentPeriodEnd: Date.now() + 30 * 24 * 60 * 60 * 1000,
      cancelAtPeriodEnd: false,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    });
    const id = (await handler(monitors.createMonitor)._handler(s.ctx, {
      url: "https://eleven.test/",
      intervalMs: 900_000,
    })) as string;
    expect(typeof id).toBe("string");
  });

  test("signed-in saveScan consumes the monthly quota; anonymous flow untouched", async () => {
    const s = await seed();
    const now = Date.now();
    const month = new Date(now).toISOString().slice(0, 7);
    await s.ctx.db.insert("billingUsage", {
      key: `${s.userId}:${month}:saved-scans`,
      count: PLANS.free.limits.savedScansPerMonth,
      updatedAt: now,
    });
    // Phase 11A: receipt key + a receipt over this exact payload.
    await s.ctx.db.insert("scanReceiptKeys", { key: RECEIPT_KEY, createdAt: now });
    const saveArgs = {
      url: "https://site.test/",
      visitorId: "visitor-1",
      scannedAt: now,
    };
    const receipt = await mintScanReceipt({ url: saveArgs.url, scannedAt: now }, RECEIPT_KEY);

    signedInAs = s.userId;
    await expectCode(
      handler(scans.saveScan)._handler(s.ctx, { ...saveArgs, receipt }),
      "plan_limit",
    );
    expect((s.tables.scans ?? []).length).toBe(0);

    // Anonymous visitors keep the pre-Phase-7 behavior (no monthly gate).
    // The SAME receipt stays valid for the same payload (nothing about the
    // report changed between the two attempts).
    signedInAs = null;
    const id = (await handler(scans.saveScan)._handler(s.ctx, {
      ...saveArgs,
      receipt,
    })) as string;
    expect(typeof id).toBe("string");
    expect((s.tables.scans ?? []).length).toBe(1);
  });

  test("agency client and member caps follow the workspace owner's plan", async () => {
    const s = await seed();
    signedInAs = s.userId;
    const agencyId = (await handler(agency.createAgency)._handler(s.ctx, {
      name: "Billing Test Agency",
    })) as string;

    for (let i = 0; i < PLANS.free.limits.agencyClients; i += 1) {
      await handler(agency.createClient)._handler(s.ctx, {
        agencyId: asId(agencyId),
        name: `Client ${i}`,
      });
    }
    await expectCode(
      handler(agency.createClient)._handler(s.ctx, { agencyId: asId(agencyId), name: "One too many" }),
      "limit",
    );

    // Team cap: free = 2 members (owner + one accepted member). Invites do
    // not count until accepted, so seed one accepted member for the cap.
    const invite = (await handler(agency.inviteMember)._handler(s.ctx, {
      agencyId: asId(agencyId),
      email: "teammate@x.test",
    })) as { token: string };
    expect(invite.token).toMatch(/^[0-9a-f]{64}$/);
    await s.ctx.db.insert("agencyMembers", {
      agencyId,
      userId: s.otherId,
      role: "member",
      createdAt: 2,
    });
    await expectCode(
      handler(agency.inviteMember)._handler(s.ctx, { agencyId: asId(agencyId), email: "two@x.test" }),
      "limit",
    );
  });

  test("the Repair Agent requires a paid plan at both entry points", async () => {
    const s = await seed();
    signedInAs = s.userId;
    // Approval gate (mutation) — checked before any proposal lookup.
    await expectCode(
      handler(github.approveAndRequestPr)._handler(s.ctx, {
        proposalId: asId("repairProposals-ghost"),
        confirmRepoFullName: "acme/site",
      }),
      "plan_required",
    );
    // With a paid plan the gate lets through to the normal proposal checks.
    await s.ctx.db.insert("subscriptions", {
      userId: s.userId,
      plan: "pro",
      status: "active",
      currency: "USD",
      provider: "simulated",
      amountPerPeriod: 500,
      currentPeriodStart: Date.now(),
      currentPeriodEnd: Date.now() + 30 * 24 * 60 * 60 * 1000,
      cancelAtPeriodEnd: false,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    });
    await expectPlainError(
      handler(github.approveAndRequestPr)._handler(s.ctx, {
        proposalId: asId("repairProposals-ghost"),
        confirmRepoFullName: "acme/site",
      }),
      "no longer exists",
    );
  });
});

/* ── Phase 10B — Stripe activation (positive path) & catalog authority ───── */

describe("billing — Stripe checkout completion (positive path)", () => {
  test("a verified checkout.session.completed activates exactly the stored catalog facts", async () => {
    const s = await seed();
    await s.ctx.db.insert("billingCheckouts", {
      userId: s.userId,
      plan: "agency",
      currency: "USD",
      amount: amountFor("agency", "USD"),
      provider: "stripe",
      status: "pending",
      providerCheckoutId: "cs_test_positive",
      createdAt: 1,
      expiresAt: Date.now() + 60_000,
    });

    const res = (await handler(billing.applyProviderWebhook)._handler(s.ctx, {
      provider: "stripe",
      eventId: "evt_stripe_positive",
      type: "checkout_completed",
      rawType: "checkout.session.completed",
      occurredAt: Date.now(),
      amount: amountFor("agency", "USD"),
      currency: "USD",
      providerCheckoutId: "cs_test_positive",
      providerSubscriptionId: "sub_positive_1",
    })) as { outcome: string };
    expect(res.outcome).toBe("applied");

    const sub = (s.tables.subscriptions ?? [])[0];
    expect(sub.userId).toBe(s.userId);
    expect(sub.plan).toBe("agency");
    expect(sub.currency).toBe("USD");
    expect(sub.amountPerPeriod).toBe(amountFor("agency", "USD"));
    expect(sub.provider).toBe("stripe");
    expect(sub.status).toBe("active");
    expect(sub.providerSubscriptionId).toBe("sub_positive_1");
    expect(typeof sub.currentPeriodEnd).toBe("number");
    expect((s.tables.billingCheckouts ?? [])[0].status).toBe("succeeded");
    // One audit row, exactly applied.
    expect((s.tables.billingEvents ?? []).map((e) => e.outcome)).toEqual(["applied"]);
  });

  test("the CATALOG price wins: a tampered checkout row cannot lower the price", async () => {
    const s = await seed();
    // A checkout row whose amount was somehow below the catalog price. The
    // event matches the tampered row but not the catalog — rejected.
    await s.ctx.db.insert("billingCheckouts", {
      userId: s.userId,
      plan: "pro",
      currency: "INR",
      amount: 1, // tampered: catalog is 29_900
      provider: "stripe",
      status: "pending",
      providerCheckoutId: "cs_test_tampered",
      createdAt: 1,
      expiresAt: Date.now() + 60_000,
    });

    const res = (await handler(billing.applyProviderWebhook)._handler(s.ctx, {
      provider: "stripe",
      eventId: "evt_stripe_tampered",
      type: "checkout_completed",
      rawType: "checkout.session.completed",
      occurredAt: Date.now(),
      amount: 1,
      currency: "INR",
      providerCheckoutId: "cs_test_tampered",
    })) as { outcome: string };
    expect(res.outcome).toBe("rejected");
    expect((s.tables.subscriptions ?? []).length).toBe(0);
    expect((s.tables.billingCheckouts ?? [])[0].status).toBe("pending");
  });
});

/* ── Phase 10B — money events REQUIRE an amount ───────────────────────────────
 * Documented matrix (enforced in applyProviderWebhook):
 *   checkout_completed → amount REQUIRED  (Stripe checkout.session.completed)
 *   renewal_paid       → amount REQUIRED  (invoice.paid / subscription.charged)
 *   payment_failed     → amount OPTIONAL  (never activates; subscription.halted
 *                                          legitimately carries no payment)
 *   subscription_updated / subscription_canceled / ignored → amount not read
 */

describe("billing — money events require an amount (Phase 10B)", () => {
  test("checkout_completed without an amount activates nothing", async () => {
    const s = await seed();
    await s.ctx.db.insert("billingCheckouts", {
      userId: s.userId,
      plan: "pro",
      currency: "INR",
      amount: 29_900,
      provider: "stripe",
      status: "pending",
      providerCheckoutId: "cs_test_noamount",
      createdAt: 1,
      expiresAt: Date.now() + 60_000,
    });

    const res = (await handler(billing.applyProviderWebhook)._handler(s.ctx, {
      provider: "stripe",
      eventId: "evt_noamount_1",
      type: "checkout_completed",
      rawType: "checkout.session.completed",
      occurredAt: Date.now(),
      // amount deliberately omitted
      currency: "INR",
      providerCheckoutId: "cs_test_noamount",
    })) as { outcome: string; reason?: string };
    expect(res.outcome).toBe("rejected");
    expect(res.reason).toBe("missing_amount");
    expect((s.tables.subscriptions ?? []).length).toBe(0);
    expect((s.tables.billingCheckouts ?? [])[0].status).toBe("pending");
    expect((s.tables.billingEvents ?? [])[0].outcome).toBe("rejected");
  });

  test("a first renewal_paid without an amount cannot activate from a stored checkout", async () => {
    const s = await seed();
    await s.ctx.db.insert("billingCheckouts", {
      userId: s.userId,
      plan: "pro",
      currency: "INR",
      amount: 29_900,
      provider: "razorpay",
      status: "pending",
      providerCheckoutId: "rzp_sub_noamount",
      createdAt: 1,
      expiresAt: Date.now() + 60_000,
    });

    const res = (await handler(billing.applyProviderWebhook)._handler(s.ctx, {
      provider: "razorpay",
      eventId: "evt_noamount_2",
      type: "renewal_paid",
      rawType: "subscription.charged",
      occurredAt: Date.now(),
      providerSubscriptionId: "rzp_sub_noamount",
      providerCheckoutId: "rzp_sub_noamount",
    })) as { outcome: string; reason?: string };
    expect(res.outcome).toBe("rejected");
    expect(res.reason).toBe("missing_amount");
    expect((s.tables.subscriptions ?? []).length).toBe(0);
    expect((s.tables.billingCheckouts ?? [])[0].status).toBe("pending");
  });

  test("renewal_paid without an amount never extends an active subscription", async () => {
    const now = Date.now();
    const s = await seed({ plan: "pro", providerSubscriptionId: "sub_noamt" });
    const before = (s.tables.subscriptions ?? [])[0] as Row;
    const periodEnd = before.currentPeriodEnd;

    const res = (await handler(billing.applyProviderWebhook)._handler(s.ctx, {
      provider: "stripe",
      eventId: "evt_noamount_3",
      type: "renewal_paid",
      rawType: "invoice.paid",
      occurredAt: now,
      providerSubscriptionId: "sub_noamt",
    })) as { outcome: string; reason?: string };
    expect(res.outcome).toBe("rejected");
    expect(res.reason).toBe("missing_amount");

    const after = (s.tables.subscriptions ?? [])[0];
    expect(after.currentPeriodEnd).toBe(periodEnd);
    expect(after.status).toBe("active");
    expect(after.updatedAt).toBe(before.updatedAt);
  });

  test("payment_failed and subscription_updated still apply WITHOUT an amount (documented behavior)", async () => {
    const now = Date.now();
    const s = await seed({ plan: "pro", providerSubscriptionId: "sub_lifecycle" });

    const failed = (await handler(billing.applyProviderWebhook)._handler(s.ctx, {
      provider: "razorpay",
      eventId: "evt_lifecycle_1",
      type: "payment_failed",
      rawType: "subscription.halted", // no payment entity → no amount, by design
      occurredAt: now,
      providerSubscriptionId: "sub_lifecycle",
    })) as { outcome: string };
    expect(failed.outcome).toBe("applied");
    const sub = (s.tables.subscriptions ?? [])[0];
    expect(sub.status).toBe("past_due");
    expect(typeof sub.pastDueGraceUntil).toBe("number");

    const updated = (await handler(billing.applyProviderWebhook)._handler(s.ctx, {
      provider: "stripe",
      eventId: "evt_lifecycle_2",
      type: "subscription_updated",
      rawType: "customer.subscription.updated", // amount never read from this event
      occurredAt: now + 1_000,
      providerSubscriptionId: "sub_lifecycle",
      providerStatus: "active",
    })) as { outcome: string };
    expect(updated.outcome).toBe("applied");
    expect((s.tables.subscriptions ?? [])[0].status).toBe("active");
    expect((s.tables.subscriptions ?? [])[0].pastDueGraceUntil).toBeUndefined();
  });
});

/* ── Phase 10B — Stripe livemode flag ────────────────────────────────────── */

describe("billing — Stripe livemode normalization", () => {
  const stripePayload = (livemode?: boolean) =>
    JSON.stringify({
      id: "evt_livemode_1",
      type: "checkout.session.completed",
      created: 1_700_000_000,
      ...(livemode === undefined ? {} : { livemode }),
      data: {
        object: {
          id: "cs_live_1",
          amount_total: 29_900,
          currency: "inr",
          subscription: "sub_live_1",
        },
      },
    });

  test("livemode:true is flagged as a live event; test-mode and absent flags are not", () => {
    const live = normalizeStripeEvent(stripePayload(true));
    expect(live.ok).toBe(true);
    expect(live.ok ? live.event.livemode : undefined).toBe(true);

    const testMode = normalizeStripeEvent(stripePayload(false));
    expect(testMode.ok ? testMode.event.livemode : undefined).toBe(false);

    const absent = normalizeStripeEvent(stripePayload(undefined));
    expect(absent.ok ? absent.event.livemode : undefined).toBe(false);
    // Everything else is normalized identically — only the flag differs.
    expect(absent.ok ? absent.event.type : "not_ok").toBe("checkout_completed");
  });

  test("Razorpay events never carry the Stripe-only flag", () => {
    const rzp = normalizeRazorpayEvent(
      JSON.stringify({
        id: "evt_rzp_nolive",
        event: "payment.captured",
        payload: { payment: { entity: { amount: 29_900, currency: "INR" } } },
      }),
    );
    expect(rzp.ok).toBe(true);
    expect(rzp.ok ? rzp.event.livemode : "unset").toBeUndefined();
  });
});
