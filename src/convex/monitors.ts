import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import {
  alertRetentionCutoff,
  incidentRetentionCutoff,
  uptimeCheckRetentionCutoff,
} from "./retention";
import { isValidAlertEmail } from "../lib/alerts";
import {
  DISPATCH_BATCH,
  MAX_MONITORS_PER_OWNER,
  availabilityPercent,
  clampInterval,
  dispatchJitter,
  evaluateResult,
  normalizeMonitorUrl,
  hostOf,
} from "../lib/monitoring";

// ── Phase 2: monitors, dispatch, check recording, retention ──────────────────
// Probing runs entirely server-side: crons.ts ticks every minute,
// dispatchDue() schedules due probes (src/convex/probe.ts, a "use node"
// action because the SSRF guard needs DNS), and recordCheck() applies the
// failure-confirmation state machine and opens/closes incidents.

async function requireUser(ctx: QueryCtx | MutationCtx): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) throw new Error("Sign in to manage monitors.");
  return userId;
}

async function ownedMonitor(
  ctx: QueryCtx | MutationCtx,
  monitorId: Id<"monitors">,
): Promise<Doc<"monitors">> {
  const monitor = await ctx.db.get(monitorId);
  if (!monitor) throw new Error("Monitor not found.");
  const userId = await getAuthUserId(ctx);
  if (userId === null || monitor.ownerId !== userId) {
    throw new Error("This monitor belongs to another account.");
  }
  return monitor;
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

export const createMonitor = mutation({
  args: {
    url: v.string(),
    intervalMs: v.number(),
    name: v.optional(v.string()),
    alertEmail: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);

    const url = normalizeMonitorUrl(args.url);
    if (!url) {
      throw new Error("Enter a valid website address (http or https, no credentials).");
    }
    const alertEmail = args.alertEmail?.trim();
    if (alertEmail && !isValidAlertEmail(alertEmail)) {
      throw new Error("That does not look like a valid email address.");
    }

    const existing = await ctx.db
      .query("monitors")
      .withIndex("by_owner", (q) => q.eq("ownerId", userId))
      .take(MAX_MONITORS_PER_OWNER + 1);
    if (existing.length >= MAX_MONITORS_PER_OWNER) {
      throw new Error(
        `Free plan limit: ${MAX_MONITORS_PER_OWNER} monitors per account.`,
      );
    }

    const now = Date.now();
    const intervalMs = clampInterval(args.intervalMs);
    // First check almost immediately, offset by a random jitter so a batch of
    // new monitors never probes in the same tick.
    return await ctx.db.insert("monitors", {
      ownerId: userId,
      name: (args.name ?? "").trim().slice(0, 80) || hostOf(url),
      url,
      host: hostOf(url),
      intervalMs,
      status: "active",
      state: "unknown",
      nextCheckAt: now + 5_000 + Math.floor(Math.random() * 15_000),
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      ...(alertEmail ? { alertEmail } : {}),
      createdAt: now,
    });
  },
});

export const updateMonitor = mutation({
  args: {
    monitorId: v.id("monitors"),
    action: v.union(
      v.literal("pause"),
      v.literal("resume"),
      v.literal("delete"),
      v.literal("updateAlerts"),
    ),
    alertEmail: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const monitor = await ownedMonitor(ctx, args.monitorId);

    if (args.action === "delete") {
      await ctx.db.delete(monitor._id);
      return { deleted: true };
    }
    if (args.action === "pause") {
      await ctx.db.patch(monitor._id, { status: "paused", pausedAt: Date.now() });
      return { status: "paused" as const };
    }
    if (args.action === "resume") {
      await ctx.db.patch(monitor._id, {
        status: "active",
        pausedAt: undefined,
        nextCheckAt: Date.now() + 5_000,
      });
      return { status: "active" as const };
    }
    const email = args.alertEmail?.trim();
    if (email && !isValidAlertEmail(email)) {
      throw new Error("That does not look like a valid email address.");
    }
    await ctx.db.patch(monitor._id, {
      alertEmail: email ? email : undefined,
    });
    return { status: monitor.status };
  },
});

// ── Queries ──────────────────────────────────────────────────────────────────

export const listMonitors = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    const monitors = await ctx.db
      .query("monitors")
      .withIndex("by_owner", (q) => q.eq("ownerId", userId))
      .order("desc")
      .take(MAX_MONITORS_PER_OWNER + 1);

    const withIncidents = await Promise.all(
      monitors.map(async (monitor) => {
        const openIncident = await ctx.db
          .query("incidents")
          .withIndex("by_monitor_open", (q) =>
            q.eq("monitorId", monitor._id).eq("open", true),
          )
          .first();
        return {
          ...monitor,
          openIncident: openIncident
            ? { _id: openIncident._id, openedAt: openIncident.openedAt, reason: openIncident.reason }
            : null,
        };
      }),
    );
    return withIncidents;
  },
});

export const getMonitor = query({
  args: { monitorId: v.id("monitors") },
  handler: async (ctx, args) => {
    const monitor = await ownedMonitor(ctx, args.monitorId);
    const checks = await ctx.db
      .query("uptimeChecks")
      .withIndex("by_monitor_checked", (q) => q.eq("monitorId", monitor._id))
      .order("desc")
      .take(240);
    const incidents = await ctx.db
      .query("incidents")
      .withIndex("by_monitor_open", (q) => q.eq("monitorId", monitor._id))
      .order("desc")
      .take(50);
    const owner = await ctx.db.get(monitor.ownerId);
    // The delivery outbox is joined through incidents: an alert is enqueued
    // only when an incident is opened, so the monitor->incident relationship is
    // derived here instead of casting monitor._id to Id<"incidents">.
    // The delivery outbox is joined through incidents: an alert is enqueued
    // only when an incident is opened, so the monitor->incident relationship
    // is derived here instead of casting monitor._id to Id<"incidents">.
    const openIncident = await ctx.db
      .query("incidents")
      .withIndex("by_monitor_open", (q) =>
        q.eq("monitorId", monitor._id).eq("open", true),
      )
      .first();
      )
      .first();
    const openDelivery = await ctx.db.query("alertDeliveries")
      .withIndex("by_incident_kind", (q) =>
        q.eq(
          "incidentId",
          openIncident === null || openIncident === undefined
            ? ""
            : (openIncident._id as unknown) as Id<"incidents">,
        ),
      )
      .order("desc")
      .first();
    const deliveryStatus = openDelivery
      ? { count: 1, status: openDelivery.status, deliveredAt: openDelivery.sentAt }
      : null;
    return {
      monitor,
      checks,
      incidents,
      availability: availabilityPercent(checks.map((c) => c.result)),
      alertDestination: monitor.alertEmail ?? owner?.email ?? null,
      alertDelivery: deliveryStatus,
    };
  },
});

// ── Dispatcher (called every minute by crons.ts) ─────────────────────────────

export const dispatchDue = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const due = await ctx.db
      .query("monitors")
      .withIndex("by_due", (q) => q.eq("status", "active").lt("nextCheckAt", now))
      .take(DISPATCH_BATCH);

    const dispatchedHosts = new Set<string>();
    let scheduled = 0;
    for (const monitor of due) {
      // One in-flight probe per host inside a batch — a courtesy to the
      // target and a cheap per-host concurrency cap.
      if (dispatchedHosts.has(monitor.host)) continue;
      dispatchedHosts.add(monitor.host);

      const jitter = dispatchJitter(monitor._id);
      // Advance the due time BEFORE scheduling so an overlapping tick can
      // never double-dispatch this monitor.
      await ctx.db.patch(monitor._id, {
        nextCheckAt: now + monitor.intervalMs,
        lastDispatchedAt: now,
      });
      ctx.scheduler.runAfter(jitter, internal.probe.probe, {
        monitorId: monitor._id,
        url: monitor.url,
        dispatchedAt: now,
      });
      scheduled += 1;
    }
    return { due: due.length, scheduled };
  },
});

// ── Recording a probe result (called by the probe action) ────────────────────

export const recordCheck = internalMutation({
  args: {
    monitorId: v.id("monitors"),
    dispatchedAt: v.number(),
    checkedAt: v.number(),
    result: v.union(
      v.literal("ok"),
      v.literal("down"),
      v.literal("blocked"),
      v.literal("error"),
    ),
    httpStatus: v.optional(v.number()),
    durationMs: v.optional(v.number()),
    detail: v.optional(v.string()),
    attempt: v.number(),
  },
  handler: async (ctx, args) => {
    const monitor = await ctx.db.get(args.monitorId);
    if (!monitor) return null;
    // A probe that was dispatched earlier must never overwrite a newer result
    // (actions can be slow or replayed; ordering is decided at dispatch).
    if ((monitor.lastDispatchedAt ?? 0) > args.dispatchedAt) {
      return { stale: true, events: [] as [] };
    }

    await ctx.db.insert("uptimeChecks", {
      monitorId: monitor._id,
      checkedAt: args.checkedAt,
      dispatchedAt: args.dispatchedAt,
      result: args.result,
      ...(args.httpStatus !== undefined ? { httpStatus: args.httpStatus } : {}),
      ...(args.durationMs !== undefined ? { durationMs: args.durationMs } : {}),
      ...(args.detail !== undefined ? { detail: args.detail } : {}),
      attempt: args.attempt,
    });

    const openIncident = await ctx.db
      .query("incidents")
      .withIndex("by_monitor_open", (q) =>
        q.eq("monitorId", monitor._id).eq("open", true),
      )
      .first();

    const evaluation = evaluateResult(
      {
        state: monitor.state,
        consecutiveFailures: monitor.consecutiveFailures,
        consecutiveSuccesses: monitor.consecutiveSuccesses,
        hasOpenIncident: openIncident !== null,
      },
      args.result,
      args.detail,
    );

    await ctx.db.patch(monitor._id, {
      state: evaluation.state,
      consecutiveFailures: evaluation.consecutiveFailures,
      consecutiveSuccesses: evaluation.consecutiveSuccesses,
      lastCheckedAt: args.checkedAt,
      lastResult: args.result,
      ...(args.httpStatus !== undefined ? { lastHttpStatus: args.httpStatus } : {}),
      ...(args.durationMs !== undefined ? { lastDurationMs: args.durationMs } : {}),
    });

    type Event = {
      kind: "downtime" | "recovery";
      incidentId: Id<"incidents">;
      openedAt: number;
      recoveredAt?: number;
      reason?: string;
    };
    const events: Event[] = [];

    if (evaluation.incident === "open") {
      const incidentId = await ctx.db.insert("incidents", {
        monitorId: monitor._id,
        kind: "down",
        open: true,
        openedAt: args.checkedAt,
        reason: args.detail ?? args.result,
        failureCount: evaluation.consecutiveFailures,
      });
      events.push({
        kind: "downtime",
        incidentId,
        openedAt: args.checkedAt,
        reason: args.detail ?? args.result,
      });
    } else if (evaluation.incident === "close" && openIncident) {
      const recoveredAt = args.checkedAt;
      await ctx.db.patch(openIncident._id, {
        open: false,
        closedAt: recoveredAt,
        recoveredAt,
      });
      events.push({
        kind: "recovery",
        incidentId: openIncident._id,
        openedAt: openIncident.openedAt,
        recoveredAt,
      });
    }

    return {
      stale: false as const,
      state: evaluation.state,
      events,
    };
  },
});

// ── Retention (bounded batch, same shape as scan retention) ──────────────────

const DELETE_BATCH_MAX = 500;
const DELETE_DEFAULT_BATCH = 200;

export const deleteExpiredUptimeData = internalMutation({
  args: { maxDeletes: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const limit = Math.min(
      Math.max(Math.floor(args.maxDeletes ?? DELETE_DEFAULT_BATCH), 1),
      DELETE_BATCH_MAX,
    );

    const expiredChecks = await ctx.db
      .query("uptimeChecks")
      .withIndex("by_checked_at", (q) =>
        q.lt("checkedAt", uptimeCheckRetentionCutoff(now)),
      )
      .take(limit);
    for (const row of expiredChecks) await ctx.db.delete(row._id);

    const expiredIncidents = await ctx.db
      .query("incidents")
      .withIndex("by_opened_at", (q) =>
        q.lt("openedAt", incidentRetentionCutoff(now)),
      )
      .take(limit);
    for (const row of expiredIncidents) await ctx.db.delete(row._id);

    const expiredAlerts = await ctx.db
      .query("alertDeliveries")
      .withIndex("by_created", (q) => q.lt("createdAt", alertRetentionCutoff(now)))
      .take(limit);
    for (const row of expiredAlerts) await ctx.db.delete(row._id);

    return {
      checks: expiredChecks.length,
      incidents: expiredIncidents.length,
      alerts: expiredAlerts.length,
      complete:
        expiredChecks.length < limit &&
        expiredIncidents.length < limit &&
        expiredAlerts.length < limit,
    };
  },
});
