import { ConvexError, v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { ALERT_MAX_AGE_MS } from "../lib/monitoring";
import {
  alertSubject,
  alertText,
  isValidAlertEmail,
  resolveAlertFrom,
  type AlertKind,
} from "../lib/alerts";
import { consumeQuota } from "./rateLimit";

// ── Downtime / recovery email outbox ────────────────────────────────────────
// Pattern: record first, send second. recordCheck() reports an incident
// event, the probe enqueues it here (idempotent per incident+kind), then an
// action posts it to Resend. Convex does not auto-retry actions, so failed
// sends stay `queued` and are retried by the next probe until
// ALERT_MAX_AGE_MS. Requires RESEND_API_KEY on this deployment (set through
// the Keys UI); RESEND_FROM optionally overrides the sender.

const RESEND_API_URL = "https://api.resend.com/emails";

/**
 * How long a send claim (status "sending") is respected before another
 * sender may steal it. Long enough to cover a slow provider call, short
 * enough that a crashed sender's row is retried within minutes.
 */
export const ALERT_CLAIM_TTL_MS = 5 * 60 * 1000;

/**
 * Atomically claim one queued (or abandoned-sending) delivery for sending.
 * Convex mutations are serializable, so exactly one concurrent caller can
 * flip a row to "sending" — the probe's opportunistic drain and the cron
 * drain can overlap without ever delivering the same email twice.
 */
export const claim = internalMutation({
  args: { id: v.id("alertDeliveries") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (!row) return { claimed: false as const, reason: "missing" };
    if (row.status === "queued") {
      await ctx.db.patch(args.id, { status: "sending", claimedAt: Date.now() });
      return { claimed: true as const };
    }
    // A "sending" row whose claim expired (sender crashed mid-flight) is
    // reclaimable; a fresh claim means another sender is working on it.
    if (row.status === "sending") {
      const stale =
        row.claimedAt === undefined ||
        Date.now() - row.claimedAt > ALERT_CLAIM_TTL_MS;
      if (stale) {
        await ctx.db.patch(args.id, { status: "sending", claimedAt: Date.now() });
        return { claimed: true as const, reclaimed: true };
      }
      return { claimed: false as const, reason: "in-flight" };
    }
    return { claimed: false as const, reason: row.status };
  },
});

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
    const now = Date.now();
    const queued = await ctx.db
      .query("alertDeliveries")
      .withIndex("by_status_created", (q) => q.eq("status", "queued"))
      .order("asc")
      .take(limit);

    // "sending" rows whose claim expired (sender crashed mid-flight) are
    // retryable — without this sweep a crashed drain would strand the email
    // in "sending" forever. Fresh claims belong to a live sender and are
    // skipped, which is what keeps concurrent drains duplicate-free.
    const sending = await ctx.db
      .query("alertDeliveries")
      .withIndex("by_status_created", (q) => q.eq("status", "sending"))
      .order("asc")
      .take(limit);
    const staleSending = sending.filter(
      (row) =>
        row.claimedAt === undefined || now - row.claimedAt > ALERT_CLAIM_TTL_MS,
    );

    return [...queued, ...staleSending].slice(0, limit);
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
      claimedAt: undefined,
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
      claimedAt: undefined,
    });
  },
});

/**
 * POST one email to Resend. Shared by the outbox drain (sendQueued) and the
 * authenticated test send (sendTestEmail), so both use the same headers,
 * sender resolution and truncation rules.
 *
 * SECURITY: the API key is passed in and used only for the Authorization
 * header of this one request. It is never logged, stored, or included in the
 * returned error (provider response bodies are truncated like markFailed).
 */
async function postToResend(
  apiKey: string,
  from: string,
  payload: { to: string[]; subject: string; text: string },
): Promise<{ ok: true; providerId?: string } | { ok: false; error: string }> {
  try {
    const response = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, ...payload }),
    });
    if (response.ok) {
      const data = (await response.json().catch(() => ({}))) as { id?: string };
      return { ok: true, ...(data.id ? { providerId: data.id } : {}) };
    }
    const body = await response.text().catch(() => "");
    return {
      ok: false,
      error: `HTTP ${response.status}${body ? `: ${body.slice(0, 160)}` : ""}`,
    };
  } catch (err) {
    return {
      ok: false,
      error: String((err as Error)?.message ?? err).slice(0, 160),
    };
  }
}

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

    // Canonical sender var is RESEND_FROM_EMAIL; RESEND_FROM stays supported
    // for older setups. resolveAlertFrom falls back to the project's verified
    // sender domain when neither is set (or a value is malformed).
    const from = resolveAlertFrom([
      process.env.RESEND_FROM_EMAIL,
      process.env.RESEND_FROM,
    ]);
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
      // Claim before sending: two concurrent drains (probe + cron) can both
      // list the same row, but only one wins the claim, so the recipient
      // never gets the same notification twice.
      const claimResult: { claimed: boolean; reason?: string } =
        await ctx.runMutation(internal.alerts.claim, { id: row._id });
      if (!claimResult.claimed) {
        continue;
      }
      const result = await postToResend(apiKey, from, {
        to: [row.to],
        subject: row.subject,
        text: row.text,
      });
      if (result.ok) {
        await ctx.runMutation(internal.alerts.markSent, {
          id: row._id,
          ...(result.providerId ? { providerId: result.providerId } : {}),
        });
        sent += 1;
      } else {
        await ctx.runMutation(internal.alerts.markFailed, {
          id: row._id,
          error: result.error,
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

// ── Phase 9D: authenticated one-off test email ────────────────────────────
// Lets a SIGNED-IN operator verify the whole Resend path (env vars, sender
// domain, provider account) with a single message, without touching a real
// monitor or incident. Safety properties:
//  - requires Convex Auth (getAuthUserId) — never callable anonymously, so
//    this can never be used as an open relay;
//  - bounded by a server-side per-user quota (consumeQuota), so even a
//    signed-in account cannot pump mail;
//  - recipient is validated with the same rule as real alert recipients;
//  - the API key and the configured From VALUE never appear in the result —
//    only an ok/providerId (success) or a truncated provider error (failure).

/** Test emails allowed per signed-in user per hour. */
export const TEST_EMAIL_LIMIT_PER_HOUR = 3;
/** Length of the test-email window. */
export const TEST_EMAIL_WINDOW_MS = 60 * 60 * 1000;

/** Internal: consume one test-email quota unit for a user (server-side). */
export const consumeTestEmailQuota = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) =>
    consumeQuota(ctx, {
      key: `test-email:${args.userId}`,
      limit: TEST_EMAIL_LIMIT_PER_HOUR,
      windowMs: TEST_EMAIL_WINDOW_MS,
    }),
});

export type TestEmailResult =
  | { ok: true; providerId?: string }
  | { ok: false; error: string };

export const sendTestEmail = action({
  args: { to: v.string() },
  handler: async (ctx, args): Promise<TestEmailResult> => {
    // 1. Authentication: only a signed-in account may trigger a send.
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new ConvexError({
        code: "auth_required",
        message: "Sign in to send a test email.",
      });
    }

    // 2. Recipient shape (same rule as monitor alert recipients).
    if (!isValidAlertEmail(args.to)) {
      throw new ConvexError({
        code: "invalid_recipient",
        message: "Enter a valid recipient email address.",
      });
    }

    // 3. Server-side per-user quota (denied BEFORE any provider contact).
    const quota: { allowed: boolean; retryAfterMs: number } =
      await ctx.runMutation(internal.alerts.consumeTestEmailQuota, { userId });
    if (!quota.allowed) {
      throw new ConvexError({
        code: "rate_limited",
        message: "Test-email limit reached. Try again later.",
        retryAfterMs: quota.retryAfterMs,
      });
    }

    // 4. Configuration check — honest refusal, no env values in the error.
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      throw new ConvexError({
        code: "not_configured",
        message:
          "Email sending is not configured on this deployment (RESEND_API_KEY is missing).",
      });
    }

    // 5. Send through the shared Resend helper (identical headers/From
    //    resolution as real downtime/recovery alerts).
    const from = resolveAlertFrom([
      process.env.RESEND_FROM_EMAIL,
      process.env.RESEND_FROM,
    ]);
    const sentAt = new Date().toISOString().replace("T", " ").slice(0, 19);
    const result = await postToResend(apiKey, from, {
      to: [args.to],
      subject: "SitePulse: test email (delivery check)",
      text: [
        "This is a SitePulse email delivery test.",
        "",
        `If you received this, this deployment can deliver downtime and`,
        `recovery alerts to ${args.to}.`,
        "",
        `Sent: ${sentAt} UTC`,
        "",
        "No action is needed. If this message was unexpected, you can",
        "ignore it — no monitor data was involved in this test.",
      ].join("\n"),
    });

    if (!result.ok) return { ok: false as const, error: result.error };
    return {
      ok: true as const,
      ...(result.providerId ? { providerId: result.providerId } : {}),
    };
  },
});

export type AlertKindExport = AlertKind;
export type QueuedDelivery = Doc<"alertDeliveries">;
export type DeliveryId = Id<"alertDeliveries">;
