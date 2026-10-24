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
import { DEFAULT_ALERT_FROM, resolveAlertFrom } from "../src/lib/alerts";
import {
  configuredSenderIsVerified,
  fromDomain,
  VERIFIED_SENDER_DOMAIN,
} from "../src/lib/alerts";
import { TEST_EMAIL_LIMIT_PER_HOUR } from "../src/convex/alerts";

const modules = {
  "_generated/api.js": () => import("../src/convex/_generated/api.js"),
  "_generated/server.js": () => import("../src/convex/_generated/server.js"),
  "billing.ts": () => import("../src/convex/billing.ts"),
  "billingActions.ts": () => import("../src/convex/billingActions.ts"),
  "alerts.ts": () => import("../src/convex/alerts.ts"),
  "integrations.ts": () => import("../src/convex/integrations.ts"),
  // Phase 10B: the billing webhook HTTP routes are tested through `t.fetch`.
  "http.ts": () => import("../src/convex/http.ts"),
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

/* ── 6. Resend sender resolution (Phase 9D) ────────────────────────────────── */

describe("alert sender resolution (RESEND_FROM_EMAIL → RESEND_FROM → verified default)", () => {
  test("pure precedence: canonical name wins, then legacy, then the verified default", () => {
    expect(
      resolveAlertFrom(["SitePulse Alerts <alerts@alerts.tejasdev.xyz>", "legacy@x.test"]),
    ).toBe("SitePulse Alerts <alerts@alerts.tejasdev.xyz>");
    expect(resolveAlertFrom([undefined, "SitePulse <legacy@x.test>"])).toBe(
      "SitePulse <legacy@x.test>",
    );
    expect(resolveAlertFrom(["  padded@example.com  "])).toBe("padded@example.com");

    // The project default IS the verified SENDER SUBDOMAIN (requirement):
    // alerts.tejasdev.xyz, NOT the root tejasdev.xyz.
    expect(VERIFIED_SENDER_DOMAIN).toBe("alerts.tejasdev.xyz");
    expect(DEFAULT_ALERT_FROM).toBe(
      "SitePulse Alerts <alerts@alerts.tejasdev.xyz>",
    );
    expect(resolveAlertFrom([])).toBe(DEFAULT_ALERT_FROM);
    expect(resolveAlertFrom([undefined, undefined])).toBe(DEFAULT_ALERT_FROM);
  });

  test("fromDomain parses both From forms; garbage parses to null", () => {
    expect(fromDomain("alerts@alerts.tejasdev.xyz")).toBe("alerts.tejasdev.xyz");
    expect(fromDomain("SitePulse Alerts <alerts@alerts.tejasdev.xyz>")).toBe(
      "alerts.tejasdev.xyz",
    );
    expect(fromDomain("  Name <A@B.Example>  ")).toBe("b.example");
    expect(fromDomain("not-an-address")).toBeNull();
    expect(fromDomain("")).toBeNull();
    expect(fromDomain(undefined)).toBeNull();
  });

  test("configuredSenderIsVerified: verified subdomain only — the ROOT domain fails", () => {
    // Unconfigured falls back to the verified default → true.
    expect(configuredSenderIsVerified([])).toBe(true);
    expect(configuredSenderIsVerified([undefined, undefined])).toBe(true);
    // The exact verified sender passes, in both From forms.
    expect(
      configuredSenderIsVerified(["SitePulse <alerts@alerts.tejasdev.xyz>"]),
    ).toBe(true);
    expect(configuredSenderIsVerified(["alerts@alerts.tejasdev.xyz"])).toBe(true);
    // THE CORRECTION THIS PINS: the root domain is NOT verified for sending.
    expect(configuredSenderIsVerified(["SitePulse <alerts@tejasdev.xyz>"])).toBe(
      false,
    );
    expect(configuredSenderIsVerified(["tejasdev.xyz <x@tejasdev.xyz>"])).toBe(
      false,
    );
    expect(configuredSenderIsVerified(["someone@example.com"])).toBe(false);
    // Garbage falls through to the verified default → true.
    expect(configuredSenderIsVerified(["not-an-address"])).toBe(true);
  });

  test("malformed configured values fall through instead of sending from a bad From", () => {
    expect(resolveAlertFrom(["not-an-address", "ok@x.test"])).toBe("ok@x.test");
    expect(resolveAlertFrom(["Name <>", ""])).toBe(DEFAULT_ALERT_FROM);
    expect(resolveAlertFrom(["spaces in@here.example"])).toBe(DEFAULT_ALERT_FROM);
  });

  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /** One real queued delivery, reused from the outbox suite above. */
  async function queueOne(t: ReturnType<typeof freshBackend>) {
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
        state: "down",
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
        open: true,
        reason: "http-503",
        failureCount: 2,
      }),
    )) as Id<"incidents">;
    await t.mutation(internal.alerts.enqueue, {
      monitorId,
      incidentId,
      kind: "downtime",
      url: "https://example.com/",
      host: "example.com",
      openedAt: Date.now() - 60_000,
      reason: "http-503",
    });
  }

  function stubProvider(calls: Array<Record<string, unknown>>) {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return new Response(JSON.stringify({ id: `email_${calls.length}` }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
  }

  test("outbox drain sends with RESEND_FROM_EMAIL as the From (stubbed provider)", async () => {
    await withEnv(
      {
        RESEND_API_KEY: "re_test_fake_key",
        RESEND_FROM_EMAIL: "SitePulse Alerts <alerts@alerts.tejasdev.xyz>",
        RESEND_FROM: undefined,
      },
      async () => {
        const calls: Array<Record<string, unknown>> = [];
        stubProvider(calls);
        const t = freshBackend();
        await queueOne(t);
        const res = await t.action(internal.alerts.sendQueued, {});
        expect(res.sent).toBe(1);
        expect(calls).toHaveLength(1);
        expect(calls[0].from).toBe("SitePulse Alerts <alerts@alerts.tejasdev.xyz>");
      },
    );
  });

  test("legacy RESEND_FROM still honored; with neither, the verified default is used", async () => {
    await withEnv(
      {
        RESEND_API_KEY: "re_test_fake_key",
        RESEND_FROM_EMAIL: undefined,
        RESEND_FROM: "SitePulse <legacy@x.test>",
      },
      async () => {
        const calls: Array<Record<string, unknown>> = [];
        stubProvider(calls);
        const t = freshBackend();
        await queueOne(t);
        await t.action(internal.alerts.sendQueued, {});
        expect(calls[0].from).toBe("SitePulse <legacy@x.test>");
      },
    );

    await withEnv(
      {
        RESEND_API_KEY: "re_test_fake_key",
        RESEND_FROM_EMAIL: undefined,
        RESEND_FROM: undefined,
      },
      async () => {
        const calls: Array<Record<string, unknown>> = [];
        stubProvider(calls);
        const t = freshBackend();
        await queueOne(t);
        await t.action(internal.alerts.sendQueued, {});
        expect(calls[0].from).toBe(DEFAULT_ALERT_FROM);
      },
    );
  });

  test("status reports sender presence and verified-domain match — values never echoed", async () => {
    await withEnv(
      {
        RESEND_API_KEY: "re_canary_secretvalue",
        RESEND_FROM_EMAIL: "SitePulse Alerts <alerts@alerts.tejasdev.xyz>",
        RESEND_FROM: undefined,
      },
      async () => {
        const t = freshBackend();
        const status = await t.query(api.integrations.getIntegrationStatus, {});
        expect(status.email.resendConfigured).toBe(true);
        expect(status.email.customFromConfigured).toBe(true);
        expect(status.email.fromOnVerifiedDomain).toBe(true);
        const serialized = JSON.stringify(status);
        expect(serialized).not.toContain("re_canary_secretvalue");
        // The configured From VALUE is an env value too — never echoed.
        expect(serialized).not.toContain("alerts@alerts.tejasdev.xyz");
        expect(serialized).not.toContain("tejasdev.xyz");
      },
    );

    // A sender pointed at the ROOT domain (or anywhere else unverified) is
    // reported honestly as not-on-verified-domain — still no value echoed.
    await withEnv(
      {
        RESEND_API_KEY: "re_test_fake_key",
        RESEND_FROM_EMAIL: "SitePulse <alerts@tejasdev.xyz>",
        RESEND_FROM: undefined,
      },
      async () => {
        const t = freshBackend();
        const status = await t.query(api.integrations.getIntegrationStatus, {});
        expect(status.email.customFromConfigured).toBe(true);
        expect(status.email.fromOnVerifiedDomain).toBe(false);
        expect(JSON.stringify(status)).not.toContain("tejasdev.xyz");
      },
    );

    // Unset sender → falls back to the verified default → reported true.
    await withEnv(
      { RESEND_API_KEY: undefined, RESEND_FROM_EMAIL: undefined, RESEND_FROM: undefined },
      async () => {
        const t = freshBackend();
        const status = await t.query(api.integrations.getIntegrationStatus, {});
        expect(status.email.customFromConfigured).toBe(false);
        expect(status.email.fromOnVerifiedDomain).toBe(true);
      },
    );
  });
});

/* ── 7. Authenticated test-email workflow (Phase 9D) ───────────────────────── */

describe("sendTestEmail (safe, authenticated, server-side only)", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function stubProvider(calls: Array<Record<string, unknown>>, status = 200) {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return new Response(JSON.stringify({ id: `email_${calls.length}` }), {
        status,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
  }

  test("anonymous callers are refused before any network contact", async () => {
    await withEnv({ RESEND_API_KEY: "re_test_fake_key" }, async () => {
      const calls: Array<Record<string, unknown>> = [];
      stubProvider(calls);
      const t = freshBackend();
      try {
        await t.action(api.alerts.sendTestEmail, { to: "operator@x.test" });
        throw new Error("expected auth_required");
      } catch (err) {
        expect(err).toBeInstanceOf(ConvexError);
        expect((err as ConvexError<{ code?: string }>).data.code).toBe("auth_required");
      }
      expect(calls).toHaveLength(0);
    });
  });

  test("missing RESEND_API_KEY refuses honestly — no env values in the error", async () => {
    await withEnv(
      { RESEND_API_KEY: undefined, RESEND_FROM_EMAIL: "SitePulse Alerts <alerts@alerts.tejasdev.xyz>" },
      async () => {
        const t = freshBackend();
        const userId = await createTestUser(t, "operator@x.test");
        const asUser = signedInAs(t, userId);
        try {
          await asUser.action(api.alerts.sendTestEmail, { to: "operator@x.test" });
          throw new Error("expected not_configured");
        } catch (err) {
          expect(err).toBeInstanceOf(ConvexError);
          const data = (err as ConvexError<{ code?: string; message?: string }>).data;
          expect(data.code).toBe("not_configured");
          expect(data.message).toContain("RESEND_API_KEY");
          expect(data.message).not.toContain("alerts.tejasdev.xyz");
        }
      },
    );
  });

  test("signed-in success: sends through the shared helper with the resolved From", async () => {
    await withEnv(
      {
        RESEND_API_KEY: "re_supersecret_canary",
        RESEND_FROM_EMAIL: "SitePulse Alerts <alerts@alerts.tejasdev.xyz>",
      },
      async () => {
        const calls: Array<Record<string, unknown>> = [];
        stubProvider(calls);
        const t = freshBackend();
        const userId = await createTestUser(t, "operator@x.test");

        const res = await signedInAs(t, userId).action(api.alerts.sendTestEmail, {
          to: "operator@x.test",
        });
        expect(res.ok).toBe(true);
        if (res.ok) expect(res.providerId).toBe("email_1");

        expect(calls).toHaveLength(1);
        expect(calls[0].from).toBe("SitePulse Alerts <alerts@alerts.tejasdev.xyz>");
        expect(calls[0].to).toEqual(["operator@x.test"]);
        expect(String(calls[0].subject)).toContain("test email");

        // Secret canary: the API key never appears in the returned result.
        expect(JSON.stringify(res)).not.toContain("re_supersecret_canary");
      },
    );
  });

  test("invalid recipient is rejected; quota bounds sends per user", async () => {
    await withEnv({ RESEND_API_KEY: "re_test_fake_key" }, async () => {
      const calls: Array<Record<string, unknown>> = [];
      stubProvider(calls);
      const t = freshBackend();
      const userId = await createTestUser(t, "operator@x.test");
      const asUser = signedInAs(t, userId);

      await expect(
        asUser.action(api.alerts.sendTestEmail, { to: "not-an-email" }),
      ).rejects.toThrow();
      expect(calls).toHaveLength(0);

      for (let i = 0; i < TEST_EMAIL_LIMIT_PER_HOUR; i++) {
        const ok = await asUser.action(api.alerts.sendTestEmail, {
          to: "operator@x.test",
        });
        expect(ok.ok).toBe(true);
      }
      expect(calls).toHaveLength(TEST_EMAIL_LIMIT_PER_HOUR);

      try {
        await asUser.action(api.alerts.sendTestEmail, { to: "operator@x.test" });
        throw new Error("expected rate_limited");
      } catch (err) {
        expect(err).toBeInstanceOf(ConvexError);
        expect((err as ConvexError<{ code?: string }>).data.code).toBe("rate_limited");
      }
      // The denied call never reached the provider.
      expect(calls).toHaveLength(TEST_EMAIL_LIMIT_PER_HOUR);
    });
  });

  test("a provider failure is reported without throwing or leaking the key", async () => {
    await withEnv({ RESEND_API_KEY: "re_supersecret_canary" }, async () => {
      const calls: Array<Record<string, unknown>> = [];
      stubProvider(calls, 500);
      const t = freshBackend();
      const userId = await createTestUser(t, "operator@x.test");

      const res = await signedInAs(t, userId).action(api.alerts.sendTestEmail, {
        to: "operator@x.test",
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).toContain("HTTP 500");
        expect(res.error).not.toContain("re_supersecret_canary");
      }
    });
  });
});

/* ── 6. Billing webhook HTTP routes: fail-closed status contract ──────────── */

// Real route-level tests through convex-test's `t.fetch` — the exact statuses
// a provider would see: 503 when no webhook secret is configured, 401 for a
// bad signature, 400 for a malformed or LIVE-mode payload, and a signed
// end-to-end test-mode activation. No network and no real credentials: every
// signature here is computed with a fake secret over the raw body, exactly
// like the provider would.
describe("billing webhook HTTP routes (Phase 10B)", () => {
  const STRIPE_ROUTE_SECRET = "whsec_route_test_secret";
  const RAZORPAY_ROUTE_SECRET = "rzpwhsec_route_test_secret";

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

  /** Stripe's `Stripe-Signature` header over the raw payload. */
  async function stripeHeader(
    payload: string,
    secret: string,
    ts = Math.floor(Date.now() / 1000),
  ): Promise<string> {
    const v1 = await hmacHex(secret, `${ts}.${payload}`);
    return `t=${ts},v1=${v1}`;
  }

  const checkoutCompletedEvent = (livemode: boolean) =>
    JSON.stringify({
      id: "evt_route_checkout",
      type: "checkout.session.completed",
      created: Math.floor(Date.now() / 1000),
      livemode,
      data: {
        object: {
          id: "cs_test_route_1",
          object: "checkout.session",
          amount_total: 29_900,
          currency: "inr",
          subscription: "sub_test_route_1",
          status: "complete",
        },
      },
    });

  async function seedPendingStripeCheckout(t: ReturnType<typeof freshBackend>) {
    const userId = await createTestUser(t, "buyer@x.test");
    // The real internal mutation validates the amount against the catalog.
    await t.mutation(internal.billing.insertProviderCheckout, {
      userId,
      plan: "pro",
      currency: "INR",
      amount: 29_900,
      provider: "stripe",
      providerCheckoutId: "cs_test_route_1",
      ttlMs: 60_000,
    });
    return { userId };
  }

  test("missing webhook secret → 503 on both routes, nothing is processed", async () => {
    await withEnv(
      { STRIPE_WEBHOOK_SECRET: undefined, RAZORPAY_WEBHOOK_SECRET: undefined },
      async () => {
        const t = freshBackend();
        const res = await t.fetch("/billing/webhooks/stripe", {
          method: "POST",
          body: JSON.stringify({ id: "evt_x", type: "checkout.session.completed" }),
        });
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ error: "webhook_not_configured" });

        const rzp = await t.fetch("/billing/webhooks/razorpay", {
          method: "POST",
          body: JSON.stringify({ id: "evt_y", event: "payment.captured" }),
        });
        expect(rzp.status).toBe(503);
        expect(await rzp.json()).toEqual({ error: "webhook_not_configured" });

        // Fail closed: nothing reached the backend at all.
        const events = await t.run(async (ctx) => ctx.db.query("billingEvents").collect());
        expect(events).toHaveLength(0);
      },
    );
  });

  test("invalid signature → 401, state untouched", async () => {
    await withEnv({ STRIPE_WEBHOOK_SECRET: STRIPE_ROUTE_SECRET }, async () => {
      const t = freshBackend();
      await seedPendingStripeCheckout(t);
      const payload = checkoutCompletedEvent(false);
      // Signed with the WRONG secret — an attacker without the secret.
      const header = await stripeHeader(payload, "whsec_wrong_secret");

      const res = await t.fetch("/billing/webhooks/stripe", {
        method: "POST",
        headers: { "Stripe-Signature": header },
        body: payload,
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "invalid_signature" });

      const subs = await t.run(async (ctx) => ctx.db.query("subscriptions").collect());
      expect(subs).toHaveLength(0);
      const events = await t.run(async (ctx) => ctx.db.query("billingEvents").collect());
      expect(events).toHaveLength(0);
    });
  });

  test("valid signature over a malformed payload → 400, state untouched", async () => {
    await withEnv({ STRIPE_WEBHOOK_SECRET: STRIPE_ROUTE_SECRET }, async () => {
      const t = freshBackend();
      await seedPendingStripeCheckout(t);
      const payload = "this is not json";
      const header = await stripeHeader(payload, STRIPE_ROUTE_SECRET);

      const res = await t.fetch("/billing/webhooks/stripe", {
        method: "POST",
        headers: { "Stripe-Signature": header },
        body: payload,
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_json" });

      const subs = await t.run(async (ctx) => ctx.db.query("subscriptions").collect());
      expect(subs).toHaveLength(0);
      const events = await t.run(async (ctx) => ctx.db.query("billingEvents").collect());
      expect(events).toHaveLength(0);
    });
  });

  test("a correctly signed LIVE-mode event → 400 live_mode_event, nothing activated", async () => {
    await withEnv({ STRIPE_WEBHOOK_SECRET: STRIPE_ROUTE_SECRET }, async () => {
      const t = freshBackend();
      await seedPendingStripeCheckout(t);
      const payload = checkoutCompletedEvent(true);
      const header = await stripeHeader(payload, STRIPE_ROUTE_SECRET);

      const res = await t.fetch("/billing/webhooks/stripe", {
        method: "POST",
        headers: { "Stripe-Signature": header },
        body: payload,
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "live_mode_event" });

      const subs = await t.run(async (ctx) => ctx.db.query("subscriptions").collect());
      expect(subs).toHaveLength(0);
      const events = await t.run(async (ctx) => ctx.db.query("billingEvents").collect());
      expect(events).toHaveLength(0);
    });
  });

  test("signed test-mode checkout.session.completed → 200 and the catalog plan activates (positive path)", async () => {
    await withEnv({ STRIPE_WEBHOOK_SECRET: STRIPE_ROUTE_SECRET }, async () => {
      const t = freshBackend();
      const { userId } = await seedPendingStripeCheckout(t);
      const payload = checkoutCompletedEvent(false);
      const header = await stripeHeader(payload, STRIPE_ROUTE_SECRET);

      const res = await t.fetch("/billing/webhooks/stripe", {
        method: "POST",
        headers: { "Stripe-Signature": header },
        body: payload,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ received: true, outcome: "applied" });

      const subs = await t.run(async (ctx) => ctx.db.query("subscriptions").collect());
      expect(subs).toHaveLength(1);
      expect(subs[0].userId).toBe(userId);
      expect(subs[0].plan).toBe("pro");
      expect(subs[0].currency).toBe("INR");
      // Server-owned catalog amount — never the client, never the event alone.
      expect(subs[0].amountPerPeriod).toBe(29_900);
      expect(subs[0].provider).toBe("stripe");
      expect(subs[0].status).toBe("active");
      expect(subs[0].providerSubscriptionId).toBe("sub_test_route_1");

      const checkout = await t.run(async (ctx) =>
        ctx.db.query("billingCheckouts").first(),
      );
      expect(checkout?.status).toBe("succeeded");

      // A duplicate delivery (Stripe retry) is a no-op.
      const retry = await t.fetch("/billing/webhooks/stripe", {
        method: "POST",
        headers: { "Stripe-Signature": await stripeHeader(payload, STRIPE_ROUTE_SECRET) },
        body: payload,
      });
      expect(retry.status).toBe(200);
      expect(await retry.json()).toEqual({ received: true, outcome: "duplicate" });
      const after = await t.run(async (ctx) => ctx.db.query("subscriptions").collect());
      expect(after).toHaveLength(1);
    });
  });

  test("Razorpay: invalid signature → 401 with a configured secret", async () => {
    await withEnv(
      {
        STRIPE_WEBHOOK_SECRET: undefined,
        RAZORPAY_WEBHOOK_SECRET: RAZORPAY_ROUTE_SECRET,
      },
      async () => {
        const t = freshBackend();
        const payload = JSON.stringify({
          id: "evt_rzp_route",
          event: "payment.captured",
          payload: { payment: { entity: { amount: 29_900, currency: "INR" } } },
        });
        const header = await hmacHex("rzpwhsec_wrong", payload);

        const res = await t.fetch("/billing/webhooks/razorpay", {
          method: "POST",
          headers: { "X-Razorpay-Signature": header },
          body: payload,
        });
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: "invalid_signature" });
      },
    );
  });
});
