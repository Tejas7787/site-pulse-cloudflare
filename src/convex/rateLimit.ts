import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { DIAGNOSIS_LIMIT_PER_HOUR, DIAGNOSIS_WINDOW_MS } from "../lib/aiDoctor";
import { FIX_PROPOSAL_LIMIT_PER_HOUR, FIX_PROPOSAL_WINDOW_MS } from "../lib/fixProposal";

/**
 * Rolling-window quotas for SitePulse's public endpoints.
 *
 * The scanner is free and unauthenticated, and every scan makes real requests
 * to a third-party website, so one visitor must not be able to push an
 * unbounded amount of traffic at someone else's server. One document holds the
 * counter for one key; the window resets in place once it expires, and the
 * retention cron sweeps keys that stopped being used.
 *
 * IDENTITY LIMITATION — documented, not a security boundary: every key is
 * derived from a CLIENT-supplied visitorId (localStorage `sp_vid`, see
 * src/lib/analytics.ts). Convex actions and mutations see no request IP, and
 * unauthenticated scanner users have no server-verifiable identity, so a
 * caller who rotates visitorId earns a fresh bucket per call and a caller who
 * omits it shares the single "anonymous" bucket. These quotas bound honest
 * traffic and damp casual abuse only — they are NOT authorization. Every
 * endpoint in front of one must stay safe to expose publicly on that basis.
 */

/** Scans allowed per visitor per window. */
export const SCAN_LIMIT = 20;
/** Length of the scan window. */
export const SCAN_WINDOW_MS = 60 * 60 * 1000; // 1 hour
/** Longest a stale key is kept around before the cron deletes it. */
export const RATE_LIMIT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
/**
 * Saved reports (shareable scan documents) a visitor may persist per window.
 * Deliberately twice SCAN_LIMIT: the honest flow performs at most one save
 * per successful scan, and scans are already capped at SCAN_LIMIT, so a
 * legitimate user can never be refused at the save step — while scripted
 * storage spam stays bounded per identity (identity caveat above applies).
 */
export const SAVE_SCAN_LIMIT = 2 * SCAN_LIMIT;

/** AI Website Doctor diagnoses allowed per visitor per window (single source: lib/aiDoctor). */
export const AI_DIAGNOSIS_LIMIT = DIAGNOSIS_LIMIT_PER_HOUR;
/** Length of the AI Website Doctor window. */
export const AI_DIAGNOSIS_WINDOW_MS = DIAGNOSIS_WINDOW_MS;

/** Fix proposals allowed per visitor per window (single source: lib/fixProposal). */
export const FIX_PROPOSAL_LIMIT = FIX_PROPOSAL_LIMIT_PER_HOUR;
/** Length of the fix-proposal window. */
export const FIX_PROPOSAL_WINDOW = FIX_PROPOSAL_WINDOW_MS;

// Phase 9A: throttles for the two remaining PUBLIC write endpoints.
// analytics.track fires automatically on page views and feedback.submit is a
// footer form — both were reachable with no server-side bound at all, so a
// single caller could insert rows without limit. Same client-supplied-visitor
// identity caveat as every quota above: this bounds honest traffic and damp
// casual abuse; it is NOT authorization, and retention (./retention.ts)
// bounds the tail regardless of identity rotation.

/** Analytics events allowed per visitor per window. Telemetry must never
 * break the page, so a denied event is silently dropped, not thrown. */
export const ANALYTICS_EVENT_LIMIT = 120;
/** Length of the analytics window. */
export const ANALYTICS_EVENT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

/** Feedback submissions allowed per visitor per window. */
export const FEEDBACK_LIMIT = 5;
/** Length of the feedback window. */
export const FEEDBACK_WINDOW_MS = 60 * 60 * 1000; // 1 hour

export interface QuotaResult {
  allowed: boolean;
  /** Requests still available inside the current window. */
  remaining: number;
  /** Milliseconds until the window resets (only meaningful when denied). */
  retryAfterMs: number;
}

/**
 * Consume one unit of a named quota. Safe to call from any mutation.
 * Never throws for storage problems: a broken counter must not take the
 * product down, so failures fail open.
 */
export async function consumeQuota(
  ctx: MutationCtx,
  args: { key: string; limit: number; windowMs: number; now?: number },
): Promise<QuotaResult> {
  const now = args.now ?? Date.now();
  try {
    const existing: Doc<"rateLimits"> | null = await ctx.db
      .query("rateLimits")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .first();

    if (!existing) {
      await ctx.db.insert("rateLimits", {
        key: args.key,
        windowStart: now,
        count: 1,
      });
      return { allowed: true, remaining: args.limit - 1, retryAfterMs: 0 };
    }

    if (now - existing.windowStart >= args.windowMs) {
      // Window expired: reset it in place rather than allocating a new key.
      await ctx.db.patch(existing._id, { windowStart: now, count: 1 });
      return { allowed: true, remaining: args.limit - 1, retryAfterMs: 0 };
    }

    if (existing.count >= args.limit) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(existing.windowStart + args.windowMs - now, 0),
      };
    }

    await ctx.db.patch(existing._id, { count: existing.count + 1 });
    return { allowed: true, remaining: args.limit - existing.count - 1, retryAfterMs: 0 };
  } catch {
    return { allowed: true, remaining: args.limit, retryAfterMs: 0 };
  }
}

/** Internal: called by the scan action before it touches the target site. */
export const consumeScanQuota = internalMutation({
  args: { visitorId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const visitor = args.visitorId?.trim().slice(0, 64) || "anonymous";
    const result = await consumeQuota(ctx, {
      key: `scan:${visitor}`,
      limit: SCAN_LIMIT,
      windowMs: SCAN_WINDOW_MS,
    });
    // The limit travels with the result so the action can word the error
    // without importing this module into its "use node" bundle.
    return { ...result, limit: SCAN_LIMIT };
  },
});

/**
 * Internal: called by the Website Doctor action before it builds a diagnosis.
 * Server-side only — the client cannot bypass it by calling the library.
 */
export const consumeAiQuota = internalMutation({
  args: { visitorId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const visitor = args.visitorId?.trim().slice(0, 64) || "anonymous";
    const result = await consumeQuota(ctx, {
      key: `ai:${visitor}`,
      limit: AI_DIAGNOSIS_LIMIT,
      windowMs: AI_DIAGNOSIS_WINDOW_MS,
    });
    return { ...result, limit: AI_DIAGNOSIS_LIMIT };
  },
});

/**
 * Internal: called by the fix-proposal action before it builds any proposal.
 * Server-side only — the client cannot bypass it by calling the library.
 */
export const consumeProposalQuota = internalMutation({
  args: { visitorId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const visitor = args.visitorId?.trim().slice(0, 64) || "anonymous";
    const result = await consumeQuota(ctx, {
      key: `fix-proposal:${visitor}`,
      limit: FIX_PROPOSAL_LIMIT,
      windowMs: FIX_PROPOSAL_WINDOW,
    });
    return { ...result, limit: FIX_PROPOSAL_LIMIT };
  },
});

// ── Paid AI completion budget (deployment-wide, fail CLOSED) ─────────────────
/**
 * Hard cap on PAID model completions per deployment per UTC day.
 *
 * Why this exists: every quota above is keyed on a CLIENT-supplied visitorId
 * (see the identity note) — by construction they cannot bound spending,
 * because any caller can pass a fresh id and earn a fresh bucket. This budget
 * has NO caller-controlled component: its key is the UTC date alone, so
 * changing visitorId cannot reset it, and it is consumed immediately before
 * every paid vly.ai.completion attempt (never for the deterministic engine,
 * the Website Doctor, fix proposals or report generation).
 *
 * Deliberately the opposite failure mode of consumeQuota: a broken counter
 * must not take the free scanner down, but for a BILLED call the safe default
 * is no call — so consumePaidAiBudget fails closed when the row cannot be
 * read or written.
 *
 * There is no provider-side cap to verify without exposing secrets:
 * integrations.md documents usage-based billing with no queryable limit, and
 * asking the gateway would require the secret key itself — which must stay
 * configured anyway, because email sign-in sends its one-time codes through
 * the same gateway (./auth/emailOtp.ts). Ops can still hard-disable paid
 * completions without touching that key via VLY_AI_PAID_DISABLED=true.
 *
 * Housekeeping: one row per UTC day (`ai-paid:<date>`); the hourly cleanup
 * cron sweeps rows older than RATE_LIMIT_MAX_AGE_MS once their date is over,
 * and the date in the key means a swept row can never be confused with the
 * current day's budget.
 */
export const PAID_AI_DAILY_LIMIT = 100;

/** Key of one UTC day's budget. Takes NO caller-supplied input, by design. */
export function paidAiBudgetKey(now: number): string {
  return `ai-paid:${new Date(now).toISOString().slice(0, 10)}`;
}

/** Next UTC midnight after `now` — when the daily budget resets. */
function nextUtcMidnight(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

export interface PaidAiBudgetResult {
  allowed: boolean;
  /** Calls left in today's deployment budget (0 when denied). */
  remaining: number;
  /** Milliseconds until the budget resets (only meaningful when denied). */
  retryAfterMs: number;
  limit: number;
  /** true only when the counter itself was unusable — no paid call either way. */
  unavailable?: boolean;
}

/**
 * Consume one unit of the deployment-wide paid-completion budget.
 * FAILS CLOSED: any storage error returns `allowed: false` — an unusable
 * counter must never authorize a billed call.
 */
export async function consumePaidAiBudget(
  ctx: MutationCtx,
  args: { now?: number; limit?: number } = {},
): Promise<PaidAiBudgetResult> {
  const now = args.now ?? Date.now();
  const limit = args.limit ?? PAID_AI_DAILY_LIMIT;
  const key = paidAiBudgetKey(now);
  try {
    const existing: Doc<"rateLimits"> | null = await ctx.db
      .query("rateLimits")
      .withIndex("by_key", (q) => q.eq("key", key))
      .first();
    if (!existing) {
      await ctx.db.insert("rateLimits", { key, windowStart: now, count: 1 });
      return { allowed: true, remaining: limit - 1, retryAfterMs: 0, limit };
    }
    if (existing.count >= limit) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(nextUtcMidnight(now) - now, 0),
        limit,
      };
    }
    // Derive `remaining` from the row BEFORE the write: correct against a
    // live row (tests) and an immutable snapshot (Convex) alike.
    const remainingAfter = limit - existing.count - 1;
    await ctx.db.patch(existing._id, { count: existing.count + 1 });
    return {
      allowed: true,
      remaining: remainingAfter,
      retryAfterMs: 0,
      limit,
    };
  } catch {
    // FAIL CLOSED — a storage problem blocks paid calls instead of enabling them.
    return { allowed: false, remaining: 0, retryAfterMs: 60_000, limit, unavailable: true };
  }
}

/**
 * Internal: paid-completion budget gate. No visitor argument exists to
 * rotate. Called by askAssistant right before any vly.ai.completion attempt.
 */
export const consumePaidAiQuota = internalMutation({
  args: {},
  handler: async (ctx) => await consumePaidAiBudget(ctx),
});

/** Internal: drop counters nobody has touched for RATE_LIMIT_MAX_AGE_MS. */
export const cleanup = internalMutation({
  args: { maxDeletes: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const cutoff = Date.now() - RATE_LIMIT_MAX_AGE_MS;
    const stale = await ctx.db
      .query("rateLimits")
      .withIndex("by_window_start", (q) => q.lt("windowStart", cutoff))
      .take(Math.min(Math.max(args.maxDeletes ?? 100, 1), 500));
    for (const doc of stale) await ctx.db.delete(doc._id);
    return { deleted: stale.length };
  },
});
