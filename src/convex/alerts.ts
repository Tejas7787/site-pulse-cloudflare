import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { ALERT_MAX_AGE_MS } from "../lib/monitoring";
import { alertSubject, alertText, isValidAlertEmail, type AlertKind } from "../lib/alerts";

// ── Downtime / recovery email outbox ────────────────────────────────────────
// Pattern: record first, send second. recordCheck() reports an incident
// event, the probe enqueues it here (idempotent per incident+kind), then an
// action posts it to Resend. Convex does not auto-retry actions, so failed
// sends stay `queued` and are retried by the next probe until
// ALERT_MAX_AGE_MS. Requires RESEND_API_KEY on this deployment (set through
// the Keys UI); RESEND_FROM optionally overrides the sender.

const RESEND_API_URL = "https://api.resend.com/emails";

export const enqueue = internalMutation({
  args: {
    monitorId: v.id("monitors"),
    incidentId: v.id("incidents"),
    kind: v.union(v.literal("downtime"), v.literal("recovery")),
    url: v.string(),
    host: v.string(),
    openedAt: v.number(),
    recoveredAt: v.optional(v.number()),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Idempotency: one email per incident per kind, ever.
    const existing = await ctx.db
      .query("alertDeliveries")
      .withIndex("by_incident_kind", (q) =>
        q.eq("incidentId", args.incidentId).eq("kind", args.kind),
      )
      .first();
    if (existing) return { queued: false as const, reason: "duplicate" };

    const monitor = await ctx.db.get(args.monitorId);
    if (!monitor) return { queued: false as const, reason: "monitor-missing" };
    const owner = await ctx.db.get(monitor.ownerId);
    const to = monitor.alertEmail ?? owner?.email ?? null;
    if (!to || !isValidAlertEmail(to)) {
      return { queued: false as const, reason: "no-recipient" };
    }

    const deliveryId = await ctx.db.insert("alertDeliveries", {
      monitorId: args.monitorId,
      incidentId: args.incidentId,
      kind: args.kind,
      to,
      subject: alertSubject(args.kind, args.host),
      text: alertText({
        kind: args.kind,
        url: args.url,
        host: args.host,
        openedAt: args.openedAt,
        ...(args.recoveredAt !== undefined ? { recoveredAt: args.recoveredAt } : {}),
        ...(args.reason !== undefined ? { reason: args.reason } : {}),
      }),
      status: "queued",
      createdAt: Date.now(),
    });

    // Record on the incident when its alert was enqueued (audit trail).
    const patch: Partial<Doc<"incidents">> =
      args.kind === "downtime"
        ? { alertedAt: Date.now() }
        : { recoveryAlertedAt: Date.now() };
    await ctx.db.patch(args.incidentId, patch);

    return { queued: true as const, deliveryId };
  },
});

export const listQueued = internalQuery({
  args: { limit: v.number() },
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(Math.floor(args.limit), 1), 50);
    return await ctx.db
      .query("alertDeliveries")
      .withIndex("by_status_created", (q) => q.eq("status", "queued"))
      .order("asc")
      .take(limit);
  },
});

export const markSent = internalMutation({
  args: { id: v.id("alertDeliveries"), providerId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, {
      status: "sent",
      sentAt: Date.now(),
      ...(args.providerId ? { providerId: args.providerId } : {}),
      error: undefined,
    });
  },
});

export const markFailed = internalMutation({
  args: { id: v.id("alertDeliveries"), error: v.string() },
  handler: async (ctx, args) => {
    // Truncated and never includes the API key or request headers.
    await ctx.db.patch(args.id, {
      status: "failed",
      error: args.error.slice(0, 300),
    });
  },
});

export const sendQueued = internalAction({
  args: {},
  handler: async (
    ctx,
  ): Promise<{ sent: number; failed: number; pending: number; reason?: string }> => {
    // Explicit types here and below: this action's own type is part of the
    // generated API it queries through, so inference must not feed back into it.
    const queued: Doc<"alertDeliveries">[] = await ctx.runQuery(
      internal.alerts.listQueued,
      { limit: 20 },
    );
    if (queued.length === 0) return { sent: 0, failed: 0, pending: 0 };

    const apiKey = process.env.RESEND_API_KEY;
    const now = Date.now();
    if (!apiKey) {
      // Not configured yet: keep recent rows queued (the next probe retries)
      // and fail the ones that have waited too long so the UI shows it.
      let expired = 0;
      for (const row of queued) {
        if (now - row.createdAt > ALERT_MAX_AGE_MS) {
          await ctx.runMutation(internal.alerts.markFailed, {
            id: row._id,
            error: "Email alerts are not configured (RESEND_API_KEY is missing).",
          });
          expired += 1;
        }
      }
      return { sent: 0, failed: expired, pending: queued.length - expired, reason: "not_configured" };
    }

    const from = process.env.RESEND_FROM?.trim() || "SitePulse <onboarding@resend.dev>";
    let sent = 0;
    let failed = 0;

    for (const row of queued) {
      if (now - row.createdAt > ALERT_MAX_AGE_MS) {
        await ctx.runMutation(internal.alerts.markFailed, {
          id: row._id,
          error: "Gave up after 24h without successful delivery.",
        });
        failed += 1;
        continue;
      }
      try {
        const response = await fetch(RESEND_API_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from,
            to: [row.to],
            subject: row.subject,
            text: row.text,
          }),
        });
        if (response.ok) {
          const data = (await response.json().catch(() => ({}))) as { id?: string };
          await ctx.runMutation(internal.alerts.markSent, {
            id: row._id,
            ...(data.id ? { providerId: data.id } : {}),
          });
          sent += 1;
        } else {
          const body = await response.text().catch(() => "");
          await ctx.runMutation(internal.alerts.markFailed, {
            id: row._id,
            error: `HTTP ${response.status}${body ? `: ${body.slice(0, 160)}` : ""}`,
          });
          failed += 1;
        }
      } catch (err) {
        await ctx.runMutation(internal.alerts.markFailed, {
          id: row._id,
          error: String((err as Error)?.message ?? err).slice(0, 160),
        });
        failed += 1;
      }
    }

    return { sent, failed, pending: queued.length - sent - failed };
  },
});

/** Exposed for tests/UI badges: is an address acceptable as a recipient? */
export const isUsableRecipient = (email: string | null | undefined): boolean =>
  typeof email === "string" && isValidAlertEmail(email);

export type AlertKindExport = AlertKind;
export type QueuedDelivery = Doc<"alertDeliveries">;
export type DeliveryId = Id<"alertDeliveries">;
