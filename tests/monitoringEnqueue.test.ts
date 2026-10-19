// SitePulse alert-outbox integration tests (Vitest + convex-test).
//
// Real handlers, not source-text checks: the incidents are opened by the real
// monitors.recordCheck failure-confirmation state machine, and alerts.enqueue
// (src/convex/alerts.ts) runs against convex-test's in-memory backend. The
// assertions below are about persisted rows and returned values. No external
// API key, no website probe, no network, no production data, no deployment,
// no mocked ctx.

import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { internal } from "../src/convex/_generated/api";
import type { Id } from "../src/convex/_generated/dataModel";
import schema from "../src/convex/schema";

// convex-test loads Convex function modules on demand from this map. Keys are
// paths relative to the functions root (src/convex, per convex.json) with the
// extension kept; at least one key must contain "_generated" so convex-test
// can locate the root prefix. Values are lazy importers so only the modules a
// test reaches are ever evaluated.
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

/**
 * Create a signed-in owner and one of their monitors through the real
 * createMonitor handler.
 */
async function ownerWithMonitor(
  t: ReturnType<typeof freshBackend>,
  opts: { email?: string; alertEmail?: string } = {},
) {
  const userId = await t.run(async (ctx) =>
    ctx.db.insert("users", opts.email === undefined ? {} : { email: opts.email }),
  );
  const owner = t.withIdentity({ subject: `${userId}|session1` });
  const monitorId = await owner.mutation(internal.monitors.createMonitor, {
    url: "https://example.com/",
    intervalMs: 300_000,
    ...(opts.alertEmail === undefined ? {} : { alertEmail: opts.alertEmail }),
  });
  return { owner, monitorId };
}

/**
 * Open a real downtime incident through the real failure-confirmation state
 * machine (one failure only raises a suspect; the second opens the incident).
 */
async function openIncident(
  t: ReturnType<typeof freshBackend>,
  monitorId: Id<"monitors">,
) {
  const now = Date.now();
  const first = await t.mutation(internal.monitors.recordCheck, {
    monitorId,
    dispatchedAt: now,
    checkedAt: now,
    result: "down",
    attempt: 1,
  });
  expect(first).toMatchObject({ stale: false, state: "suspect" });
  expect(first.events).toEqual([]);

  const second = await t.mutation(internal.monitors.recordCheck, {
    monitorId,
    dispatchedAt: now + 1,
    checkedAt: now + 1,
    result: "down",
    attempt: 1,
  });
  expect(second).toMatchObject({ stale: false, state: "down" });
  if (second.stale || second.events.length === 0) {
    throw new Error("expected the second failure to open an incident");
  }
  return second.events[0].incidentId;
}

async function allDeliveries(t: ReturnType<typeof freshBackend>) {
  return await t.run(async (ctx) => ctx.db.query("alertDeliveries").collect());
}

describe("alerts.enqueue — real handler (outbox writes)", () => {
  test("an open incident queues exactly one delivery to the owner's account email", async () => {
    const t = freshBackend();
    const { monitorId } = await ownerWithMonitor(t, {
      email: "ops@example.com",
    });
    const incidentId = await openIncident(t, monitorId);

    const result = await t.mutation(internal.alerts.enqueue, {
      monitorId,
      incidentId,
      kind: "downtime",
      url: "https://example.com/",
      host: "example.com",
      openedAt: Date.now(),
    });
    expect(result.queued).toBe(true);

    const deliveries = await allDeliveries(t);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      incidentId,
      kind: "downtime",
      to: "ops@example.com",
      status: "queued",
    });
    expect(deliveries[0].subject).toContain("SitePulse: example.com is DOWN");

    // Audit trail: the incident records when its alert was enqueued.
    const incident = await t.run(async (ctx) => ctx.db.get(incidentId));
    expect(incident?.alertedAt).toBeGreaterThan(0);
  });

  test("a monitor's alertEmail overrides the account email as the recipient", async () => {
    const t = freshBackend();
    const { monitorId } = await ownerWithMonitor(t, {
      email: "account@example.com",
      alertEmail: "oncall@example.net",
    });
    const incidentId = await openIncident(t, monitorId);

    await t.mutation(internal.alerts.enqueue, {
      monitorId,
      incidentId,
      kind: "downtime",
      url: "https://example.com/",
      host: "example.com",
      openedAt: Date.now(),
    });

    const [delivery] = await allDeliveries(t);
    expect(delivery.to).toBe("oncall@example.net");
  });

  test("a monitor with no reachable recipient queues nothing", async () => {
    const t = freshBackend();
    // Neither an account email nor a per-monitor alertEmail.
    const { monitorId } = await ownerWithMonitor(t);
    const incidentId = await openIncident(t, monitorId);

    const result = await t.mutation(internal.alerts.enqueue, {
      monitorId,
      incidentId,
      kind: "downtime",
      url: "https://example.com/",
      host: "example.com",
      openedAt: Date.now(),
    });
    expect(result).toEqual({ queued: false, reason: "no-recipient" });
    expect(await allDeliveries(t)).toHaveLength(0);
  });

  test("the same incident+kind is enqueued exactly once (idempotency)", async () => {
    const t = freshBackend();
    const { monitorId } = await ownerWithMonitor(t, {
      email: "ops@example.com",
    });
    const incidentId = await openIncident(t, monitorId);

    const args = {
      monitorId,
      incidentId,
      kind: "downtime" as const,
      url: "https://example.com/",
      host: "example.com",
      openedAt: Date.now(),
    };
    const first = await t.mutation(internal.alerts.enqueue, args);
    const duplicate = await t.mutation(internal.alerts.enqueue, args);

    expect(first.queued).toBe(true);
    expect(duplicate).toEqual({ queued: false, reason: "duplicate" });
    expect(await allDeliveries(t)).toHaveLength(1);
  });

  test("a missing incident rejects the write and persists nothing", async () => {
    const t = freshBackend();
    const { monitorId } = await ownerWithMonitor(t, {
      email: "ops@example.com",
    });

    // A real incident id whose document no longer exists.
    const ghostIncidentId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("incidents", {
        monitorId,
        kind: "down",
        open: true,
        openedAt: Date.now(),
        reason: "probe",
        failureCount: 2,
      });
      await ctx.db.delete(id);
      return id;
    });

    await expect(
      t.mutation(internal.alerts.enqueue, {
        monitorId,
        incidentId: ghostIncidentId,
        kind: "downtime",
        url: "https://example.com/",
        host: "example.com",
        openedAt: Date.now(),
      }),
    ).rejects.toThrow();
    // The handler's insert was rolled back with the failed transaction.
    expect(await allDeliveries(t)).toHaveLength(0);
  });
});
