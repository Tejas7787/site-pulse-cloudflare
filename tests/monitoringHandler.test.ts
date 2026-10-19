// SitePulse monitoring handler integration tests (Vitest + convex-test).
//
// These drive the REAL Convex handlers from src/convex/monitors.ts inside
// convex-test's in-memory backend: no fakes, no module mocks, no network, no
// external API key, no production database. Authorization is exercised
// through the real @convex-dev/auth path — getAuthUserId() reads the identity
// that t.withIdentity() authenticates, with the subject shaped exactly like
// the library's own JWT ("userId|sessionId").

import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { internal } from "../src/convex/_generated/api";
import schema from "../src/convex/schema";
import { MAX_MONITORS_PER_OWNER, clampInterval } from "../src/lib/monitoring";

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

/** Insert an isolated users row and return its real Convex id. */
async function createTestUser(
  t: ReturnType<typeof freshBackend>,
  email?: string,
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", email === undefined ? {} : { email }),
  );
}

/** Authenticate as a users document exactly the way @convex-dev/auth does. */
function signedInAs(
  t: ReturnType<typeof freshBackend>,
  userId: string,
  sessionId = "session1",
) {
  return t.withIdentity({ subject: `${userId}|${sessionId}` });
}

async function allMonitors(t: ReturnType<typeof freshBackend>) {
  return await t.run(async (ctx) => ctx.db.query("monitors").collect());
}

describe("createMonitor — real handler, real auth", () => {
  test("signed-out callers are rejected before anything is written", async () => {
    const t = freshBackend();
    await expect(
      t.mutation(internal.monitors.createMonitor, {
        url: "https://example.com/",
        intervalMs: 300_000,
      }),
    ).rejects.toThrow("Sign in to manage monitors.");
    expect(await allMonitors(t)).toHaveLength(0);
  });

  test("a credential-carrying URL is rejected without persisting anything", async () => {
    const t = freshBackend();
    const userId = await createTestUser(t);
    const user = signedInAs(t, userId);

    await expect(
      user.mutation(internal.monitors.createMonitor, {
        url: "https://user:pass@example.com/",
        intervalMs: 300_000,
      }),
    ).rejects.toThrow(/valid website address/);
    expect(await allMonitors(t)).toHaveLength(0);
  });

  test("a signed-in create persists a normalized monitor owned by that user", async () => {
    const t = freshBackend();
    const userId = await createTestUser(t, "owner@example.com");
    const user = signedInAs(t, userId);

    const before = Date.now();
    const monitorId = await user.mutation(internal.monitors.createMonitor, {
      url: "https://Example.COM/a?b=1 ",
      intervalMs: 123_456, // not an allowed interval: must be clamped
    });

    const doc = await t.run(async (ctx) => ctx.db.get(monitorId));
    expect(doc).toMatchObject({
      ownerId: userId,
      url: "https://example.com/a?b=1",
      host: "example.com",
      name: "example.com", // derived from the host when no name is given
      status: "active",
      state: "unknown",
      intervalMs: clampInterval(123_456),
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
    });
    // First check is scheduled ~5s ahead plus a bounded jitter.
    expect(doc?.nextCheckAt).toBeGreaterThanOrEqual(before + 5_000);
    expect(doc?.nextCheckAt).toBeLessThan(before + 5_000 + 15_000);
  });

  test("the free-plan limit is enforced per account, not globally", async () => {
    const t = freshBackend();
    const ownerId = await createTestUser(t);
    const owner = signedInAs(t, ownerId);

    for (let i = 0; i < MAX_MONITORS_PER_OWNER; i += 1) {
      await owner.mutation(internal.monitors.createMonitor, {
        url: `https://site${i}.example.com/`,
        intervalMs: 300_000,
      });
    }
    await expect(
      owner.mutation(internal.monitors.createMonitor, {
        url: "https://one-too-many.example.com/",
        intervalMs: 300_000,
      }),
    ).rejects.toThrow(/Free plan limit/);
    expect(await allMonitors(t)).toHaveLength(MAX_MONITORS_PER_OWNER);

    // A second account is unaffected by the first account's full quota.
    const otherId = await createTestUser(t);
    const other = signedInAs(t, otherId);
    const otherMonitorId = await other.mutation(
      internal.monitors.createMonitor,
      { url: "https://other-owner.example.com/", intervalMs: 300_000 },
    );
    expect(otherMonitorId).toBeTruthy();
    expect(await allMonitors(t)).toHaveLength(MAX_MONITORS_PER_OWNER + 1);
  });

  test("listMonitors and getMonitor only ever expose the caller's own monitors", async () => {
    const t = freshBackend();
    const ownerId = await createTestUser(t, "owner@example.com");
    const monitorId = await signedInAs(t, ownerId).mutation(
      internal.monitors.createMonitor,
      { url: "https://example.com/", intervalMs: 300_000 },
    );

    const strangerId = await createTestUser(t, "stranger@example.com");
    const stranger = signedInAs(t, strangerId, "other-session");

    // Authorization: a signed-in stranger sees nothing and cannot read the
    // monitor — enforced inside the real handlers, not in the test.
    expect(await stranger.query(internal.monitors.listMonitors, {})).toEqual(
      [],
    );
    await expect(
      stranger.query(internal.monitors.getMonitor, { monitorId }),
    ).rejects.toThrow("This monitor belongs to another account.");

    // The owner's own view works.
    const mine = await signedInAs(t, ownerId).query(
      internal.monitors.listMonitors,
      {},
    );
    expect(mine).toHaveLength(1);
    const detail = await signedInAs(t, ownerId).query(
      internal.monitors.getMonitor,
      { monitorId },
    );
    expect(detail.monitor.url).toBe("https://example.com/");
    expect(detail.alertDestination).toBe("owner@example.com");
  });
});
