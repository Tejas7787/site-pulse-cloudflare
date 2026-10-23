// SitePulse Phase 9A integration tests (Vitest + convex-test).
//
// Launch-blocking reliability fixes for the two UNAUTHENTICATED write
// endpoints:
//  - analytics.track and feedback.submit used to accept an unbounded number
//    of inserts from any caller; both now consume a per-visitor rolling
//    quota through the same machinery as the scanner's save-scan quota.
//  - neither table had retention, so rows lived forever; both are now swept
//    by one bounded, indexed cron (analytics.deleteExpiredAnalytics).
// Real handlers throughout — the quota gates and the sweep run exactly as
// they do in production.

import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "../src/convex/_generated/api";
import schema from "../src/convex/schema";
import { ANALYTICS_EVENT_LIMIT, FEEDBACK_LIMIT } from "../src/convex/rateLimit";
import { analyticsRetentionCutoff, feedbackRetentionCutoff } from "../src/convex/retention";

const modules = {
  "_generated/api.js": () => import("../src/convex/_generated/api.js"),
  "_generated/server.js": () => import("../src/convex/_generated/server.js"),
  "analytics.ts": () => import("../src/convex/analytics.ts"),
  "feedback.ts": () => import("../src/convex/feedback.ts"),
};

function freshBackend() {
  return convexTest(schema, modules);
}

function pageView(visitorId = "visitor-1") {
  return {
    name: "page_view",
    visitorId,
    sessionId: "session-1",
    path: "/",
  };
}

// ── analytics.track: public-write throttle ──────────────────────────────────

describe("analytics.track — per-visitor quota (was: unbounded public inserts)", () => {
  test("one visitor is capped at the hourly limit; the excess is silently dropped", async () => {
    const t = freshBackend();
    for (let i = 0; i < ANALYTICS_EVENT_LIMIT; i += 1) {
      await t.mutation(api.analytics.track, pageView());
    }
    // The next event from the SAME visitor must not be stored — and must not
    // throw: telemetry can never break the page it is fired from.
    await expect(t.mutation(api.analytics.track, pageView())).resolves.toBe(null);

    const rows = await t.run(async (ctx) => ctx.db.query("analyticsEvents").collect());
    expect(rows).toHaveLength(ANALYTICS_EVENT_LIMIT);
  });

  test("a different visitor has their own bucket", async () => {
    const t = freshBackend();
    for (let i = 0; i < ANALYTICS_EVENT_LIMIT; i += 1) {
      await t.mutation(api.analytics.track, pageView("visitor-1"));
    }
    await t.mutation(api.analytics.track, pageView("visitor-2"));
    const rows = await t.run(async (ctx) => ctx.db.query("analyticsEvents").collect());
    expect(rows).toHaveLength(ANALYTICS_EVENT_LIMIT + 1);
    expect(rows.filter((r) => r.visitorId === "visitor-2")).toHaveLength(1);
  });

  test("unknown event names are still dropped before any quota is consumed", async () => {
    const t = freshBackend();
    for (let i = 0; i < 5; i += 1) {
      await t.mutation(api.analytics.track, { ...pageView(), name: "evil_event" });
    }
    const rows = await t.run(async (ctx) => ctx.db.query("analyticsEvents").collect());
    expect(rows).toHaveLength(0);
  });
});

// ── feedback.submit: public-write throttle ──────────────────────────────────

describe("feedback.submit — per-visitor quota (was: unbounded public inserts)", () => {
  test("the sixth submission in the window is rejected as rate_limited", async () => {
    const t = freshBackend();
    for (let i = 0; i < FEEDBACK_LIMIT; i += 1) {
      await t.mutation(api.feedback.submit, { rating: 5, visitorId: "visitor-1" });
    }
    let error: unknown;
    try {
      await t.mutation(api.feedback.submit, { rating: 5, visitorId: "visitor-1" });
    } catch (err) {
      error = err;
    }
    expect(error).toBeDefined();
    expect(String(error)).toContain("rate_limited");

    const rows = await t.run(async (ctx) => ctx.db.query("feedback").collect());
    expect(rows).toHaveLength(FEEDBACK_LIMIT);
  });

  test("visitors are throttled independently", async () => {
    const t = freshBackend();
    for (let i = 0; i < FEEDBACK_LIMIT; i += 1) {
      await t.mutation(api.feedback.submit, { rating: 4, visitorId: "visitor-1" });
    }
    await t.mutation(api.feedback.submit, { rating: 4, visitorId: "visitor-2" });
    const rows = await t.run(async (ctx) => ctx.db.query("feedback").collect());
    expect(rows).toHaveLength(FEEDBACK_LIMIT + 1);
  });
});

// ── retention: bounded, indexed sweep ──────────────────────────────────────

describe("analytics & feedback retention (was: rows lived forever)", () => {
  test("only rows older than the cutoff are deleted, in both tables", async () => {
    const t = freshBackend();
    const now = Date.now();
    const old = analyticsRetentionCutoff(now) - 1;
    const fresh = now - 60_000;

    await t.run(async (ctx) => {
      await ctx.db.insert("analyticsEvents", {
        name: "page_view",
        visitorId: "v-old",
        sessionId: "s",
        createdAt: old,
      });
      await ctx.db.insert("analyticsEvents", {
        name: "page_view",
        visitorId: "v-new",
        sessionId: "s",
        createdAt: fresh,
      });
      await ctx.db.insert("feedback", { rating: 1, createdAt: feedbackRetentionCutoff(now) - 1 });
      await ctx.db.insert("feedback", { rating: 5, createdAt: fresh });
    });

    const result = await t.mutation(internal.analytics.deleteExpiredAnalytics, {
      maxDeletes: 100,
    });
    expect(result).toEqual({ analyticsEvents: 1, feedback: 1, complete: true });

    const events = await t.run(async (ctx) => ctx.db.query("analyticsEvents").collect());
    expect(events).toHaveLength(1);
    expect(events[0].visitorId).toBe("v-new");

    const feedback = await t.run(async (ctx) => ctx.db.query("feedback").collect());
    expect(feedback).toHaveLength(1);
    expect(feedback[0].rating).toBe(5);
  });

  test("rows past the cutoff survive (strictly-older-than semantics; margins beat clock drift)", async () => {
    const t = freshBackend();
    const now = Date.now();
    // A row a minute BEFORE the cutoff is clearly expired; a row a minute
    // AFTER it is clearly inside the window even though the mutation computes
    // its own `now` a few ms later. Exact-boundary `.lt` semantics are
    // covered by the pure cutoff tests in tests/retention.test.ts.
    const clearlyExpired = analyticsRetentionCutoff(now) - 60_000;
    const clearlyInside = analyticsRetentionCutoff(now) + 60_000;
    await t.run(async (ctx) => {
      await ctx.db.insert("analyticsEvents", {
        name: "page_view",
        visitorId: "v-expired",
        sessionId: "s",
        createdAt: clearlyExpired,
      });
      await ctx.db.insert("analyticsEvents", {
        name: "page_view",
        visitorId: "v-inside",
        sessionId: "s",
        createdAt: clearlyInside,
      });
    });
    const result = await t.mutation(internal.analytics.deleteExpiredAnalytics, {
      maxDeletes: 100,
    });
    expect(result.analyticsEvents).toBe(1);
    const events = await t.run(async (ctx) => ctx.db.query("analyticsEvents").collect());
    expect(events).toHaveLength(1);
    expect(events[0].visitorId).toBe("v-inside");
  });

  test("the sweep is bounded by maxDeletes (one batch per run)", async () => {
    const t = freshBackend();
    const old = analyticsRetentionCutoff(Date.now()) - 1000;
    await t.run(async (ctx) => {
      for (let i = 0; i < 5; i += 1) {
        await ctx.db.insert("analyticsEvents", {
          name: "page_view",
          visitorId: `v-${i}`,
          sessionId: "s",
          createdAt: old,
        });
      }
    });
    const result = await t.mutation(internal.analytics.deleteExpiredAnalytics, {
      maxDeletes: 3,
    });
    expect(result.analyticsEvents).toBe(3);
    expect(result.complete).toBe(false);
    const remaining = await t.run(async (ctx) => ctx.db.query("analyticsEvents").collect());
    expect(remaining).toHaveLength(2);
  });
});
