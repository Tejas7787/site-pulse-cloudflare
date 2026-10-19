// SitePulse alert-outbox integration test (Phase 1).
// Real Convex handler, not a source-text check: t.mutation(internal.alerts.enqueue, ...)
// drives the handler body against convex-test's in-memory database, so the
// assertions below are about persisted rows and returned values, not about the
// text of src/convex/alerts.ts. No external API key, no website probe, no
// network, no production database access, no deployment, no fake ctx.
import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { internal } from "../src/convex/_generated/api";
import { enqueue } from "../src/convex/alerts";
import { createMonitor } from "../src/convex/monitors";
import schema from "../src/convex/schema";

// convex-test resolves function modules via Vite's import.meta.glob which is
// not defined in Vitest's node environment, and its findModulesRoot() needs
// a "_generated" directory next to the module root. Register the generated
// files as the "_generated" module, then the handler modules. The resolved
// module map is passed so moduleCache can load every handler. The returned
// value of convexTest is the stateful test context ({ createTest, ...}, not
// an app with defineModules.
const generated = await import("../src/convex/_generated/api.js");
const generatedServer = await import("../src/convex/_generated/server.js");

const modules = {
  "_generated": {
    api: generated,
    server: generatedServer,
    dataModel: generatedServer.DataModel,
  },
  alerts: () => import("../src/convex/alerts.ts"),
  monitors: () => import("../src/convex/monitors.ts"),
  retention: () => import("../src/convex/retention.ts"),
  probe: () => import("../src/convex/probe.ts"),
  crons: () => import("../src/convex/crons.ts"),
  analytics: () => import("../src/convex/analytics.ts"),
  feedback: () => import("../src/convex/feedback.ts"),
  http: () => import("../src/convex/http.ts"),
  users: () => import("../src/convex/users.ts"),
  scans: () => import("../src/convex/scans.ts"),
};

// convexTest returns a single test context; each test calls createTest().
const testCtx = convexTest({ schema, modules });

describe("alerts.enqueue — real handler", () => {
  test("enqueues exactly one delivery per incident+kind and returns queued", async () => {
    const t = testCtx.createTest();
    const monitorId = await t.mutation(internal.monitors.createMonitor, {
      url: "https://example.com/",
      intervalMs: 300_000,
    });
    const incidentId = await t.mutation(internal.monitors.recordCheck, {
      monitorId,
      dispatchedAt: Date.now(),
      checkedAt: Date.now(),
      result: "down",
      attempt: 1,
    });
    const result = await t.mutation(internal.alerts.enqueue, {
      monitorId,
      incidentId,
      kind: "downtime",
      url: "https://example.com/",
      host: "example.com",
      openedAt: Date.now(),
    });
    expect(result.queued).toBe(true);
    expect(result.reason).toBeUndefined();

    const deliveries = await t.query("alertDeliveries");
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].incidentId).toBe(incidentId);
    expect(deliveries[0].kind).toBe("downtime");
    expect(deliveries[0].status).toBe("queued");
    expect(deliveries[0].to).toBe("ops@example.com");
    expect(deliveries[0].subject).toContain("SitePulse: example.com is DOWN");
  });

  test("does not enqueue a duplicate for the same incident+kind (idempotency)", async () => {
    const t = testCtx.createTest();
    const _monitorId = await t.mutation(internal.monitors.createMonitor, {
      url: "https://example.com/",
      intervalMs: 300_000,
    });
    const incidentId = await t.mutation(internal.monitors.recordCheck, {
      monitorId: "monitor|11",
      dispatchedAt: Date.now(),
      checkedAt: Date.now(),
      result: "down",
      attempt: 1,
    });
    await t.mutation(internal.alerts.enqueue, {
      monitorId: "monitor|11",
      incidentId,
      kind: "downtime",
      url: "https://example.com/",
      host: "example.com",
      openedAt: Date.now(),
    });
    const dup = await t.mutation(internal.alerts.enqueue, {
      monitorId: "monitor|11",
      incidentId,
      kind: "downtime",
      url: "https://example.com/",
      host: "example.com",
      openedAt: Date.now(),
    });
    expect(dup.queued).toBe(false);
    expect(dup.reason).toBe("duplicate");

    const deliveries = await t.query("alertDeliveries");
    expect(deliveries).toHaveLength(1);
  });

  test("refuses a missing incident without persisting anything", async () => {
    const t = testCtx.createTest();
    const monitorId = await t.mutation(internal.monitors.createMonitor, {
      url: "https://example.com/",
      intervalMs: 300_000,
    });
    await expect(
      t.mutation(internal.alerts.enqueue, {
        monitorId,
        incidentId: "incidents|missing",
        kind: "downtime",
        url: "https://example.com/",
        host: "example.com",
        openedAt: Date.now(),
      }),
    ).rejects.toThrow();

    const deliveries = await t.query("alertDeliveries");
    expect(deliveries).toHaveLength(0);
  });
});
