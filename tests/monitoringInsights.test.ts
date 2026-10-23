// SitePulse Phase 8 integration tests (Vitest + convex-test).
//
// Real handlers, not source-text checks: incidents are opened and closed by
// the real recordCheck state machine, uptime insights are computed over
// real uptimeChecks rows, and the alert send claim is exercised through the
// real mutations. Authorization is enforced inside the handlers and verified
// through the real @convex-dev/auth path (subject shaped like the library's
// own JWT: "userId|sessionId").

import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { internal } from "../src/convex/_generated/api";
import type { Id } from "../src/convex/_generated/dataModel";
import schema from "../src/convex/schema";
import { ALERT_CLAIM_TTL_MS } from "../src/convex/alerts";
import { MIN_CHECKS_FOR_RELIABLE_UPTIME } from "../src/lib/uptime";

// convex-test loads Convex function modules on demand from this map. Keys are
// paths relative to the functions root (src/convex, per convex.json); values
// are lazy importers so only modules a test reaches are evaluated.
const modules = {
  "_generated/api.js": () => import("../src/convex/_generated/api.js"),
  "_generated/server.js": () => import("../src/convex/_generated/server.js"),
  "monitors.ts": () => import("../src/convex/monitors.ts"),
  "alerts.ts": () => import("../src/convex/alerts.ts"),
};

/** Fresh in-memory backend per test: isolated test data, nothing shared. */
function freshBackend() {
  return convexTest(schema, modules);
}

async function createTestUser(t: ReturnType<typeof freshBackend>, email?: string) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", email === undefined ? {} : { email }),
  );
}

function signedInAs(t: ReturnType<typeof freshBackend>, userId: string, sessionId = "session1") {
  return t.withIdentity({ subject: `${userId}|${sessionId}` });
}

/** Create a signed-in owner and one of their monitors through the real handler. */
async function ownerWithMonitor(
  t: ReturnType<typeof freshBackend>,
  opts: { email?: string } = {},
) {
  const userId = await createTestUser(t, opts.email);
  const owner = signedInAs(t, userId);
  const monitorId = await owner.mutation(internal.monitors.createMonitor, {
    url: "https://example.com/",
    intervalMs: 300_000,
  });
  return { owner, userId, monitorId: monitorId as Id<"monitors"> };
}

/** Record a real probe result through the real state machine. */
async function record(
  t: ReturnType<typeof freshBackend>,
  monitorId: Id<"monitors">,
  args: {
    result: "ok" | "down" | "blocked" | "error";
    at: number;
    durationMs?: number;
    detail?: string;
  },
) {
  return await t.mutation(internal.monitors.recordCheck, {
    monitorId,
    dispatchedAt: args.at,
    checkedAt: args.at,
    result: args.result,
    ...(args.durationMs === undefined ? {} : { durationMs: args.durationMs }),
    ...(args.detail === undefined ? {} : { detail: args.detail }),
    attempt: 1,
  });
}

/** Open a real incident: exactly two consecutive failed checks. */
async function openIncident(
  t: ReturnType<typeof freshBackend>,
  monitorId: Id<"monitors">,
  startAt: number,
) {
  await record(t, monitorId, { result: "down", at: startAt });
  const second = await record(t, monitorId, { result: "down", at: startAt + 60_000 });
  if (second.stale || second.events.length === 0) {
    throw new Error("expected the second failure to open an incident");
  }
  return second.events[0].incidentId;
}

// ── Incident history ─────────────────────────────────────────────────────────

describe("incident lifecycle (creation, duplicates, recovery, duration)", () => {
  test("two failures open one incident; more failures never open a second", async () => {
    const t = freshBackend();
    const { monitorId } = await ownerWithMonitor(t);
    const start = Date.now() - 60 * 60 * 1000;

    await record(t, monitorId, { result: "down", at: start });
    const second = await record(t, monitorId, { result: "down", at: start + 60_000 });
    expect(second.events).toHaveLength(1);
    expect(second.events[0].kind).toBe("downtime");

    // A third, fourth… failed check during the SAME outage changes nothing.
    for (let i = 2; i <= 5; i += 1) {
      const repeated = await record(t, monitorId, {
        result: "down",
        at: start + i * 60_000,
      });
      expect(repeated.events).toEqual([]);
    }

    const incidents = await t.run(async (ctx) => ctx.db.query("incidents").collect());
    expect(incidents).toHaveLength(1);
    expect(incidents[0].open).toBe(true);
    expect(incidents[0].failureCount).toBe(2);
    expect(incidents[0].openedAt).toBe(start + 60_000);
    expect(incidents[0].durationMs).toBeUndefined(); // frozen only at close
  });

  test("recovery closes the incident and freezes its duration", async () => {
    const t = freshBackend();
    const { monitorId } = await ownerWithMonitor(t);
    const start = Date.now() - 60 * 60 * 1000;
    const incidentId = await openIncident(t, monitorId, start);

    // One success only raises a suspect — the incident stays open.
    const first = await record(t, monitorId, { result: "ok", at: start + 10 * 60_000 });
    expect(first.events).toEqual([]);
    let incidents = await t.run(async (ctx) => ctx.db.query("incidents").collect());
    expect(incidents[0].open).toBe(true);

    // The second success closes it and records the duration once.
    const recoveredAt = start + 12 * 60_000;
    const second = await record(t, monitorId, { result: "ok", at: recoveredAt });
    expect(second.events).toHaveLength(1);
    expect(second.events[0].kind).toBe("recovery");

    incidents = await t.run(async (ctx) => ctx.db.query("incidents").collect());
    expect(incidents).toHaveLength(1); // recovery never spawns a new incident
    expect(incidents[0]._id).toBe(incidentId);
    expect(incidents[0].open).toBe(false);
    expect(incidents[0].recoveredAt).toBe(recoveredAt);
    expect(incidents[0].durationMs).toBe(recoveredAt - incidents[0].openedAt);
  });

  test("a new outage AFTER recovery opens a fresh incident", async () => {
    const t = freshBackend();
    const { monitorId } = await ownerWithMonitor(t);
    const start = Date.now() - 3 * 60 * 60 * 1000;
    await openIncident(t, monitorId, start);
    await record(t, monitorId, { result: "ok", at: start + 10 * 60_000 });
    await record(t, monitorId, { result: "ok", at: start + 11 * 60_000 });

    await openIncident(t, monitorId, start + 30 * 60_000);
    const incidents = await t.run(async (ctx) => ctx.db.query("incidents").collect());
    expect(incidents).toHaveLength(2);
    expect(incidents.filter((i) => i.open)).toHaveLength(1);
  });
});

// ── Uptime insights ──────────────────────────────────────────────────────────

describe("getUptimeInsights", () => {
  test("rejects signed-out callers and strangers (ownership enforced)", async () => {
    const t = freshBackend();
    const { monitorId } = await ownerWithMonitor(t);

    await expect(
      t.query(internal.monitors.getUptimeInsights, { monitorId }),
    ).rejects.toThrow("This monitor belongs to another account.");

    const strangerId = await createTestUser(t, "stranger@example.com");
    await expect(
      signedInAs(t, strangerId, "other-session").query(internal.monitors.getUptimeInsights, {
        monitorId,
      }),
    ).rejects.toThrow("This monitor belongs to another account.");
  });

  test("a monitor with no checks reports null uptime, not an invented number", async () => {
    const t = freshBackend();
    const { owner, monitorId } = await ownerWithMonitor(t);
    const insights = await owner.query(internal.monitors.getUptimeInsights, { monitorId });

    expect(insights.windows).toHaveLength(2);
    for (const window of insights.windows) {
      expect(window.uptime).toBeNull();
      expect(window.insufficient).toBe(true);
      expect(window.checks).toBe(0);
    }
    expect(insights.trends.every((tr) => tr.samples === 0)).toBe(true);
    expect(insights.truncated).toBe(false);
  });

  test("computes 7/30-day uptime and trend samples from real check rows", async () => {
    const t = freshBackend();
    const { owner, monitorId } = await ownerWithMonitor(t);
    const now = Date.now();
    const hour = 60 * 60 * 1000;

    // 30 hourly ok checks (last 30 hours) + one confirmed down check.
    const rows = Array.from({ length: 30 }, (_, i) => ({
      monitorId,
      checkedAt: now - (i + 1) * hour,
      dispatchedAt: now - (i + 1) * hour - 1000,
      result: "ok" as const,
      durationMs: 100 + i,
      attempt: 1,
    }));
    rows.push({
      monitorId,
      checkedAt: now - 5 * hour,
      dispatchedAt: now - 5 * hour - 1000,
      result: "down" as const,
      durationMs: undefined as unknown as number,
      attempt: 1,
    });
    await t.run(async (ctx) => {
      for (const row of rows) await ctx.db.insert("uptimeChecks", row);
    });

    const insights = await owner.query(internal.monitors.getUptimeInsights, { monitorId });
    const week = insights.windows.find((w) => w.days === 7)!;
    const month = insights.windows.find((w) => w.days === 30)!;

    // 31 checks inside a 7-day window (30 hourly ok + 1 down, all within
    // the last 30 hours): present, but the window is far from covered.
    expect(week.checks).toBe(31);
    expect(week.uptime).not.toBeNull();
    expect(week.uptime!).toBeLessThan(100); // the down check counts against it
    expect(week.partial).toBe(true);
    expect(week.insufficient).toBe(true);

    expect(month.checks).toBe(31);
    expect(month.uptime).not.toBeNull();

    const trend = insights.trends.find((tr) => tr.days === 7)!;
    // One timed sample per hourly bucket except the down check (no duration).
    expect(trend.samples).toBe(30);
    expect(trend.points.some((p) => p.medianMs !== null)).toBe(true);
  });

  test("blocked-only windows surface insufficient data instead of 0%", async () => {
    const t = freshBackend();
    const { owner, monitorId } = await ownerWithMonitor(t);
    const now = Date.now();
    const hour = 60 * 60 * 1000;
    await t.run(async (ctx) => {
      for (let i = 1; i <= 10; i += 1) {
        await ctx.db.insert("uptimeChecks", {
          monitorId,
          checkedAt: now - i * hour,
          dispatchedAt: now - i * hour - 1000,
          result: "blocked",
          attempt: 1,
        });
      }
    });

    const insights = await owner.query(internal.monitors.getUptimeInsights, { monitorId });
    for (const window of insights.windows) {
      expect(window.uptime).toBeNull();
      expect(window.insufficient).toBe(true);
    }
  });
});

// ── Incident history query ───────────────────────────────────────────────────

describe("getIncidentHistory", () => {
  test("only the owner may read it", async () => {
    const t = freshBackend();
    const { monitorId } = await ownerWithMonitor(t);
    await expect(
      t.query(internal.monitors.getIncidentHistory, { monitorId }),
    ).rejects.toThrow("This monitor belongs to another account.");
  });

  test("returns newest-first history with frozen and live durations", async () => {
    const t = freshBackend();
    const { owner, monitorId } = await ownerWithMonitor(t);
    const now = Date.now();

    // First outage: fully recovered.
    const firstStart = now - 5 * 60 * 60 * 1000;
    await openIncident(t, monitorId, firstStart);
    await record(t, monitorId, { result: "ok", at: firstStart + 10 * 60_000 });
    await record(t, monitorId, { result: "ok", at: firstStart + 11 * 60_000 });

    // Second outage: still open.
    const secondStart = now - 30 * 60_000;
    await openIncident(t, monitorId, secondStart);

    const history = await owner.query(internal.monitors.getIncidentHistory, { monitorId });
    expect(history).toHaveLength(2);
    // Newest first: the open outage leads.
    expect(history[0].open).toBe(true);
    expect(history[0].openedAt).toBe(secondStart + 60_000);
    expect(history[0].durationMs!).toBeGreaterThanOrEqual(now - secondStart - 60_000);

    const closed = history[1];
    expect(closed.open).toBe(false);
    expect(closed.recoveredAt).toBe(firstStart + 11 * 60_000);
    // Frozen duration equals recovered − opened, not "now − opened".
    expect(closed.durationMs).toBe(11 * 60_000 - 60_000);
  });
});

// ── Phase 7 limits on the list ───────────────────────────────────────────────

describe("listMonitors respects the Phase 7 plan cap", () => {
  test("a Pro subscriber sees every monitor their plan allows", async () => {
    const t = freshBackend();
    const { owner, userId } = await ownerWithMonitor(t);
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("subscriptions", {
        userId,
        plan: "pro",
        status: "active",
        currency: "INR",
        provider: "simulated",
        amountPerPeriod: 299_00,
        currentPeriodStart: now,
        currentPeriodEnd: now + 30 * 24 * 60 * 60 * 1000,
        cancelAtPeriodEnd: false,
        startedAt: now,
        updatedAt: now,
      });
    });

    // Free cap is 10; Pro allows 25 — create 12 and list ALL of them.
    for (let i = 0; i < 11; i += 1) {
      await owner.mutation(internal.monitors.createMonitor, {
        url: `https://site${i}.example.com/`,
        intervalMs: 300_000,
      });
    }
    const list = await owner.query(internal.monitors.listMonitors, {});
    expect(list).toHaveLength(12);
  });
});

// ── Alert delivery: no duplicate notifications ───────────────────────────────

describe("alert send claim (duplicate-notification guard)", () => {
  async function queuedDelivery(t: ReturnType<typeof freshBackend>) {
    const { owner, monitorId } = await ownerWithMonitor(t, { email: "ops@example.com" });
    const incidentId = await openIncident(t, monitorId, Date.now() - 10 * 60_000);
    const result = await t.mutation(internal.alerts.enqueue, {
      monitorId,
      incidentId,
      kind: "downtime",
      url: "https://example.com/",
      host: "example.com",
      openedAt: Date.now(),
    });
    expect(result.queued).toBe(true);
    const delivery = await t.run(async (ctx) => ctx.db.query("alertDeliveries").first());
    return { owner, delivery: delivery! };
  }

  test("exactly one sender can claim a queued row", async () => {
    const t = freshBackend();
    const { delivery } = await queuedDelivery(t);

    const first = await t.mutation(internal.alerts.claim, { id: delivery._id });
    expect(first.claimed).toBe(true);

    // A second concurrent sender (another probe, the drain cron) loses.
    const second = await t.mutation(internal.alerts.claim, { id: delivery._id });
    expect(second).toMatchObject({ claimed: false, reason: "in-flight" });

    const row = await t.run(async (ctx) => ctx.db.get(delivery._id));
    expect(row?.status).toBe("sending");
    expect(row?.claimedAt).toBeGreaterThan(0);
  });

  test("a claimed-and-sent row can never be claimed again", async () => {
    const t = freshBackend();
    const { delivery } = await queuedDelivery(t);
    await t.mutation(internal.alerts.claim, { id: delivery._id });
    await t.mutation(internal.alerts.markSent, { id: delivery._id, providerId: "re_1" });

    const after = await t.mutation(internal.alerts.claim, { id: delivery._id });
    expect(after).toMatchObject({ claimed: false, reason: "sent" });
  });

  test("a claim past its TTL (crashed sender) is reclaimable", async () => {
    const t = freshBackend();
    const { delivery } = await queuedDelivery(t);
    await t.mutation(internal.alerts.claim, { id: delivery._id });
    // Simulate a sender that died mid-flight: age the claim past the TTL.
    await t.run(async (ctx) =>
      ctx.db.patch(delivery._id, { claimedAt: Date.now() - ALERT_CLAIM_TTL_MS - 1000 }),
    );

    const reclaim = await t.mutation(internal.alerts.claim, { id: delivery._id });
    expect(reclaim).toMatchObject({ claimed: true, reclaimed: true });
  });

  test("listQueued returns queued rows and stale claims, never fresh claims", async () => {
    const t = freshBackend();
    const { delivery } = await queuedDelivery(t);
    const fresh = await t.query(internal.alerts.listQueued, { limit: 20 });
    expect(fresh.map((r) => r._id)).toEqual([delivery._id]);

    // Claim it (fresh): the drain must NOT pick it up again.
    await t.mutation(internal.alerts.claim, { id: delivery._id });
    const whileSending = await t.query(internal.alerts.listQueued, { limit: 20 });
    expect(whileSending).toEqual([]);

    // Age the claim past the TTL: the row becomes retryable again.
    await t.run(async (ctx) =>
      ctx.db.patch(delivery._id, { claimedAt: Date.now() - ALERT_CLAIM_TTL_MS - 1 }),
    );
    const afterStale = await t.query(internal.alerts.listQueued, { limit: 20 });
    expect(afterStale.map((r) => r._id)).toEqual([delivery._id]);
  });
});

// ── Recovery alerts ──────────────────────────────────────────────────────────

describe("recovery notifications", () => {
  test("a recovery event enqueues exactly one recovery email", async () => {
    const t = freshBackend();
    const { monitorId } = await ownerWithMonitor(t, { email: "ops@example.com" });
    const start = Date.now() - 60 * 60_000;
    const incidentId = await openIncident(t, monitorId, start);

    await record(t, monitorId, { result: "ok", at: start + 10 * 60_000 });
    const close = await record(t, monitorId, { result: "ok", at: start + 11 * 60_000 });
    expect(close.events[0].kind).toBe("recovery");

    const args = {
      monitorId,
      incidentId,
      kind: "recovery" as const,
      url: "https://example.com/",
      host: "example.com",
      openedAt: close.events[0].openedAt,
      recoveredAt: close.events[0].recoveredAt,
    };
    const first = await t.mutation(internal.alerts.enqueue, args);
    const duplicate = await t.mutation(internal.alerts.enqueue, args);
    expect(first.queued).toBe(true);
    expect(duplicate).toEqual({ queued: false, reason: "duplicate" });

    const deliveries = await t.run(async (ctx) => ctx.db.query("alertDeliveries").collect());
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].kind).toBe("recovery");
    expect(deliveries[0].text).toContain("back UP");

    // Audit trail on the incident: recovery alert recorded once.
    const incident = await t.run(async (ctx) => ctx.db.get(incidentId));
    expect(incident?.recoveryAlertedAt).toBeGreaterThan(0);
  });

  test("notification preference: the monitor's alertEmail wins over the account email", async () => {
    const t = freshBackend();
    const { owner, monitorId } = await ownerWithMonitor(t, { email: "account@example.com" });
    await owner.mutation(internal.monitors.updateMonitor, {
      monitorId,
      action: "updateAlerts",
      alertEmail: "oncall@example.net",
    });
    const incidentId = await openIncident(t, monitorId, Date.now() - 10 * 60_000);
    await t.mutation(internal.alerts.enqueue, {
      monitorId,
      incidentId,
      kind: "downtime",
      url: "https://example.com/",
      host: "example.com",
      openedAt: Date.now(),
    });
    const delivery = await t.run(async (ctx) => ctx.db.query("alertDeliveries").first());
    expect(delivery?.to).toBe("oncall@example.net");
  });
});

// ── Guardrail: insights never touch scoring ──────────────────────────────────

describe("Phase 8 guardrails", () => {
  test("recordCheck does not modify any scan/score state", async () => {
    const t = freshBackend();
    const { monitorId } = await ownerWithMonitor(t);
    const start = Date.now() - 60 * 60_000;
    await openIncident(t, monitorId, start);

    const scans = await t.run(async (ctx) => ctx.db.query("scans").collect());
    expect(scans).toEqual([]);
    const monitor = await t.run(async (ctx) => ctx.db.get(monitorId));
    // The state machine only tracks liveness — no score-like fields exist.
    expect(Object.keys(monitor ?? {}).some((k) => k.toLowerCase().includes("score"))).toBe(
      false,
    );
  });

  test("insight queries read only the caller's own monitor's data", async () => {
    const t = freshBackend();
    const { owner, monitorId } = await ownerWithMonitor(t, { email: "a@example.com" });
    const other = await ownerWithMonitor(t, { email: "b@example.com" });

    const now = Date.now();
    await t.run(async (ctx) => {
      for (let i = 1; i <= 5; i += 1) {
        await ctx.db.insert("uptimeChecks", {
          monitorId: other.monitorId,
          checkedAt: now - i * 60_000,
          dispatchedAt: now - i * 60_000 - 1,
          result: "down",
          attempt: 1,
        });
      }
    });

    const insights = await owner.query(internal.monitors.getUptimeInsights, {
      monitorId,
    });
    // The stranger's downtime must not leak into this monitor's windows.
    for (const window of insights.windows) {
      expect(window.checks).toBe(0);
      expect(window.uptime).toBeNull();
    }
    const history = await owner.query(internal.monitors.getIncidentHistory, { monitorId });
    expect(history).toEqual([]);
    expect(
      MIN_CHECKS_FOR_RELIABLE_UPTIME,
    ).toBeGreaterThan(0); // guard the constant itself
  });
});
