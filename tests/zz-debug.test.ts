// Temporary debug scaffold — delete after diagnosing.
import { describe, test } from "bun:test";
import { getAuthUserId } from "@convex-dev/auth/server";
import { convexTest } from "convex-test";
import { internal } from "../src/convex/_generated/api";
import schema from "../src/convex/schema";

const modules = {
  "_generated/api.js": () => import("../src/convex/_generated/api.js"),
  "_generated/server.js": () => import("../src/convex/_generated/server.js"),
  "monitors.ts": () => import("../src/convex/monitors.ts"),
  "alerts.ts": () => import("../src/convex/alerts.ts"),
};

describe("debug", () => {
  test("enqueue reason", async () => {
    const src = getAuthUserId.toString();
    console.log("DEBUG auth fn:", src.includes("signedInAs") ? "MOCKED" : "real", "|", src.replace(/\s+/g, " ").slice(0, 90));
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: "ops@example.com" }),
    );
    const owner = t.withIdentity({ subject: `${userId}|session1` });
    const monitorId = await owner.mutation(internal.monitors.createMonitor, {
      url: "https://example.com/",
      intervalMs: 300_000,
    });
    const monitor = await t.run(async (ctx) => ctx.db.get(monitorId));
    console.log("DEBUG monitor.ownerId:", monitor?.ownerId, "userId:", userId);
    const ownerDoc = await t.run(async (ctx) => ctx.db.get(monitor!.ownerId));
    console.log("DEBUG ownerDoc:", JSON.stringify(ownerDoc));

    const now = Date.now();
    await t.mutation(internal.monitors.recordCheck, {
      monitorId,
      dispatchedAt: now,
      checkedAt: now,
      result: "down",
      attempt: 1,
    });
    const second = await t.mutation(internal.monitors.recordCheck, {
      monitorId,
      dispatchedAt: now + 1,
      checkedAt: now + 1,
      result: "down",
      attempt: 1,
    });
    console.log("DEBUG second:", JSON.stringify(second));
    const incidentId = second.events?.[0]?.incidentId;
    const result = await t.mutation(internal.alerts.enqueue, {
      monitorId,
      incidentId: incidentId as never,
      kind: "downtime",
      url: "https://example.com/",
      host: "example.com",
      openedAt: Date.now(),
    });
    console.log("DEBUG enqueue result:", JSON.stringify(result));
  });
});
