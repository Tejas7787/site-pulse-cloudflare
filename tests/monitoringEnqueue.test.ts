// SitePulse alert-outbox integration test (Phase 1).
//
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

// Schema and function modules: the test app is wired without generated files,
// matching how convex-test ships. The same handler modules are what the
// deployed app loads.
const schema = require("../src/convex/schema.ts") as { default: unknown };
const alertsModule = require("../src/convex/alerts.ts");
const monitorsModule = require("../src/convex/monitors.ts");

describe("alerts.enqueue — real handler", () => {
  // Create a dedicated test app that knows about monitors and alerts; a
  // plain app (schema only) would not resolve internal.monitors.createMonitor.
  const app = convexTest({ schema });
  const { mutation, query } = app.defineModules({
    alerts: alertsModule,
    monitors: monitorsModule,
  });

  test("enqueues exactly one delivery per incident+kind and returns queued", async () => {
    const monitorId = await mutation(createMonitor, {
      url: "https://example.com/",
      intervalMs: 300_000,
    });
    // Open an incident so enqueue has a recipient (monitor.alertEmail falls
    // back to owner email when set).
    const incidentId = await mutation(monitorsModule.insert, {
      ownerId: "users|me",
      name: "example",
      url: "https://example.com/",
      host: "example.com",
      intervalMs: 300_000,
      status: "active",
      state: "unknown",
      nextCheckAt: Date.now() + 5_000,
      createdAt: Date.now(),
      consecutiveFailures: 2,
      consecutiveSuccesses: 0,
    });
    await mutation(monitorsModule.patch, {
      id: monitorId,
      value: { ownerId: "users|me", alertEmail: "ops@example.com" },
    });

    const now = Date.now();
    const result = await mutation(enqueue, {
      monitorId,
      incidentId,
      kind: "downtime",
      url: "https://example.com/",
      host: "example.com",
      openedAt: now,
    });

    expect(result.queued).toBe(true);
    expect(result.reason).toBeUndefined();

    const deliveries = await query("alertDeliveries");
    expect(deliveries.length).toBe(1);
    expect(deliveries[0].incidentId).toBe(incidentId);
    expect(deliveries[0].kind).toBe("downtime");
    expect(deliveries[0].status).toBe("queued");
    expect(deliveries[0].to).toBe("ops@example.com");
    expect(deliveries[0].subject).toContain("SitePulse: example.com is DOWN");
  });

  test("does not enqueue a duplicate for the same incident+kind (idempotency)", async () => {
    const monitorId = await mutation(createMonitor, {
      url: "https://example.com/",
      intervalMs: 300_000,
    });
    const incidentId = await mutation(monitorsModule.insert, {
      ownerId: "users|me",
      name: "example",
      url: "https://example.com/",
      host: "example.com",
      intervalMs: 300_000,
      status: "active",
      state: "unknown",
      nextCheckAt: Date.now() + 5_000,
      createdAt: Date.now(),
      consecutiveFailures: 2,
      consecutiveSuccesses: 0,
    });
    await mutation(monitorsModule.patch, {
      id: monitorId,
      value: { ownerId: "users|me", alertEmail: "ops@example.com" },
    });

    await mutation(enqueue, {
      monitorId,
      incidentId,
      kind: "downtime",
      url: "https://example.com/",
      host: "example.com",
      openedAt: Date.now(),
    });

    const duplicate = await mutation(enqueue, {
      monitorId,
      incidentId,
      kind: "downtime",
      url: "https://example.com/",
      host: "example.com",
      openedAt: Date.now(),
    });
    expect(duplicate.queued).toBe(false);
    expect(duplicate.reason).toBe("duplicate");

    const deliveries = await query("alertDeliveries");
    expect(deliveries.length).toBe(1);
  });

  test("refuses a missing incident without persisting anything", async () => {
    const monitorId = await mutation(createMonitor, {
      url: "https://example.com/",
      intervalMs: 300_000,
    });
    await expect(
      mutation(enqueue, {
        monitorId,
        incidentId: "incidents|missing",
        kind: "downtime",
        url: "https://example.com/",
        host: "example.com",
        openedAt: Date.now(),
      }),
    ).rejects.toThrow();

    const deliveries = await query("alertDeliveries");
    expect(deliveries.length).toBe(0);
  });
});
