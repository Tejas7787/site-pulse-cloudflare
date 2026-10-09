import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";

/**
 * Rolling-window quotas for SitePulse's public endpoints.
 *
 * The scanner is free and unauthenticated, and every scan makes real requests
 * to a third-party website, so one visitor must not be able to push an
 * unbounded amount of traffic at someone else's server. One document holds the
 * counter for one key; the window resets in place once it expires, and the
 * retention cron sweeps keys that stopped being used.
 */

/** Scans allowed per visitor per window. */
export const SCAN_LIMIT = 20;
/** Length of the scan window. */
export const SCAN_WINDOW_MS = 60 * 60 * 1000; // 1 hour
/** Longest a stale key is kept around before the cron deletes it. */
export const RATE_LIMIT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

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
