// Security regression tests for server-side authorization:
//
// 1. /admin — analytics.getDashboard, feedback.getAdmin and the *Passcode
//    queries must deny data to anyone who is not a signed-in user with
//    role === "admin". (Root cause of the original hole: the gate compared a
//    client-held passcode against an env var that might not even be set —
//    there was no identity check at all.)
//
// 2. /monitors — getMonitor must enforce ownership (no IDOR) and join the
//    alert-delivery outbox ONLY through the monitor's own open incident, so a
//    healthy monitor can never surface another account's alert status.
//
// Convex function handlers are invoked directly through their runtime
// `_handler` property with a fake ctx; getAuthUserId is module-mocked so the
// signed-in identity is controlled per test.

import { describe, expect, test, mock } from "bun:test";

// Keep the real module's other exports: src/convex/auth.ts calls convexAuth()
// at import time and loads through the generated api graph.
const realAuthServer = await import("@convex-dev/auth/server");
let signedInAs: string | null = null;
mock.module("@convex-dev/auth/server", () => ({
  ...realAuthServer,
  getAuthUserId: async () => signedInAs,
}));

const feedback = await import("../src/convex/feedback");
const analytics = await import("../src/convex/analytics");
const monitors = await import("../src/convex/monitors");

type Row = Record<string, unknown> & { _id: string };

/** Minimal fake Convex ctx: table scans with eq-based index ranges. */
function makeCtx(tables: Record<string, Row[]> = {}) {
  const reads: { table: string; range: Array<[string, unknown]> }[] = [];
  const db = {
    async get(id: string) {
      for (const rows of Object.values(tables)) {
        const doc = rows.find((r) => r._id === id);
        if (doc) return doc;
      }
      return null;
    },
    query(table: string) {
      const range: Array<[string, unknown]> = [];
      const state: Record<string, unknown> = {};
      const filtered = () => {
        let out = tables[table] ?? [];
        for (const [field, value] of range) {
          out = out.filter((d) => d[field] === value);
        }
        return out;
      };
      state.withIndex = (_name: string, cb?: (q: unknown) => unknown) => {
        if (cb) {
          const recorder: Record<string, unknown> = {};
          for (const op of ["eq", "gt", "gte", "lt", "lte"]) {
            recorder[op] = (field: string, value: unknown) => {
              if (op === "eq") range.push([field, value]);
              return recorder;
            };
          }
          cb(recorder);
        }
        reads.push({ table, range: [...range] });
        return state;
      };
      state.order = () => state;
      state.take = async (n: number) => filtered().slice(0, n);
      state.first = async () => filtered()[0] ?? null;
      state.collect = async () => filtered();
      return state;
    },
  };
  return { ctx: { db }, reads };
}

function handler(fn: unknown) {
  return fn as {
    _handler: (ctx: unknown, args: Record<string, unknown>) => Promise<unknown>;
  };
}

async function expectRejects(promise: Promise<unknown>, message: string) {
  try {
    await promise;
  } catch (err) {
    expect((err as Error).message).toBe(message);
    return;
  }
  throw new Error(`expected rejection with: ${message}`);
}

const me: Row = { _id: "users|me", email: "me@example.com" };
const adminUser: Row = { _id: "users|admin", email: "admin@example.com", role: "admin" };
const regularUser: Row = { _id: "users|u2", email: "u2@example.com" };

describe("/admin — requireAdmin (server-side role gate)", () => {
  test("signed-out callers are rejected", async () => {
    signedInAs = null;
    await expectRejects(
      handler(feedback.requireAdmin)(makeCtx().ctx, {}),
      "Sign in to view admin data.",
    );
    await expectRejects(
      handler(analytics.requireAdmin)(makeCtx().ctx, {}),
      "Sign in to view admin data.",
    );
  });

  test("signed-in users without an admin role are rejected", async () => {
    signedInAs = "users|u2";
    await expectRejects(
      handler(feedback.requireAdmin)(makeCtx({ users: [regularUser] }).ctx, {}),
      "Admin access required.",
    );
  });

  test("a missing user record is rejected", async () => {
    signedInAs = "users|ghost";
    await expectRejects(
      handler(feedback.requireAdmin)(makeCtx().ctx, {}),
      "User record missing.",
    );
  });

  test("role === admin passes", async () => {
    signedInAs = "users|admin";
    const { ctx } = makeCtx({ users: [adminUser] });
    await handler(feedback.requireAdmin)(ctx, {});
    await handler(analytics.requireAdmin)(ctx, {});
  });
});

describe("/admin — admin queries deny data before touching the database", () => {
  test("feedback.getAdmin returns authorized:false for a non-admin even with a passcode", async () => {
    signedInAs = "users|u2";
    const { ctx, reads } = makeCtx({ users: [regularUser] });
    const result = await handler(feedback.getAdmin)._handler(ctx, {
      passcode: "guessed-passcode",
    });
    expect(result).toEqual({ authorized: false });
    expect(reads.length).toBe(0);
  });

  test("feedback.getAdmin returns authorized:false when signed out", async () => {
    signedInAs = null;
    const { ctx, reads } = makeCtx();
    const result = await handler(feedback.getAdmin)._handler(ctx, {});
    expect(result).toEqual({ authorized: false });
    expect(reads.length).toBe(0);
  });

  test("analytics.getDashboard returns authorized:false for a non-admin with any passcode", async () => {
    signedInAs = "users|u2";
    const { ctx, reads } = makeCtx({ users: [regularUser] });
    const result = await handler(analytics.getDashboard)._handler(ctx, {
      passcode: "guessed-passcode",
    });
    expect(result).toEqual({ authorized: false });
    expect(reads.length).toBe(0);
  });

  test("an admin does get the feedback data (the gate is not inverted)", async () => {
    signedInAs = "users|admin";
    const { ctx } = makeCtx({
      users: [adminUser],
      feedback: [
        { _id: "feedback|f1", rating: 5, createdAt: 100 },
        { _id: "feedback|f2", rating: 3, createdAt: 200 },
      ],
    });
    const result = (await handler(feedback.getAdmin)._handler(ctx, {
      passcode: "anything",
    })) as { authorized: boolean; total: number; byRating: { rating: number; count: number }[] };
    expect(result.authorized).toBe(true);
    expect(result.total).toBe(2);
    expect(result.byRating.find((r) => r.rating === 5)?.count).toBe(1);
  });

  test("the env admin passcode is served only to admins", async () => {
    const prev = process.env.SITEPULSE_ADMIN_PASSWORD;
    process.env.SITEPULSE_ADMIN_PASSWORD = "test-admin-passcode";
    try {
      signedInAs = "users|admin";
      const adminCtx = makeCtx({ users: [adminUser] }).ctx;
      expect(await handler(analytics.getAdminPasscode)._handler(adminCtx, {})).toBe(
        "test-admin-passcode",
      );

      signedInAs = null;
      const anonCtx = makeCtx().ctx;
      expect(
        await handler(analytics.getAdminPasscode)._handler(anonCtx, {}),
      ).toBeUndefined();
      expect(
        await handler(feedback.getAdminPasscode)._handler(anonCtx, {}),
      ).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.SITEPULSE_ADMIN_PASSWORD;
      else process.env.SITEPULSE_ADMIN_PASSWORD = prev;
    }
  });
});

// ── Monitor detail query (getMonitor) ───────────────────────────────────────

const myMonitor: Row = {
  _id: "monitors|m1",
  ownerId: "users|me",
  name: "example.com",
  url: "https://example.com/",
  host: "example.com",
  intervalMs: 300_000,
  status: "active",
  state: "up",
  nextCheckAt: 0,
  consecutiveFailures: 0,
  consecutiveSuccesses: 2,
  createdAt: 0,
};

const checks = [
  { _id: "uptimeChecks|c1", monitorId: "monitors|m1", checkedAt: 10, dispatchedAt: 9, result: "ok", attempt: 1 },
  { _id: "uptimeChecks|c2", monitorId: "monitors|m1", checkedAt: 20, dispatchedAt: 19, result: "ok", attempt: 1 },
];

const closedIncident: Row = {
  _id: "incidents|c1",
  monitorId: "monitors|m1",
  kind: "down",
  open: false,
  openedAt: 10,
  closedAt: 20,
  recoveredAt: 20,
  reason: "http-503",
  failureCount: 2,
};

const otherAccountsDelivery: Row = {
  _id: "alertDeliveries|decoy",
  incidentId: "incidents|other-open",
  monitorId: "monitors|other",
  kind: "downtime",
  to: "other-user@example.com",
  subject: "SitePulse: other.example is DOWN",
  text: "another account's alert",
  status: "sent",
  createdAt: 30,
  sentAt: 31,
};

describe("/monitors — getMonitor enforces ownership (no IDOR)", () => {
  test("signed-out callers cannot read another account's monitor", async () => {
    signedInAs = null;
    const { ctx, reads } = makeCtx({
      monitors: [myMonitor],
      users: [me],
      uptimeChecks: checks,
      incidents: [closedIncident],
      alertDeliveries: [otherAccountsDelivery],
    });
    await expectRejects(
      handler(monitors.getMonitor)._handler(ctx, { monitorId: "monitors|m1" }),
      "This monitor belongs to another account.",
    );
    // Nothing beyond the monitor document itself may be read.
    expect(reads.length).toBe(0);
  });

  test("a signed-in stranger cannot read the monitor either", async () => {
    signedInAs = "users|u2";
    const { ctx, reads } = makeCtx({
      monitors: [myMonitor],
      users: [me, regularUser],
      uptimeChecks: checks,
      incidents: [closedIncident],
      alertDeliveries: [otherAccountsDelivery],
    });
    await expectRejects(
      handler(monitors.getMonitor)._handler(ctx, { monitorId: "monitors|m1" }),
      "This monitor belongs to another account.",
    );
    expect(reads.length).toBe(0);
  });

  test("listMonitors returns nothing for signed-out callers", async () => {
    signedInAs = null;
    const { ctx } = makeCtx({ monitors: [myMonitor] });
    expect(await handler(monitors.listMonitors)._handler(ctx, {})).toEqual([]);
  });
});

describe("/monitors — alert status is joined only through the monitor's own open incident", () => {
  test("healthy monitor (no open incident) never reads the delivery outbox", async () => {
    signedInAs = "users|me";
    const { ctx, reads } = makeCtx({
      monitors: [myMonitor],
      users: [me],
      uptimeChecks: checks,
      incidents: [closedIncident],
      // A decoy delivery from another account sits in the table; an unbounded
      // by_incident_kind scan would surface it.
      alertDeliveries: [otherAccountsDelivery],
    });
    const result = (await handler(monitors.getMonitor)._handler(ctx, {
      monitorId: "monitors|m1",
    })) as { alertDelivery: unknown; availability: number | null };
    expect(result.alertDelivery).toBeNull();
    expect(result.availability).toBe(100);
    expect(reads.some((r) => r.table === "alertDeliveries")).toBe(false);
  });

  test("open incident: delivery lookup is bound to that incident id only", async () => {
    signedInAs = "users|me";
    const openIncident: Row = {
      _id: "incidents|open1",
      monitorId: "monitors|m1",
      kind: "down",
      open: true,
      openedAt: 40,
      reason: "http-503",
      failureCount: 2,
    };
    const ownDelivery: Row = {
      _id: "alertDeliveries|d1",
      incidentId: "incidents|open1",
      monitorId: "monitors|m1",
      kind: "downtime",
      to: "me@example.com",
      subject: "SitePulse: example.com is DOWN",
      text: "your alert",
      status: "queued",
      createdAt: 41,
    };
    const { ctx, reads } = makeCtx({
      monitors: [myMonitor],
      users: [me],
      uptimeChecks: checks,
      incidents: [openIncident],
      alertDeliveries: [ownDelivery, otherAccountsDelivery],
    });
    const result = (await handler(monitors.getMonitor)._handler(ctx, {
      monitorId: "monitors|m1",
    })) as { alertDelivery: { count: number; status: string } | null };
    expect(result.alertDelivery).not.toBeNull();
    expect(result.alertDelivery?.status).toBe("queued");
    expect(result.alertDelivery?.count).toBe(1);

    const deliveryReads = reads.filter((r) => r.table === "alertDeliveries");
    expect(deliveryReads.length).toBe(1);
    // Every bound value must be defined and must be THIS incident — never
    // undefined (which would scan the whole outbox) and never another id.
    expect(deliveryReads[0].range).toEqual([["incidentId", "incidents|open1"]]);
    expect(deliveryReads[0].range.every(([, value]) => value !== undefined)).toBe(
      true,
    );
  });
});
