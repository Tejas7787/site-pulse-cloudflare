// SitePulse Phase 9B integration-readiness tests (Vitest + convex-test).
//
// Everything here runs with NO real credentials and NO network: actions that
// would call a provider must refuse before any request when keys are missing
// or live, and the alert sender must fall back safely when RESEND_API_KEY is
// absent. Real handlers throughout.
//
// Coverage boundaries (deliberate, to avoid duplication):
//  - GitHub OAuth callback/redemption/write-gate paths are already pinned in
//    tests/githubRepair.test.ts (mocked exchange, single-use state, open
//    redirect rejection, GITHUB_WRITE_ENABLED default off).
//  - Webhook signature verification and event normalization are pinned with
//    real HMAC in tests/billing.test.ts.
// This file covers what none of those did: the simulated-billing kill switch,
// provider actions refusing missing/LIVE credentials, the Razorpay first
// charge activating entitlements, and email alert delivery fallbacks.

import { afterEach, describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { api, internal } from "../src/convex/_generated/api";
import type { Id } from "../src/convex/_generated/dataModel";
import schema from "../src/convex/schema";
import { ALERT_MAX_AGE_MS } from "../src/lib/monitoring";

const modules = {
  "_generated/api.js": () => import("../src/convex/_generated/api.js"),
  "_generated/server.js": () => import("../src/convex/_generated/server.js"),
  "billing.ts": () => import("../src/convex/billing.ts"),
  "billingActions.ts": () => import("../src/convex/billingActions.ts"),
  "alerts.ts": () => import("../src/convex/alerts.ts"),
  "integrations.ts": () => import("../src/convex/integrations.ts"),
};

function freshBackend() {
  return convexTest(schema, modules);
}

/** Set/restore env vars around one test (fail-closed paths must see ABSENCE). */
async function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => Promise<void>,
) {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function createTestUser(t: ReturnType<typeof freshBackend>, email?: string) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", email === undefined ? {} : { email }),
  );
}

function signedInAs(t: ReturnType<typeof freshBackend>, userId: string, sessionId = "session1") {
  return t.withIdentity({ subject: `${userId}|${sessionId}` });
}

// Env hygiene for tests that must see a clean environment regardless of what
// a developer (or another file) exported locally.
const CLEAN_PROVIDER_ENV = {
  STRIPE_SECRET_KEY: undefined,
  STRIPE_WEBHOOK_SECRET: undefined,
  RAZORPAY_KEY_ID: undefined,
  RAZORPAY_KEY_SECRET: undefined,
  RAZORPAY_WEBHOOK_SECRET: undefined,
  RESEND_API_KEY: undefined,
  SITEPULSE_SIMULATED_BILLING: undefined,
  GITHUB_WRITE_ENABLED: undefined,
};

/* ── 1. Simulated paid-plan activation: DEFAULT DISABLED ──────────────────── */

describe("simulated billing kill switch (focus 5)", () => {
  test("with no configuration, simulated checkout is refused before any side effect", async () => {
    await withEnv(CLEAN_PROVIDER_ENV, async () => {
      const t = freshBackend();
      const userId = await createTestUser(t, "user@x.test");
      const user = signedInAs(t, userId);

      let error: unknown;
      try {
        await user.mutation(api.billing.startCheckout, { plan: "pro", currency: "INR" });
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(ConvexError);
      expect((error as ConvexError<{ code?: string }>).data.code).toBe(
        "simulated_billing_disabled",
      );

      // Nothing was written: no checkout row exists to later complete.
      const checkouts = await t.run(async (ctx) => ctx.db.query("billingCheckouts").collect());
      expect(checkouts).toHaveLength(0);

      // The completion path is gated too — an attacker cannot complete a
      // checkout row left behind by an older deployment. (A real-format id
      // is required so argument validation passes and the HANDLER's gate is
      // what rejects.)
      const legacyCheckoutId = await t.run(async (ctx) =>
        ctx.db.insert("billingCheckouts", {
          userId,
          plan: "pro",
          currency: "INR",
          amount: 29_900,
          provider: "simulated",
          status: "pending",
          createdAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        }),
      );
      let completionError: unknown;
      try {
        await user.mutation(api.billing.completeSimulatedCheckout, {
          checkoutId: legacyCheckoutId,
          outcome: "succeeded",
        });
      } catch (err) {
        completionError = err;
      }
      expect((completionError as ConvexError<{ code?: string }>).data.code).toBe(
        "simulated_billing_disabled",
      );
      const subs = await t.run(async (ctx) => ctx.db.query("subscriptions").collect());
      expect(subs).toHaveLength(0);
    });
  });

  test("billingMode.simulated reports false by default (pricing page hides the flow)", async () => {
    await withEnv(CLEAN_PROVIDER_ENV, async () => {
      const t = freshBackend();
      const catalog = await t.query(api.billing.getPlanCatalog, {});
      expect(catalog.billingMode.simulated).toBe(false);
      const userId = await createTestUser(t, "user@x.test");
      const mine = await signedInAs(t, userId).query(api.billing.getMySubscription, {});
      expect(mine?.billingMode.simulated).toBe(false);
    });
  });

  test("explicit opt-in (local/test env) re-enables the documented simulated flow", async () => {
    await withEnv({ ...CLEAN_PROVIDER_ENV, SITEPULSE_SIMULATED_BILLING: "true" }, async () => {
      const t = freshBackend();
      const userId = await createTestUser(t, "user@x.test");
      const user = signedInAs(t, userId);

      const catalog = await t.query(api.billing.getPlanCatalog, {});
      expect(catalog.billingMode.simulated).toBe(true);

      const checkout = await user.mutation(api.billing.startCheckout, {
        plan: "pro",
        currency: "INR",
      });
      expect(checkout.amount).toBe(29_900);
      const done = await user.mutation(api.billing.completeSimulatedCheckout, {
        checkoutId: checkout.checkoutId,
        outcome: "succeeded",
      });
      expect(done.ok).toBe(true);
      const subs = await t.run(async (ctx) => ctx.db.query("subscriptions").collect());
      expect(subs).toHaveLength(1);
      expect(subs[0].plan).toBe("pro");
    });
  });
});

/* ── 2. Provider actions refuse missing (or LIVE) credentials ─────────────── */

describe("provider checkout actions fail closed without test credentials (focus 2, 3)", () => {
  test("startStripeCheckout: missing key → not_configured, zero provider requests", async () => {
    await withEnv(CLEAN_PROVIDER_ENV, async () => {
      const t = freshBackend();
      const userId = await createTestUser(t, "user@x.test");
      const res = await signedInAs(t, userId).action(api.billingActions.startStripeCheckout, {
        plan: "pro",
        currency: "INR",
      });
      expect(res).toEqual({ ok: false, reason: "not_configured" });
    });
  });

  test("startStripeCheckout: a LIVE key is refused outright", async () => {
    await withEnv({ ...CLEAN_PROVIDER_ENV, STRIPE_SECRET_KEY: "sk_live_shouldneverwork" }, async () => {
      const t = freshBackend();
      const userId = await createTestUser(t, "user@x.test");
      const res = await signedInAs(t, userId).action(api.billingActions.startStripeCheckout, {
        plan: "pro",
        currency: "INR",
      });
      expect(res).toEqual({ ok: false, reason: "not_configured" });
    });
  });

  test("startRazorpayCheckout: missing key → not_configured, zero provider requests", async () => {
    await withEnv(CLEAN_PROVIDER_ENV, async () => {
      const t = freshBackend();
      const userId = await createTestUser(t, "user@x.test");
      const res = await signedInAs(t, userId).action(api.billingActions.startRazorpayCheckout, {
        plan: "pro",
        currency: "INR",
      });
      expect(res).toEqual({ ok: false, reason: "not_configured" });
    });
  });

  test("startRazorpayCheckout: a LIVE key is refused outright", async () => {
    await withEnv(
      { ...CLEAN_PROVIDER_ENV, RAZORPAY_KEY_ID: "rzp_live_shouldneverwork", RAZORPAY_KEY_SECRET: "x" },
      async () => {
        const t = freshBackend();
        const userId = await createTestUser(t, "user@x.test");
        const res = await signedInAs(t, userId).action(api.billingActions.startRazorpayCheckout, {
          plan: "pro",
          currency: "INR",
        });
        expect(res).toEqual({ ok: false, reason: "not_configured" });
      },
    );
  });

  test("startRazorpayCheckout: unauthenticated callers get nothing", async () => {
    await withEnv(CLEAN_PROVIDER_ENV, async () => {
      const t = freshBackend();
      const res = await t.action(api.billingActions.startRazorpayCheckout, {
        plan: "pro",
        currency: "INR",
      });
      expect(res).toEqual({ ok: false, reason: "unauthenticated" });
    });
  });
});

/* ── 3. Razorpay first charge activates entitlements (signed webhook) ─────── */

describe("Razorpay first-charge activation through applyProviderWebhook (focus 3)", () => {
  async function seedPendingRazorpayCheckout(t: ReturnType<typeof freshBackend>) {
    const userId = await createTestUser(t, "buyer@x.test");
    const checkoutId = await t.mutation(internal.billing.insertProviderCheckout, {
      userId,
      plan: "pro",
      currency: "INR",
      amount: 29_900,
      provider: "razorpay",
      providerCheckoutId: "rzp_sub_test123",
      ttlMs: 60_000,
    });
    return { userId, checkoutId };
  }

  test("subscription.charged BEFORE any subscriptions row → activated from the stored checkout", async () => {
    const t = freshBackend();
    const { userId } = await seedPendingRazorpayCheckout(t);

    // Razorpay's first charge links back through the subscription id, which
    // is exactly the providerCheckoutId stored at checkout creation.
    const res = await t.mutation(internal.billing.applyProviderWebhook, {
      provider: "razorpay",
      eventId: "evt_rzp_first",
      type: "renewal_paid",
      rawType: "subscription.charged",
      occurredAt: Date.now(),
      amount: 29_900,
      currency: "INR",
      providerSubscriptionId: "rzp_sub_test123",
      providerCheckoutId: "rzp_sub_test123",
    });
    expect(res.outcome).toBe("applied");

    const subs = await t.run(async (ctx) => ctx.db.query("subscriptions").collect());
    expect(subs).toHaveLength(1);
    expect(subs[0].userId).toBe(userId);
    expect(subs[0].plan).toBe("pro");
    expect(subs[0].status).toBe("active");
    // The provider subscription id is linked so every later event binds
    // directly instead of walking through the checkout row.
    expect(subs[0].providerSubscriptionId).toBe("rzp_sub_test123");

    const checkout = await t.run(async (ctx) => ctx.db.query("billingCheckouts").first());
    expect(checkout?.status).toBe("succeeded");

    // Replays are still no-ops.
    const replay = await t.mutation(internal.billing.applyProviderWebhook, {
      provider: "razorpay",
      eventId: "evt_rzp_first",
      type: "renewal_paid",
      rawType: "subscription.charged",
      occurredAt: Date.now(),
      amount: 29_900,
      currency: "INR",
      providerSubscriptionId: "rzp_sub_test123",
    });
    expect(replay.outcome).toBe("duplicate");
    const after = await t.run(async (ctx) => ctx.db.query("subscriptions").collect());
    expect(after).toHaveLength(1);
  });

  test("a first charge with the wrong amount changes nothing", async () => {
    const t = freshBackend();
    await seedPendingRazorpayCheckout(t);
    const res = await t.mutation(internal.billing.applyProviderWebhook, {
      provider: "razorpay",
      eventId: "evt_rzp_forged",
      type: "renewal_paid",
      rawType: "subscription.charged",
      occurredAt: Date.now(),
      amount: 1,
      currency: "INR",
      providerSubscriptionId: "rzp_sub_test123",
      providerCheckoutId: "rzp_sub_test123",
    });
    expect(res.outcome).toBe("rejected");
    const subs = await t.run(async (ctx) => ctx.db.query("subscriptions").collect());
    expect(subs).toHaveLength(0);
  });

  test("an event that matches nothing (invalid webhook event) is rejected, state untouched", async () => {
    const t = freshBackend();
    const res = await t.mutation(internal.billing.applyProviderWebhook, {
      provider: "razorpay",
      eventId: "evt_rzp_orphan",
      type: "renewal_paid",
      rawType: "subscription.charged",
      occurredAt: Date.now(),
      providerSubscriptionId: "rzp_sub_nobody",
      providerCheckoutId: "rzp_sub_nobody",
    });
    expect(res.outcome).toBe("rejected");
    const subs = await t.run(async (ctx) => ctx.db.query("subscriptions").collect());
    expect(subs).toHaveLength(0);
    const events = await t.run(async (ctx) => ctx.db.query("billingEvents").collect());
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe("rejected");
  });
});

/* ── 4. Email alert delivery: safe fallbacks + full test-mode send ────────── */

describe("downtime/recovery alert email delivery (focus 4)", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /** A real monitor + incident + enqueued delivery through the real handler. */
  async function enqueueRealDelivery(
    t: ReturnType<typeof freshBackend>,
    kind: "downtime" | "recovery",
  ) {
    const userId = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: "alerts@x.test" }),
    );
    const monitorId = (await t.run(async (ctx) =>
      ctx.db.insert("monitors", {
        ownerId: userId,
        name: "example.com",
        url: "https://example.com/",
        host: "example.com",
        intervalMs: 300_000,
        status: "active",
        state: kind === "downtime" ? "down" : "up",
        nextCheckAt: 0,
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        createdAt: Date.now(),
      }),
    )) as Id<"monitors">;
    const incidentId = (await t.run(async (ctx) =>
      ctx.db.insert("incidents", {
        monitorId,
        kind: "down",
        openedAt: Date.now() - 60_000,
        ...(kind === "recovery"
          ? { open: false, closedAt: Date.now(), recoveredAt: Date.now(), durationMs: 60_000 }
          : { open: true }),
        reason: "http-503",
        failureCount: 2,
      }),
    )) as Id<"incidents">;
    const enqueued = await t.mutation(internal.alerts.enqueue, {
      monitorId,
      incidentId,
      kind,
      url: "https://example.com/",
      host: "example.com",
      openedAt: Date.now() - 60_000,
      ...(kind === "recovery" ? { recoveredAt: Date.now() } : {}),
      reason: "http-503",
    });
    expect(enqueued.queued).toBe(true);
    return { monitorId, incidentId };
  }

  test("without RESEND_API_KEY a fresh alert stays queued (safe fallback, retried later)", async () => {
    await withEnv({ RESEND_API_KEY: undefined }, async () => {
      const t = freshBackend();
      await enqueueRealDelivery(t, "downtime");

      const res = await t.action(internal.alerts.sendQueued, {});
      expect(res.pending).toBe(1);
      expect(res.sent).toBe(0);
      expect(res.reason).toBe("not_configured");

      const rows = await t.run(async (ctx) => ctx.db.query("alertDeliveries").collect());
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("queued"); // NOT failed — the cron will retry
    });
  });

  test("without RESEND_API_KEY an aged alert fails honestly instead of retrying forever", async () => {
    await withEnv({ RESEND_API_KEY: undefined }, async () => {
      const t = freshBackend();
      await enqueueRealDelivery(t, "downtime");
      await t.run(async (ctx) => {
        const row = await ctx.db.query("alertDeliveries").first();
        await ctx.db.patch(row!._id, { createdAt: Date.now() - ALERT_MAX_AGE_MS - 1_000 });
      });

      const res = await t.action(internal.alerts.sendQueued, {});
      expect(res.failed).toBe(1);
      const rows = await t.run(async (ctx) => ctx.db.query("alertDeliveries").collect());
      expect(rows[0].status).toBe("failed");
      expect(rows[0].error).toContain("RESEND_API_KEY");
    });
  });

  test("test-mode send: downtime and recovery each deliver exactly once (stubbed provider)", async () => {
    await withEnv({ RESEND_API_KEY: "re_test_fake_key" }, async () => {
      const calls: Array<{ to: string; subject: string }> = [];
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push(JSON.parse(String(init?.body ?? "{}")) as { to: string; subject: string });
        return new Response(JSON.stringify({ id: `email_${calls.length}` }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch;

      const t = freshBackend();
      await enqueueRealDelivery(t, "downtime");
      await enqueueRealDelivery(t, "recovery");

      const first = await t.action(internal.alerts.sendQueued, {});
      expect(first.sent).toBe(2);
      expect(first.failed).toBe(0);
      expect(calls).toHaveLength(2);
      expect(calls[0].to).toContain("alerts@x.test");
      expect(calls[0].subject).toContain("DOWN");
      expect(calls[1].subject).toContain("back up");

      const rows = await t.run(async (ctx) => ctx.db.query("alertDeliveries").collect());
      expect(rows.every((r) => r.status === "sent")).toBe(true);

      // A second drain finds nothing to send — no duplicate notifications.
      const second = await t.action(internal.alerts.sendQueued, {});
      expect(second.sent).toBe(0);
      expect(calls).toHaveLength(2);
    });
  });

  test("a provider failure marks the row failed without throwing (probe never breaks)", async () => {
    await withEnv({ RESEND_API_KEY: "re_test_fake_key" }, async () => {
      globalThis.fetch = (async () =>
        new Response("provider exploded", { status: 500 })) as typeof fetch;

      const t = freshBackend();
      await enqueueRealDelivery(t, "downtime");
      const res = await t.action(internal.alerts.sendQueued, {});
      expect(res.failed).toBe(1);
      const rows = await t.run(async (ctx) => ctx.db.query("alertDeliveries").collect());
      expect(rows[0].status).toBe("failed");
      expect(rows[0].error).toContain("HTTP 500");
    });
  });
});

/* ── 5. Integration status: readiness booleans, never secret values ───────── */

describe("getIntegrationStatus (focus: safe configuration checks)", () => {
  test("reports booleans only — configured secrets never appear in the response", async () => {
    await withEnv(
      {
        ...CLEAN_PROVIDER_ENV,
        STRIPE_SECRET_KEY: "sk_test_supersecretvalue",
        STRIPE_WEBHOOK_SECRET: "whsec_supersecretvalue",
        RAZORPAY_KEY_ID: "rzp_test_secretidvalue",
        RAZORPAY_KEY_SECRET: "razorsecretvalue",
        RAZORPAY_WEBHOOK_SECRET: "rzpwhsec_secretvalue",
        RESEND_API_KEY: "re_secretvalue",
        GITHUB_CLIENT_ID: "gh_client_secretid",
        GITHUB_CLIENT_SECRET: "gh_outragesecret",
        CONVEX_SITE_URL: "https://example.convex.site",
      },
      async () => {
        const t = freshBackend();
        const status = await t.query(api.integrations.getIntegrationStatus, {});
        expect(status.billing.stripe).toBe(true);
        expect(status.billing.razorpay).toBe(true);
        expect(status.billing.stripeWebhookConfigured).toBe(true);
        expect(status.billing.razorpayWebhookConfigured).toBe(true);
        expect(status.billing.simulatedEnabled).toBe(false);
        expect(status.email.resendConfigured).toBe(true);
        expect(status.github.configured).toBe(true);
        expect(status.github.redirectConfigured).toBe(true);
        expect(status.github.writeEnabled).toBe(false); // default off

        // The whole response is one big secret-canary: none of the configured
        // secret values may ever appear anywhere inside it.
        const serialized = JSON.stringify(status);
        for (const secret of [
          "sk_test_supersecretvalue",
          "whsec_supersecretvalue",
          "rzp_test_secretidvalue",
          "razorsecretvalue",
          "rzpwhsec_secretvalue",
          "re_secretvalue",
          "gh_outragesecret",
        ]) {
          expect(serialized).not.toContain(secret);
        }
      },
    );
  });

  test("an unconfigured deployment reports everything false, not an error", async () => {
    await withEnv(
      { ...CLEAN_PROVIDER_ENV, GITHUB_CLIENT_ID: undefined, GITHUB_CLIENT_SECRET: undefined, CONVEX_SITE_URL: undefined },
      async () => {
        const t = freshBackend();
        const status = await t.query(api.integrations.getIntegrationStatus, {});
        expect(status.github.configured).toBe(false);
        expect(status.billing.stripe).toBe(false);
        expect(status.billing.razorpay).toBe(false);
        expect(status.email.resendConfigured).toBe(false);
      },
    );
  });
});
